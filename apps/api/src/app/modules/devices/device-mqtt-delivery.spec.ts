import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { DeviceMqttIngestService } from './device-mqtt-ingest.service';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceObservationService } from './device-observation.service';
import { OperationalLogService } from './operational-log.service';
import { TelemetryIngestService } from '../telemetry/telemetry-ingest.service';
import { DurableMqttSubscriber } from './mqtt/durable-mqtt-subscriber';
import type { DeviceEnrollmentService } from './enrollment/device-enrollment.service';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn(),
}));
jest.mock('./mqtt/durable-mqtt-subscriber', () => ({
  ...jest.requireActual('./mqtt/durable-mqtt-subscriber'),
  DurableMqttSubscriber: jest.fn(),
}));
const original = process.env;
beforeEach(() => {
  process.env = {
    ...original,
    HOME_MQTT_CLIENT_ID: 'unit-only',
    HOME_MQTT_INGEST_ENABLED: 'true',
    HOME_MQTT_TOPIC_PREFIX: 'energrid/tenant-demo/site-home',
  };
  jest.clearAllMocks();
});
afterEach(() => {
  process.env = original;
});
const setup = (enabled: boolean, enrollment?: DeviceEnrollmentService) => {
  const subscriber = {
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockReturnValue({ connected: true, qosZeroMessages: 0 }),
  };
  (DurableMqttSubscriber as jest.Mock).mockImplementation(() => subscriber);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  });
  (spawn as jest.Mock).mockReturnValue(child);
  const telemetry = {
    status: () => ({ enabled }),
    capture: jest.fn().mockResolvedValue(undefined),
  };
  const registry = new DeviceRegistryService();
  const service = new DeviceMqttIngestService(
    registry,
    new OperationalLogService(),
    new DeviceObservationService(),
    telemetry as unknown as TelemetryIngestService,
    undefined,
    undefined,
    undefined,
    undefined,
    enrollment,
  );
  return { service, subscriber, child, telemetry, registry };
};

it('selects the acknowledged transport only for enabled new recording, keeping multiline payloads intact', async () => {
  const enrollment = {
    find: jest.fn().mockResolvedValue({ status: 'enrolled' }),
  } as unknown as DeviceEnrollmentService;
  const { service, subscriber, telemetry, registry } = setup(true, enrollment);
  registry.ingestRegistryPayload({
    tenantId: 'tenant-demo',
    siteId: 'site-home',
    siteName: 'Integration test site',
    devices: [{
      deviceId: 'meter',
      name: 'Integration test meter',
      kind: 'physical',
      protocol: 'mqtt',
      transport: 'mqtt',
      driver: 'integration-test',
      target: 'meter/telemetry',
      location: 'Test',
      capabilities: ['power'],
      values: {},
    }],
  });
  await service.onModuleInit();
  expect(subscriber.start).toHaveBeenCalledTimes(1);
  expect(spawn).not.toHaveBeenCalled();
  expect(service.getDebugState()).toEqual(
    expect.objectContaining({
      status: 'running',
      delivery: { connected: true, qosZeroMessages: 0 },
    }),
  );
  const receive = (DurableMqttSubscriber as jest.Mock).mock.calls[0][2];
  let commit!: () => void;
  let captureStarted!: () => void;
  const captureEntered = new Promise<void>(resolve => {
    captureStarted = resolve;
  });
  telemetry.capture.mockImplementation(
    () => new Promise((resolve) => {
      captureStarted();
      commit = resolve;
    }),
  );
  const accepted = jest.fn();
  const payloadText = '{\n"deviceId":"meter",\n"readings":[{\n"schemaVersion":1,\n"tenantId":"tenant-demo",\n"siteId":"site-home",\n"deviceId":"meter",\n"channel":"main",\n"metric":"power",\n"value":42,\n"unit":"W",\n"quality":"measured",\n"observedAt":"2026-10-20T10:00:00.000Z",\n"receivedAt":"2026-10-20T10:00:00.000Z",\n"timestampBasis":"device-observed",\n"source":"integration-test"\n}]\n}';
  const receiving = receive(
    'energrid/tenant-demo/site-home/devices/meter/telemetry',
    payloadText,
  );
  void receiving.then(accepted);
  await captureEntered;
  expect(enrollment.find).toHaveBeenCalledWith({
    tenantId: 'tenant-demo',
    siteId: 'site-home',
    deviceId: 'meter',
  });
  expect(telemetry.capture).toHaveBeenCalledWith(
    expect.objectContaining({ deviceId: 'meter', readings: expect.any(Array) }),
    expect.objectContaining({ id: 'meter', trustStatus: 'approved', kind: 'physical' }),
    'energrid-native',
  );
  expect(accepted).not.toHaveBeenCalled();
  commit();
  await receiving;
  expect(accepted).toHaveBeenCalled();
  expect(service.getDebugState().recentMessages[0]).toEqual(expect.objectContaining({
    payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
    validJson: true,
    handled: true,
  }));
  await service.onModuleDestroy();
  expect(subscriber.stop).toHaveBeenCalledTimes(1);
});
it('keeps the existing CLI live-state path when recording is disabled', async () => {
  const { service, child } = setup(false);
  await service.onModuleInit();
  expect(spawn).toHaveBeenCalled();
  expect(DurableMqttSubscriber).not.toHaveBeenCalled();
  child.stdout.emit(
    'data',
    Buffer.from('bad-line\nenergrid/tenant-demo/site-home/unknown {}\n'),
  );
  expect(service.getDebugState().status).toBe('running');
  await service.onModuleDestroy();
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it('starts neither transport when MQTT ingestion is disabled and does not invent a client identity', async () => {
  const { service } = setup(true);
  process.env.HOME_MQTT_INGEST_ENABLED = 'false';
  await service.onModuleInit();
  expect(spawn).not.toHaveBeenCalled();
  expect(DurableMqttSubscriber).not.toHaveBeenCalled();
  process.env.HOME_MQTT_INGEST_ENABLED = 'true';
  delete process.env.HOME_MQTT_CLIENT_ID;
  await expect(service.onModuleInit()).rejects.toThrow('CLIENT_ID');
  await service.onModuleDestroy();
});
