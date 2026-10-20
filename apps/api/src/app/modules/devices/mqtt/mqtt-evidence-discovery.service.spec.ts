import type { DeviceRegistryService } from '../device-registry.service';
import type { MqttEvidenceCaptureService } from './mqtt-evidence-capture.service';

import { MqttEvidenceDiscoveryService } from './mqtt-evidence-discovery.service';

describe('MqttEvidenceDiscoveryService', () => {
  const scope = {
    tenantId: 'tenant-demo',
    siteId: 'site-home',
  };

  function harness(samples: Array<{ payload: Record<string, unknown> }>) {
    const registry = {
      ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(() => ({
        tenant: { id: scope.tenantId },
        site: { id: scope.siteId },
      })),
      registerDiscoveredDevice: jest.fn(() => true),
    };

    const capture = {
      getConfiguredSources: jest.fn(() => [
        {
          deviceId: 'temp-kitchen',
          topic: 'devices/temp-kitchen/data',
        },
      ]),
      readInvestigationEvidence: jest.fn().mockResolvedValue({
        samples,
      }),
    };

    const service = new MqttEvidenceDiscoveryService(
      capture as unknown as MqttEvidenceCaptureService,
      registry as unknown as DeviceRegistryService,
    );

    return { service, registry, capture };
  }

  it('registers a captured sensor as an untrusted candidate', async () => {
    const { service, registry } = harness([
      { payload: { temperature: 24.7, humidity: 41.7 } },
    ]);

    await service.onModuleInit();

    expect(registry.registerDiscoveredDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'temp-kitchen',
        source: 'mqtt',
        protocol: 'mqtt',
        target: 'devices/temp-kitchen/data',
        capabilities: ['temperature', 'humidity'],
        metadata: expect.objectContaining({
          mqttEvidenceCandidate: true,
        }),
      }),
    );
  });

  it('does not register sources without captured samples', async () => {
    const { service, registry } = harness([]);

    await service.onModuleInit();

    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled();
  });

  it('does not grant commands or observation authority', async () => {
    const { service, registry } = harness([
      { payload: { temperature: 25.1 } },
    ]);

    await service.onModuleInit();

    const candidate =
      registry.registerDiscoveredDevice.mock.calls[0][0];

    expect(candidate.capabilities).toEqual(['temperature']);
    expect(candidate).not.toHaveProperty('control');
    expect(candidate).not.toHaveProperty('trustStatus', 'approved');
    expect(candidate).not.toHaveProperty('observationBinding');
  });

  it('does not invent capabilities from malformed readings', async () => {
    const { service, registry } = harness([
      { payload: { temperature: 'unknown', humidity: null } },
    ]);

    await service.onModuleInit();

    const candidate =
      registry.registerDiscoveredDevice.mock.calls[0][0];

    expect(candidate.capabilities).toEqual([]);
  });
});

describe('MQTT discovery after startup', () => {
  it('registers a candidate when evidence arrives after initialization', async () => {
    const scope = {
      tenantId: 'tenant-demo',
      siteId: 'site-home',
    };

    const registry = {
      ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(() => ({
        tenant: { id: scope.tenantId },
        site: { id: scope.siteId },
      })),
      registerDiscoveredDevice: jest.fn(() => true),
    };

    const capture = {
      getConfiguredSources: jest.fn(() => [
        {
          deviceId: 'temp-garage',
          topic: 'devices/temp-garage/data',
        },
      ]),
      readInvestigationEvidence: jest.fn().mockResolvedValue({
        samples: [],
      }),
    };

    const service = new MqttEvidenceDiscoveryService(
      capture as unknown as MqttEvidenceCaptureService,
      registry as unknown as DeviceRegistryService,
    );

    // Startup: source configured but no captured evidence.
    await service.onModuleInit();

    expect(registry.registerDiscoveredDevice)
      .not.toHaveBeenCalled();

    // A valid MQTT message is subsequently captured.
    capture.readInvestigationEvidence.mockResolvedValue({
      samples: [
        {
          payload: {
            temperature: 18.8,
            humidity: 52.4,
          },
        },
      ],
    });

    // The MQTT ingest service notifies Discovery.
    await Promise.all([
      service.refreshForTopic('devices/temp-garage/data'),
      service.refreshForTopic('devices/temp-garage/data'),
    ]);

    expect(registry.registerDiscoveredDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'temp-garage',
        source: 'mqtt',
        capabilities: ['temperature', 'humidity'],
        metadata: expect.objectContaining({
          mqttEvidenceCandidate: true,
        }),
      }),
    );

    // Repeated messages must not create duplicate candidates.
    await service.refreshForTopic('devices/temp-garage/data');

    expect(registry.registerDiscoveredDevice)
      .toHaveBeenCalledTimes(1);

    // An unrelated topic must not trigger investigation.
    await service.refreshForTopic('devices/unknown/data');

    expect(capture.readInvestigationEvidence)
      .toHaveBeenCalledTimes(2);
  });
});
