import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceObservationStateStore } from './device-observation-state.store';

describe('Persistent Device Observation State', () => {

  const scope = {
    tenantId: 'tenant-home',
    siteId: 'site-house-1',
  };

  let directory: string;
  let store: DeviceObservationStateStore;

  const binding = {
    deviceId: 'garage-sensor',
    sourceId: 'approved-mqtt',
    selector: 'devices/temp-kitchen/data',
    fields: {
      temperature: {
        rawKey: 'temperature',
        type: 'number' as const,
      },
      humidity: {
        rawKey: 'humidity',
        type: 'number' as const,
      },
    },
  };

  const policy = {
    deviceId: 'garage-sensor',
    allowedSourcesByField: {
      temperature: ['approved-mqtt'],
      humidity: ['approved-mqtt'],
    },
  };

  function observation(
    temperature: number,
    receivedAt: string,
  ) {
    return {
      binding,
      policy,
      context: {
        selector: 'devices/temp-kitchen/data',
        receivedAt,
      },
      payload: { temperature },
    };
  }

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'energrid-observations-'),
    );

    store = new DeviceObservationStateStore(directory, 3);
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  });

  it('persists observation state across restarts', async () => {
    await store.process(
      scope, 'garage-sensor',
      observation(25, '2026-10-18T11:00:00Z'),
    );

    await store.close();

    store = new DeviceObservationStateStore(directory, 3);

    const state = await store.getState(scope, 'garage-sensor');

    expect(state?.fields.temperature.value).toBe(25);
    expect(state?.fields.temperature.sourceId).toBe('approved-mqtt');
  });

  it('keeps HTTP source sample identities stable across API restarts and advances only on a device counter reset', async () => {
    const source = 'energrid-http-status';
    const sample = {
      uptimeMs: 12_000, sampleCount: 6, lastSampleUptimeMs: 10_000,
      observedAt: '2026-10-01T00:00:02.000Z', apiUptimeMs: 102_000,
    };
    const first = await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, sample);
    expect(await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, sample)).toBe(first);

    await store.close();
    store = new DeviceObservationStateStore(directory, 3);
    expect(await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, sample)).toBe(first);

    const afterDeviceRestart = await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 4_000, sampleCount: 2, lastSampleUptimeMs: 2_000,
      observedAt: '2026-10-01T00:00:04.000Z', apiUptimeMs: 104_000,
    });
    expect(afterDeviceRestart).not.toBe(first);
    expect(afterDeviceRestart).toContain('boot-1:sample-2-2000');
  });

  it('defers an ambiguous sample after a long interruption instead of inventing a boot session', async () => {
    const source = 'energrid-http-status';
    const first = await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 100_000, sampleCount: 50, lastSampleUptimeMs: 98_000,
      observedAt: '2026-10-01T00:00:00.000Z', apiUptimeMs: 500_000,
    });
    // Wall and host clocks agree on a day, but firmware uptime advanced by only
    // 100 seconds and its counters did not reset. This could be an unexplained
    // source discontinuity, so it cannot safely identify a new boot.
    await expect(store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 200_000, sampleCount: 100, lastSampleUptimeMs: 198_000,
      observedAt: '2026-10-02T00:00:00.000Z', apiUptimeMs: 86_900_000,
    })).rejects.toThrow('source_sample_session_ambiguous');
    expect(first).toContain('boot-0:');
  });

  it('keeps the same boot session across a long polling interruption when all monotonic clocks agree', async () => {
    const source = 'energrid-http-status';
    await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 100_000, sampleCount: 50, lastSampleUptimeMs: 98_000,
      observedAt: '2026-10-01T00:00:00.000Z', apiUptimeMs: 500_000,
    });
    const afterLongGap = await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 86_500_000, sampleCount: 43_250, lastSampleUptimeMs: 86_498_000,
      observedAt: '2026-10-02T00:00:00.000Z', apiUptimeMs: 86_900_000,
    });
    expect(afterLongGap).toContain('boot-0:sample-43250-86498000');
  });

  it('defers partial counter regressions rather than treating one reset counter as a reboot', async () => {
    const source = 'energrid-http-status';
    await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 100_000, sampleCount: 50, lastSampleUptimeMs: 98_000,
      observedAt: '2026-10-01T00:00:00.000Z', apiUptimeMs: 500_000,
    });
    await expect(store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      // Uptime fell, but the per-boot sample count did not reset.
      uptimeMs: 4_000, sampleCount: 51, lastSampleUptimeMs: 2_000,
      observedAt: '2026-10-01T00:00:02.000Z', apiUptimeMs: 502_000,
    })).rejects.toThrow('source_sample_session_ambiguous');
  });

  it.each([
    ['forward', '2026-10-01T01:00:02.000Z'],
    ['backward', '2026-09-30T23:00:02.000Z'],
  ])('rejects a %s wall-clock jump and recovers without changing sample session', async (_direction, jumpedAt) => {
    const source = 'energrid-http-status';
    const first = await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 100_000, sampleCount: 50, lastSampleUptimeMs: 98_000,
      observedAt: '2026-10-01T00:00:00.000Z', apiUptimeMs: 500_000,
    });
    await expect(store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 102_000, sampleCount: 51, lastSampleUptimeMs: 100_000,
      observedAt: jumpedAt, apiUptimeMs: 502_000,
    })).rejects.toThrow('source_sample_session_ambiguous');
    const recovered = await store.sourceSampleEvidenceId(scope, 'esp8266-device', source, {
      uptimeMs: 102_000, sampleCount: 51, lastSampleUptimeMs: 100_000,
      observedAt: '2026-10-01T00:00:02.000Z', apiUptimeMs: 502_000,
    });
    expect(recovered).toContain('boot-0:sample-51-100000');
    expect(recovered).not.toBe(first);
  });

  it('serializes simultaneous observations', async () => {
    const results = await Promise.all([
      store.process(
        scope, 'garage-sensor',
        observation(25, '2026-10-18T11:10:00Z'),
      ),
      store.process(
        scope, 'garage-sensor',
        observation(23.6, '2026-10-18T11:05:00Z'),
      ),
    ]);

    expect(results[0].accepted).toBe(true);
    expect(results[1].accepted).toBe(false);

    const state = await store.getState(scope, 'garage-sensor');

    expect(state?.fields.temperature.value).toBe(25);
  });

  it('preserves rejected decisions for investigation', async () => {
    await store.process(
      scope, 'garage-sensor',
      observation(25, '2026-10-18T11:10:00Z'),
    );

    await store.process(
      scope, 'garage-sensor',
      observation(23.6, '2026-10-18T11:05:00Z'),
    );

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions).toHaveLength(2);

    expect(decisions[0]).toEqual(
      expect.objectContaining({
        accepted: false,
        reason: 'stale_observation',
      }),
    );
  });

  it('bounds decision history', async () => {
    for (let index = 0; index < 6; index++) {
      await store.process(
        scope, 'garage-sensor',
        observation(
          20 + index,
          new Date(
            Date.parse('2026-10-18T11:00:00Z') +
              index * 60_000,
          ).toISOString(),
        ),
      );
    }

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions).toHaveLength(3);
    expect(decisions.map((d) => d.sequence)).toEqual([
      5, 4, 3,
    ]);
  });

  it('keeps state isolated between devices', async () => {
    await store.process(
      scope, 'garage-sensor',
      observation(25, '2026-10-18T11:00:00Z'),
    );

    expect(await store.getState(scope, 'other-device')).toBeNull();
  });

  it('does not accept a binding for another device', async () => {
    await expect(
      store.process(
        scope, 'other-device',
        observation(25, '2026-10-18T11:00:00Z'),
      ),
    ).rejects.toThrow('Binding identity mismatch');

    expect(await store.getState(scope, 'other-device')).toBeNull();
  });

  it('persists rejection history across restarts', async () => {
    await store.process(
      scope, 'garage-sensor',
      observation(25, '2026-10-18T11:10:00Z'),
    );

    await store.process(
      scope, 'garage-sensor',
      observation(23, '2026-10-18T11:05:00Z'),
    );

    await store.close();
    store = new DeviceObservationStateStore(directory, 3);

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions[0].reason).toBe('stale_observation');
    expect(decisions[0].accepted).toBe(false);
  });

  it('does not record duplicate MQTT evidence twice', async () => {
    const input = {
      binding,
      policy,
      context: {
        selector: 'devices/temp-kitchen/data',
        receivedAt: '2026-10-18T11:00:00Z',
        evidenceId: 'mqtt-event-001',
      },
      payload: {
        temperature: 25,
      },
    };

    const first = await store.process(
      scope, 'garage-sensor',
      input,
    );

    const second = await store.process(
      scope, 'garage-sensor',
      input,
    );

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions).toHaveLength(1);
  });

  it('recognizes duplicate evidence after restart', async () => {
    const input = {
      binding,
      policy,
      context: {
        selector: 'devices/temp-kitchen/data',
        receivedAt: '2026-10-18T11:00:00Z',
        evidenceId: 'mqtt-event-persisted-001',
      },
      payload: {
        temperature: 25,
      },
    };

    await store.process(scope, 'garage-sensor', input);

    await store.close();

    store = new DeviceObservationStateStore(directory, 3);

    await store.process(scope, 'garage-sensor', input);

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions).toHaveLength(1);
  });


  it('rejects evidence ID collisions without changing state', async () => {
    const context = {
      selector: 'devices/temp-kitchen/data',
      receivedAt: '2026-10-18T11:00:00Z',
      evidenceId: 'mqtt-collision-001',
    };

    await store.process(scope, 'garage-sensor', {
      binding,
      policy,
      context,
      payload: { temperature: 25 },
    });

    const collision = await store.process(scope, 'garage-sensor', {
      binding,
      policy,
      context,
      payload: { temperature: 99 },
    });

    expect(collision.accepted).toBe(false);
    expect(collision.reason).toBe('evidence_id_conflict');

    const state = await store.getState(scope, 'garage-sensor');

    expect(state?.fields.temperature.value).toBe(25);

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions).toHaveLength(1);
  });

  it('expires evidence indexes with bounded decision history', async () => {
    for (let index = 0; index < 4; index++) {
      await store.process(scope, 'garage-sensor', {
        binding,
        policy,
        context: {
          selector: 'devices/temp-kitchen/data',
          receivedAt: new Date(
            Date.parse('2026-10-18T11:00:00Z') +
              index * 60_000,
          ).toISOString(),
          evidenceId: `mqtt-retention-${index}`,
        },
        payload: { temperature: 20 + index },
      });
    }

    // Store retention is 3. Evidence 0 has expired.
    // Evidence 2 must still be recognized.
    const duplicate = await store.process(scope, 'garage-sensor', {
      binding,
      policy,
      context: {
        selector: 'devices/temp-kitchen/data',
        receivedAt: '2026-10-18T11:02:00Z',
        evidenceId: 'mqtt-retention-2',
      },
      payload: { temperature: 22 },
    });

    expect(duplicate.reason).toBe('duplicate_evidence');

    const decisions = await store.decisions(scope, 'garage-sensor');

    expect(decisions).toHaveLength(3);
    expect(decisions.map((d) => d.sequence)).toEqual([3, 2, 1]);
  });


  it('isolates identical device IDs across sites', async () => {
    const otherSite = {
      tenantId: 'tenant-home',
      siteId: 'site-house-2',
    };

    await store.process(
      scope,
      'garage-sensor',
      observation(25, '2026-10-18T11:00:00Z'),
    );

    await store.process(
      otherSite,
      'garage-sensor',
      observation(19, '2026-10-18T11:00:00Z'),
    );

    const first = await store.getState(scope, 'garage-sensor');
    const second = await store.getState(otherSite, 'garage-sensor');

    expect(first?.fields.temperature.value).toBe(25);
    expect(second?.fields.temperature.value).toBe(19);

    expect(await store.decisions(scope, 'garage-sensor'))
      .toHaveLength(1);

    expect(await store.decisions(otherSite, 'garage-sensor'))
      .toHaveLength(1);
  });

  it('isolates evidence identities across tenants', async () => {
    const otherTenant = {
      tenantId: 'another-tenant',
      siteId: scope.siteId,
    };

    const input = {
      ...observation(25, '2026-10-18T11:00:00Z'),
      context: {
        selector: 'devices/temp-kitchen/data',
        receivedAt: '2026-10-18T11:00:00Z',
        evidenceId: 'same-evidence-id',
      },
    };

    const first = await store.process(
      scope, 'garage-sensor', input,
    );

    const second = await store.process(
      otherTenant, 'garage-sensor', input,
    );

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    expect(await store.decisions(scope, 'garage-sensor'))
      .toHaveLength(1);

    expect(await store.decisions(otherTenant, 'garage-sensor'))
      .toHaveLength(1);
  });

  it('rejects invalid tenant or site identity', async () => {
    await expect(
      store.process(
        { tenantId: '', siteId: 'house' },
        'garage-sensor',
        observation(25, '2026-10-18T11:00:00Z'),
      ),
    ).rejects.toThrow('Valid tenant and site identity required');
  });

});
