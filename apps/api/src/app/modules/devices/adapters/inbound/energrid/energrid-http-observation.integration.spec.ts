import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceIntelligenceObservationIngress } from '../../../device-intelligence-observation-ingress';
import { DeviceObservationStateStore } from '../../../device-observation-state.store';
import type { DeviceInstallationRecord } from '../../../device-installation.store';
import { energridHttpObservationApproval } from './energrid-http-observation-approval';
import { ENERGRID_HTTP_OBSERVATION_SOURCE, ENERGRID_HTTP_STATUS_SELECTOR } from './energrid-http-observation.adapter';

const scope = { tenantId: 'tenant-a', siteId: 'site-a' };
const deviceId = 'device:upstream-lan:esp8266:324864';

function harness(directory: string, history = { persistAccepted: jest.fn().mockResolvedValue([]) }) {
  const device = { id: deviceId, tenantId: scope.tenantId, siteId: scope.siteId, kind: 'physical', trustStatus: 'approved' };
  const registry = { ensureInstallationsLoaded: jest.fn(), getDevices: jest.fn().mockReturnValue([device]) };
  const installation = {
    schemaVersion: 1, device, observationAuthority: energridHttpObservationApproval(deviceId),
  } as unknown as DeviceInstallationRecord;
  const installations = { get: jest.fn().mockResolvedValue(installation) };
  const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
  const store = new DeviceObservationStateStore(directory);
  const ingress = new DeviceIntelligenceObservationIngress(
    registry as never, installations as never, enrollment as never, store, history as never,
  );
  return { ingress, registry, installations, enrollment, store, history };
}

async function sourceInput(store: DeviceObservationStateStore, counters = { uptimeMs: 12_000, sampleCount: 6, lastSampleUptimeMs: 10_000 }, values: Record<string, unknown> = { temperatureC: 22.5, humidityPct: 48 }) {
  const evidenceId = await store.sourceSampleEvidenceId(scope, deviceId, ENERGRID_HTTP_OBSERVATION_SOURCE, { ...counters, apiUptimeMs: 42_000 });
  return {
    scope, deviceId, sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
    selector: ENERGRID_HTTP_STATUS_SELECTOR, payload: values, evidenceId,
  };
}

describe('Energrid HTTP trusted observation ingestion', () => {
  let directory: string;
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-http-observation-'));
    h = harness(directory);
  });
  afterEach(async () => {
    await h.store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('authorizes only temperature and humidity and deduplicates repeated source samples', async () => {
    const input = await sourceInput(h.store, undefined, { temperatureC: 22.5, humidityPct: 48, pressureHpa: 1013 });
    const first = await h.ingress.ingest(input);
    expect(first).toMatchObject({ outcome: 'processed', accepted: true, updatedKeys: ['temperature', 'humidity'] });
    expect(Object.keys(first.outcome === 'processed' ? first.state?.fields || {} : {})).toEqual(['temperature', 'humidity']);
    expect(h.history.persistAccepted).toHaveBeenCalledTimes(1);
    expect(h.history.persistAccepted.mock.calls[0][0].fields.map((field: { field: string; value: number }) => [field.field, field.value]))
      .toEqual([['temperature', 22.5], ['humidity', 48]]);

    const replay = await h.ingress.ingest(input);
    expect(replay).toMatchObject({ outcome: 'processed', accepted: false, stage: 'deduplication', reason: 'duplicate_evidence' });
    expect(h.history.persistAccepted).toHaveBeenCalledTimes(2); // Retries a previous failed history delivery using the same evidence identity.
    await expect(h.store.decisions(scope, deviceId)).resolves.toHaveLength(1);
  });

  it('rejects unapproved sources, unapproved tenant/site scope, and unapproved installations before persistence', async () => {
    const input = await sourceInput(h.store);
    await expect(h.ingress.ingest({ ...input, sourceId: 'other-http' })).resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
    await expect(h.ingress.ingest({ ...input, scope: { ...scope, tenantId: 'other' } })).resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'device_not_approved' });
    h.installations.get.mockResolvedValue({ schemaVersion: 1, device: { id: deviceId, tenantId: scope.tenantId, siteId: scope.siteId, kind: 'physical', trustStatus: 'approved' } });
    await expect(h.ingress.ingest(input)).resolves.toMatchObject({ outcome: 'rejected', reasonCode: 'observation_authority_missing' });
    expect(await h.store.getState(scope, deviceId)).toBeNull();
    expect(h.history.persistAccepted).not.toHaveBeenCalled();
  });

  it('fails closed when an approved installation binding is revoked or mismatched', async () => {
    const input = await sourceInput(h.store);
    h.installations.get.mockResolvedValue({
      ...((await h.installations.get()) as DeviceInstallationRecord),
      observationAuthority: undefined,
    });
    await expect(h.ingress.ingest(input)).resolves.toMatchObject({
      outcome: 'rejected', reasonCode: 'observation_authority_missing',
    });

    const record = (await h.installations.get()) as DeviceInstallationRecord;
    const approved = energridHttpObservationApproval(deviceId);
    approved.bindings[0].selector = '/api/v1/other';
    h.installations.get.mockResolvedValue({ ...record, observationAuthority: approved });
    await expect(h.ingress.ingest(input)).resolves.toMatchObject({
      outcome: 'rejected', reasonCode: 'observation_authority_missing',
    });
    expect(await h.store.getState(scope, deviceId)).toBeNull();
  });

  it('recovers latest authorized state and source identity across API restarts', async () => {
    const input = await sourceInput(h.store);
    await h.ingress.ingest(input);
    const history = h.history;
    await h.store.close();
    h = harness(directory, history);

    const replay = await h.ingress.ingest(await sourceInput(h.store));
    expect(replay).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence' });
    const state = await h.store.getState(scope, deviceId);
    expect(state?.fields.temperature.value).toBe(22.5);
    expect(state?.fields.humidity.value).toBe(48);
    expect(h.history.persistAccepted).toHaveBeenCalledTimes(2);
  });

  it('retries failed history delivery after the same sample is replayed without changing latest state', async () => {
    h.history.persistAccepted.mockRejectedValueOnce(new Error('temporary database failure'));
    const input = await sourceInput(h.store);
    const accepted = await h.ingress.ingest(input);
    expect(accepted).toMatchObject({ outcome: 'processed', accepted: true });
    expect(await h.store.getState(scope, deviceId)).not.toBeNull();

    const retry = await h.ingress.ingest(input);
    expect(retry).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence' });
    expect(h.history.persistAccepted).toHaveBeenCalledTimes(2);
    expect((await h.store.getState(scope, deviceId))?.fields.temperature.value).toBe(22.5);
  });

  it('recognizes a verified firmware counter reset as a new sample session', async () => {
    const initial = await sourceInput(h.store);
    await h.ingress.ingest(initial);
    await new Promise(resolve => setTimeout(resolve, 5));
    const reboot = await sourceInput(h.store, {
      uptimeMs: 1_000, sampleCount: 1, lastSampleUptimeMs: 0,
    }, { temperatureC: 22.5, humidityPct: 48 });
    expect(reboot.evidenceId).not.toBe(initial.evidenceId);
    await expect(h.ingress.ingest(reboot)).resolves.toMatchObject({
      outcome: 'processed', accepted: true, updatedKeys: ['temperature', 'humidity'],
    });
    expect(h.history.persistAccepted).toHaveBeenCalledTimes(2);
  });
});
