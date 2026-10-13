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
    const execute = jest.fn();
    const check = jest.fn();
    const scanNow = jest
      .fn()
      .mockResolvedValue({ devices: [], zones: [], scannedAt: 'now' });
    const registerDiscoveredDevice = jest.fn();
    return {
      configure,
      execute,
      check,
      scanNow,
      registerDiscoveredDevice,
      controller: new PortalController(
        {} as PortalStateService,
        { scanNow } as unknown as DeviceLanDiscoveryService,
        {} as PortalDeviceProxyService,
        { configure, execute } as unknown as DeviceControlService,
        {} as DeviceMqttIngestService,
        { registerDiscoveredDevice } as unknown as DeviceRegistryService,
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
  it('rejects unauthenticated configuration without touching the device service', () => {
    const { controller, configure, execute } = setup();
    expect(() =>
      controller.configureDeviceControl(
        'relay',
        { binding: null },
        { method: 'POST', url: '/', headers: {} },
      ),
    ).toThrow(UnauthorizedException);
    expect(configure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('configures only the requested route and reports runtime persistence, never switching', () => {
    const { controller, configure, execute } = setup();
    const binding = {
      kind: 'shelly-mqtt',
      enabled: false,
      physicalId: 'shelly-test',
      channel: 1,
      topic: 'device/rpc',
    };
    expect(
      controller.configureDeviceControl(
        'relay',
        { binding },
        {
          method: 'POST',
          url: '/',
          headers: { authorization: 'Bearer unit-only' },
        },
      ),
    ).toEqual({ device: { id: 'relay' }, persistence: 'runtime' });
    expect(configure).toHaveBeenCalledWith('relay', binding);
    expect(execute).not.toHaveBeenCalled();
  });
});
