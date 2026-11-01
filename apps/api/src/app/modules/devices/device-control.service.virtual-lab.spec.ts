import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DeviceControlService } from './device-control.service';
import { runWithAuthorizedPortalSite } from '../portal/portal-site-context';
import type { RegisteredDevice } from './device-registry.types';

const physicalId = 'shellyplus1-00c0de000001';
const deviceId = `${physicalId}:switch:0`;
const inventoryId = '3e709572-76c5-4d5f-8c89-ec23a8d7c55b';
const site = { tenantId: 'tenant-demo', siteId: 'site-device-lab', siteName: 'Virtual Device Lab', mode: 'home' as const };
const binding = { kind: 'shelly-virtual-lab' as const, enabled: true, physicalId, channel: 0 };
const device: RegisteredDevice = {
  id: deviceId, tenantId: site.tenantId, siteId: site.siteId, siteName: site.siteName,
  displayName: 'Virtual Shelly Plus 1', kind: 'physical', zoneId: 'lab', zoneName: 'Lab', trustStatus: 'approved',
  capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
  adapter: { id: 'shelly-lan', protocol: 'http', driver: 'shelly-lan', configured: true, target: 'http://172.30.250.11/rpc/Switch.GetStatus?id=0' },
  // Real enrolled Home/Device Lab projections can omit this denormalized field;
  // the resolver verifies the durable inventory assignment independently.
  metadata: { physicalId, component: 'switch:0', channel: 0 },
  state: { values: { output: false }, observedAt: null, source: 'saved', status: 'unknown' },
  control: { status: 'ready', reason: 'Explicit control route configured.', binding },
  assistantEnabled: false,
  policy: { requiresApproval: false, confirmationRequiredFor: [] },
  responseProfile: { confidence: 1, learningEnabled: false },
};

function setup(remoteResult: Record<string, unknown> = {
  writeAttempted: true, acknowledged: true, output: true, observedAt: new Date().toISOString(),
  observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
}, controlBinding: typeof binding | { kind: 'shelly-switch'; enabled: boolean; physicalId: string; channel: number } = binding) {
  const configuredDevice = { ...device, control: { ...device.control, binding: controlBinding } };
  const registry = {
    getDevices: jest.fn(() => [configuredDevice]),
    markDeviceCommandPending: jest.fn(() => ({ id: 'command-1', status: 'pending', requestedAt: new Date().toISOString(), expectedValues: { on: true } })),
    markDeviceCommandPublished: jest.fn(), ingestDeviceTelemetry: jest.fn(), recordObserverReachability: jest.fn(),
  };
  const target = { device: configuredDevice, inventory: { physicalDeviceId: inventoryId }, physicalId, component: 'switch:0', channel: 0, ipAddress: '172.30.250.11', zone: { id: 'device-lab-vlan', collectionSource: 'virtual-lab' } };
  const poll = { resolveShellyControlTarget: jest.fn().mockResolvedValue(target) };
  const lab = { executeVirtualLabSwitchControl: jest.fn().mockResolvedValue(remoteResult) };
  const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
  const service = new DeviceControlService(registry as never, enrollment as never, poll as never, lab as never);
  return { service, registry, poll, lab, enrollment };
}

