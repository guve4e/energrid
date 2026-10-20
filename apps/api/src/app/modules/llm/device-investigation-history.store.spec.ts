import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceInvestigationHistoryStore } from './device-investigation-history.store';
import type { DeviceAiInvestigationResult } from './device-ai-investigation.service';

describe('DeviceInvestigationHistoryStore', () => {
  let directory: string;
  let store: DeviceInvestigationHistoryStore;

  const result = (deviceId: string): DeviceAiInvestigationResult => ({
    deviceId,
    provider: 'test',
    model: 'test-model',
    report: {
      summary: 'Test investigation',
      findings: [],
      unknowns: [],
      nextSteps: [],
    },
    assessment: {
      schemaVersion: 1,
      deviceId,
      snapshotId: 'snap_test',
      hypotheses: [],
      proposals: [],
    },
    evidenceSnapshot: {
      id: 'snap_test',
      schemaVersion: 1,
      deviceId,
      createdAt: new Date().toISOString(),
      evidence: [],
    },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-investigation-'));
    store = new DeviceInvestigationHistoryStore(directory);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists an investigation', async () => {
    const saved = await store.save(result('device-1'));

    expect(saved.id).toBeTruthy();
    expect(saved.deviceId).toBe('device-1');

    const loaded = await store.get(saved.id);
    expect(loaded).toEqual(saved);
  });

  it('isolates history by device', async () => {
    await store.save(result('device-1'));
    await store.save(result('device-2'));

    expect(await store.list('device-1')).toHaveLength(1);
    expect(await store.list('device-2')).toHaveLength(1);
    expect(await store.list('device-3')).toHaveLength(0);
  });

  it('preserves multiple investigations', async () => {
    await store.save(result('device-1'));
    await store.save(result('device-1'));

    const history = await store.list('device-1');

    expect(history).toHaveLength(2);
    expect(history[0].id).not.toBe(history[1].id);
  });

  it('survives closing and reopening the database', async () => {
    const saved = await store.save(result('device-1'));

    await store.onModuleDestroy();

    const reopened = new DeviceInvestigationHistoryStore(directory);

    expect(await reopened.get(saved.id)).toEqual(saved);

    await reopened.onModuleDestroy();

    // Prevent afterEach from closing the original instance twice.
    store = new DeviceInvestigationHistoryStore(directory);
  });

  it('does not expose another device in a history query', async () => {
    await store.save(result('192.168.1.92'));

    expect(await store.list('192.168.1.133')).toEqual([]);
  });

  it('isolates scoped investigation history by tenant, site, and network', async () => {
    const scope = { tenantId: 'tenant-a', siteId: 'site-a', networkId: 'lan-a' };
    const otherNetwork = { ...scope, networkId: 'lan-b' };
    const otherTenant = { ...scope, tenantId: 'tenant-b' };

    const saved = await store.saveScoped(scope, 'host-1', result('host-1'));

    expect(await store.listScoped(scope, 'host-1')).toEqual([saved]);
    expect(await store.listScoped(otherNetwork, 'host-1')).toEqual([]);
    expect(await store.listScoped(otherTenant, 'host-1')).toEqual([]);
    expect(await store.getScoped(otherNetwork, saved.id)).toBeNull();
  });

  it('persists action claims and prevents repeated execution after restart', async () => {
    const scope = { tenantId: 'tenant-a', siteId: 'site-a', networkId: 'lan-a' };
    const saved = await store.saveScoped(scope, 'lan-a:host-1', result('host-1'));

    expect(await store.getScoped(scope, saved.id)).not.toBeNull();
    expect(await store.getAction(scope, saved.id, 'probe-http')).toBeNull();
    expect(await store.beginAction(scope, saved.id, 'probe-http')).toBe(true);
    expect(await store.beginAction(scope, saved.id, 'probe-http')).toBe(false);
    await store.finishAction(scope, saved.id, 'probe-http', {
      outcome: 'completed', reasonCode: 'http_response_received', statusCode: 404,
    });

    const action = await store.getAction(scope, saved.id, 'probe-http');
    expect(action).toMatchObject({ status: 'completed', result: { statusCode: 404 } });
  });

  it('keeps legacy unscoped records invisible to scoped queries', async () => {
    await store.save(result('host-1'));

    expect(await store.listScoped(
      { tenantId: 'tenant-a', siteId: 'site-a', networkId: 'lan-a' },
      'host-1',
    )).toEqual([]);
  });
});
