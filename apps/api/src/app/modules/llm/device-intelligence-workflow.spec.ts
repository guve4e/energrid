import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceAiInvestigationService } from './device-ai-investigation.service';
import { DeviceInvestigationHistoryStore } from './device-investigation-history.store';
import { MqttEvidenceCaptureService } from '../devices/mqtt/mqtt-evidence-capture.service';

describe('Energrid Device Intelligence complete workflow', () => {
  const scope = {
    tenantId: 'workflow-tenant',
    siteId: 'workflow-site',
  };

  const deviceId = 'virtual-esp8266-kitchen';
  const topic = 'devices/virtual-esp8266-kitchen/data';

  let directory: string;
  let recorder: MqttEvidenceCaptureService;
  let history: DeviceInvestigationHistoryStore;

  const originalBindings =
    process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON;
  const originalDirectory =
    process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), 'energrid-intelligence-workflow-'),
    );

    process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON =
      JSON.stringify([{ scope, deviceId, topic }]);

    process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY =
      join(directory, 'evidence');

    recorder = new MqttEvidenceCaptureService();

    history = new DeviceInvestigationHistoryStore(
      join(directory, 'history'),
    );
  });

  afterEach(async () => {
    await recorder.onModuleDestroy();
    await history.onModuleDestroy();

    await rm(directory, { recursive: true, force: true });

    if (originalBindings === undefined) {
      delete process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON;
    } else {
      process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON =
        originalBindings;
    }

    if (originalDirectory === undefined) {
      delete process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY;
    } else {
      process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY =
        originalDirectory;
    }
  });

  it('captures, investigates, replays, persists and restores', async () => {
    await recorder.capture(
      topic,
      JSON.stringify({
        temperature: 25.3,
        humidity: 40.4,
        timestamp: 92671135,
      }),
    );

    const generate = jest.fn(async (request: {
      userPrompt: string;
    }) => {
      const input = JSON.parse(request.userPrompt);

      return {
        provider: 'mock-local',
        model: 'energrid-test-investigator',
        text: JSON.stringify({
          schemaVersion: 1,
          deviceId: input.deviceId,
          snapshotId: input.snapshotId,
          status: 'proposed',
          requiresApproval: true,
          protocol: 'mqtt',
          selector: topic,
          fields: {
            temperature: {
              rawKey: 'temperature',
              type: 'number',
            },
            humidity: {
              rawKey: 'humidity',
              type: 'number',
            },
          },
          supportingEvidenceIds: [
            input.evidence[0].id,
          ],
        }),
      };
    });

    const investigator = new DeviceAiInvestigationService(
      { generate } as any,
      history,
      recorder,
    );

    // Complete intelligence workflow.
    const saved =
      await investigator.investigateStoredMqttProfile(
        scope,
        deviceId,
      );

    expect(generate).toHaveBeenCalledTimes(1);

    expect(saved.result.proposal.status)
      .toBe('proposed');

    expect(saved.result.replay.status)
      .toBe('passed');

    expect(saved.result.replay.observedFields)
      .toEqual({
        temperature: 25.3,
        humidity: 40.4,
      });

    expect(saved.result.replay.installationAuthorized)
      .toBe(false);

    // Simulate restarting investigation history storage.
    await history.onModuleDestroy();

    history = new DeviceInvestigationHistoryStore(
      join(directory, 'history'),
    );

    const restored =
      await history.getProfileForDevice(
        scope,
        deviceId,
        saved.id,
      );

    expect(restored?.result.replay.status)
      .toBe('passed');

    expect(restored?.result.proposal.fields.temperature.rawKey)
      .toBe('temperature');

    // Reading saved history must not invoke the LLM again.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
