import { randomUUID } from 'node:crypto';
import { createVerifiedEnrollmentTestPool } from '../devices/enrollment/postgres-integration-test-database';
import { DeviceIntelligenceQueryService } from '../devices/device-intelligence-query.service';
import { ENERGRID_HTTP_OBSERVATION_SOURCE, ENERGRID_HTTP_STATUS_SELECTOR } from '../devices/adapters/inbound/energrid/energrid-http-observation.adapter';
import { PostgresGenericMeasurementRepository } from '../telemetry/generic-measurements/postgres-generic-measurement.repository';
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service';

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

describe('portal device measurement history PostgreSQL integration', () => {
  testWithDatabase('returns only enrolled-scope rows in the requested time window and limit', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    const tenantId = `portal-history-${randomUUID()}`;
    const siteId = 'site-home';
    const deviceId = `device:history:esp8266:${randomUUID().replaceAll('-', '').slice(0, 6)}`;
    const repository = new PostgresGenericMeasurementRepository(pool);
    const device = {
      id: deviceId, tenantId, siteId, kind: 'physical', trustStatus: 'approved',
      displayName: 'Kitchen sensor', zoneName: 'Kitchen', assistantEnabled: true,
      capabilities: [], supportedCapabilities: [],
      metadata: { physicalId: deviceId },
      adapter: { id: 'energrid-esp-http', protocol: 'http', driver: 'energrid-esp-http', configured: true },
      state: { values: {}, observedAt: null, source: 'test', status: 'unknown' },
      policy: { confirmationRequiredFor: [], requiresApproval: true },
    };
    const humiditySource = 'approved-humidity-source';
    const installation = {
      schemaVersion: 1,
      device,
      physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null },
      observationAuthority: {
        bindings: [
          {
            deviceId,
            sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
            selector: ENERGRID_HTTP_STATUS_SELECTOR,
            fields: { temperature: { rawKey: 'temperatureC', type: 'number' as const } },
          },
          {
            deviceId,
            sourceId: humiditySource,
            selector: 'humidity-status-v1',
            fields: { humidity: { rawKey: 'humidityPct', type: 'number' as const } },
          },
        ],
        policy: {
          deviceId,
          allowedSourcesByField: {
            temperature: [ENERGRID_HTTP_OBSERVATION_SOURCE],
            humidity: [humiditySource],
          },
        },
      },
    };
    const registry = { ensureInstallationsLoaded: jest.fn(), getDevices: jest.fn(() => [device]) };
    const installations = { get: jest.fn().mockResolvedValue(installation), list: jest.fn().mockResolvedValue([installation]) };
    const enrollment = { find: jest.fn().mockResolvedValue({ tenantId, siteId, deviceId, status: 'enrolled' }) };
    const intelligence = new DeviceIntelligenceQueryService(
      registry as never, installations as never, enrollment as never,
      { read: jest.fn().mockResolvedValue(null) } as never, repository,
    );
    const end = new Date(Date.now() - 10_000);
    const from = new Date(end.getTime() - 60 * 60_000);
    const to = end;
    const service = new PortalDeviceMeasurementsService(intelligence as never, repository);
    try {
      await pool.query(
        `INSERT INTO device_inventory.enrollments
         (tenant_id,site_id,device_id,display_name,status,enrolled_at,updated_at,version)
         VALUES ($1,$2,$3,'Kitchen sensor','enrolled',now(),now(),1)`,
        [tenantId, siteId, deviceId],
      );
      for (const [index, offsetMs] of [-50 * 60_000, -20 * 60_000, -1_000].entries()) {
        const observedAt = new Date(end.getTime() + offsetMs).toISOString();
        await repository.append({
          tenantId, siteId, deviceId, physicalDeviceId: null, componentId: 'device',
          channel: 'temperature', metric: 'temperature', unit: 'Cel', value: 19 + index,
          quality: 'measured', source: ENERGRID_HTTP_OBSERVATION_SOURCE,
          provenance: `approved:${ENERGRID_HTTP_OBSERVATION_SOURCE}`,
          sampleId: `sample-${index}`, observedAt, receivedAt: observedAt,
        });
      }

      for (const [sampleId, offsetMs] of [['revoked-old', -55 * 60_000], ['revoked-new', 5_000]] as const) {
        const observedAt = new Date(end.getTime() + offsetMs).toISOString();
        await repository.append({
          tenantId, siteId, deviceId, physicalDeviceId: null, componentId: 'device',
          channel: 'temperature', metric: 'temperature', unit: 'Cel', value: 99,
          quality: 'measured', source: 'revoked-http-source', provenance: 'historical-source',
          sampleId, observedAt, receivedAt: observedAt,
        });
      }

      for (const [sampleId, source, value, offsetMs] of [
        ['humidity-approved', humiditySource, 48, -30 * 60_000],
        ['humidity-from-temperature-source', ENERGRID_HTTP_OBSERVATION_SOURCE, 99, -25 * 60_000],
      ] as const) {
        const observedAt = new Date(end.getTime() + offsetMs).toISOString();
        await repository.append({
          tenantId, siteId, deviceId, physicalDeviceId: null, componentId: 'device',
          channel: 'humidity', metric: 'humidity', unit: '%RH', value,
          quality: 'measured', source, provenance: `historical:${source}`,
          sampleId, observedAt, receivedAt: observedAt,
        });
      }

      const readModel = await service.readModel({ tenantId, siteId }, deviceId);
      const temperatureSummary = readModel.history.streams.find(stream => stream.metric === 'temperature');
      const humiditySummary = readModel.history.streams.find(stream => stream.metric === 'humidity');
      expect(temperatureSummary).toMatchObject({
        status: 'available', count: 3,
        oldest: new Date(end.getTime() - 50 * 60_000).toISOString(),
        newest: new Date(end.getTime() - 1_000).toISOString(),
      });
      expect(humiditySummary).toMatchObject({
        status: 'available', count: 1,
        oldest: new Date(end.getTime() - 30 * 60_000).toISOString(),
        newest: new Date(end.getTime() - 30 * 60_000).toISOString(),
      });

      const result = await service.history(
        { tenantId, siteId }, deviceId, 'temperature', from.toISOString(), to.toISOString(), 1,
      );
      expect(result).toMatchObject({ metric: 'temperature', unit: 'Cel', measurements: [
        { value: 19, unit: 'Cel' },
      ] });
      expect(result.measurements).toHaveLength(1);
      expect(Date.parse(result.measurements[0].observedAt)).toBeGreaterThanOrEqual(from.getTime());
      expect(Date.parse(result.measurements[0].observedAt)).toBeLessThan(to.getTime());

      const authorizedHistory = await service.history(
        { tenantId, siteId }, deviceId, 'temperature', from.toISOString(), to.toISOString(), 10,
      );
      expect(authorizedHistory.measurements).toHaveLength(3);
      expect(authorizedHistory.measurements.at(-1)?.observedAt).toBe(temperatureSummary?.newest);
      expect(authorizedHistory.measurements[0].observedAt).toBe(temperatureSummary?.oldest);
      expect(authorizedHistory.measurements.map(sample => sample.value)).not.toContain(99);

      const authorizedHumidity = await service.history(
        { tenantId, siteId }, deviceId, 'humidity', from.toISOString(), to.toISOString(), 10,
      );
      expect(authorizedHumidity.measurements).toHaveLength(1);
      expect(authorizedHumidity.measurements[0]).toMatchObject({ value: 48, unit: '%RH' });
      expect(authorizedHumidity.measurements[0].observedAt).toBe(humiditySummary?.newest);

      await expect(service.readModel({ tenantId: `${tenantId}-other`, siteId }, deviceId))
        .rejects.toMatchObject({ status: 404 });
      await expect(service.readModel({ tenantId, siteId: 'site-other' }, deviceId))
        .rejects.toMatchObject({ status: 404 });
      await expect(service.readModel({ tenantId, siteId }, `${deviceId}-other`))
        .rejects.toMatchObject({ status: 404 });

      await expect(service.history(
        { tenantId: `${tenantId}-other`, siteId }, deviceId, 'temperature', from.toISOString(), to.toISOString(), 10,
      )).rejects.toMatchObject({ status: 404 });
      await expect(service.history(
        { tenantId, siteId: 'site-other' }, deviceId, 'temperature', from.toISOString(), to.toISOString(), 10,
      )).rejects.toMatchObject({ status: 404 });
    } finally {
      await pool.query('DELETE FROM telemetry.measurements WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]).catch(() => undefined);
      await pool.query('DELETE FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]).catch(() => undefined);
      await pool.end();
    }
  }, 30000);
});
