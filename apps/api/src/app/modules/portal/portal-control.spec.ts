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
  beforeEach(() => {
    process.env = { PORTAL_CONTROL_TOKEN: 'unit-only' };
  });
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
      registerDiscoveredDevice,
      persistInstallation,
      persistInstallationEvent,
      getDevices,
      setEnrollmentStatus,
      getState,
      listIdentityEvidence,
      controller: new PortalController(
        { getState } as unknown as PortalStateService,
        { scanNow, getZones } as unknown as DeviceLanDiscoveryService,
        {} as PortalDeviceProxyService,
        { configure, execute } as unknown as DeviceControlService,
        {} as DeviceMqttIngestService,
        { registerDiscoveredDevice, persistInstallation, persistInstallationEvent, getDevices,
          setEnrollmentStatus,
          getSnapshot: () => ({ tenant: { id: 'tenant-demo' }, site: { id: 'site-home' } }) } as unknown as DeviceRegistryService,
        { check } as unknown as DeviceDiagnosticsService,
        {} as never,
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
    controller.checkDeviceConnection('relay', { method: 'POST', url: '/', headers: { authorization: 'Bearer unit-only' } });
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
      { method: 'POST', url: '/', headers: { authorization: 'Bearer unit-only' } },
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
  it('requires a bearer token to read portal state and rejects query-string tokens', async () => {
    const { controller, getState } = setup();
    await expect(controller.getState({ method: 'GET', url: '/', headers: {} })).rejects.toThrow(UnauthorizedException);
    await expect(controller.getState({ method: 'GET', url: '/?token=unit-only', headers: {} })).rejects.toThrow(UnauthorizedException);
    expect(getState).not.toHaveBeenCalled();
    await expect(controller.getState({ method: 'GET', url: '/', headers: { authorization: 'Bearer unit-only' } }))
      .resolves.toEqual({ site: { id: 'site-home' }, pendingDeviceIdentities: {} });
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
      method: 'GET', url: '/', headers: { authorization: 'Bearer unit-only' },
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
      method: 'POST', url: '/', headers: { authorization: 'Bearer unit-only' },
    })).resolves.toMatchObject({ status: 'retired' });
    expect(enrollment.retire).toHaveBeenCalledWith({
      tenantId: 'tenant-demo', siteId: 'site-home', deviceId: 'temp-kitchen',
    }, 'portal-control-token');
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
      method: 'GET', url: '/', headers: { authorization: 'Bearer unit-only' },
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
    const request = { method: 'GET', url: '/', headers: { authorization: 'Bearer unit-only' } };

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
          id: 'shellyplus1-aabbccddeeff',
          vendor: 'Shelly',
          ipAddress: '192.168.7.21',
          generation: 2,
          status: 'online',
          components: [{ component: 'switch:1', channel: 1 }],
        },
        { id: 'camera', vendor: 'Ring', status: 'online' },
      ],
    });
    await controller.scanNetwork({ scopeIds: ['home-lan'], fullSubnetConfirmed: true }, {
      method: 'POST',
      url: '/',
      headers: { authorization: 'Bearer unit-only' },
    });
    expect(registerDiscoveredDevice).toHaveBeenCalledTimes(1);
    expect(registerDiscoveredDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shellyplus1-aabbccddeeff:switch:1' }),
    );
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
          headers: { authorization: 'Bearer unit-only' },
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
      method: 'POST', url: '/', headers: { authorization: 'Bearer unit-only' },
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
      method: 'POST', url: '/', headers: { authorization: 'Bearer unit-only' },
    })).rejects.toThrow('route is unavailable');
    expect(persistInstallationEvent).toHaveBeenLastCalledWith('relay', 'command', expect.objectContaining({
      stage: 'result', status: 'failed', failureType: 'Error',
    }));
  });
});
