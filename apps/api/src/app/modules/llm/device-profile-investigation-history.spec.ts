import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeviceInvestigationHistoryStore,
  type DeviceProfileInvestigationOutcome,
} from './device-investigation-history.store';

describe('MQTT profile investigation history', () => {
  const scope = {
    tenantId: 'tenant-home',
    siteId: 'site-home',
  };

  const result: DeviceProfileInvestigationOutcome = {
    provider: 'mock-local',
    model: 'test-model',
    proposal: {
      schemaVersion: 1,
      deviceId: 'temp-kitchen',
      snapshotId: 'snap-test',
      status: 'proposed',
      requiresApproval: true,
      protocol: 'mqtt',
      selector: 'devices/temp-kitchen/data',
      fields: {
        temperature: {
          rawKey: 'temperature',
          type: 'number',
        },
      },
      supportingEvidenceIds: ['ev-test'],
    },
    replay: {
      status: 'passed',
      profileStatus: 'proposed',
      installationAuthorized: false,
      testedSamples: 1,
      acceptedSamples: 1,
      rejectedSamples: 0,
      mappedFields: ['temperature'],
      observedFields: { temperature: 25.3 },
      steps: [{
        evidenceId: 'ev-test',
        receivedAt: '2026-10-18T12:00:00.000Z',
        pipelineAccepted: true,
        passed: true,
        stage: 'observation',
        reason: 'accepted',
        updatedKeys: ['temperature'],
        ignoredKeys: [],
        rejectedFields: [],
      }],
    },
  };

  let directory: string;
  let store: DeviceInvestigationHistoryStore;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'energrid-profile-history-'),
    );
    store = new DeviceInvestigationHistoryStore(directory);
  });

  afterEach(async () => {
    await store.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists an AI profile and replay report across restart', async () => {
    const saved = await store.saveProfile(scope, result);

    expect(saved.kind).toBe('mqtt-observation-profile');
    expect(saved.result.proposal.status).toBe('proposed');
    expect(saved.result.replay.installationAuthorized).toBe(false);

    await store.onModuleDestroy();
    store = new DeviceInvestigationHistoryStore(directory);

    const restored = await store.getProfileForDevice(
      scope,
      'temp-kitchen',
      saved.id,
    );

    expect(restored?.result.replay.status).toBe('passed');
    expect(restored?.result.replay.observedFields.temperature)
      .toBe(25.3);

    const history = await store.listProfiles(
      scope,
      'temp-kitchen',
    );

    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(saved.id);
  });

  it('isolates investigations by tenant, site and device', async () => {
    const saved = await store.saveProfile(scope, result);

    expect(
      await store.getProfileForDevice(
        { ...scope, siteId: 'other-site' },
        'temp-kitchen',
        saved.id,
      ),
    ).toBeNull();

    expect(
      await store.getProfileForDevice(
        { tenantId: 'other-tenant', siteId: scope.siteId },
        'temp-kitchen',
        saved.id,
      ),
    ).toBeNull();

    expect(
      await store.getProfileForDevice(
        scope,
        'temp-garage',
        saved.id,
      ),
    ).toBeNull();

    expect(
      await store.listProfiles(
        { ...scope, siteId: 'other-site' },
        'temp-kitchen',
      ),
    ).toHaveLength(0);
  });

  it('keeps network investigations separate from profile history', async () => {
    await store.saveProfile(scope, result);

    expect(
      await store.list('temp-kitchen'),
    ).toHaveLength(0);
  });

  it('rejects an attempt to persist an approved AI profile', async () => {
    const invalid = {
      ...result,
      proposal: {
        ...result.proposal,
        status: 'approved' as const,
      },
    };

    await expect(
      store.saveProfile(scope, invalid as any),
    ).rejects.toThrow('Invalid profile investigation');

    expect(
      await store.listProfiles(scope, 'temp-kitchen'),
    ).toHaveLength(0);
  });
});
