import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ClassicLevel } from 'classic-level';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';
import { DeviceInstallationStore } from './device-installation.store';
import { DeviceEnrollmentService } from './enrollment/device-enrollment.service';
import { PostgresDeviceEnrollmentRepository } from './enrollment/postgres-device-enrollment.repository';
import { findExactShellyInventoryAssignment } from '../portal/site-local-shelly-inventory-match';
import { DeviceMqttMessageRouter } from './mqtt/device-mqtt-message-router';
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime';
import { DeviceObservationService } from './device-observation.service';
import { shellyPro2PmNotifyStatusFixture } from './adapters/inbound/shelly/__fixtures__/shelly-pro2pm-notifystatus.fixture';
import { configuredShellyMqttBroker } from './adapters/inbound/shelly/shelly-mqtt-observation-approval';
import { GenericMeasurementHistoryOutbox } from '../telemetry/generic-measurements/generic-measurement-history-outbox';
import { GenericMeasurementHistoryWriter } from '../telemetry/generic-measurements/generic-measurement-history-writer';
import { PostgresGenericMeasurementRepository } from '../telemetry/generic-measurements/postgres-generic-measurement.repository';
import { TelemetryStore } from '../telemetry/telemetry.store';
import { TelemetrySpool } from '../telemetry/telemetry-spool';
import { TelemetryIngestService } from '../telemetry/telemetry-ingest.service';
import { telemetryConfig } from '../telemetry/telemetry.config';
import { PortalDeviceElectricalMeasurementsService } from '../portal/portal-device-electrical-measurements.service';
import { PortalDeviceMeasurementsService } from '../portal/portal-device-measurements.service';

