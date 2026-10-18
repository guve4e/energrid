import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicLevel } from 'classic-level';

import { DeviceObservationStateStore } from './device-observation-state.store';

describe('Energrid Observation Store Recovery', () => {
  let directory: string;
  let store: DeviceObservationStateStore;

  const scope = {
    tenantId: 'tenant-home',
    siteId: 'site-home',
  };

  const input = {
    binding: {
      deviceId: 'garage-sensor',
      sourceId: 'approved-mqtt',
      selector: 'devices/temp-kitchen/data',
      fields: {
        temperature: {
          rawKey: 'temperature',
          type: 'number' as const,
        },
      },
    },
    policy: {
      deviceId: 'garage-sensor',
      allowedSourcesByField: {
        temperature: ['approved-mqtt'],
      },
    },
    context: {
      selector: 'devices/temp-kitchen/data',
      receivedAt: '2026-10-18T11:00:00Z',
      evidenceId: 'mqtt-event-001',
    },
    payload: {
      temperature: 25,
    },
  };

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'energrid-recovery-'),
    );

    store = new DeviceObservationStateStore(directory, 100);
  });

  afterEach(async () => {
    await store.close();

    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  it('recovers after a successful commit with a lost acknowledgment', async () => {
    // Open database.
    await store.getState(scope, 'garage-sensor');

    // Test-only access to the underlying storage.
    const db = (
      store as unknown as {
        db: ClassicLevel<string, unknown>;
      }
    ).db;

    const originalBatch = db.batch.bind(db);

    // Simulate:
    // 1. Disk commit succeeds.
    // 2. Application receives an error.
    // 3. Application does not know if data was saved.

    const spy = jest.spyOn(db, 'batch');

    spy.mockImplementation(async (...args: any[]) => {
      await originalBatch(
        args[0],
        args[1],
      );

      throw new Error('simulated acknowledgment loss');
    });

    await expect(
      store.process(scope, 'garage-sensor', input),
    ).rejects.toThrow('simulated acknowledgment loss');

    // The store must refuse further operations.
    await expect(
      store.process(scope, 'garage-sensor', input),
    ).rejects.toThrow('requires recovery');

    spy.mockRestore();

    // Simulate application shutdown.
    await store.close();

    // Simulate restarting Energrid.
    store = new DeviceObservationStateStore(directory, 100);

    const recovered = await store.getState(
      scope,
      'garage-sensor',
    );

    expect(recovered?.fields.temperature.value).toBe(25);

    // MQTT redelivers the same event.
    const replay = await store.process(
      scope,
      'garage-sensor',
      input,
    );

    expect(replay.accepted).toBe(false);
    expect(replay.reason).toBe('duplicate_evidence');

    // No duplicate decision should exist.
    const decisions = await store.decisions(
      scope,
      'garage-sensor',
    );

    expect(decisions).toHaveLength(1);
  });

  it('does not acknowledge a failed commit', async () => {
    await store.getState(scope, 'garage-sensor');

    const db = (
      store as unknown as {
        db: ClassicLevel<string, unknown>;
      }
    ).db;

    const spy = jest.spyOn(db, 'batch');

    // Simulate failure before anything reaches storage.
    spy.mockRejectedValueOnce(
      new Error('simulated disk failure'),
    );

    await expect(
      store.process(scope, 'garage-sensor', input),
    ).rejects.toThrow('simulated disk failure');

    spy.mockRestore();

    await store.close();

    store = new DeviceObservationStateStore(directory, 100);

    // No state was committed.
    const state = await store.getState(
      scope,
      'garage-sensor',
    );

    expect(state).toBeNull();

    // Redelivery should now succeed.
    const result = await store.process(
      scope,
      'garage-sensor',
      input,
    );

    expect(result.accepted).toBe(true);

    expect(
      (await store.getState(scope, 'garage-sensor'))
        ?.fields.temperature.value,
    ).toBe(25);
  });

  it('prevents competing database owners', async () => {
    await store.getState(scope, 'garage-sensor');

    const competitor = new DeviceObservationStateStore(
      directory,
      100,
    );

    try {
      await expect(
        competitor.getState(scope, 'garage-sensor'),
      ).rejects.toThrow();
    } finally {
      await competitor.close();
    }

    // Original writer remains operational.
    const result = await store.process(
      scope,
      'garage-sensor',
      input,
    );

    expect(result.accepted).toBe(true);
  });
});
