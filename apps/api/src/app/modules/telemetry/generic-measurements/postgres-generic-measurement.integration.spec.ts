import { randomUUID } from 'node:crypto';
import { createVerifiedEnrollmentTestPool } from '../../devices/enrollment/postgres-integration-test-database';
import { ConflictingMeasurementSampleError, PostgresGenericMeasurementRepository } from './postgres-generic-measurement.repository';
import type { GenericMeasurementInput } from '@energrid/domain-telemetry';

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

function sample(patch: Partial<GenericMeasurementInput> = {}): GenericMeasurementInput {
  return {
    tenantId: 'm1-measurement-test',
    siteId: 'site-a',
    deviceId: 'device-stable-001',
    physicalDeviceId: 'physical-stable-001',
    componentId: 'dht22',
    channel: 'environment',
    metric: 'temperature',
    unit: 'Cel',
    value: 21.5,
    quality: 'measured',
    source: 'trusted-http-status-adapter',
    provenance: 'approved-binding-dht22-status',
    sampleId: 'sample-001',
    observedAt: '2026-10-23T12:00:00.000Z',
    receivedAt: '2026-10-23T12:00:01.000Z',
    ...patch,
  };
}

describe('PostgreSQL generic measurement history integration', () => {
  testWithDatabase('stores canonical metrics, isolates scope, deduplicates, detects conflicts, and survives reconnect', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    const tenantId = `measurement-${randomUUID()}`;
    const siteId = 'site-a';
    const repository = new PostgresGenericMeasurementRepository(pool);
    const at = '2026-10-23T12:00:00.000Z';
    const inputs = [
      sample({ tenantId, siteId, metric: 'temperature', unit: 'Cel', value: 21.5, sampleId: 'temp-1', observedAt: at }),
      sample({ tenantId, siteId, metric: 'humidity', unit: '%RH', value: 48, sampleId: 'humidity-1', observedAt: at }),
      sample({ tenantId, siteId, metric: 'pressure', unit: 'hPa', value: 1013.2, sampleId: 'pressure-1', observedAt: at }),
      sample({ tenantId, siteId, metric: 'power', unit: 'W', value: 120, componentId: 'meter', channel: 'main', sampleId: 'power-1', observedAt: at }),
    ];
    let restartPool: Awaited<ReturnType<typeof createVerifiedEnrollmentTestPool>> | undefined;
    try {
      await pool.query(
        `INSERT INTO device_inventory.enrollments
         (tenant_id,site_id,device_id,display_name,status,enrolled_at,updated_at,version)
         VALUES ($1,$2,$3,'Test device','enrolled',$4,$4,1)`,
        [tenantId, siteId, 'device-stable-001', '2026-10-23T12:00:00.000Z'],
      );
      await pool.query(
        `INSERT INTO device_inventory.physical_devices
         (tenant_id,site_id,physical_device_id,vendor,hardware_model,firmware_version,first_seen_at,last_seen_at)
         VALUES ($1,$2,$3,'Energrid','DHT22','0.2.0',$4,$4),
                ($1,$2,$5,'Energrid','Other sensor','0.2.0',$4,$4)`,
        [tenantId, siteId, 'physical-stable-001', '2026-10-23T12:00:00.000Z', 'physical-unassigned-002'],
      );
      await pool.query(
        `INSERT INTO device_inventory.logical_component_assignments
         (tenant_id,site_id,device_id,physical_device_id,assigned_at,assigned_by)
         VALUES ($1,$2,$3,$4,$5,'integration-test')`,
        [tenantId, siteId, 'device-stable-001', 'physical-stable-001', '2026-10-23T12:00:00.000Z'],
      );
      const constraints = await pool.query(
        `SELECT referenced.relname AS referenced_table
         FROM pg_constraint constraint_row
         JOIN pg_class source ON source.oid=constraint_row.conrelid
         JOIN pg_namespace source_schema ON source_schema.oid=source.relnamespace
         LEFT JOIN pg_class referenced ON referenced.oid=constraint_row.confrelid
         WHERE source_schema.nspname='telemetry' AND source.relname='measurements'
           AND constraint_row.contype='f'`,
      );
      expect(constraints.rows.map(row => row.referenced_table).sort()).toEqual([
        'enrollments', 'logical_component_assignments',
      ]);
      const indexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname='telemetry' AND tablename='measurements'`,
      );
      expect(indexes.rows.map(row => row.indexname)).toEqual(expect.arrayContaining([
        'measurements_pkey', 'telemetry_measurements_history',
      ]));
      for (const input of inputs) expect(await repository.append(input)).toBe('stored');
      expect(await repository.append({ ...inputs[0], receivedAt: '2026-10-23T12:00:02.000Z' })).toBe('duplicate');
      await expect(repository.append({ ...inputs[0], value: 22 }))
        .rejects.toBeInstanceOf(ConflictingMeasurementSampleError);
      await expect(repository.append({ ...inputs[0], physicalDeviceId: 'physical-unassigned-002', sampleId: 'wrong-physical-association' }))
        .rejects.toMatchObject({ code: '23503' });

      const historyPolicy = { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 };
      const historyBase = {
        ...inputs[0], componentId: 'history-policy', channel: 'ambient',
        sampleId: 'history-initial', receivedAt: at,
      };
      expect(await repository.appendIfDue(historyBase, historyPolicy))
        .toEqual({ outcome: 'stored', reason: 'initial' });
      expect(await repository.appendIfDue({
        ...historyBase, sampleId: 'history-unchanged', value: 21.6,
        observedAt: '2026-10-23T12:00:02.000Z', receivedAt: '2026-10-23T12:00:02.000Z',
      }, historyPolicy)).toEqual({ outcome: 'skipped', reason: 'below_threshold' });
      const changed = {
        ...historyBase, sampleId: 'history-change', value: 21.8,
        observedAt: '2026-10-23T12:00:03.000Z', receivedAt: '2026-10-23T12:00:03.000Z',
      };
      expect(await repository.appendIfDue(changed, historyPolicy))
        .toEqual({ outcome: 'stored', reason: 'meaningful_change' });
      const heartbeat = {
        ...changed, sampleId: 'history-heartbeat',
        observedAt: '2026-10-23T12:15:03.000Z', receivedAt: '2026-10-23T12:15:03.000Z',
      };
      expect(await repository.appendIfDue(heartbeat, historyPolicy))
        .toEqual({ outcome: 'stored', reason: 'heartbeat' });
      expect(await repository.appendIfDue(heartbeat, historyPolicy))
        .toEqual({ outcome: 'duplicate' });

      expect(await repository.read({
        tenantId, siteId, deviceId: 'device-stable-001', componentId: 'dht22',
        channel: 'environment', metric: 'temperature', from: '2026-10-23T11:59:00.000Z',
        to: '2026-10-23T12:01:00.000Z',
      })).toHaveLength(1);
      expect(await repository.read({
        tenantId: `${tenantId}-other`, siteId, deviceId: 'device-stable-001',
        componentId: 'dht22', channel: 'environment', metric: 'temperature',
        from: '2026-10-23T11:59:00.000Z', to: '2026-10-23T12:01:00.000Z',
      })).toEqual([]);
      expect(await repository.read({
        tenantId, siteId: 'site-other', deviceId: 'device-stable-001',
        componentId: 'dht22', channel: 'environment', metric: 'temperature',
        from: '2026-10-23T11:59:00.000Z', to: '2026-10-23T12:01:00.000Z',
      })).toEqual([]);

      await pool.end();
      restartPool = await createVerifiedEnrollmentTestPool({ max: 1, connectionTimeoutMillis: 1000 });
      const restartedRepository = new PostgresGenericMeasurementRepository(restartPool);
      expect(await restartedRepository.appendIfDue(heartbeat, historyPolicy))
        .toEqual({ outcome: 'duplicate' });
      expect(await restartedRepository.append({ ...inputs[0], receivedAt: '2026-10-23T12:00:03.000Z' })).toBe('duplicate');
      await expect(restartedRepository.append({ ...inputs[0], value: 22 }))
        .rejects.toBeInstanceOf(ConflictingMeasurementSampleError);
      const recovered = await restartedRepository.read({
        tenantId, siteId, deviceId: 'device-stable-001', componentId: 'dht22',
        channel: 'environment', metric: 'humidity', from: '2026-10-23T11:59:00.000Z',
        to: '2026-10-23T12:01:00.000Z',
      });
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ metric: 'humidity', unit: '%RH', value: 48, physicalDeviceId: 'physical-stable-001' });
    } finally {
      const cleanupPool = restartPool ?? pool;
      await cleanupPool.query('DELETE FROM telemetry.measurements WHERE tenant_id=$1', [tenantId]).catch(() => undefined);
      await cleanupPool.query('DELETE FROM device_inventory.logical_component_assignments WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]).catch(() => undefined);
      await cleanupPool.query('DELETE FROM device_inventory.physical_devices WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]).catch(() => undefined);
      await cleanupPool.query('DELETE FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]).catch(() => undefined);
      await cleanupPool.end().catch(() => undefined);
    }
  }, 30000);
});
