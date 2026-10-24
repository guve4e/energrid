import { UnauthorizedException } from '@nestjs/common';
import { PortalController } from './portal.controller';
import type { PortalStateService } from './portal-state.service';
import type { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service';
import type { PortalDeviceProxyService } from './portal-device-proxy.service';
import type { DeviceControlService } from '../devices/device-control.service';
import type { DeviceMqttIngestService } from '../devices/device-mqtt-ingest.service';
import type { DeviceRegistryService } from '../devices/device-registry.service';
import type { DeviceDiagnosticsService } from '../devices/device-diagnostics.service';

describe('portal control configuration authorization', () => {
  const originalEnv = process.env;
  afterAll(() => {
    process.env = originalEnv;
  });
  function setup(enrollment?: any) {
    const configure = jest.fn().mockReturnValue({ id: 'relay' });
    const execute = jest.fn().mockResolvedValue({
      action: 'turn_on', status: 'acked', adapter: 'shelly-rpc',
      command: { id: 'command-1' }, message: 'reported on',
    });
    const check = jest.fn();
    const scanNow = jest
      .fn()
      .mockResolvedValue({ devices: [], zones: [], scannedAt: 'now' });
    const getZones = jest.fn(() => [{ id: 'home-lan', name: 'Home LAN', cidr: '192.168.7.0/24', seedIps: [] }]);
    const getLastScan = jest.fn(() => []);
    const registerDiscoveredDevice = jest.fn();
    const persistInstallation = jest.fn().mockResolvedValue(undefined);
    const persistInstallationEvent = jest.fn().mockResolvedValue(undefined);
    const getDevices = jest.fn().mockReturnValue([]);
    const setEnrollmentStatus = jest.fn();
    const getState = jest.fn().mockReturnValue({ site: { id: 'site-home' } });
    const listIdentityEvidence = jest.fn().mockResolvedValue([]);
    return {
      configure,
      execute,
      check,
      scanNow,
      getZones,
      getLastScan,
      registerDiscoveredDevice,
      persistInstallation,
      persistInstallationEvent,
      getDevices,
      setEnrollmentStatus,
      getState,
      listIdentityEvidence,
      controller: new PortalController(
        { getState } as unknown as PortalStateService,
        { scanNow, getZones, getLastScan } as unknown as DeviceLanDiscoveryService,
        {} as PortalDeviceProxyService,
        { configure, execute } as unknown as DeviceControlService,
        {} as DeviceMqttIngestService,
        { registerDiscoveredDevice, persistInstallation, persistInstallationEvent, getDevices,
          setEnrollmentStatus,
          getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-home' } }) } as unknown as DeviceRegistryService,
        { check } as unknown as DeviceDiagnosticsService,
        { investigate: jest.fn() } as never,
        {} as never,
        {} as never,
        { listIdentityEvidence } as never,
        enrollment,
      ),
    };
  }
  it('authorizes read-only diagnostics without executing or configuring a switch', () => {
    const { controller, check, configure, execute } = setup();
    expect(() => controller.checkDeviceConnection('relay', { method: 'POST', url: '/', headers: {} })).toThrow(UnauthorizedException);
    expect(check).not.toHaveBeenCalled();
    controller.checkDeviceConnection('relay', { method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } });
    expect(check).toHaveBeenCalledWith('relay');
    expect(execute).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });
  it('requires authorization before scanning or registering channels', async () => {
    const { controller, scanNow, registerDiscoveredDevice } = setup();
    await expect(
      controller.scanNetwork({ scopeIds: ['home-lan'], fullSubnetConfirmed: true }, { method: 'POST', url: '/', headers: {} }),
    ).rejects.toThrow(UnauthorizedException);
    expect(scanNow).not.toHaveBeenCalled();
    expect(registerDiscoveredDevice).not.toHaveBeenCalled();
  });
  it('rejects an unconfirmed full-subnet scan before invoking LAN discovery', async () => {
    const { controller, scanNow, registerDiscoveredDevice } = setup()
    await expect(controller.scanNetwork(
      { scopeIds: ['home-lan'], fullSubnetConfirmed: false },
      { method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } },
    )).rejects.toThrow('explicit operator confirmation')
    expect(scanNow).not.toHaveBeenCalled()
    expect(registerDiscoveredDevice).not.toHaveBeenCalled()
  })

  it('requires Portal authorization before approving a diagnostic probe', async () => {
    const { controller } = setup();
    await expect(controller.executeInvestigationAction(
      'host-1', 'investigation-1', 'proposal-1', { approved: true },
      { method: 'POST', url: '/', headers: {} },
    )).rejects.toThrow(UnauthorizedException);
  });
  it('keeps recognized Energrid identity out of the LLM investigation path', async () => {
    const { controller, getLastScan } = setup();
    const observedAt = new Date().toISOString();
    getLastScan.mockReturnValue([{
      id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN',
      protocol: 'http', confidence: 1, status: 'online', discoveredAt: observedAt, reason: 'Verified firmware identity',
      observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt },
        { source: 'http_identity', attribute: 'device.model', value: 'Energrid ESP8266 DHT22', observedAt },
        { source: 'http_identity', attribute: 'firmware.version', value: '0.2.0', observedAt },
        { source: 'http_identity', attribute: 'device.capability', value: 'temperature', observedAt },
        { source: 'http_identity', attribute: 'device.capability', value: 'humidity', observedAt },
      ],
    }]);
    await expect(controller.investigateNetworkDeviceWithAi('esp8266:324864', {}, {
      method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    })).rejects.toThrow('LLM investigation is disabled');
  });
  it('requires a bearer token to read portal state and rejects query-string tokens', async () => {
    const { controller, getState } = setup();
    await expect(controller.getState({ method: 'GET', url: '/', headers: {} })).rejects.toThrow(UnauthorizedException);
    await expect(controller.getState({ method: 'GET', url: '/?token=unit-only', headers: {} })).rejects.toThrow(UnauthorizedException);
    expect(getState).not.toHaveBeenCalled();
    await expect(controller.getState({ method: 'GET', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } }))
      .resolves.toEqual({ site: { id: 'site-home' }, devices: [], pendingDeviceIdentities: {} });
  });

  it('rebuilds the physical Energrid pending candidate from persisted discovery memory after API restart', async () => {
    const observedAt = new Date().toISOString();
    const record = {
      schemaVersion: 1, identity: 'device:upstream-lan:esp8266:324864', firstSeenAt: observedAt,
      lastSeenAt: observedAt, lastScanId: 'scan-1', device: {
        id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan', networkZoneName: 'Upstream LAN',
        protocol: 'http', confidence: 1, status: 'online', discoveredAt: observedAt, reason: 'Verified identity',
        observations: [
          { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt },
          { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt },
          { source: 'http_identity', attribute: 'device.model', value: 'Energrid ESP8266 DHT22', observedAt },
          { source: 'http_identity', attribute: 'firmware.version', value: '0.2.0', observedAt },
          { source: 'http_identity', attribute: 'device.capability', value: 'temperature', observedAt },
          { source: 'http_identity', attribute: 'device.capability', value: 'humidity', observedAt },
        ],
      },
    };
    const createController = () => {
      const candidateConfigs = new Map<string, any>();
      const registry = {
        registerDiscoveredDevice: jest.fn(config => { candidateConfigs.set(config.id, config); return true; }),
        getSnapshot: jest.fn(() => ({
          tenant: { id: 'tenant-demo' }, site: { id: 'site-home' },
          devices: [...candidateConfigs.values()].map(config => ({
            ...config, tenantId: 'tenant-demo', siteId: 'site-home', siteName: 'Home', zoneId: 'home', zoneName: 'Home',
            trustStatus: 'discovered', kind: 'physical', capabilities: config.capabilities.map((kind: string) => ({ kind, actions: ['read'] })),
            adapter: { protocol: config.protocol, target: config.target, driver: config.driver },
            state: { values: {}, observedAt: null, source: 'registry', status: 'unknown' },
          })),
        })),
      };
      const controller = new PortalController(
        { getState: () => ({ devices: [] }) } as never, {} as never, {} as never, {} as never, {} as never,
        registry as never, {} as never, {} as never, {} as never, {} as never,
        { listIdentityEvidence: jest.fn().mockResolvedValue([record]) } as never,
      );
      return { controller, registry };
    };
    // A second controller has an empty in-memory registry, simulating API restart.
    const { controller, registry } = createController();
    const result = await controller.getState({ method: 'GET', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } });
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledTimes(1);
    expect(result.devices).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'device:upstream-lan:esp8266:324864', displayName: 'Energrid ESP8266 DHT22', trustStatus: 'discovered',
    })]));
    expect(result.pendingDeviceIdentities).toMatchObject({
      'device:upstream-lan:esp8266:324864': {
        physicalHardwareId: 'esp8266:324864', ipAddress: '192.168.1.198',
        evidenceSource: 'bounded GET /api/v1/identity', verificationStatus: 'verified',
      },
    });
  });

  it('projects a pending Shelly candidate from scoped inventory plus an exact current LAN protocol match', async () => {
    const candidate = {
      id: 'shellyproem50-8c4f00dbd258:em1:0', tenantId: 'tenant-demo', siteId: 'site-home',
      trustStatus: 'discovered', metadata: { physicalId: 'shellyproem50-8c4f00dbd258', component: 'em1:0' },
      adapter: { protocol: 'mqtt', target: 'shellyproem50-8c4f00dbd258/rpc' },
      state: { observedAt: '2026-10-20T09:00:00.000Z' },
    };
    const record = {
      physicalDeviceId: 'physical-record-1', scope: { tenantId: 'tenant-demo', siteId: 'site-home' },
      identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-8c4f00dbd258' },
      identityEvidenceSource: 'mqtt_protocol_message', identityLastObservedAt: '2026-10-20T09:00:00.000Z',
      verificationStatus: 'protocol_observed', lastSeenAt: '2026-10-20T09:00:00.000Z',
      components: [{ key: 'em1:0' }],
    };
    const lan = {
      id: 'shellyproem50-8c4f00dbd258', ipAddress: '192.168.1.204', macAddress: '8c:4f:00:db:d2:58',
      hostname: 'shelly-proem', gatewayId: 'gateway-home', networkZoneId: 'iot', status: 'online',
      discoveredAt: new Date().toISOString(), components: [{ component: 'em1:0', channel: 0 }],
    };
    const getState = jest.fn().mockReturnValue({ devices: [candidate] });
    const inventoryList = jest.fn().mockResolvedValue([record]);
    const controller = new PortalController(
      { getState } as never,
      { getLastScan: () => [lan] } as never,
      {} as never, {} as never, {} as never,
      { getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-home' } }) } as never,
      {} as never, {} as never, {} as never, {} as never,
      { listIdentityEvidence: jest.fn().mockResolvedValue([]) } as never,
      undefined, undefined, { list: inventoryList } as never,
    );

    const result = await controller.getState({
      method: 'GET', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    });
    expect(inventoryList).toHaveBeenCalledWith({ tenantId: 'tenant-demo', siteId: 'site-home' });
    expect(result.pendingDeviceIdentities).toMatchObject({
      [candidate.id]: {
        logicalCandidateId: candidate.id,
        physicalDeviceId: 'physical-record-1',
        physicalHardwareId: 'shellyproem50-8c4f00dbd258', componentId: 'em1:0',
        ipAddress: '192.168.1.204', macAddress: '8c:4f:00:db:d2:58',
        status: 'correlated', verificationStatus: 'protocol_observed',
      },
    });
  });
  it('requires portal authorization before reading identity or retiring a device', async () => {
    const { controller } = setup();
    await expect(controller.getDeviceNetworkIdentity('temp-kitchen', {
      method: 'GET', url: '/', headers: {},
    })).rejects.toThrow(UnauthorizedException);
    await expect(controller.retireDevice('temp-kitchen', {
      method: 'POST', url: '/', headers: {},
    })).rejects.toThrow(UnauthorizedException);
  });
  it('persists retirement only through the authorized Portal action', async () => {
    const enrollment = {
      find: jest.fn().mockResolvedValue({ status: 'enrolled' }),
      retire: jest.fn().mockResolvedValue({ status: 'retired' }),
    };
    const { controller, setEnrollmentStatus } = setup(enrollment);
    await expect(controller.retireDevice('temp-kitchen', {
      method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    })).resolves.toMatchObject({ status: 'retired' });
    expect(enrollment.retire).toHaveBeenCalledWith({
      tenantId: 'tenant-demo', siteId: 'site-home', deviceId: 'temp-kitchen',
    }, 'admin@example.test');
    expect(setEnrollmentStatus).toHaveBeenCalledWith('temp-kitchen', 'retired');
  });
  it('returns persisted identity without requiring a live Discovery scan', async () => {
    const physicalDevice = {
      physicalDeviceId: 'physical-proem',
      assignments: [],
      networkObservations: [{
        id: 'observation-1', physicalDeviceId: 'physical-proem', ipAddress: '192.168.1.204',
        networkScope: 'gateway-home:iot', observedAt: '2026-10-19T12:00:00.000Z',
        evidenceSource: 'lan_discovery', verificationStatus: 'user_confirmed',
        associatedAt: '2026-10-19T12:00:00.000Z', associatedBy: 'operator', isCurrent: true,
      }],
    };
    const controller = new PortalController(
      {} as PortalStateService,
      { getZones: jest.fn(() => []), scanNow: jest.fn() } as unknown as DeviceLanDiscoveryService,
      {} as PortalDeviceProxyService,
      {} as DeviceControlService,
      {} as DeviceMqttIngestService,
      { getSnapshot: () => ({ tenant: { id: 'tenant-a' }, site: { id: 'site-a' } }) } as unknown as DeviceRegistryService,
      {} as DeviceDiagnosticsService,
      {} as never,
      {} as never,
      {} as never,
      { list: jest.fn().mockRejectedValue(new Error('Discovery offline')) } as never,
      { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) } as never,
      undefined,
      {
        forLogicalDevice: jest.fn().mockResolvedValue(physicalDevice),
        list: jest.fn().mockResolvedValue([physicalDevice]),
      } as never,
    );

    await expect(controller.getDeviceNetworkIdentity('temp-kitchen', {
      method: 'GET', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    })).resolves.toMatchObject({
      association: expect.objectContaining({ ipAddress: '192.168.1.204' }),
      physicalDevice,
    });
  });
  it('projects one physical identity onto two logical devices with distinct components', async () => {
    const physicalDevice = {
      physicalDeviceId: 'shelly-proem-001',
      components: [{ key: 'em1:0', capabilities: ['power'] }, { key: 'em1:1', capabilities: ['power'] }],
      endpoints: [
        { protocol: 'mqtt', kind: 'topic', address: 'shelly/boiler@oven/status' },
        { protocol: 'http', kind: 'rpc', address: 'http://192.168.1.204/rpc' },
      ],
      assignments: [
        { deviceId: 'boiler-power', componentKey: 'em1:0', role: 'Boiler' },
        { deviceId: 'oven-power', componentKey: 'em1:1', role: 'Oven' },
      ],
      networkObservations: [{
        id: 'net-observation-1', physicalDeviceId: 'shelly-proem-001',
        ipAddress: '192.168.1.204', macAddress: '00:11:22:33:44:55',
        hostname: 'shelly-proem', gatewayId: 'gateway-home', networkScope: 'gateway-home:lan',
        observedAt: '2026-10-19T12:00:00.000Z', evidenceSource: 'lan_discovery',
        verificationStatus: 'user_confirmed', associatedAt: '2026-10-19T12:00:00.000Z',
        associatedBy: 'operator', isCurrent: true,
      }],
    };
    const forLogicalDevice = jest.fn((_scope, deviceId: string) =>
      Promise.resolve(physicalDevice.assignments.some(item => item.deviceId === deviceId)
        ? physicalDevice : null));
    const controller = new PortalController(
      {} as PortalStateService,
      { getZones: jest.fn(() => []), scanNow: jest.fn() } as unknown as DeviceLanDiscoveryService,
      {} as PortalDeviceProxyService,
      {} as DeviceControlService,
      {} as DeviceMqttIngestService,
      { getSnapshot: () => ({ tenant: { id: 'tenant-a' }, site: { id: 'site-a' } }) } as unknown as DeviceRegistryService,
      {} as DeviceDiagnosticsService,
      {} as never,
      {} as never,
      {} as never,
      { list: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) } as never,
      undefined,
      {
        forLogicalDevice,
        list: jest.fn().mockResolvedValue([physicalDevice]),
      } as never,
    );
    const request = { method: 'GET', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 } };

    const [boiler, oven] = await Promise.all([
      controller.getDeviceNetworkIdentity('boiler-power', request),
      controller.getDeviceNetworkIdentity('oven-power', request),
    ]);

    expect(boiler).toMatchObject({
      logicalDeviceId: 'boiler-power',
      logicalAssignment: { deviceId: 'boiler-power', componentKey: 'em1:0', role: 'Boiler' },
      physicalDevice: { physicalDeviceId: 'shelly-proem-001' },
      association: { ipAddress: '192.168.1.204', macAddress: '00:11:22:33:44:55' },
    });
    expect(oven).toMatchObject({
      logicalDeviceId: 'oven-power',
      logicalAssignment: { deviceId: 'oven-power', componentKey: 'em1:1', role: 'Oven' },
      physicalDevice: { physicalDeviceId: 'shelly-proem-001' },
      association: { ipAddress: '192.168.1.204', macAddress: '00:11:22:33:44:55' },
    });
    expect(forLogicalDevice).toHaveBeenNthCalledWith(1, { tenantId: 'tenant-a', siteId: 'site-a' }, 'boiler-power');
    expect(forLogicalDevice).toHaveBeenNthCalledWith(2, { tenantId: 'tenant-a', siteId: 'site-a' }, 'oven-power');
  });
  it('registers reported channels for review without approving, configuring, or switching', async () => {
    const {
      controller,
      scanNow,
      registerDiscoveredDevice,
      configure,
      execute,
    } = setup();
    scanNow.mockResolvedValue({
      devices: [
        {
          id: 'shellyplus1-8813bfcdc8bc',
          vendor: 'Shelly',
          ipAddress: '192.168.1.220',
          generation: 2,
          model: 'SNSW-001X16EU',
          app: 'Plus1',
          macAddress: '88:13:bf:cd:c8:bc',
          status: 'online',
          discoveredAt: '2026-10-22T12:00:00.000Z',
          components: [{ component: 'switch:0', channel: 0 }],
        },
        { id: 'camera', vendor: 'Ring', status: 'online' },
      ],
    });
    await controller.scanNetwork({ scopeIds: ['home-lan'], fullSubnetConfirmed: true }, {
      method: 'POST',
      url: '/',
      headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    });
    expect(registerDiscoveredDevice).toHaveBeenCalledTimes(1);
    expect(registerDiscoveredDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'shellyplus1-8813bfcdc8bc:switch:0',
        protocol: 'http',
        driver: 'shelly-lan',
        metadata: expect.objectContaining({
          physicalId: 'shellyplus1-8813bfcdc8bc',
          ipAddress: '192.168.1.220',
          networkObservedAt: '2026-10-22T12:00:00.000Z',
        }),
      }),
    );
    expect(configure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps verified Energrid HTTP identities in Discovery without registering or approving them', async () => {
    const { controller, scanNow, registerDiscoveredDevice, configure, execute } = setup();
    scanNow.mockResolvedValue({ devices: [{
      id: 'esp8266:324864', vendor: 'Energrid', protocol: 'http', status: 'online',
      ipAddress: '192.168.1.198', networkZoneId: 'home-lan', networkZoneName: 'Home LAN',
      model: 'Energrid ESP8266 DHT22',
      observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: '2026-10-23T12:00:00.000Z' },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt: '2026-10-23T12:00:00.000Z' },
      ],
    }], zones: [] });

    await controller.scanNetwork({ scopeIds: ['home-lan'], fullSubnetConfirmed: true }, {
      method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    });

    expect(registerDiscoveredDevice).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated configuration without touching the device service', async () => {
    const { controller, configure, execute } = setup();
    await expect(
      controller.configureDeviceControl(
        'relay',
        { binding: null },
        { method: 'POST', url: '/', headers: {} },
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(configure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('configures only the requested route and reports local persistence, never switching', async () => {
    const { controller, configure, execute, persistInstallation, persistInstallationEvent } = setup();
    configure.mockReturnValue({ id: 'relay', control: { binding: { kind: 'shelly-mqtt', enabled: false } } });
    const binding = {
      kind: 'shelly-mqtt',
      enabled: false,
      physicalId: 'shelly-test',
      channel: 1,
      topic: 'device/rpc',
    };
    await expect(
      controller.configureDeviceControl(
        'relay',
        { binding },
        {
          method: 'POST',
          url: '/',
          headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
        },
      ),
    ).resolves.toEqual({ device: expect.objectContaining({ id: 'relay' }), persistence: 'local' });
    expect(configure).toHaveBeenCalledWith('relay', binding);
    expect(persistInstallation).toHaveBeenCalled();
    expect(persistInstallationEvent).toHaveBeenCalledWith('relay', 'control_configured', expect.any(Object));
    expect(execute).not.toHaveBeenCalled();
  });

  it('records command evidence after the control service returns', async () => {
    const { controller, execute, persistInstallationEvent } = setup();
    await controller.executeDeviceAction('relay', { action: 'turn_on' }, {
      method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    });
    expect(execute).toHaveBeenCalledWith('relay', 'turn_on');
    expect(persistInstallationEvent.mock.calls).toEqual([
      ['relay', 'command', expect.objectContaining({ action: 'turn_on', stage: 'requested' })],
      ['relay', 'command', expect.objectContaining({
        action: 'turn_on', stage: 'result', status: 'acked', commandId: 'command-1',
      })],
    ]);
  });
  it('records a failed result when control rejects a command', async () => {
    const { controller, execute, persistInstallationEvent } = setup();
    execute.mockRejectedValue(new Error('route is unavailable'));
    await expect(controller.executeDeviceAction('relay', { action: 'turn_on' }, {
      method: 'POST', url: '/', headers: {}, user: { userId: 'test-user', email: 'admin@example.test', name: 'Admin', role: 'admin', sessionId: 'test-session', sessionVersion: 0 },
    })).rejects.toThrow('route is unavailable');
    expect(persistInstallationEvent).toHaveBeenLastCalledWith('relay', 'command', expect.objectContaining({
      stage: 'result', status: 'failed', failureType: 'Error',
    }));
  });
});
