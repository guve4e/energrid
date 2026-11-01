import { execFile } from 'node:child_process';
import { DeviceControlService } from './device-control.service';
import { runWithAuthorizedPortalSite } from '../portal/portal-site-context';
import type { RegisteredDevice } from './device-registry.types';

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_command, _args, _options, callback) => {
    const response = responses.shift();
    callback(null, `${JSON.stringify(response)}\n200`, '');
    return { stdin: { on: jest.fn(), end: jest.fn() } };
  }),
}));

const site = { tenantId: 'tenant-demo', siteId: 'site-home', siteName: 'Home', mode: 'home' as const };
const physicalId = 'shellyplus1-aabbccddeeff';
const deviceId = `${physicalId}:switch:0`;
let responses: Record<string, unknown>[] = [];

const device: RegisteredDevice = {
  id: deviceId, tenantId: site.tenantId, siteId: site.siteId, siteName: site.siteName,
  displayName: 'Kitchen Shelly', kind: 'physical', zoneId: 'kitchen', zoneName: 'Kitchen', trustStatus: 'approved',
  capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
  adapter: { id: 'shelly-lan', protocol: 'http', driver: 'shelly-lan', configured: true, target: `http://192.168.7.21/rpc/Switch.GetStatus?id=0` },
  metadata: { physicalId, component: 'switch:0', channel: 0, networkScope: 'home-observer:home-iot' },
  state: { values: { output: false }, observedAt: null, source: 'saved', status: 'unknown' },
  control: { status: 'ready', reason: 'Permission enabled.', binding: { kind: 'shelly-switch', enabled: true, physicalId, channel: 0 } },
  assistantEnabled: false,
  policy: { requiresApproval: false, confirmationRequiredFor: [] },
  responseProfile: { confidence: 1, learningEnabled: false },
};

function setup(adapter = device.adapter) {
  const configuredDevice = { ...device, adapter }
  const registry = {
    getDevices: jest.fn(() => [configuredDevice]),
    markDeviceCommandPending: jest.fn(() => ({ id: 'cmd-1', status: 'pending', requestedAt: new Date().toISOString(), expectedValues: { on: true } })),
    markDeviceCommandPublished: jest.fn(),
    ingestDeviceTelemetry: jest.fn(),
    markDeviceCommandTransportFailed: jest.fn(),
    markDeviceCommandFailed: jest.fn(() => ({ id: 'cmd-1', status: 'failed' })),
  };
  const target = {
    device: configuredDevice, inventory: { physicalDeviceId: 'inventory-1' }, physicalId, component: 'switch:0', channel: 0,
    ipAddress: '192.168.7.21', zone: { id: 'home-iot', collectionSource: 'local' }, observerId: 'home-observer',
  };
  const httpPoll = { resolveShellyControlTarget: jest.fn().mockResolvedValue(target) };
  const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
  const service = new DeviceControlService(registry as never, enrollment as never, httpPoll as never, {} as never);
  return { service, registry, httpPoll };
}

describe('scope-aware Shelly execution', () => {
  beforeEach(() => {
    responses = [];
    jest.mocked(execFile).mockClear();
  });

  it.each([true, false])('selects the local RPC adapter and settles only on matching output=%s', async (output) => {
    responses = [
      { id: physicalId },
      { was_on: !output },
      { id: 0, output },
    ];
    const fixture = setup();
    const result = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, output ? 'turn_on' : 'turn_off'));
    expect(result).toMatchObject({ status: 'success', adapter: 'http' });
    expect(fixture.httpPoll.resolveShellyControlTarget).toHaveBeenCalledWith(deviceId, site);
    expect(execFile).toHaveBeenCalledTimes(3);
    const calls = jest.mocked(execFile).mock.calls;
    expect(calls[0][1]).toContain(`http://192.168.7.21/rpc/Shelly.GetDeviceInfo`);
    expect(calls[1][1]).toContain(`http://192.168.7.21/rpc/Switch.Set`);
    expect(JSON.parse(String(calls[1][1]?.[calls[1][1]!.indexOf('--data') + 1]))).toEqual({ id: 0, on: output });
    expect(calls[2][1]).toContain(`http://192.168.7.21/rpc/Switch.GetStatus`);
  });

  it('resolves a discovered MQTT Shelly profile to the same authorized local RPC adapter', async () => {
    responses = [
      { id: physicalId },
      { was_on: false },
      { id: 0, output: true },
    ]
    const fixture = setup({
      id: 'shelly-discovered', protocol: 'mqtt', driver: 'shelly-discovered',
      configured: true, target: physicalId,
    })

    const result = await runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on'))

    expect(result).toMatchObject({ status: 'success', adapter: 'http' })
    expect(fixture.httpPoll.resolveShellyControlTarget).toHaveBeenCalledWith(deviceId, site)
    expect(execFile).toHaveBeenCalledTimes(3)
    expect(jest.mocked(execFile).mock.calls[1][1]).toContain('http://192.168.7.21/rpc/Switch.Set')
  })

  it('does not send a command when the resolver returns another physical identity or site endpoint', async () => {
    const fixture = setup();
    fixture.httpPoll.resolveShellyControlTarget.mockResolvedValueOnce({
      device, inventory: { physicalDeviceId: 'inventory-1' }, physicalId: 'shellyplus1-000000000000',
      component: 'switch:0', channel: 0, ipAddress: '192.168.7.22',
      zone: { id: 'home-iot', collectionSource: 'local' }, observerId: 'home-observer',
    });
    await expect(runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on')))
      .rejects.toThrow(/no longer matches the enrolled physical component/);
    expect(execFile).not.toHaveBeenCalled();
    expect(fixture.registry.markDeviceCommandPending).not.toHaveBeenCalled();
  });

  it('rejects a device from another site before resolving any execution transport', async () => {
    const fixture = setup();
    fixture.registry.getDevices.mockReturnValue([{ ...device, siteId: 'site-other' }]);
    await expect(runWithAuthorizedPortalSite(site, () => fixture.service.execute(deviceId, 'turn_on')))
      .rejects.toThrow(/limited to approved devices in this site/);
    expect(fixture.httpPoll.resolveShellyControlTarget).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
