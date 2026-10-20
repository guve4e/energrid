import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeviceMqttIngestService } from '../device-mqtt-ingest.service';
import { DeviceAiInvestigationService } from '../../llm/device-ai-investigation.service';
import { MqttEvidenceCaptureService } from './mqtt-evidence-capture.service';
import { OperationalLogService } from '../operational-log.service';

describe('MQTT evidence capture integration', () => {
  const scope = {
    tenantId: 'test-tenant',
    siteId: 'test-site',
  };

  const topic = 'devices/temp-kitchen/data';
  const boilerRoomTopic = 'devices/temp-boiler-room/data';

  const payload = JSON.stringify({
    temperature: 25.3,
    humidity: 40.4,
    timestamp: 92671135,
  });
  const boilerPayload = JSON.stringify({
    temperature: 18.8,
    timestamp: 5640962,
    humidity: 48.2,
  });

  const oldBindings = process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON;
  const oldDirectory = process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY;

  let directory: string;
  let recorder: MqttEvidenceCaptureService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'energrid-capture-'));

    process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON =
      JSON.stringify([
        {
          scope,
          deviceId: 'temp-kitchen',
          topic,
        },
        {
          scope,
          deviceId: 'temp-boiler-room',
          topic: boilerRoomTopic,
        },
      ]);

    process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY = directory;

    recorder = new MqttEvidenceCaptureService();
  });

  afterEach(async () => {
    await recorder.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });

    if (oldBindings === undefined) {
      delete process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON;
    } else {
      process.env.HOME_MQTT_EVIDENCE_BINDINGS_JSON = oldBindings;
    }

    if (oldDirectory === undefined) {
      delete process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY;
    } else {
      process.env.HOME_MQTT_EVIDENCE_STORE_DIRECTORY = oldDirectory;
    }
  });

  function mockIngestion() {
    const service = Object.create(
      DeviceMqttIngestService.prototype,
    ) as any;

    service.evidenceCapture = recorder;
    service.operationalLog = new OperationalLogService();
    service.logger = { log: jest.fn(), warn: jest.fn() };
    service.recordDebugMessage = jest.fn();

    service.messageRouter = {
      route: jest.fn(() => ({
        reason: 'test observation',
        persisted: Promise.resolve(),
      })),
    };

    return service;
  }

  it('records an allowlisted message through existing ingestion', async () => {
    const service = mockIngestion();

    await service.handlePayload(topic, payload);

    const { snapshot, samples } =
      await recorder.readInvestigationEvidence(
        scope,
        'temp-kitchen',
      );

    expect(snapshot.evidence).toHaveLength(1);
    expect(samples[0].payload).toEqual({
      temperature: 25.3,
      humidity: 40.4,
      timestamp: 92671135,
    });

    expect(service.messageRouter.route).toHaveBeenCalledTimes(1);
  });

  it('captures the representative boiler-room schema and exposes each processing outcome', async () => {
    const service = mockIngestion();
    service.messageRouter.route.mockReturnValue(null);

    await service.handlePayload(boilerRoomTopic, boilerPayload);

    const status = await recorder.getCaptureStatus(
      scope,
      'temp-boiler-room',
    );

    expect(status).toMatchObject({
      enabled: true,
      deviceId: 'temp-boiler-room',
      topics: [boilerRoomTopic],
      samplesInWindow: 1,
    });
    expect(status.latestCapturedAt).toEqual(expect.any(String));
    expect(service.messageRouter.route).toHaveBeenCalledTimes(1);
    const events = service.operationalLog.recent().filter(
      (entry: any) => entry.correlationId && entry.topic === boilerRoomTopic,
    );
    expect(events.map((entry: any) => [entry.stage, entry.outcome])).toEqual(
      expect.arrayContaining([
        ['received', 'received'],
        ['parse', 'parsed'],
        ['evidence', 'matched'],
        ['persistence', 'succeeded'],
        ['discovery', 'skipped'],
        ['registry', 'not_updated'],
        ['routing', 'skipped'],
        ['observation', 'skipped'],
      ]),
    );
    expect(new Set(events.map((entry: any) => entry.correlationId)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain('18.8');
    expect(JSON.stringify(events)).not.toContain('48.2');
    expect(JSON.stringify(events)).not.toContain('5640962');
  });

  it('reports invalid JSON as a reasoned parse failure without storing payload text', async () => {
    const service = mockIngestion();
    const badPayload = '{secret-token-not-for-logs';

    await service.handlePayload(boilerRoomTopic, badPayload);

    const events = service.operationalLog.recent();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'parse', outcome: 'failed', reasonCode: 'invalid_json' }),
      expect.objectContaining({ stage: 'routing', outcome: 'skipped', reasonCode: 'invalid_json' }),
      expect.objectContaining({ stage: 'persistence', outcome: 'skipped', reasonCode: 'invalid_json' }),
    ]));
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('does not capture non-allowlisted topics', async () => {
    const service = mockIngestion();

    await service.handlePayload(
      'devices/temp-garage/data',
      payload,
    );

    const { samples } =
      await recorder.readInvestigationEvidence(
        scope,
        'temp-kitchen',
      );

    expect(samples).toHaveLength(0);
    expect(service.messageRouter.route).toHaveBeenCalledTimes(1);
    expect(service.operationalLog.recent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'evidence', outcome: 'skipped', reasonCode: 'topic_not_bound' }),
      expect.objectContaining({ stage: 'persistence', outcome: 'skipped', reasonCode: 'topic_not_bound' }),
    ]));
  });

  it('keeps MQTT routing alive when evidence storage fails', async () => {
    const service = mockIngestion();

    jest.spyOn(recorder, 'capture')
      .mockRejectedValueOnce(new Error('Evidence disk unavailable'));

    await expect(
      service.handlePayload(topic, payload),
    ).resolves.toBeUndefined();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.messageRouter.route).toHaveBeenCalledTimes(1);
    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('see operational diagnostics'),
    );
    expect(service.operationalLog.recent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'persistence', outcome: 'failed', reasonCode: 'evidence_persistence_failed' }),
      expect.objectContaining({ stage: 'discovery', outcome: 'skipped', reasonCode: 'evidence_persistence_failed' }),
    ]));
  });

  it.each([
    [{ outcome: 'admitted' }, 'admitted', undefined],
    [{ outcome: 'rejected', reasonCode: 'device_not_approved' }, 'rejected', 'device_not_approved'],
  ])('records observation admission decisions', async (decision, outcome, reasonCode) => {
    const service = mockIngestion();
    service.evidenceCapture = undefined;
    service.messageRouter.route.mockReturnValue({
      reason: 'test route',
      persisted: Promise.resolve(),
      observationAdmission: Promise.resolve(decision),
    });

    await service.handlePayload('devices/test-device/state', payload);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.operationalLog.recent()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'observation',
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
      }),
    ]));
  });

  it('lets the existing AI investigator propose from stored evidence', async () => {
    await recorder.capture(topic, payload);

    const generate = jest.fn(async (request: {
      userPrompt: string;
    }) => {
      const input = JSON.parse(request.userPrompt);

      return {
        provider: 'mock-local',
        model: 'virtual-investigator',
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
      undefined,
      recorder,
    );

    const result =
      await investigator.proposeObservationProfileFromStoredEvidence(
        scope,
        'temp-kitchen',
      );

    expect(result.proposal.status).toBe('proposed');

    expect(result.replay.status).toBe('passed');
    expect(result.replay.installationAuthorized).toBe(false);
    expect(result.replay.testedSamples).toBe(1);
    expect(result.replay.observedFields.temperature).toBe(25.3);
    expect(result.replay.observedFields.humidity).toBe(40.4);
    expect(result.proposal.requiresApproval).toBe(true);
    expect(result.proposal.fields.temperature.rawKey)
      .toBe('temperature');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