const databaseUrl = process.env.SHELLY_ACCEPTANCE_DATABASE_URL || process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL;
const e2e = databaseUrl ? describe : describe.skip;
const tenantId = `shelly-mqtt-test-${randomUUID()}`;
const siteId = `site-${randomUUID()}`;
const physicalId = `shellye2e${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const physicalInventoryId = randomUUID();
const topic = `shelly/${physicalId}@other/events/rpc`;
const components = ['switch:0', 'switch:1'] as const;
const reportId = `site-observer-e2e-${randomUUID()}`;
let evidenceAt: string;

/**
 * Integration test for a disposable, migrated PostgreSQL database.
 * The test refuses remote or non-test databases and uses unique identities
 * plus temporary LevelDB directories. It accepts the repository's named
 * enrollment integration database or a dedicated Shelly acceptance database.
 */
e2e('Shelly MQTT measurement end-to-end acceptance (isolated PostgreSQL)', () => {
  let pool: Pool;
  let tempDirectory: string;
  let installStore: DeviceInstallationStore;
  let registry: DeviceRegistryService;
  let runtime: ApprovedMqttObservationRuntime;
  let historyWriter: GenericMeasurementHistoryWriter;
  let telemetry: TelemetryIngestService;
  let telemetrySpool: TelemetrySpool;
  let telemetryStore: TelemetryStore;
  let genericRepository: PostgresGenericMeasurementRepository;
  let config: ReturnType<typeof telemetryConfig>;
  let enrollment: DeviceEnrollmentService;
  let oldEnvironment: NodeJS.ProcessEnv;
  let schemaReady = false;
  let frozenNow: Date;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const databaseName = url.pathname.slice(1);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
        !(databaseName === 'energrid_physical_inventory_test' || /^energrid_shelly_e2e_[a-z0-9_]+$/i.test(databaseName))) {
      throw new Error('Shelly acceptance tests require a disposable localhost integration database.');
    }
    oldEnvironment = { ...process.env };
    frozenNow = new Date();
    evidenceAt = frozenNow.toISOString();
    process.env.PORTAL_TENANT_ID = tenantId;
    process.env.PORTAL_SITE_ID = siteId;
    process.env.PORTAL_SITE_NAME = 'Home';
    process.env.HOME_MQTT_HOST = 'devicebroker.ddns.net';
    process.env.HOME_MQTT_PORT = '1883';
    process.env.HOME_MQTT_INGEST_ENABLED = 'true';
    process.env.HOME_HTTP_POLL_ENABLED = 'true';
    delete process.env.HOME_OBSERVATION_BINDINGS_JSON;
    delete process.env.LAB_MQTT_OBSERVATION_BINDINGS_JSON;

    pool = new Pool({ connectionString: databaseUrl });
    const schema = await pool.query("SELECT to_regclass('telemetry.readings') AS electrical, to_regclass('telemetry.measurements') AS generic, to_regclass('device_inventory.enrollments') AS enrollments");
    if (!schema.rows[0]?.electrical || !schema.rows[0]?.generic || !schema.rows[0]?.enrollments) {
      throw new Error('Disposable DB must have the Core enrollment and telemetry migrations applied.');
    }
    schemaReady = true;
    await cleanDisposableRecords();
    const now = frozenNow.toISOString();
    enrollment = new DeviceEnrollmentService(new PostgresDeviceEnrollmentRepository(pool), () => now,
      () => randomUUID());
    tempDirectory = await mkdtemp(join(tmpdir(), 'energrid-shelly-acceptance-'));
    process.env.HOME_OBSERVATION_STORE_DIRECTORY = join(tempDirectory, 'observation-state');
    installStore = new DeviceInstallationStore(join(tempDirectory, 'installations'));
    await installStore.onModuleInit();

    for (const [index, component] of components.entries()) {
      const deviceId = `${physicalId}:${component}`;
      const displayName = index === 0 ? 'Washer / bathroom fan' : 'Existing component';
      await enrollment.enroll({ tenantId, siteId, deviceId, displayName }, 'isolated-test-operator');
      const record = {
        schemaVersion: 1 as const,
        device: {
          id: deviceId, tenantId, siteId, siteName: 'Home', displayName,
          kind: 'physical' as const, trustStatus: 'approved' as const,
          zoneId: index === 0 ? 'bathroom' : 'unknown', zoneName: index === 0 ? 'Bathroom' : 'Unknown',
          adapter: { id: 'mqtt', protocol: 'mqtt', transport: 'mqtt', driver: 'shelly-discovered', configured: true },
          capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
          supportedCapabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
          state: { values: { output: false }, observedAt: null, source: 'mqtt', status: 'unknown' },
          metadata: { physicalId, component, mqttEvidenceCandidate: true },
        },
        physicalOutcome: { status: 'not_confirmed' as const, confirmedAt: null, confirmedBy: null },
        updatedAt: now,
      };
      await installStore.save(record as any);
    }

    registry = new DeviceRegistryService(undefined, installStore, enrollment);
    await registry.onModuleInit();
    const inventory = {
      physicalDeviceId: physicalInventoryId,
      scope: { tenantId, siteId },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      verificationStatus: 'protocol_observed', firstSeenAt: now, lastSeenAt: now,
      components: components.map(key => ({ key, capabilities: ['switch', 'power'], firstSeenAt: now, lastSeenAt: now })),
      endpoints: [], networkObservations: [],
      assignments: components.map(key => ({ deviceId: `${physicalId}:${key}`, physicalDeviceId: physicalInventoryId,
        componentKey: key, assignedAt: now, assignedBy: 'isolated-test-fixture' })),
    };
    for (const component of components) {
      const deviceId = `${physicalId}:${component}`;
      // Resolve the authoritative assignment as the Portal review does; the
      // logical Home record intentionally has no copied inventory ID.
      const assignment = findExactShellyInventoryAssignment([inventory] as any,
        { tenantId, siteId }, deviceId, physicalId, component);
      expect(assignment?.physicalDeviceId).toBe(physicalInventoryId);
      await registry.reconcileShellyIdentityEvidence({
        tenantId, siteId, deviceId, physicalId, component, physicalInventoryId: assignment!.physicalDeviceId,
        // A fresh, sanitized RPC fixture is used here; the old accepted Home
        // snapshot remains separately covered by the historical-evidence test.
        evidenceScanId: reportId,
        evidenceCompletedAt: now, observerId: 'pi-housenet', ipAddress: '192.168.1.166',
        networkScope: 'upstream-lan:192.168.1.0/24', identityVerifiedAt: now, componentVerifiedAt: now,
        verifiedMeasurementFields: ['power', 'energy_import_total', 'energy_export_total'],
      });
      expect(await registry.getShellyObservationApproval(tenantId, siteId, deviceId))
        .toMatchObject({ approved: false, evidenceFresh: true, approvalStatus: 'missing' });
      await registry.approveShellyObservations(tenantId, siteId, deviceId, 'isolated-test-operator',
        ['power'], topic, configuredShellyMqttBroker());
    }

    config = telemetryConfig({
      TELEMETRY_ENABLED: 'true', TELEMETRY_HISTORY_ENABLED: 'true',
      TELEMETRY_DATABASE_URL: databaseUrl!,
      TELEMETRY_SPOOL_DIRECTORY: join(tempDirectory, 'electrical-spool'),
      TELEMETRY_HISTORY_OUTBOX_DIRECTORY: join(tempDirectory, 'measurement-history-outbox'),
    });
    telemetryStore = new TelemetryStore(pool);
    telemetrySpool = new TelemetrySpool(config, directory => new ClassicLevel(directory, { valueEncoding: 'json' }));
    telemetry = new TelemetryIngestService(config, telemetryStore, telemetrySpool);
    await telemetry.onModuleInit();
    genericRepository = new PostgresGenericMeasurementRepository(pool);
    const historyOutbox = new GenericMeasurementHistoryOutbox(config,
      directory => new ClassicLevel(directory, { valueEncoding: 'json' }));
    historyWriter = new GenericMeasurementHistoryWriter(genericRepository, true, config.historyPolicies, historyOutbox);
    await historyWriter.onModuleInit();
    runtime = new ApprovedMqttObservationRuntime(registry, installStore, enrollment, historyWriter);
  }, 30_000);

  afterAll(async () => {
    await runtime?.onModuleDestroy();
    await historyWriter?.onModuleDestroy();
    await telemetry?.onModuleDestroy();
    await telemetrySpool?.close();
    await installStore?.onModuleDestroy();
    if (pool && schemaReady) await cleanDisposableRecords();
    await pool?.end();
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    if (oldEnvironment) process.env = oldEnvironment;
  });

  async function cleanDisposableRecords() {
    for (const component of components) {
      const deviceId = `${physicalId}:${component}`;
      await pool.query('DELETE FROM telemetry.measurements WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]);
      await pool.query('DELETE FROM telemetry.readings WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]);
      await pool.query('DELETE FROM telemetry.dirty_hours WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]);
      await pool.query('DELETE FROM telemetry.hourly WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]);
      await pool.query('DELETE FROM device_inventory.enrollment_events WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]);
      await pool.query('DELETE FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]);
    }
  }

  it('writes and reads zero-watt observations for both existing logical components, while rejecting other source/site/identity and unapproved fields', async () => {
    const router = new DeviceMqttMessageRouter(registry, new DeviceObservationService(), telemetry,
      undefined, undefined, new PostgresDeviceEnrollmentRepository(pool), runtime);
    const historyFrom = new Date(frozenNow.getTime() - 60_000).toISOString();
    const historyTo = new Date(Date.now() + 5_000).toISOString();
    const payload = { ...shellyPro2PmNotifyStatusFixture, src: physicalId, params: {
      ...shellyPro2PmNotifyStatusFixture.params,
      ts: Math.floor(frozenNow.getTime() / 1000),
      'switch:0': { ...shellyPro2PmNotifyStatusFixture.params['switch:0'], apower: 0, current: 0.1, voltage: 230 },
      'switch:1': { ...shellyPro2PmNotifyStatusFixture.params['switch:1'], apower: 0, current: 0.2, voltage: 230 },
    } };
    const routed = await router.route({ topic, payload, payloadText: JSON.stringify(payload) });
    await routed?.persisted;
    await telemetry.flush();

    expect(routed?.observationAdmissions).toEqual(components.map(component => expect.objectContaining({
      deviceId: `${physicalId}:${component}`, outcome: 'admitted',
    })));
    await expect(pool.query('SELECT device_id,metric,value FROM telemetry.measurements WHERE tenant_id=$1 AND site_id=$2 ORDER BY device_id', [tenantId, siteId]))
      .resolves.toMatchObject({ rows: expect.arrayContaining([
        expect.objectContaining({ device_id: `${physicalId}:switch:0`, metric: 'power', value: 0 }),
        expect.objectContaining({ device_id: `${physicalId}:switch:1`, metric: 'power', value: 0 }),
      ]) });
    for (const component of components) {
      const deviceId = `${physicalId}:${component}`;
      const reading = await telemetryStore.read({ tenantId, siteId, deviceId, channel: component, metric: 'power' },
        historyFrom, historyTo);
      expect(reading).toHaveLength(1);
      expect(reading[0]).toMatchObject({ value: 0, unit: 'W', timestampBasis: 'device-observed', source: 'shelly-mqtt' });
      const generic = await genericRepository.read({
        tenantId, siteId, deviceId, componentId: 'device', channel: 'power', metric: 'power',
        from: historyFrom, to: historyTo, limit: 10,
      });
      expect(generic).toHaveLength(1);
      expect(generic[0]).toMatchObject({ value: 0, unit: 'W', quality: 'measured', source: 'shelly-mqtt' });

      const intelligence = new DeviceIntelligenceQueryService(registry, installStore, enrollment, {
        read: (scope, requestedDeviceId) => runtime.getAuthorizedObservation(scope, requestedDeviceId),
      } as never, genericRepository);
      const genericHistory = new PortalDeviceMeasurementsService(intelligence, genericRepository);
      const portal = new PortalDeviceElectricalMeasurementsService(registry, genericHistory);
      const genericPortalHistory = await genericHistory.history({ tenantId, siteId }, deviceId, 'power', historyFrom, historyTo, 5000);
      expect(genericPortalHistory.measurements).toEqual([expect.objectContaining({ value: 0, quality: 'measured' })]);
      await expect(portal.history(deviceId, 'power', historyFrom, historyTo))
        .resolves.toMatchObject({ deviceId, metric: 'power', unit: 'W', measurements: [expect.objectContaining({ value: 0 })] });
      const installation = await installStore.get({ tenantId, siteId }, deviceId);
      expect(installation?.device.metadata?.physicalId).toBe(physicalId);
      expect(installation?.device.metadata?.component).toBe(component);
      expect(installation?.device.metadata?.identityEvidenceSource).toBe('verified_site_local_shelly_rpc');
      expect(installation?.device.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'switch', actions: expect.arrayContaining(['turn_on', 'turn_off']) }),
        expect.objectContaining({ kind: 'power', actions: ['read'] }),
      ]));
      expect(installation?.observationAuthority?.bindings[0]).toMatchObject({
        sourceId: 'shelly-mqtt', selector: topic,
        fields: { power: { rawKey: 'power', type: 'number' } },
      });
    }

    const wrongTopic = await router.route({ topic: 'shelly/other/events/rpc', payload, payloadText: JSON.stringify(payload) });
    expect(wrongTopic?.observationAdmissions?.every(item => item.outcome === 'rejected' &&
      item.reasonCode === 'observation_authority_missing')).toBe(true);
    const wrongIdentity = await runtime.ingestShellyMqttObservation({
      topic, physicalId: 'shellyplus1-unverified', componentKey: 'switch:0', values: { power: 0 }, evidenceId: randomUUID(),
    });
    expect(wrongIdentity).toMatchObject({ outcome: 'rejected', reasonCode: 'shelly_lan_verified_enrollment_missing' });
    expect(await registry.getShellyObservationApproval(tenantId, 'site-device-lab', `${physicalId}:switch:0`)).toBeNull();
    const unapprovedEnergy = await runtime.ingestShellyMqttObservation({
      topic, physicalId, componentKey: 'switch:0', values: { energy_import_total: 0 }, evidenceId: randomUUID(),
    });
    expect(unapprovedEnergy).toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
    const stillPowerOnly = await genericRepository.read({
      tenantId, siteId, deviceId: `${physicalId}:switch:0`, componentId: 'device', channel: 'energy_import_total',
      metric: 'energy_import_total', from: historyFrom, to: historyTo,
    });
    expect(stillPowerOnly).toHaveLength(0);
  });
});
