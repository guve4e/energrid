import { DeviceRegistryService } from './device-registry.service';
import { runWithAuthorizedPortalSite } from '../portal/portal-site-context';

describe('DeviceRegistryService', () => {
  it('does not infer offline from missing configuration or missing observations', () => {
    const snapshot = new DeviceRegistryService().getSnapshot();
    const unobserved = snapshot.devices.filter(d => d.state.observedAt === null);
    expect(unobserved.length).toBeGreaterThan(0);
    expect(unobserved.every(d => d.state.status === 'unknown')).toBe(true);
  });
  it('keeps verified measurement support separate from observation authorization', () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      deviceId: 'sensor-device', protocol: 'http', driver: 'energrid-esp8266',
      capabilities: ['temperature', 'humidity'],
      metadata: { observationApprovalRequired: true },
    }] });
    const device = new DeviceRegistryService().getSnapshot().devices.find(item => item.id === 'sensor-device');
    expect(device?.supportedCapabilities?.map(capability => capability.kind)).toEqual(['temperature', 'humidity']);
    expect(device?.capabilities).toEqual([]);
  });
  it('leaves an unknown device without invented switch or measurement capabilities', () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{ deviceId: 'unclassified-unit', protocol: 'none', capabilities: [] }] });
    const device = new DeviceRegistryService().getSnapshot().devices.find(item => item.id === 'unclassified-unit');
    expect(device?.supportedCapabilities).toEqual([]);
    expect(device?.capabilities).toEqual([]);
  });
  it('refreshes only Shelly verification metadata on an existing enrollment', async () => {
    const physicalId = 'shellyplus1-00c0de000001';
    const component = 'switch:0';
    const deviceId = `${physicalId}:${component}`;
    const verifiedAt = new Date().toISOString();
    process.env.PORTAL_TENANT_ID = 'tenant-demo';
    process.env.PORTAL_SITE_ID = 'site-virtual-lab';
    process.env.PORTAL_SITE_NAME = 'Virtual Device Lab';
    const authority = { source: 'existing-authority', bindings: [] };
    const initialDevice = {
      id: deviceId, tenantId: 'tenant-demo', siteId: 'site-virtual-lab', displayName: 'Virtual Shelly',
      trustStatus: 'approved', kind: 'physical', zoneId: 'unassigned', zoneName: 'Unassigned',
      adapter: { protocol: 'http', transport: 'http', driver: 'shelly-lan', target: 'http://172.30.250.11/rpc', configured: true },
      capabilities: [{ kind: 'switch', actions: ['read'] }], supportedCapabilities: [{ kind: 'switch', actions: ['read'] }],
      control: { status: 'unavailable' }, assistantEnabled: false,
      metadata: { approvedFromDiscovery: true, physicalId, component,
        identityEvidenceSource: 'claimed_mqtt_identity', discoveryTenantId: 'tenant-demo', discoverySiteId: 'site-virtual-lab' },
      state: { values: {}, observedAt: null, status: 'unknown' },
    } as any;
    const record = { schemaVersion: 1, device: initialDevice, observationAuthority: authority,
      physicalOutcome: { status: 'not_confirmed', confirmedAt: null, confirmedBy: null }, updatedAt: verifiedAt };
    let saved: any = record;
    const store = { listAll: jest.fn(async () => [record]), save: jest.fn(async value => { saved = value; }), append: jest.fn() };
    const enrollment = { list: jest.fn(async () => [{ deviceId, status: 'enrolled' }]),
      find: jest.fn(async () => ({ status: 'enrolled' })) };
    const registry = new DeviceRegistryService(undefined, store as any, enrollment as any);
    await registry.ensureInstallationsLoaded();
    const result = await registry.refreshShellyVerificationEvidence({
      tenantId: 'tenant-demo', siteId: 'site-virtual-lab', deviceId, physicalId, component,
      physicalInventoryId: '3e709572-76c5-4d5f-8c89-ec23a8d7c55b', ipAddress: '172.30.250.11',
      networkScope: 'observer-lab:virtual-device-lab', identityVerifiedAt: verifiedAt,
      componentVerifiedAt: verifiedAt, observerId: 'virtual-observer',
    });
    expect(result?.metadata).toEqual(expect.objectContaining({
      identityEvidenceSource: 'verified_site_local_shelly_rpc',
      componentEvidenceSource: 'verified_site_local_shelly_rpc', physicalId, component,
    }));
    expect(saved.device.zoneName).toBe('Unassigned');
    expect(saved.device.capabilities).toEqual(initialDevice.capabilities);
    expect(saved.device.assistantEnabled).toBe(false);
    expect(saved.device.observationAuthority).toBeUndefined();
    expect(saved.observationAuthority).toBe(authority);
    expect(saved.device.metadata).not.toHaveProperty('measurementApproval');
    expect(result?.metadata).not.toHaveProperty('controlBinding');
  });
  afterEach(() => {});

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON;
    delete process.env.HOME_ASSISTANT_ENABLED_DEVICE_IDS;
    delete process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES;
    delete process.env.HOME_KITCHEN_LIGHT_MQTT_TOPIC;
    delete process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC;
    delete process.env.HOME_DISCOVERED_DEVICES_JSON;
    delete process.env.HOME_APPROVED_DEVICES_JSON;
    delete process.env.HOME_DEVICE_REGISTRY_JSON;
    delete process.env.DEVICE_REGISTRY_JSON;
    delete process.env.PORTAL_TENANT_ID;
    delete process.env.PORTAL_SITE_ID;
    delete process.env.PORTAL_SITE_NAME;
    delete process.env.HOME_GATEWAY_ID;
    delete process.env.PORTAL_KITCHEN_TEMP_C;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns a device-first snapshot with logical and physical devices', () => {
    process.env.PORTAL_KITCHEN_TEMP_C = '23.6';
    process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES =
      'kitchen.light.wall.led:shellyplus1-cc7b5c0ea5f8:0,kitchen.light.island.led:shellyplus1-78ee4ccf5cf0:0,kitchen.light.cans:shellyplus1-78ee4ccf4268:0';

    const snapshot = new DeviceRegistryService().getSnapshot();
    const group = snapshot.devices.find(
      (device) => device.id === 'kitchen_light',
    );
    const temperature = snapshot.devices.find(
      (device) => device.id === 'kitchen_temperature',
    );

    expect(group).toEqual(
      expect.objectContaining({
        displayName: 'Kitchen lights',
        kind: 'logical',
        memberDeviceIds: [
          'kitchen.light.wall.led',
          'kitchen.light.island.led',
          'kitchen.light.cans',
        ],
      }),
    );
    expect(group?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'mqtt',
        driver: 'shelly-rpc',
        configured: true,
      }),
    );
    expect(temperature?.state.values.temperature).toBe(23.6);
    expect(snapshot.summary).toEqual({
      total: 5,
      approved: 5,
      discovered: 0,
      controllable: 0,
      sensors: 1,
      systems: 5,
      learningEnabled: 5,
    });
    expect(snapshot.systems.map((system) => system.id)).toEqual(
      expect.arrayContaining([
        'floor_heating',
        'fan_coils',
        'refrigerator_inventory',
        'forecast_optimizer',
      ]),
    );
  });

  it('falls back to simulated devices while hardware adapters are not configured', () => {
    const snapshot = new DeviceRegistryService().getSnapshot();
    const group = snapshot.devices.find(
      (device) => device.id === 'kitchen_light',
    );

    expect(group?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'simulated',
        configured: false,
      }),
    );
    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.systems).toBe(5);
  });

  it('keeps discovered devices out of approved control until onboarding', () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([
      {
        id: 'shellyplus1-new',
        displayName: 'Shelly Plus 1',
        suggestedRoom: 'Kitchen',
        suggestedName: 'Kitchen cabinet light',
        protocol: 'mqtt',
        driver: 'shelly-rpc',
        target: 'shellyplus1-new',
        capabilities: ['light'],
        confidence: 0.84,
        reason: 'Shelly device announced on the local MQTT network.',
      },
    ]);

    const service = new DeviceRegistryService();
    const snapshot = service.getSnapshot();
    const discovered = snapshot.devices.find(
      (device) => device.id === 'shellyplus1-new',
    );

    expect(discovered).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        adapter: expect.objectContaining({
          protocol: 'mqtt',
          configured: false,
        }),
        discovery: expect.objectContaining({
          suggestedRoom: 'Kitchen',
          confidence: 0.84,
        }),
      }),
    );
    expect(service.getAvailableDeviceIds()).not.toContain('shellyplus1-new');
    expect(snapshot.summary.discovered).toBe(1);
  });

  it('requires explicit assistant permission and a ready route before exposing a physical light to voice', () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      id: 'office.desk_lamp',
      displayName: 'Desk lamp',
      zoneName: 'Office',
      protocol: 'mqtt',
      driver: 'shelly-rpc',
      target: 'shellyplus1-desk',
      capabilities: ['switch'],
      configured: true,
      assistantEnabled: false,
      metadata: { physicalId: 'shellyplus1-desk', channel: 0 },
    }] });
    process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = JSON.stringify({
      'office.desk_lamp': {
        kind: 'shelly-mqtt',
        enabled: true,
        physicalId: 'shellyplus1-desk',
        channel: 0,
        topic: 'shelly/rpc',
      },
    });

    expect(new DeviceRegistryService().getAvailableDeviceIds()).not.toContain('office.desk_lamp');

    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      id: 'office.desk_lamp',
      displayName: 'Desk lamp',
      zoneName: 'Office',
      protocol: 'mqtt',
      driver: 'shelly-rpc',
      target: 'shellyplus1-desk',
      capabilities: ['switch'],
      configured: true,
      assistantEnabled: true,
      metadata: { physicalId: 'shellyplus1-desk', channel: 0 },
    }] });
    const enabled = new DeviceRegistryService();
    expect(enabled.getAvailableDeviceIds()).toContain('office.desk_lamp');
  });

  it('approves and blocks discovered devices from onboarding', () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([
      {
        id: 'shelly-new-channel',
        displayName: 'Shelly new channel',
        suggestedRoom: 'Kitchen',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-rpc',
        target: 'shellyplus1-new',
        capabilities: ['switch'],
        confidence: 0.8,
      },
      {
        id: 'shelly-ignore-channel',
        displayName: 'Shelly ignore channel',
        protocol: 'mqtt',
        capabilities: ['power'],
      },
    ]);

    const service = new DeviceRegistryService();

    const approved = service.approveDiscoveredDevice('shelly-new-channel');
    expect(approved).toEqual(
      expect.objectContaining({
        id: 'shelly-new-channel',
        trustStatus: 'approved',
        zoneName: 'Kitchen',
        adapter: expect.objectContaining({
          configured: true,
          target: 'shellyplus1-new',
        }),
      }),
    );

    expect(service.blockDiscoveredDevice('shelly-ignore-channel')).toBe(true);

    const snapshot = service.getSnapshot();
    expect(
      snapshot.devices.find((device) => device.id === 'shelly-new-channel')
        ?.trustStatus,
    ).toBe('approved');
    expect(
      snapshot.devices.find((device) => device.id === 'shelly-ignore-channel'),
    ).toBeUndefined();
    expect(snapshot.summary.discovered).toBe(0);
  });

  it('keeps Energrid measurements unauthorized after explicit inventory enrollment', () => {
    const registry = new DeviceRegistryService();
    registry.registerDiscoveredDevice({
      id: 'device:upstream-lan:esp8266:324864',
      displayName: 'Energrid ESP8266 DHT22',
      protocol: 'http', transport: 'http', driver: 'energrid-esp8266',
      target: 'http://192.168.1.198/api/v1/status',
      capabilities: ['temperature', 'humidity'],
      metadata: { physicalId: 'esp8266:324864', observationApprovalRequired: true },
    });
    const approved = registry.approveDiscoveredDevice('device:upstream-lan:esp8266:324864', {
      zoneId: 'office', zoneName: 'Office',
    });
    expect(approved).toEqual(expect.objectContaining({ trustStatus: 'approved', zoneId: 'office', zoneName: 'Office' }));
    expect(approved?.capabilities).toEqual([]);
  });

  it('updates a repeated scoped Energrid discovery record instead of creating duplicate candidates', () => {
    const registry = new DeviceRegistryService();
    const id = 'device:upstream-lan:esp8266:324864';
    const candidate = (ipAddress: string) => ({
      id, displayName: 'Energrid ESP8266 DHT22', protocol: 'http' as const, driver: 'energrid-esp8266',
      target: `http://${ipAddress}/api/v1/status`, capabilities: ['temperature' as const, 'humidity' as const],
      metadata: { physicalId: 'esp8266:324864', ipAddress, networkScope: 'upstream-lan', observationApprovalRequired: true },
    });
    registry.registerDiscoveredDevice(candidate('192.168.1.198'));
    registry.registerDiscoveredDevice(candidate('192.168.1.211'));
    const matches = registry.getSnapshot().devices.filter(device => device.id === id);
    expect(matches).toHaveLength(1);
    expect(matches[0].adapter.target).toBe('http://192.168.1.211/api/v1/status');
  });

  it('keeps Home inventory and discovery candidates isolated from the Virtual Device Lab site', () => {
    const registry = new DeviceRegistryService();
    const homeOwner = { tenantId: 'tenant-demo', siteId: 'site-home', siteName: 'Home', mode: 'home' as const };
    const labOwner = { tenantId: 'tenant-demo', siteId: 'site-device-lab', siteName: 'Virtual Device Lab', mode: 'home' as const };
    const labCandidate = {
      id: 'simulated-esp8266', displayName: 'Virtual ESP8266',
      tenantId: labOwner.tenantId, siteId: labOwner.siteId, siteName: labOwner.siteName,
      protocol: 'http' as const, transport: 'http' as const, driver: 'energrid-esp8266',
      target: 'http://172.30.250.10/api/v1/status', capabilities: ['temperature' as const],
      metadata: { discoveryTenantId: labOwner.tenantId, discoverySiteId: labOwner.siteId },
    };

    runWithAuthorizedPortalSite(labOwner, () => {
      expect(registry.registerDiscoveredDevice(labCandidate)).toBe(true);
      expect(registry.getSnapshot().devices.map(device => device.id)).toContain(labCandidate.id);
      expect(registry.getSnapshot().devices.every(device => device.siteId === labOwner.siteId)).toBe(true);
    });

    runWithAuthorizedPortalSite(homeOwner, () => {
      const snapshot = registry.getSnapshot();
      expect(snapshot.devices.some(device => device.id === labCandidate.id)).toBe(false);
      expect(snapshot.devices.every(device => device.siteId === homeOwner.siteId)).toBe(true);
      expect(snapshot.summary.total).toBe(2);
    });

    runWithAuthorizedPortalSite(labOwner, () => {
      expect(registry.getSnapshot().devices.map(device => device.id)).toContain(labCandidate.id);
    });
  });

  it('restores an approved installation and its assigned room after a restart', async () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([{
      id: 'shellyplus1-installed:switch:0',
      displayName: 'Shelly switch',
      protocol: 'mqtt',
      transport: 'mqtt',
      driver: 'shelly-discovered',
      target: 'shellyplus1-installed',
      capabilities: ['switch'],
      confidence: 0.9,
      reason: 'Unit test fixture',
    }]);
    const records = new Map<string, any>();
    const store = {
      list: jest.fn(async () => [...records.values()]),
      listAll: jest.fn(async () => [...records.values()]),
      save: jest.fn(async (record) => { records.set(record.device.id, record); }),
      append: jest.fn().mockResolvedValue(undefined),
      events: jest.fn().mockResolvedValue([]),
    };
    const first = new DeviceRegistryService(undefined, store as any);
    const approved = first.approveDiscoveredDevice('shellyplus1-installed:switch:0');
    expect(approved?.trustStatus).toBe('approved');
    const named = await first.updateInstallationDetails(
      approved!.id,
      'Hall relay',
      'Hall',
      true,
      'http://192.168.1.21',
    );
    await first.persistInstallation(named, true);

    // Relay state is a live operational observation, held separately from the
    // durable installation. A restart must restore enrollment and placement,
    // but must not present the prior process's output as current.
    first.ingestDeviceTelemetry({
      deviceId: approved!.id, protocol: 'http', driver: 'shelly-lan',
      values: { output: true }, observedAt: '2026-10-31T10:00:00.000Z',
      state: { source: 'site-local-http-rpc:lab-observer', status: 'online', values: { output: true } },
    });
    expect(first.getDevices().find(device => device.id === approved!.id)?.state).toMatchObject({
      values: { output: true }, observedAt: '2026-10-31T10:00:00.000Z', status: 'online',
    });

    const restarted = new DeviceRegistryService(undefined, store as any);
    await restarted.onModuleInit();
    expect(restarted.getDevices()).toContainEqual(expect.objectContaining({
      id: approved!.id,
      trustStatus: 'approved',
      displayName: 'Hall relay',
      zoneName: 'Hall',
      assistantEnabled: true,
      settingsUrl: 'http://192.168.1.21',
      commissioning: { physicalOutcome: 'not_confirmed', confirmedAt: null },
    }));
    expect(restarted.getDevices().find(device => device.id === approved!.id)?.state).toMatchObject({
      values: {}, observedAt: null, source: 'device-store', status: 'unknown',
    });
    expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approved' }));
  });

  it('keeps Unicode room names addressable in the normalized zone ID', async () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([{
      id: 'shellyplus1-bulgarian:switch:0',
      displayName: 'Relay',
      protocol: 'mqtt',
      driver: 'shelly-discovered',
      target: 'shellyplus1-bulgarian',
      capabilities: ['switch'],
    }]);
    const store = {
      list: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
      append: jest.fn().mockResolvedValue(undefined),
      events: jest.fn().mockResolvedValue([]),
    };
    const registry = new DeviceRegistryService(undefined, store as any);
    const approved = registry.approveDiscoveredDevice('shellyplus1-bulgarian:switch:0')!;
    await expect(registry.updateInstallationDetails(approved.id, 'Реле', 'Детска стая'))
      .resolves.toEqual(expect.objectContaining({ zoneId: 'детска-стая' }));
  });

  it('tracks a pending command until matching telemetry acknowledges it', () => {
    const service = new DeviceRegistryService();

    const pending = service.markDeviceCommandPending('kitchen_light', {
      action: 'turn_on',
      expectedValues: { on: true },
      ttlMs: 5000,
    });

    expect(pending).toEqual(
      expect.objectContaining({
        status: 'pending',
        expectedValues: { on: true },
      }),
    );
    expect(
      service
        .getSnapshot()
        .devices.find((device) => device.id === 'kitchen_light')?.state.command,
    ).toEqual(expect.objectContaining({ status: 'pending' }));

    service.ingestDeviceTelemetry({
      deviceId: 'kitchen_light',
      values: { on: true },
      observedAt: new Date().toISOString(),
    });

    expect(
      service
        .getSnapshot()
        .devices.find((device) => device.id === 'kitchen_light')?.state.command,
    ).toEqual(expect.objectContaining({ status: 'acked' }));
  });

  it('records observer reachability without replacing last successful telemetry or device status', () => {
    const deviceId = 'observer-relative-test';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      deviceId, protocol: 'http', driver: 'http-json-sensor', capabilities: ['temperature'],
    }] });
    const service = new DeviceRegistryService();
    const observedAt = '2026-10-26T05:20:00.000Z';
    service.ingestDeviceTelemetry({
      deviceId, values: { temperature: 22.5 }, observedAt, protocol: 'http',
      state: { source: 'http-poll', status: 'online' },
    });

    service.recordObserverReachability(deviceId, {
      status: 'unreachable', checkedAt: '2026-10-26T06:20:00.000Z',
      endpoint: 'http://192.168.7.48', targetIpAddress: '192.168.7.48', networkScopeId: 'eero-lan',
      observer: { id: 'Mac-LAB/darwin', host: 'Mac-LAB', platform: 'darwin', localScopes: [
        { interfaceName: 'en0', cidr: '192.168.1.25/24', address: '192.168.1.25' },
      ] },
      reason: 'request_timeout',
    });

    expect(service.getSnapshot().devices.find(device => device.id === deviceId)?.state).toMatchObject({
      values: { temperature: 22.5 }, observedAt, source: 'http-poll', status: 'online',
      observerReachability: { status: 'unreachable', targetIpAddress: '192.168.7.48', networkScopeId: 'eero-lan' },
    });
  });

  it('does not let an older operational observation or failure overwrite newer live state', () => {
    const deviceId = 'shelly-ordering-test:switch:0';
    const service = new DeviceRegistryService();
    service.ingestDeviceTelemetry({
      deviceId, protocol: 'http', driver: 'shelly-lan', values: { output: true },
      observedAt: '2026-10-31T10:00:02.000Z',
      state: { source: 'site-local-http-rpc:lab-observer', status: 'online', values: { output: true } },
    });
    service.ingestDeviceStatus({ deviceId, status: 'offline', observedAt: '2026-10-31T10:00:01.000Z' });
    service.ingestDeviceTelemetry({
      deviceId, protocol: 'http', driver: 'shelly-lan', values: { output: false },
      observedAt: '2026-10-31T10:00:00.000Z',
      state: { source: 'http-poll', status: 'online', values: { output: false } },
    });
    expect(service.getSnapshot().devices.find(device => device.id === deviceId)?.state).toMatchObject({
      values: { output: true }, observedAt: '2026-10-31T10:00:02.000Z',
      source: 'site-local-http-rpc:lab-observer', status: 'online',
    });
  });

  it('ignores duplicate operational observation IDs while accepting false as a real relay value', () => {
    const deviceId = 'shellyplus1-duplicate-test:switch:0';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      deviceId, protocol: 'http', driver: 'shelly-lan', capabilities: ['switch'], configured: true,
    }] });
    const service = new DeviceRegistryService();
    const observedAt = '2026-11-01T09:00:00.000Z';
    const message = {
      deviceId, protocol: 'http', driver: 'shelly-lan', observationId: 'observer-session:12',
      values: { on: false }, observedAt,
      state: { source: 'site-local-http-rpc:lab-observer', status: 'online', values: { on: false }, observedAt },
    };
    service.ingestDeviceTelemetry(message);
    service.ingestDeviceTelemetry({ ...message, values: { on: true }, state: { ...message.state, values: { on: true } } });

    expect(service.getSnapshot().devices.find(device => device.id === deviceId)?.state).toMatchObject({
      values: { on: false }, observedAt, source: 'site-local-http-rpc:lab-observer', status: 'online',
    });
  });

  it('keeps relay freshness independent from a later approved power observation', () => {
    const deviceId = 'shellypro2pm-field-freshness:switch:0';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      deviceId, protocol: 'http', driver: 'shelly-lan', capabilities: ['switch', 'power'], configured: true,
    }] });
    const service = new DeviceRegistryService();
    service.ingestDeviceTelemetry({
      deviceId, protocol: 'http', driver: 'shelly-lan', values: { on: true },
      observedAt: '2026-11-01T10:00:00.000Z',
      state: { source: 'site-local-http-rpc:mac-eero-en0', status: 'online', values: { on: true } },
    });
    service.projectApprovedObservation({
      deviceId, values: { power: 4.2 }, observedAt: '2026-11-01T10:00:05.000Z',
    });
    expect(service.getDevices().find(device => device.id === deviceId)?.state).toMatchObject({
      values: { on: true, power: 4.2 },
      observedAt: '2026-11-01T10:00:05.000Z',
      source: 'approved-observation',
      fieldObservedAt: { on: '2026-11-01T10:00:00.000Z', power: '2026-11-01T10:00:05.000Z' },
    });
  });

  it('publishes a device-state event only after an approved observation is accepted', () => {
    const deviceId = 'shellyplus1-event-test:switch:0';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      deviceId, protocol: 'http', driver: 'shelly-lan', capabilities: ['switch'], configured: true,
    }] });
    const service = new DeviceRegistryService();
    const events: any[] = [];
    service.streamOperationalStateChanges().subscribe(event => events.push(event));
    const message = {
      deviceId, tenantId: 'tenant-demo', siteId: 'site-home', protocol: 'http', driver: 'shelly-lan',
      observationId: 'observer-session:1', values: { output: false }, observedAt: '2026-11-01T10:00:00.000Z',
      state: { source: 'remote-http', status: 'online', values: { output: false }, observedAt: '2026-11-01T10:00:00.000Z' },
    };
    service.ingestDeviceTelemetry(message);
    service.ingestDeviceTelemetry({ ...message, observationId: 'observer-session:1', values: { output: true }, state: { ...message.state, values: { output: true } } });
    service.ingestDeviceTelemetry({ ...message, observationId: 'observer-session:2', observedAt: '2026-11-01T09:59:59.000Z' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: 'tenant-demo', siteId: 'site-home', deviceId,
      state: { values: { output: false }, observedAt: '2026-11-01T10:00:00.000Z', source: 'remote-http', status: 'online' },
    });
  });

  it('does not publish operational state for a device without enrollment approval', () => {
    delete process.env.HOME_APPROVED_DEVICES_JSON;
    const service = new DeviceRegistryService();
    const events: any[] = [];
    service.streamOperationalStateChanges().subscribe(event => events.push(event));
    service.ingestDeviceTelemetry({
      deviceId: 'unapproved-state-source', tenantId: 'tenant-demo', siteId: 'site-home',
      values: { output: true }, observedAt: '2026-11-01T10:00:00.000Z',
    });
    expect(events).toEqual([]);
  });

  it('publishes accepted approved-observation projections but not restore-only state', () => {
    const deviceId = 'sensor-event-test';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({ devices: [{
      deviceId, protocol: 'http', driver: 'energrid-esp8266', capabilities: ['temperature'],
    }] });
    const service = new DeviceRegistryService();
    const events: any[] = [];
    service.streamOperationalStateChanges().subscribe(event => events.push(event));
    service.restoreApprovedObservation({ deviceId, values: { temperature: 20 }, observedAt: '2026-11-01T10:00:00.000Z' });
    expect(events).toHaveLength(0);
    service.projectApprovedObservation({ deviceId, values: { temperature: 21 }, observedAt: '2026-11-01T10:00:01.000Z' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ siteId: 'site-home', deviceId, state: { values: { temperature: 21 }, observedAt: '2026-11-01T10:00:01.000Z' } });
  });

  it('stores a running diagnosis when an execution is created', () => {
    const service = new DeviceRegistryService();

    service.markDeviceCommandPending('kitchen_light', {
      action: 'turn_on',
      expectedValues: { on: true },
      ttlMs: 5000,
    });

    const trace = service.getExecutionTraces()[0];

    expect(trace).toEqual(
      expect.objectContaining({
        deviceId: 'kitchen_light',
        outcome: 'running',
        diagnosis: expect.objectContaining({
          category: 'unknown',
          stage: 'settling',
          confidence: 1,
        }),
      }),
    );
  });

  it('stores an acknowledgement-missing diagnosis when an execution times out', () => {
    const service = new DeviceRegistryService();

    service.markDeviceCommandPending('kitchen_light', {
      action: 'turn_on',
      expectedValues: { on: true },
      ttlMs: 1,
    });

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);

    const trace = service.getExecutionTraces()[0];

    expect(trace).toEqual(
      expect.objectContaining({
        deviceId: 'kitchen_light',
        outcome: 'timed_out',
        diagnosis: expect.objectContaining({
          category: 'ack_missing',
          stage: 'telemetry',
          confidence: 0.95,
        }),
      }),
    );
  });

  it('stores a successful diagnosis after matching telemetry settles', () => {
    const service = new DeviceRegistryService();

    const baseNow = Date.now();

    service.markDeviceCommandPending('kitchen_light', {
      action: 'turn_on',
      expectedValues: { on: true },
      ttlMs: 5000,
    });

    service.ingestDeviceTelemetry({
      deviceId: 'kitchen_light',
      values: { on: true },
      observedAt: new Date(baseNow + 10).toISOString(),
    });

    jest.spyOn(Date, 'now').mockReturnValue(baseNow + 3000);

    const trace = service.getExecutionTraces()[0];

    expect(trace).toEqual(
      expect.objectContaining({
        deviceId: 'kitchen_light',
        outcome: 'settled',
        diagnosis: expect.objectContaining({
          category: 'success',
          stage: 'settling',
          confidence: 1,
        }),
      }),
    );

    jest.restoreAllMocks();
  });

  it('imports approved site devices from the legacy Shelly registry shape', () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.light.wall.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-cc7b5c0ea5f8',
          channel: 0,
          groups: ['kitchen.lights'],
          aliases: ['kitchen wall', 'лампа на стената в кухнята'],
          capabilities: ['switch'],
        },
        {
          deviceId: 'kitchen.light.island.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-78ee4ccf5cf0',
          channel: 0,
          groups: ['kitchen.lights'],
          aliases: ['kitchen island', 'лампи на острова'],
          capabilities: ['switch'],
        },
        {
          deviceId: 'bath.light.led',
          origin: 'shelly',
          physicalId: 'shellyplus1-8813bfcdc8bc',
          channel: 0,
          groups: ['bath.lights'],
          aliases: ['bathroom lights', 'лампи в банята'],
          capabilities: ['switch'],
        },
        {
          deviceId: 'mainline',
          name: 'mainline',
          type: 'power-sensor',
          origin: 'shelly',
          physicalId: 'shellyproem50-main',
          location: 'PANEL',
          values: { power: 376.2, current: 1.824 },
        },
        {
          deviceId: 'water-pump',
          name: 'Water pump',
          type: 'power-sensor',
          origin: 'shelly',
          physicalId: 'shellyproem50-main',
          hardwareId: 'shellyproem50-main',
          channel: 1,
          channelName: 'water-pump',
          component: 'em:1',
          location: 'shed',
          capabilities: ['power', 'pump'],
          values: { power: 55.9, current: 0.395 },
        },
      ],
    });

    const service = new DeviceRegistryService();
    const snapshot = service.getSnapshot();
    const bathLight = snapshot.devices.find(
      (device) => device.id === 'bath.light.led',
    );
    const bathGroup = snapshot.devices.find(
      (device) => device.id === 'bath_light',
    );
    const kitchenGroup = snapshot.devices.find(
      (device) => device.id === 'kitchen_light',
    );
    const mainline = snapshot.devices.find(
      (device) => device.id === 'mainline',
    );
    const waterPump = snapshot.devices.find(
      (device) => device.id === 'water-pump',
    );

    expect(bathLight).toEqual(
      expect.objectContaining({
        zoneName: 'Bathroom',
        adapter: expect.objectContaining({
          protocol: 'mqtt',
          driver: 'shelly-rpc',
          target: 'shellyplus1-8813bfcdc8bc',
        }),
      }),
    );
    expect(
      bathLight?.capabilities.map((capability) => capability.kind),
    ).toContain('switch');
    expect(bathGroup).toEqual(
      expect.objectContaining({
        kind: 'logical',
        zoneName: 'Bathroom',
        memberDeviceIds: ['bath.light.led'],
        adapter: expect.objectContaining({
          driver: 'shelly-rpc-group',
          configured: true,
        }),
      }),
    );
    expect(kitchenGroup).toEqual(
      expect.objectContaining({
        kind: 'logical',
        memberDeviceIds: ['kitchen.light.wall.led', 'kitchen.light.island.led'],
        adapter: expect.objectContaining({
          driver: 'shelly-rpc-group',
          configured: true,
        }),
      }),
    );
    expect(mainline).toEqual(
      expect.objectContaining({
        zoneName: 'PANEL',
        state: expect.objectContaining({
          values: { power: 376.2, current: 1.824 },
        }),
      }),
    );
    expect(
      mainline?.capabilities.map((capability) => capability.kind),
    ).toContain('power');
    expect(waterPump).toEqual(
      expect.objectContaining({
        zoneName: 'shed',
        metadata: expect.objectContaining({
          hardwareId: 'shellyproem50-main',
          physicalId: 'shellyproem50-main',
          channel: 1,
          channelName: 'water-pump',
          component: 'em:1',
        }),
        state: expect.objectContaining({
          values: { power: 55.9, current: 0.395 },
        }),
      }),
    );
    expect(
      waterPump?.capabilities.map((capability) => capability.kind),
    ).toEqual(expect.arrayContaining(['power', 'pump']));
    expect(service.getAvailableDeviceIds()).toEqual(
      expect.arrayContaining(['mainline', 'water-pump']),
    );
    expect(service.getAvailableDeviceIds()).not.toContain('bath_light');
    expect(service.getAvailableDeviceIds()).not.toContain('bath.light.led');
  });

  it('scopes the active snapshot to the current tenant site while keeping site summaries', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.light.wall',
          tenantId: 'valentin',
          siteId: 'boyana-home',
          siteName: 'Boyana Home',
          gatewayId: 'boyana-gateway',
          origin: 'shelly',
          physicalId: 'shelly-boyana',
          groups: ['kitchen.lights'],
        },
        {
          deviceId: 'garage.temp',
          tenantId: 'valentin',
          siteId: 'village-house',
          siteName: 'Village House',
          gatewayId: 'village-gateway',
          type: 'sensor',
          origin: 'native',
          location: 'garage',
          values: { temperature: 8.5 },
        },
      ],
    });

    const snapshot = new DeviceRegistryService().getSnapshot();

    expect(snapshot.tenant.id).toBe('valentin');
    expect(snapshot.site).toEqual({ id: 'boyana-home', name: 'Boyana Home' });
    expect(snapshot.devices.map((device) => device.id)).toContain(
      'kitchen.light.wall',
    );
    expect(snapshot.devices.map((device) => device.id)).not.toContain(
      'garage.temp',
    );
    expect(snapshot.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'boyana-home',
          gatewayIds: ['boyana-gateway'],
        }),
        expect.objectContaining({
          id: 'village-house',
          gatewayIds: ['village-gateway'],
        }),
      ]),
    );
    const kitchenDevice = snapshot.devices.find(
      (device) => device.id === 'kitchen.light.wall',
    );
    expect(kitchenDevice?.adapter.commandTopic).toContain(
      'energrid/valentin/boyana-home/devices/',
    );
  });

  it('keeps native protocol separate from the gateway transport', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify({
      devices: [
        {
          deviceId: 'kitchen.temperature.http',
          protocol: 'http',
          transport: 'http',
          driver: 'http-json-sensor',
          target: 'http://192.168.1.88/status',
          location: 'Kitchen',
          capabilities: ['temperature', 'humidity'],
          values: { temperature: 22.4, humidity: 48 },
        },
        {
          deviceId: 'hall.motion.zigbee',
          protocol: 'zigbee',
          transport: 'mqtt',
          driver: 'zigbee2mqtt',
          bridge: 'zigbee2mqtt-hall',
          target: 'zigbee2mqtt/hall_motion',
          location: 'Hall',
          capabilities: ['motion'],
          values: { motion: false },
        },
        {
          deviceId: 'utility.heatpump.modbus',
          protocol: 'modbus',
          transport: 'mqtt',
          driver: 'modbus-gateway',
          bridge: 'rs485-site-gateway',
          target: 'modbus/heatpump',
          location: 'Utility',
          capabilities: ['heat_source', 'temperature'],
          values: { flowTemperature: 31.5, mode: 'heat' },
        },
      ],
    });

    const snapshot = new DeviceRegistryService().getSnapshot();
    const httpSensor = snapshot.devices.find(
      (device) => device.id === 'kitchen.temperature.http',
    );
    const zigbeeSensor = snapshot.devices.find(
      (device) => device.id === 'hall.motion.zigbee',
    );
    const modbusHeatPump = snapshot.devices.find(
      (device) => device.id === 'utility.heatpump.modbus',
    );

    expect(httpSensor?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'http',
        transport: 'http',
        driver: 'http-json-sensor',
      }),
    );
    expect(zigbeeSensor?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'zigbee',
        transport: 'mqtt',
        driver: 'zigbee2mqtt',
        bridge: 'zigbee2mqtt-hall',
      }),
    );
    expect(zigbeeSensor?.capabilities).toEqual([
      expect.objectContaining({ kind: 'motion', actions: ['read'] }),
    ]);
    expect(modbusHeatPump?.adapter).toEqual(
      expect.objectContaining({
        protocol: 'modbus',
        transport: 'mqtt',
        driver: 'modbus-gateway',
        bridge: 'rs485-site-gateway',
      }),
    );
    expect(modbusHeatPump?.adapter.commandTopic).toContain(
      'energrid/valentin/boyana-home/devices/utility_heatpump_modbus/command',
    );
  });

  it('discovers zigbee devices without approving them for control', () => {
    process.env.HOME_DISCOVERED_DEVICES_JSON = JSON.stringify([
      {
        id: 'hall.motion.zigbee',
        suggestedName: 'Hall motion sensor',
        suggestedRoom: 'Hall',
        protocol: 'zigbee',
        transport: 'mqtt',
        driver: 'zigbee2mqtt',
        target: 'zigbee2mqtt/hall_motion',
        capabilities: ['motion'],
        confidence: 0.76,
      },
    ]);

    const service = new DeviceRegistryService();
    const snapshot = service.getSnapshot();
    const discovered = snapshot.devices.find(
      (device) => device.id === 'hall.motion.zigbee',
    );

    expect(discovered).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        adapter: expect.objectContaining({
          protocol: 'zigbee',
          transport: 'mqtt',
          configured: false,
        }),
        discovery: expect.objectContaining({
          source: 'zigbee',
          confidence: 0.76,
        }),
      }),
    );
    expect(service.getAvailableDeviceIds()).not.toContain('hall.motion.zigbee');
  });

  it('ingests live MQTT registry and telemetry into the portal snapshot', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';

    const service = new DeviceRegistryService();

    service.ingestRegistryPayload({
      tenantId: 'valentin',
      siteId: 'boyana-home',
      siteName: 'Boyana Home',
      gatewayId: 'boyana-gateway',
      observedAt: '2026-08-02T08:00:00.000Z',
      devices: [
        {
          deviceId: 'kitchen.temperature.http',
          name: 'Kitchen temperature HTTP sensor',
          protocol: 'http',
          transport: 'http',
          driver: 'http-json-sensor',
          target: 'http://192.168.1.88/status',
          location: 'Kitchen',
          capabilities: ['temperature'],
          values: { temperature: 22.4 },
        },
      ],
    });
    service.ingestDeviceTelemetry({
      deviceId: 'kitchen.temperature.http',
      values: { temperature: 23.1 },
      observedAt: '2026-08-02T08:01:00.000Z',
      protocol: 'http',
      transport: 'http',
    });

    const snapshot = service.getSnapshot();
    const device = snapshot.devices.find(
      (item) => item.id === 'kitchen.temperature.http',
    );

    expect(device).toEqual(
      expect.objectContaining({
        trustStatus: 'approved',
        adapter: expect.objectContaining({
          protocol: 'http',
          transport: 'http',
        }),
        state: expect.objectContaining({
          values: { temperature: 23.1 },
          observedAt: '2026-08-02T08:01:00.000Z',
          status: 'online',
        }),
      }),
    );
  });

  it('shows the current site inventory with two temp sensors and all Shelly devices', () => {
    process.env.PORTAL_TENANT_ID = 'valentin';
    process.env.PORTAL_SITE_ID = 'boyana-home';
    process.env.PORTAL_SITE_NAME = 'Boyana Home';
    process.env.HOME_GATEWAY_ID = 'boyana-gateway';

    const service = new DeviceRegistryService();
    service.ingestRegistryPayload({
      tenantId: 'valentin',
      siteId: 'boyana-home',
      siteName: 'Boyana Home',
      gatewayId: 'boyana-gateway',
      devices: [
        {
          deviceId: 'kitchen.light.wall.led',
          name: 'Kitchen wall lights',
          origin: 'shelly',
          physicalId: 'shellyplus1-cc7b5c0ea5f8',
          channel: 0,
          groups: ['kitchen.lights'],
          values: { on: false },
        },
        {
          deviceId: 'kitchen.light.island.led',
          name: 'Kitchen island lights',
          origin: 'shelly',
          physicalId: 'shellyplus1-78ee4ccf4b54',
          channel: 0,
          groups: ['kitchen.lights'],
          values: { on: false },
        },
        {
          deviceId: 'kitchen.light.cans',
          name: 'Kitchen ceiling cans',
          origin: 'shelly',
          physicalId: 'shellyplus1-78ee4ccf4268',
          channel: 0,
          groups: ['kitchen.lights'],
          values: { on: false },
        },
        {
          deviceId: 'temp-kitchen',
          name: 'Kitchen temperature',
          origin: 'native',
          location: 'kitchen',
          values: { temperature: 22.4, humidity: 48.0 },
        },
        {
          deviceId: 'temp-garage',
          name: 'Garage temperature',
          origin: 'native',
          location: 'garage',
          values: { temperature: 18.7, humidity: 56.1 },
        },
        {
          deviceId: 'panel.mainline.energy',
          name: 'Whole house mainline',
          origin: 'shelly',
          driver: 'shelly-pro-em',
          physicalId: 'shellyproem50-8c4f00dbd258',
          hardwareId: 'shellyproem50-8c4f00dbd258',
          channel: 0,
          channelName: 'mainline',
          component: 'em:0',
          location: 'panel',
          capabilities: ['power'],
          values: { power: 420.0, current: 1.9, energy: 108.2 },
        },
        {
          deviceId: 'shed.water_pump.energy',
          name: 'Water pump energy',
          origin: 'shelly',
          driver: 'shelly-pro-em',
          physicalId: 'shellyproem50-8c4f00dbd258',
          hardwareId: 'shellyproem50-8c4f00dbd258',
          channel: 1,
          channelName: 'water-pump',
          component: 'em:1',
          location: 'shed',
          capabilities: ['power', 'pump'],
          values: { power: 0, current: 0.02, energy: 7.9 },
        },
      ],
    });

    const snapshot = service.getSnapshot();
    const ids = snapshot.devices.map((device) => device.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'kitchen_light',
        'kitchen.light.wall.led',
        'kitchen.light.island.led',
        'kitchen.light.cans',
        'temp-kitchen',
        'temp-garage',
        'panel.mainline.energy',
        'shed.water_pump.energy',
      ]),
    );
    expect(
      snapshot.devices.filter((device) =>
        device.capabilities.some(
          (capability) => capability.kind === 'temperature',
        ),
      ),
    ).toHaveLength(2);
    expect(
      snapshot.devices.filter((device) => device.metadata?.origin === 'shelly'),
    ).toHaveLength(5);
    expect(
      snapshot.devices.find((device) => device.id === 'kitchen_light'),
    ).toEqual(
      expect.objectContaining({
        kind: 'logical',
        memberDeviceIds: [
          'kitchen.light.wall.led',
          'kitchen.light.island.led',
          'kitchen.light.cans',
        ],
      }),
    );
  });

  it('treats telemetry without a registry entry as discovered only', () => {
    const service = new DeviceRegistryService();

    service.ingestDeviceTelemetry({
      deviceId: 'garage.motion.zigbee',
      name: 'Garage motion',
      protocol: 'zigbee',
      transport: 'mqtt',
      driver: 'zigbee2mqtt',
      location: 'Garage',
      capabilities: ['motion'],
      values: { motion: true },
    });

    const snapshot = service.getSnapshot();
    const device = snapshot.devices.find(
      (item) => item.id === 'garage.motion.zigbee',
    );

    expect(device).toEqual(
      expect.objectContaining({
        trustStatus: 'discovered',
        adapter: expect.objectContaining({
          protocol: 'zigbee',
          transport: 'mqtt',
          configured: false,
        }),
        state: expect.objectContaining({
          values: { motion: true },
          status: 'online',
        }),
      }),
    );
    expect(service.getAvailableDeviceIds()).not.toContain(
      'garage.motion.zigbee',
    );
  });

  it('does not match a Shelly component with another component on the same physical channel', () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify([
      {
        deviceId: 'panel.mainline.energy',
        name: 'Whole house mainline',
        kind: 'physical',
        origin: 'shelly',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-pro-em',
        target: 'shellyproem50-8c4f00dbd258',
        physicalId: 'shellyproem50-8c4f00dbd258',
        component: 'em1:0',
        channel: 0,
        capabilities: ['power'],
      },
      {
        deviceId: 'panel.relay',
        name: 'Panel relay',
        kind: 'physical',
        origin: 'shelly',
        protocol: 'mqtt',
        transport: 'mqtt',
        driver: 'shelly-rpc',
        target: 'shellyproem50-8c4f00dbd258',
        physicalId: 'shellyproem50-8c4f00dbd258',
        component: 'switch:0',
        channel: 0,
        capabilities: ['switch'],
      },
    ]);

    const registry = new DeviceRegistryService();

    expect(
      registry.findApprovedDeviceIdByPhysicalChannel(
        'shellyproem50-8c4f00dbd258',
        'em1:0',
        0,
      ),
    ).toBe('panel.mainline.energy');

    expect(
      registry.findApprovedDeviceIdByPhysicalChannel(
        'shellyproem50-8c4f00dbd258',
        'switch:0',
        0,
      ),
    ).toBe('panel.relay');
  });
});
