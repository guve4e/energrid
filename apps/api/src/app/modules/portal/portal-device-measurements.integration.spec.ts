import { randomUUID } from 'node:crypto';
import { createVerifiedEnrollmentTestPool } from '../devices/enrollment/postgres-integration-test-database';
import { PostgresGenericMeasurementRepository } from '../telemetry/generic-measurements/postgres-generic-measurement.repository';
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service';

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

describe('portal device measurement history PostgreSQL integration', () => {
  testWithDatabase('returns only enrolled-scope rows in the requested time window and limit', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    const tenantId = `portal-history-${randomUUID()}`;
    const siteId = 'site-home';
    const deviceId = `device:${randomUUID()}`;
    const repository = new PostgresGenericMeasurementRepository(pool);
    const end = new Date(Date.now() - 10_000);
    const from = new Date(end.getTime() - 60 * 60_000);
    const to = end;
    const current = {
      deviceId,
      fields: { temperature: { value: 20, sourceId: 'energrid-http-status', receivedAt: end.toISOString(), ageSeconds: 1, freshness: 'fresh', authority: 'approved' } },
    };
    const intelligence = {
      describeDevice: jest.fn(async (scope: { tenantId: string; siteId: string }, id: string) =>
        scope.tenantId === tenantId && scope.siteId === siteId && id === deviceId ? { deviceId, displayName: 'Kitchen sensor' } : null),
      readObservations: jest.fn(async () => current),
    };
    const service = new PortalDeviceMeasurementsService(intelligence as never, repository);
    try {
      await pool.query(
        `INSERT INTO device_inventory.enrollments
         (tenant_id,site_id,device_id,display_name,status,enrolled_at,updated_at,version)
         VALUES ($1,$2,$3,'Kitchen sensor','enrolled',now(),now(),1)`,
        [tenantId, siteId, deviceId],
      );
      for (const [index, offsetMs] of [-50 * 60_000, -20 * 60_000, 0].entries()) {
        const observedAt = new Date(end.getTime() + offsetMs).toISOString();
        await repository.append({
          tenantId, siteId, deviceId, physicalDeviceId: null, componentId: 'device',
          channel: 'temperature', metric: 'temperature', unit: 'Cel', value: 19 + index,
          quality: 'measured', source: 'energrid-http-status', provenance: 'approved:energrid-http-status',
          sampleId: `sample-${index}`, observedAt, receivedAt: observedAt,
        });
      }

      const result = await service.history(
        { tenantId, siteId }, deviceId, 'temperature', from.toISOString(), to.toISOString(), 1,
      );
      expect(result).toMatchObject({ metric: 'temperature', unit: 'Cel', measurements: [
        { value: 19, unit: 'Cel' },
      ] });
      expect(result.measurements).toHaveLength(1);
      expect(Date.parse(result.measurements[0].observedAt)).toBeGreaterThanOrEqual(from.getTime());
      expect(Date.parse(result.measurements[0].observedAt)).toBeLessThan(to.getTime());

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
