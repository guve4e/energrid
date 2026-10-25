import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClassicLevel } from 'classic-level';
import { createVerifiedEnrollmentTestPool } from '../../devices/enrollment/postgres-integration-test-database';
import { DeviceIntelligenceObservationIngress } from '../../devices/device-intelligence-observation-ingress';
import { DeviceObservationStateStore } from '../../devices/device-observation-state.store';
import type { DeviceInstallationRecord } from '../../devices/device-installation.store';
import { energridHttpObservationApproval } from '../../devices/adapters/inbound/energrid/energrid-http-observation-approval';
import { ENERGRID_HTTP_OBSERVATION_SOURCE, ENERGRID_HTTP_STATUS_SELECTOR } from '../../devices/adapters/inbound/energrid/energrid-http-observation.adapter';
import { GenericMeasurementHistoryWriter } from './generic-measurement-history-writer';
import { PostgresGenericMeasurementRepository } from './postgres-generic-measurement.repository';
import { GenericMeasurementHistoryOutbox } from './generic-measurement-history-outbox';

function historyOutbox(directory: string) {
  return new GenericMeasurementHistoryOutbox(
    { historyOutboxDirectory: directory, maxPendingWrites: 1000 } as never,
    path => new ClassicLevel<string, unknown>(path, { valueEncoding: 'json' }),
  );
}

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

