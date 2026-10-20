import { DeviceMqttIngestService } from './device-mqtt-ingest.service';
import { DurableMqttSubscriber } from './mqtt/durable-mqtt-subscriber';

describe('MQTT startup waits for observation recovery', () => {
  const originalEnv = process.env.HOME_MQTT_INGEST_ENABLED;
  const originalClientId = process.env.HOME_MQTT_CLIENT_ID;

  let startSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.HOME_MQTT_INGEST_ENABLED = 'true';
    process.env.HOME_MQTT_CLIENT_ID = 'energrid-recovery-test';

    // Prevent a real MQTT connection.
    startSpy = jest
      .spyOn(DurableMqttSubscriber.prototype, 'start')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HOME_MQTT_INGEST_ENABLED;
    } else {
      process.env.HOME_MQTT_INGEST_ENABLED = originalEnv;
    }

    if (originalClientId === undefined) {
      delete process.env.HOME_MQTT_CLIENT_ID;
    } else {
      process.env.HOME_MQTT_CLIENT_ID = originalClientId;
    }

    jest.restoreAllMocks();
  });

  function makeService(recover: () => Promise<void>) {
    // Focus on the actual lifecycle method without creating
    // NestJS dependencies, starting sockets, or opening databases.
    const service = Object.create(
      DeviceMqttIngestService.prototype,
    ) as DeviceMqttIngestService;

    const internal = service as any;

    internal.approvedObservations = {
      recover,
    };

    internal.messageRouter = {
      legacyTemperatureTopics: jest.fn(() => []),
      legacyDeviceTopics: jest.fn(() => []),
      subscriptions: jest.fn(() => []),
    };

    // Select the durable branch and mock its start method.
    // No network activity occurs.
    internal.telemetry = {
      status: jest.fn(() => ({ enabled: true })),
    };

    internal.logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    internal.operationalLog = {
      record: jest.fn(),
    };

    return service;
  }

  it('does not subscribe until recovery finishes', async () => {
    let finishRecovery!: () => void;

    const pendingRecovery = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });

    const recover = jest.fn(() => pendingRecovery);

    const service = makeService(recover);

    const startup = service.onModuleInit();

    expect(recover).toHaveBeenCalledTimes(1);

    // Recovery hasn't completed.
    expect(startSpy).not.toHaveBeenCalled();

    // Allow recovery to complete.
    finishRecovery();

    await startup;

    // MQTT may start only after recovery succeeds.
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('never starts MQTT when recovery fails', async () => {
    const recover = jest.fn(async () => {
      throw new Error('Observation recovery failed');
    });

    const service = makeService(recover);

    await expect(service.onModuleInit()).rejects.toThrow(
      'Observation recovery failed',
    );

    expect(recover).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
