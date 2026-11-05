import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicLevel } from 'classic-level';
import { createVerifiedEnrollmentTestPool } from '../devices/enrollment/postgres-integration-test-database';
import { DeviceIntelligenceObservationIngress } from '../devices/device-intelligence-observation-ingress';
import { DeviceIntelligenceQueryService } from '../devices/device-intelligence-query.service';
import { DeviceObservationStateStore } from '../devices/device-observation-state.store';
import type { DeviceInstallationRecord } from '../devices/device-installation.store';
import { shellyHttpEm1Approval } from '../devices/integrations/shelly/shelly-http-em1-observation-approval';
import { PostgresGenericMeasurementRepository } from '../telemetry/generic-measurements/postgres-generic-measurement.repository';
import { GenericMeasurementHistoryOutbox } from '../telemetry/generic-measurements/generic-measurement-history-outbox';
import { GenericMeasurementHistoryWriter } from '../telemetry/generic-measurements/generic-measurement-history-writer';
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service';
import { PortalDeviceElectricalMeasurementsService } from './portal-device-electrical-measurements.service';

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

describe('Portal electrical history over canonical generic measurement storage', () => {
  testWithDatabase('accepts an authorized EM50 HTTP power observation and returns its durable history', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    const tenantId = `portal-em50-${randomUUID()}`;
    const siteId = 'site-home';
    const deviceId = 'shellyproem50-8c4f00dbd258:em1:0';
    const sourceId = 'shelly-http-em1';
    const selector = 'EM1.GetStatus?id=0';
    const device = {
      id: deviceId, tenantId, siteId, kind: 'physical', trustStatus: 'approved',
      displayName: 'EM50 channel 0', zoneName: 'Panel', assistantEnabled: true,
      capabilities: [{ kind: 'power', actions: ['read'] }],
      supportedCapabilities: [{ kind: 'power', actions: ['read'] }],
      metadata: { physicalId: 'shellyproem50-8c4f00dbd258', component: 'em1:0' },
      adapter: { id: 'shelly-lan', protocol: 'http', driver: 'shelly-lan', configured: true },
      state: { values: {}, observedAt: null, source: 'test', status: 'unknown' },
      policy: { confirmationRequiredFor: [], requiresApproval: true },
    };
    const installation = {
      schemaVersion: 1,
      device,
      physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
      observationAuthority: {
        bindings: [{ deviceId, sourceId, selector, fields: { power: { rawKey: 'power', type: 'number' } } }],
        policy: { deviceId, allowedSourcesByField: { power: [sourceId] } },
      },
    } as unknown as DeviceInstallationRecord;
    const registry = {
      ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getDevices: jest.fn().mockReturnValue([device]),
      getSnapshot: () => ({ tenant: { id: tenantId }, site: { id: siteId } }),
    };
    const installations = { get: jest.fn().mockResolvedValue(installation) };
    const enrollment = { find: jest.fn().mockResolvedValue({ tenantId, siteId, deviceId, status: 'enrolled' }) };
    const directory = await mkdtemp(join(tmpdir(), 'energrid-em50-history-'));
    const repository = new PostgresGenericMeasurementRepository(pool);
    const queryService = new DeviceIntelligenceQueryService(
      registry as never, installations as never, enrollment as never,
      { read: jest.fn().mockResolvedValue(null) } as never, repository,
    );
    const outbox = new GenericMeasurementHistoryOutbox(
      { historyOutboxDirectory: join(directory, 'history-outbox'), maxPendingWrites: 1000 } as never,
      path => new ClassicLevel<string, unknown>(path, { valueEncoding: 'json' }),
    );
    const writer = new GenericMeasurementHistoryWriter(repository, true, {
      power: { meaningfulChange: 5, maxHeartbeatMs: 300_000 },
    }, outbox);
    const stateStore = new DeviceObservationStateStore(join(directory, 'observation-state'));
    const ingress = new DeviceIntelligenceObservationIngress(
      registry as never, installations as never, enrollment as never, stateStore, writer,
    );
    const electricalHistory = new PortalDeviceElectricalMeasurementsService(
      registry as never,
      new PortalDeviceMeasurementsService(queryService as never, repository),
    );
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 5_000).toISOString();

    try {
      await pool.query(
        `INSERT INTO device_inventory.enrollments
         (tenant_id,site_id,device_id,display_name,status,enrolled_at,updated_at,version)
         VALUES ($1,$2,$3,'EM50 channel 0','enrolled',now(),now(),1)`,
        [tenantId, siteId, deviceId],
      );
      await writer.onModuleInit();
      const input = { scope: { tenantId, siteId }, deviceId, sourceId, selector,
        payload: { power: 1342.6 }, evidenceId: `em50-${randomUUID()}` };
      const accepted = await ingress.ingest(input);
      expect(accepted).toMatchObject({ outcome: 'processed', accepted: true, updatedKeys: ['power'],
        historyWrites: [{ field: 'power', outcome: 'stored', reason: 'initial' }] });

      await expect(electricalHistory.history(deviceId, 'power', from, to)).resolves.toMatchObject({
        deviceId, metric: 'power', unit: 'W', measurements: [
          { value: 1342.6, unit: 'W' },
        ],
      });
      expect(await repository.latest({ tenantId, siteId, deviceId, componentId: 'device', channel: 'power', metric: 'power', sources: [sourceId] }))
        .toMatchObject({ value: 1342.6, source: sourceId });

      const duplicate = await ingress.ingest(input);
      expect(duplicate).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence',
        historyWrites: [{ field: 'power', outcome: 'duplicate' }] });
      const stored = await repository.read({ tenantId, siteId, deviceId, componentId: 'device',
        channel: 'power', metric: 'power', from, to, limit: 10 });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ value: 1342.6, unit: 'W', source: sourceId, provenance: `approved:${sourceId}`, quality: 'measured' });
    } finally {
      await writer.onModuleDestroy().catch(() => undefined);
      await stateStore.close().catch(() => undefined);
      await pool.query('DELETE FROM telemetry.measurements WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]).catch(() => undefined);
      await pool.query('DELETE FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3', [tenantId, siteId, deviceId]).catch(() => undefined);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