describe('accepted observation to PostgreSQL history integration', () => {
  testWithDatabase('persists approved HTTP measurements by policy across duplicates, reboot and API restart', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    let cleanupPool = pool;
    const tenantId = `history-${randomUUID()}`;
    const siteId = 'site-home';
    const deviceId = 'device:upstream-lan:esp8266:324864';
    const concurrentDeviceId = 'device:concurrent-lan:esp8266:324865';
    const directory = await mkdtemp(join(tmpdir(), 'energrid-history-state-'));
    const repository = new PostgresGenericMeasurementRepository(pool);
    let failReferenceSyncOnce = true;
    const retryableRepository = {
      ensureEnrollmentReference: jest.fn(async (identity: { tenantId: string; siteId: string; deviceId: string }) => {
        if (failReferenceSyncOnce) {
          failReferenceSyncOnce = false;
          throw Object.assign(new Error('temporary isolated history database outage'), { code: '08006' });
        }
        return repository.ensureEnrollmentReference(identity);
      }),
      appendIfDue: repository.appendIfDue.bind(repository),
    };
    let writer = new GenericMeasurementHistoryWriter(retryableRepository, true, {
      temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 },
      humidity: { meaningfulChange: 2, maxHeartbeatMs: 900_000 },
    }, historyOutbox(join(directory, 'history-outbox')));
    const device = { id: deviceId, tenantId, siteId, kind: 'physical', trustStatus: 'approved' };
    let installation = {
      schemaVersion: 1, device, observationAuthority: energridHttpObservationApproval(deviceId),
    } as unknown as DeviceInstallationRecord;
    const registry = { ensureInstallationsLoaded: jest.fn(), getDevices: jest.fn().mockReturnValue([device]) };
    const installations = { get: jest.fn().mockImplementation(async () => installation) };
    const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
    let store = new DeviceObservationStateStore(directory);
    let ingress = new DeviceIntelligenceObservationIngress(registry as never, installations as never,
      enrollment as never, store, writer);
    const inputFor = async (
      counters: { uptimeMs: number; sampleCount: number; lastSampleUptimeMs: number },
      apiUptimeMs: number,
      temperatureC: number,
      humidityPct: number,
    ) => ({
      scope: { tenantId, siteId }, deviceId,
      sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
      selector: ENERGRID_HTTP_STATUS_SELECTOR,
      payload: { temperatureC, humidityPct },
      evidenceId: await store.sourceSampleEvidenceId(
        { tenantId, siteId }, deviceId, ENERGRID_HTTP_OBSERVATION_SOURCE,
        { ...counters, apiUptimeMs },
      ),
    });

    try {
      const first = await inputFor({ uptimeMs: 12_000, sampleCount: 6, lastSampleUptimeMs: 10_000 }, 42_000, 22.5, 48);
      const firstAttempt = await ingress.ingest(first);
      expect(firstAttempt).toMatchObject({ outcome: 'processed', accepted: true, historyWrites: [
        { field: 'temperature', outcome: 'pending' },
        { field: 'humidity', outcome: 'pending' },
      ] });

      // The durable LevelDB decision retries the same history sample after reference sync recovers.
      await writer.onModuleDestroy();
      const recoveredRepository = new PostgresGenericMeasurementRepository(pool);
      writer = new GenericMeasurementHistoryWriter(recoveredRepository, true, {
        temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 },
        humidity: { meaningfulChange: 2, maxHeartbeatMs: 900_000 },
      }, historyOutbox(join(directory, 'history-outbox')));
      await writer.onModuleInit();
      const firstResult = await ingress.ingest(first);
      expect(firstResult).toMatchObject({ historyWrites: [
        { field: 'temperature', outcome: 'duplicate' },
        { field: 'humidity', outcome: 'duplicate' },
      ] });
      const initialReference = await pool.query(
        `SELECT tenant_id,site_id,device_id,display_name FROM device_inventory.enrollments
         WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3`, [tenantId, siteId, deviceId],
      );
      expect(initialReference.rows).toHaveLength(1);
      expect(initialReference.rows[0]).toMatchObject({
        tenant_id: tenantId, site_id: siteId, device_id: deviceId,
        display_name: 'History enrollment reference',
      });

      // The unique key arbitrates concurrent reference creation without a check-then-insert race.
      const concurrentIdentity = { tenantId, siteId, deviceId: concurrentDeviceId };
      await Promise.all(Array.from({ length: 12 }, () => repository.ensureEnrollmentReference(concurrentIdentity)));
      const concurrentReference = await pool.query(
        `SELECT count(*)::int AS count FROM device_inventory.enrollments
         WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3`, [tenantId, siteId, concurrentDeviceId],
      );
      expect(concurrentReference.rows[0].count).toBe(1);

      const unchanged = await inputFor({ uptimeMs: 14_000, sampleCount: 7, lastSampleUptimeMs: 12_000 }, 44_000, 22.6, 49);
      const unchangedResult = await ingress.ingest(unchanged);
      expect(unchangedResult).toMatchObject({ outcome: 'processed', accepted: true, historyWrites: [
        { field: 'temperature', outcome: 'skipped', reason: 'below_threshold' },
        { field: 'humidity', outcome: 'skipped', reason: 'below_threshold' },
      ] });

      const changed = await inputFor({ uptimeMs: 16_000, sampleCount: 8, lastSampleUptimeMs: 14_000 }, 46_000, 22.9, 49);
      const changedResult = await ingress.ingest(changed);
      expect(changedResult).toMatchObject({ outcome: 'processed', accepted: true, historyWrites: [
        { field: 'temperature', outcome: 'stored', reason: 'meaningful_change' },
        { field: 'humidity', outcome: 'skipped', reason: 'below_threshold' },
      ] });
      const replay = await ingress.ingest(changed);
      expect(replay).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence', historyWrites: [
        { field: 'temperature', outcome: 'duplicate' },
        { field: 'humidity', outcome: 'skipped', reason: 'below_threshold' },
      ] });

      let temperatureHistory = await repository.read({
        tenantId, siteId, deviceId, componentId: 'device', channel: 'temperature', metric: 'temperature',
        from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z',
      });
      expect(temperatureHistory.map(row => row.value)).toEqual([22.5, 22.9]);
      expect(await repository.read({
        tenantId: `${tenantId}-other`, siteId, deviceId, componentId: 'device', channel: 'temperature', metric: 'temperature',
        from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z',
      })).toEqual([]);
      expect(await repository.read({
        tenantId, siteId: 'site-other', deviceId, componentId: 'device', channel: 'temperature', metric: 'temperature',
        from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z',
      })).toEqual([]);

      const reboot = await inputFor({ uptimeMs: 1_000, sampleCount: 1, lastSampleUptimeMs: 0 }, 48_000, 22.9, 49);
      expect(reboot.evidenceId).not.toBe(changed.evidenceId);
      expect(await ingress.ingest(reboot)).toMatchObject({ outcome: 'processed', accepted: true });
      await store.close();
      await pool.end();

      const restartPool = await createVerifiedEnrollmentTestPool({ max: 1, connectionTimeoutMillis: 1000 });
      cleanupPool = restartPool;
      const restartRepository = new PostgresGenericMeasurementRepository(restartPool);
      store = new DeviceObservationStateStore(directory);
      ingress = new DeviceIntelligenceObservationIngress(registry as never, installations as never,
        enrollment as never, store, new GenericMeasurementHistoryWriter(restartRepository, true, {
          temperature: { meaningfulChange: 0.3, maxHeartbeatMs: 900_000 },
          humidity: { meaningfulChange: 2, maxHeartbeatMs: 900_000 },
        }, historyOutbox(join(directory, 'history-outbox'))));
      expect(await ingress.ingest(reboot)).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence' });
      expect((await store.getState({ tenantId, siteId }, deviceId))?.fields.temperature.value).toBe(22.9);

      installation = { ...installation, observationAuthority: undefined };
      const unauthorized = await inputFor({ uptimeMs: 3_000, sampleCount: 2, lastSampleUptimeMs: 2_000 }, 50_000, 24, 51);
      await expect(ingress.ingest(unauthorized)).resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
      expect(await restartRepository.read({
        tenantId, siteId, deviceId, componentId: 'device', channel: 'temperature', metric: 'temperature',
        from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z',
      })).toHaveLength(2);
      temperatureHistory = await restartRepository.read({
        tenantId, siteId, deviceId, componentId: 'device', channel: 'humidity', metric: 'humidity',
        from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z',
      });
      expect(temperatureHistory).toHaveLength(1);
      await restartPool.end();
    } finally {
      await store.close().catch(() => undefined);
      await cleanupPool.query('DELETE FROM telemetry.measurements WHERE tenant_id=$1', [tenantId]).catch(() => undefined);
      await cleanupPool.query('DELETE FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]).catch(() => undefined);
      await cleanupPool.end().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
