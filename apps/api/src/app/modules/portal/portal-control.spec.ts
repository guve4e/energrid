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
  function setup() {
    const configure = jest.fn().mockReturnValue({ id: 'relay' });
    const execute = jest.fn().mockResolvedValue({
      action: 'turn_on', status: 'acked', adapter: 'shelly-rpc',
      command: { id: 'command-1' }, message: 'reported on',
    });
    const check = jest.fn();
    const scanNow = jest
      .fn()
      .mockResolvedValue({ devices: [], zones: [], scannedAt: 'now' });
    const registerDiscoveredDevice = jest.fn();
    const persistInstallation = jest.fn().mockResolvedValue(undefined);
    const persistInstallationEvent = jest.fn().mockResolvedValue(undefined);
    const getDevices = jest.fn().mockReturnValue([]);
    const getState = jest.fn().mockReturnValue({ site: { id: 'site-home' } });
    return {
      configure,
      execute,
      check,
      scanNow,
      registerDiscoveredDevice,
      persistInstallation,
      persistInstallationEvent,
      getDevices,
      getState,
      controller: new PortalController(
        { getState } as unknown as PortalStateService,
        { scanNow } as unknown as DeviceLanDiscoveryService,
        {} as PortalDeviceProxyService,
        { configure, execute } as unknown as DeviceControlService,
        {} as DeviceMqttIngestService,
        { registerDiscoveredDevice, persistInstallation, persistInstallationEvent, getDevices } as unknown as DeviceRegistryService,
        { check } as unknown as DeviceDiagnosticsService,
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
      controller.scanNetwork({ method: 'GET', url: '/', headers: {} }),
    ).rejects.toThrow(UnauthorizedException);
    expect(scanNow).not.toHaveBeenCalled();
    expect(registerDiscoveredDevice).not.toHaveBeenCalled();
  });
  it('requires a bearer token to read portal state and rejects query-string tokens', () => {
    const { controller, getState } = setup();
    expect(() => controller.getState({ method: 'GET', url: '/', headers: {} })).toThrow(UnauthorizedException);
    expect(() => controller.getState({ method: 'GET', url: '/?token=unit-only', headers: {} })).toThrow(UnauthorizedException);
    expect(getState).not.toHaveBeenCalled();
    expect(controller.getState({ method: 'GET', url: '/', headers: { authorization: 'Bearer unit-only' } }))
      .toEqual({ site: { id: 'site-home' } });
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
    await controller.scanNetwork({
      method: 'GET',
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
