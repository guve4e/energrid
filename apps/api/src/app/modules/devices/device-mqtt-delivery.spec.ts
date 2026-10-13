import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { DeviceMqttIngestService } from './device-mqtt-ingest.service';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceObservationService } from './device-observation.service';
import { OperationalLogService } from './operational-log.service';
import { TelemetryIngestService } from '../telemetry/telemetry-ingest.service';
import { DurableMqttSubscriber } from './mqtt/durable-mqtt-subscriber';

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
const setup = (enabled: boolean) => {
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
  const service = new DeviceMqttIngestService(
    new DeviceRegistryService(),
    new OperationalLogService(),
    new DeviceObservationService(),
    telemetry as unknown as TelemetryIngestService,
  );
  return { service, subscriber, child, telemetry };
};

it('selects the acknowledged transport only for enabled new recording, keeping multiline payloads intact', async () => {
  const { service, subscriber, telemetry } = setup(true);
  service.onModuleInit();
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
  telemetry.capture.mockReturnValue(
    new Promise((resolve) => {
      commit = resolve;
    }),
  );
  const accepted = jest.fn();
  const receiving = receive(
    'energrid/tenant-demo/site-home/devices/meter/telemetry',
    '{\n"deviceId":"meter",\n"readings":[]\n}',
  );
  void receiving.then(accepted);
  await Promise.resolve();
  expect(telemetry.capture).toHaveBeenCalled();
  expect(accepted).not.toHaveBeenCalled();
  commit();
  await receiving;
  expect(accepted).toHaveBeenCalled();
  await service.onModuleDestroy();
  expect(subscriber.stop).toHaveBeenCalledTimes(1);
});
it('keeps the existing CLI live-state path when recording is disabled', async () => {
  const { service, child } = setup(false);
  service.onModuleInit();
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
  service.onModuleInit();
  expect(spawn).not.toHaveBeenCalled();
  expect(DurableMqttSubscriber).not.toHaveBeenCalled();
  process.env.HOME_MQTT_INGEST_ENABLED = 'true';
  delete process.env.HOME_MQTT_CLIENT_ID;
  expect(() => service.onModuleInit()).toThrow('CLIENT_ID');
  await service.onModuleDestroy();
});
