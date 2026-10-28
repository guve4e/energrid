import type { DeviceRegistryService } from '../device-registry.service';
import type { MqttEvidenceCaptureService } from './mqtt-evidence-capture.service';

import { MqttEvidenceDiscoveryService } from './mqtt-evidence-discovery.service';
import { ShellyMqttAdapter } from '../adapters/inbound/shelly/shelly-mqtt.adapter';
import { shellyPro2PmNotifyStatusFixture } from '../adapters/inbound/shelly/__fixtures__/shelly-pro2pm-notifystatus.fixture';

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
      registerDiscoveredDevice: jest.fn((_candidate: Parameters<DeviceRegistryService['registerDiscoveredDevice']>[0]) => true),
    };

    const capture = {
      listConfiguredBindings: jest.fn(() => [{ scope, deviceId: 'temp-kitchen', topic: 'devices/temp-kitchen/data' }]),
      getConfiguredBindingForTopic: jest.fn((topic: string) => topic === 'devices/temp-kitchen/data'
        ? { scope, deviceId: 'temp-kitchen', topic }
        : null),
      getConfiguredSources: jest.fn(() => [
        {
          deviceId: 'temp-kitchen',
          topic: 'devices/temp-kitchen/data',
        },
      ]),
      readInvestigationEvidence: jest.fn().mockResolvedValue({
        snapshot: {
          schemaVersion: 1,
          deviceId: 'temp-kitchen',
          createdAt: '2026-10-28T15:41:00.000Z',
          evidence: samples.map((_, index) => ({
            id: `capture-${index}`,
            source: 'mqtt' as const,
            attribute: 'captured-message',
            value: 'devices/temp-kitchen/data',
            observedAt: `2026-10-28T15:4${index}:00.000Z`,
            confidence: 'observed' as const,
          })),
        },
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
          mqttObservedAt: '2026-10-28T15:40:00.000Z',
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

    const candidate = registry.registerDiscoveredDevice.mock.calls[0]?.[0];
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Expected an unverified MQTT candidate');

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

    const candidate = registry.registerDiscoveredDevice.mock.calls[0]?.[0];
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Expected a candidate for observed evidence');

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
      registerDiscoveredDevice: jest.fn((_candidate: Parameters<DeviceRegistryService['registerDiscoveredDevice']>[0]) => true),
    };

    const capture = {
      listConfiguredBindings: jest.fn(() => [{ scope, deviceId: 'temp-garage', topic: 'devices/temp-garage/data' }]),
      getConfiguredBindingForTopic: jest.fn((topic: string) => topic === 'devices/temp-garage/data'
        ? { scope, deviceId: 'temp-garage', topic }
        : null),
      getConfiguredSources: jest.fn(() => [
        {
          deviceId: 'temp-garage',
          topic: 'devices/temp-garage/data',
        },
      ]),
      readInvestigationEvidence: jest.fn().mockResolvedValue({
        snapshot: {
          schemaVersion: 1,
          deviceId: 'temp-garage',
          createdAt: '2026-10-28T15:40:00.000Z',
          evidence: [],
        },
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
      snapshot: {
        schemaVersion: 1,
        deviceId: 'temp-garage',
        createdAt: '2026-10-28T15:41:00.000Z',
        evidence: [
          {
            id: 'older', source: 'mqtt', attribute: 'captured-message',
            value: 'devices/temp-garage/data', observedAt: '2026-10-28T15:40:00.000Z',
            confidence: 'observed',
          },
          {
            id: 'newer', source: 'mqtt', attribute: 'captured-message',
            value: 'devices/temp-garage/data', observedAt: '2026-10-28T15:41:00.000Z',
            confidence: 'observed',
          },
        ],
      },
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
          mqttObservedAt: '2026-10-28T15:41:00.000Z',
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

describe('Shelly Add Devices projection', () => {
  const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
  const topic = 'shelly/washer@other/events/rpc';
  const physicalId = 'shellypro2pm-ec6260888084';
  const adapter = new ShellyMqttAdapter();

  function fixture({ enrolled = [] as string[], bound = true } = {}) {
    const registry = {
      ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(() => ({ tenant: { id: scope.tenantId }, site: { id: scope.siteId } })),
      getDevices: jest.fn(() => enrolled.map(id => ({
        id, tenantId: scope.tenantId, siteId: scope.siteId,
        trustStatus: 'approved', metadata: { physicalId },
      }))),
      registerDiscoveredDevice: jest.fn((_candidate: Parameters<DeviceRegistryService['registerDiscoveredDevice']>[0]) => true),
    };
    const capture = {
      listConfiguredBindings: jest.fn(() => bound ? [{ scope, deviceId: 'washer-source', topic }] : []),
      getConfiguredBindingForTopic: jest.fn((candidateTopic: string) =>
        bound && candidateTopic === topic ? { scope, deviceId: 'washer-source', topic } : null),
      getConfiguredSources: jest.fn(() => []),
      readInvestigationEvidence: jest.fn().mockResolvedValue({ samples: [] }),
    };
    let record: Record<string, unknown> | null = null;
    const inventory = {
      discover: jest.fn(async (input: Record<string, any>) => {
        const existing = record as any;
        const components = new Map<string, any>((existing?.components ?? []).map((component: any) => [component.key, component]));
        for (const component of input.components) components.set(component.key, {
          ...component, firstSeenAt: existing?.components?.find((item: any) => item.key === component.key)?.firstSeenAt || input.observedAt,
          lastSeenAt: input.observedAt,
        });
        const endpoints = new Map<string, any>((existing?.endpoints ?? []).map((endpoint: any) => [endpoint.address, endpoint]));
        if (input.endpoint) endpoints.set(input.endpoint.address, { ...input.endpoint, lastSeenAt: input.observedAt });
        record = {
          physicalDeviceId: 'inventory-record-1', scope, identity: input.identity,
          identityEvidenceSource: input.evidenceSource, verificationStatus: 'protocol_observed',
          firstSeenAt: existing?.firstSeenAt ?? input.observedAt, lastSeenAt: input.observedAt,
          components: [...components.values()], endpoints: [...endpoints.values()],
          networkObservations: [], assignments: [],
        };
        return record;
      }),
      list: jest.fn(async () => record ? [record] : []),
    };
    const service = new MqttEvidenceDiscoveryService(
      capture as unknown as MqttEvidenceCaptureService,
      registry as unknown as DeviceRegistryService,
      inventory as any,
    );
    return { service, registry, capture, inventory };
  }

  function notifyStatus() {
    const result = adapter.handle({
      topic,
      payload: shellyPro2PmNotifyStatusFixture,
      payloadText: '',
    });
    return result!.physicalDiscoveries!;
  }

  it('shows a site-attributed two-channel Shelly as one claimed physical identity with two unverified components', async () => {
    const { service, registry, inventory } = fixture();
    const discoveries = notifyStatus();
    const records = await service.projectShellyMessage(topic, discoveries);

    expect(discoveries).toHaveLength(2);
    expect(inventory.discover).toHaveBeenCalledTimes(2);
    expect(inventory.discover).toHaveBeenCalledWith(expect.objectContaining({ scope, evidenceSource: 'mqtt_protocol_message' }));
    expect(records?.[0].identity).toEqual({ namespace: 'mqtt:shelly-protocol-id', value: physicalId });
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledTimes(2);
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledWith(expect.objectContaining({
      id: `${physicalId}:switch:0`, tenantId: scope.tenantId, siteId: scope.siteId,
      capabilities: ['power', 'switch'],
      metadata: expect.objectContaining({ identityEvidenceSource: 'mqtt-claimed-protocol-id', verificationStatus: 'unverified' }),
    }));
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledWith(expect.objectContaining({ id: `${physicalId}:switch:1` }));
  });

  it('does not re-surface an enrolled component as an onboarding candidate', async () => {
    const { service, registry } = fixture({ enrolled: [`${physicalId}:switch:0`, `${physicalId}:switch:1`] });
    await service.projectShellyMessage(topic, notifyStatus());
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled();
  });

  it('keeps unbound or unscoped Shelly claims out of authorized inventory and candidates', async () => {
    const { service, registry, inventory } = fixture({ bound: false });
    expect(await service.projectShellyMessage(topic, notifyStatus())).toBeNull();
    expect(inventory.discover).not.toHaveBeenCalled();
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled();
  });

  it('restores candidate visibility from scoped Physical Inventory after service restart', async () => {
    const { service, registry, inventory } = fixture();
    await service.projectShellyMessage(topic, notifyStatus());
    registry.registerDiscoveredDevice.mockClear();
    const restarted = new MqttEvidenceDiscoveryService(
      {
        listConfiguredBindings: () => [{ scope, deviceId: 'washer-source', topic }],
        getConfiguredBindingForTopic: () => ({ scope, deviceId: 'washer-source', topic }),
        getConfiguredSources: () => [],
        readInvestigationEvidence: async () => ({ samples: [] }),
      } as unknown as MqttEvidenceCaptureService,
      registry as unknown as DeviceRegistryService,
      inventory as any,
    );
    await restarted.onModuleInit();
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledTimes(2);
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledWith(expect.objectContaining({
      id: `${physicalId}:switch:0`, metadata: expect.objectContaining({ verificationStatus: 'unverified' }),
    }));
  });

  it('does not restore a legacy Home inventory claim without an exact topic binding', async () => {
    const { service, registry, inventory } = fixture();
    await service.projectShellyMessage(topic, notifyStatus());
    registry.registerDiscoveredDevice.mockClear();

    const restarted = new MqttEvidenceDiscoveryService(
      {
        // An unrelated, authorized Home binding makes the Home inventory
        // scope readable, but does not authorize this Shelly topic.
        listConfiguredBindings: () => [{
          scope, deviceId: 'temp-kitchen', topic: 'devices/temp-kitchen/data',
        }],
        getConfiguredBindingForTopic: () => null,
        getConfiguredSources: () => [],
        readInvestigationEvidence: async () => ({ samples: [] }),
      } as unknown as MqttEvidenceCaptureService,
      registry as unknown as DeviceRegistryService,
      inventory as any,
    );

    await restarted.onModuleInit();

    expect(inventory.list).toHaveBeenCalledWith(scope);
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled();
  });
});