describe('Virtual Lab Shelly control authorization and confirmation', () => {
  it.each([true, false])('routes only the explicitly configured switch:0 and ingests fresh readback output=%s', async (output) => {
    const fixture = setup({
      writeAttempted: true, acknowledged: true, output, observedAt: new Date().toISOString(),
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
    });
    const result = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, output ? 'turn_on' : 'turn_off'));
    expect(result).toMatchObject({ status: 'success', adapter: 'virtual-lab' });
    expect(fixture.poll.resolveShellyControlTarget).toHaveBeenCalledWith(deviceId, site);
    expect(fixture.lab.executeVirtualLabSwitchControl).toHaveBeenCalledWith('device-lab-vlan', '172.30.250.11', physicalId, 0, output, expect.any(AbortSignal));
    expect(fixture.registry.ingestDeviceTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      deviceId, tenantId: site.tenantId, siteId: site.siteId, values: { on: output },
      state: expect.objectContaining({ values: { on: output }, status: 'online' }),
    }));
    expect(fixture.registry.recordObserverReachability).toHaveBeenCalledTimes(1);
    expect(fixture.registry.markDeviceCommandPending).toHaveBeenCalledWith(deviceId, expect.objectContaining({
      ttlMs: 25_000,
      expectedValues: { on: output },
    }));
    expect(device.assistantEnabled).toBe(false);
  });

  it('uses the same production resolver for a transport-independent component permission', async () => {
    const permission = { kind: 'shelly-switch' as const, enabled: true, physicalId, channel: 0 };
    const fixture = setup({
      writeAttempted: true, acknowledged: true, output: true, observedAt: new Date().toISOString(),
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
    }, permission);
    const result = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'));
    expect(result).toMatchObject({ status: 'success', adapter: 'virtual-lab' });
    expect(fixture.poll.resolveShellyControlTarget).toHaveBeenCalledWith(deviceId, site);
    expect(fixture.lab.executeVirtualLabSwitchControl).toHaveBeenCalledWith(
      'device-lab-vlan', '172.30.250.11', physicalId, 0, true, expect.any(AbortSignal),
    );
  });

  it('rejects a mismatched permission before any route executes', async () => {
    const permission = { kind: 'shelly-switch' as const, enabled: true, physicalId: 'another-shelly', channel: 0 };
    const fixture = setup(undefined, permission);
    await expect(runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on')))
      .resolves.toMatchObject({ status: 'failed', adapter: 'none' });
    expect(fixture.lab.executeVirtualLabSwitchControl).not.toHaveBeenCalled();
    expect(fixture.registry.markDeviceCommandPending).not.toHaveBeenCalled();
  });

  it('does not execute an unconfigured route or an unapproved installation', async () => {
    const noRoute = { ...device, control: { status: 'needs-setup' as const, reason: 'No route.', binding: null } };
    const registry = { getDevices: jest.fn(() => [noRoute]) };
    const lab = { executeVirtualLabSwitchControl: jest.fn() };
    const service = new DeviceControlService(registry as never, { find: async () => ({ status: 'enrolled' }) } as never,
      { resolveShellyControlTarget: jest.fn() } as never, lab as never);
    const denied = await runWithAuthorizedPortalSite(site, () => service.execute(deviceId, 'turn_on'));
    expect(denied.status).toBe('failed');
    expect(lab.executeVirtualLabSwitchControl).not.toHaveBeenCalled();

    const unapproved = { ...device, trustStatus: 'discovered' as const };
    registry.getDevices.mockReturnValue([unapproved]);
    await expect(runWithAuthorizedPortalSite(site, () => service.execute(deviceId, 'turn_on'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(lab.executeVirtualLabSwitchControl).not.toHaveBeenCalled();
  });

  it('keeps the result pending when command acknowledgement has no fresh state read', async () => {
    const fixture = setup({
      writeAttempted: true, acknowledged: true, output: null, observedAt: null,
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
    });
    const result = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'));
    expect(result.status).toBe('pending');
    expect(fixture.registry.ingestDeviceTelemetry).not.toHaveBeenCalled();
  });

  it('rejects a concurrent command for the same switch until the first readback completes', async () => {
    let finish!: (value: { writeAttempted: boolean; acknowledged: boolean; output: boolean; observedAt: string; observer: { id: string; host: string; interfaceName: string } }) => void;
    const fixture = setup();
    fixture.lab.executeVirtualLabSwitchControl.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));

    const first = runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'));
    await Promise.resolve();
    await Promise.resolve();

    await expect(runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_off')))
      .rejects.toBeInstanceOf(ConflictException);
    expect(fixture.lab.executeVirtualLabSwitchControl).toHaveBeenCalledTimes(1);

    finish({
      writeAttempted: true, acknowledged: true, output: true, observedAt: new Date().toISOString(),
      observer: { id: 'virtual-lab-docker/192.168.1.138/eth0', host: '192.168.1.138', interfaceName: 'eth0' },
    });
    await expect(first).resolves.toMatchObject({ status: 'success', action: 'turn_on' });
  });
});
