import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime';
import { energridHttpObservationApproval } from './adapters/inbound/energrid/energrid-http-observation-approval';
import { ENERGRID_HTTP_OBSERVATION_SOURCE, ENERGRID_HTTP_STATUS_SELECTOR } from './adapters/inbound/energrid/energrid-http-observation.adapter';

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), uptime: () => 420 }));

describe('Core authorized observation reader', () => {
  it('reads HTTP fields from LevelDB only while the persisted installation binding authorizes them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-authorized-reader-'));
    const previous = {
      enabled: process.env.HOME_HTTP_POLL_ENABLED,
      directory: process.env.HOME_OBSERVATION_STORE_DIRECTORY,
      bindings: process.env.HOME_OBSERVATION_BINDINGS_JSON,
    };
    process.env.HOME_HTTP_POLL_ENABLED = 'true';
    process.env.HOME_OBSERVATION_STORE_DIRECTORY = directory;
    delete process.env.HOME_OBSERVATION_BINDINGS_JSON;

    const scope = { tenantId: 'tenant-home', siteId: 'site-home' };
    const deviceId = 'device:upstream-lan:esp8266:324864';
    const device = { id: deviceId, ...scope, kind: 'physical', trustStatus: 'approved' };
    const installation: any = {
      schemaVersion: 1,
      device,
      observationAuthority: energridHttpObservationApproval(deviceId),
    };
    const registry = {
      ensureInstallationsLoaded: jest.fn(),
      getDevices: jest.fn(() => [device]),
      projectApprovedObservation: jest.fn(),
    };
    const runtime = new ApprovedMqttObservationRuntime(
      registry as never,
      { get: jest.fn(async () => installation) } as never,
      { find: jest.fn(async () => ({ status: 'enrolled' })) } as never,
    );
    try {
      const evidenceId = await runtime.sourceSampleEvidenceId(scope, deviceId, ENERGRID_HTTP_OBSERVATION_SOURCE, {
        uptimeMs: 12_000, sampleCount: 6, lastSampleUptimeMs: 10_000,
      });
      const accepted = await runtime.ingestHttpObservation({
        scope, deviceId, sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
        selector: ENERGRID_HTTP_STATUS_SELECTOR, evidenceId: evidenceId!,
        payload: { temperatureC: 18.2, humidityPct: 49 },
      });
      expect(accepted).toMatchObject({ outcome: 'processed', accepted: true });
      await expect(runtime.getAuthorizedObservation(scope, deviceId)).resolves.toMatchObject({
        deviceId,
        fields: {
          temperature: { value: 18.2, sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE },
          humidity: { value: 49, sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE },
        },
      });

      installation.observationAuthority = undefined;
      await expect(runtime.getAuthorizedObservation(scope, deviceId)).resolves.toBeNull();
    } finally {
      await runtime.onModuleDestroy();
      if (previous.enabled === undefined) delete process.env.HOME_HTTP_POLL_ENABLED;
      else process.env.HOME_HTTP_POLL_ENABLED = previous.enabled;
      if (previous.directory === undefined) delete process.env.HOME_OBSERVATION_STORE_DIRECTORY;
      else process.env.HOME_OBSERVATION_STORE_DIRECTORY = previous.directory;
      if (previous.bindings === undefined) delete process.env.HOME_OBSERVATION_BINDINGS_JSON;
      else process.env.HOME_OBSERVATION_BINDINGS_JSON = previous.bindings;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
