import { execFile } from 'node:child_process';
import { DeviceControlService } from './device-control.service';
import { DeviceRegistryService } from './device-registry.service';
import type { RegisteredDevice } from './device-registry.types';

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_c, _a, _o, cb) => {
    cb(null, { stdout: '', stderr: '' });
    return {} as ReturnType<typeof execFile>;
  }),
}));
const env = process.env;
const base: RegisteredDevice = {
  id: 'relay',
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  siteName: 'Home',
  displayName: 'Relay',
  kind: 'physical',
  zoneId: 'home',
  zoneName: 'Home',
  trustStatus: 'approved',
  capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
  adapter: {
    id: 'native',
    protocol: 'mqtt',
    driver: 'native',
    configured: true,
  },
  state: { values: {}, observedAt: null, source: 'unit', status: 'unknown' },
  policy: { requiresApproval: false, confirmationRequiredFor: [] },
  responseProfile: { confidence: 1, learningEnabled: false },
  control: {
    status: 'ready',
    reason: 'Configured',
    binding: {
      kind: 'generic-mqtt',
      enabled: true,
      topic: 'site/relay/command',
    },
  },
};
const group: RegisteredDevice = {
  ...base,
  id: 'group',
  kind: 'logical',
  memberDeviceIds: ['relay'],
};
function setup(devices: RegisteredDevice[]) {
  return new DeviceControlService({
    getDevices: () => devices,
    markDeviceCommandPending: jest.fn(() => ({
      id: 'cmd',
      status: 'pending',
      requestedAt: new Date().toISOString(),
      expectedValues: { on: true },
    })),
    markDeviceCommandPublished: jest.fn(),
    markDeviceCommandTransportFailed: jest.fn(),
    markDeviceCommandFailed: jest.fn(() => ({ id: 'cmd', status: 'failed' })),
    ingestDeviceTelemetry: jest.fn(),
  } as unknown as DeviceRegistryService);
}
beforeEach(() => {
  process.env = {};
  jest.mocked(execFile).mockClear();
});
afterAll(() => {
  process.env = env;
});
describe('control dispatch safety', () => {
  it('reports a fully confirmed HTTP group as HTTP, not MQTT', async () => {
    const device: RegisteredDevice = {
      ...base,
      adapter: { ...base.adapter, driver: 'shelly-rpc', target: 'shelly-test' },
      metadata: {
        physicalId: 'shelly-test',
        channel: 1,
        component: 'switch:1',
      },
      control: {
        status: 'ready',
        reason: 'Configured',
        binding: {
          kind: 'shelly-http',
          enabled: true,
          physicalId: 'shelly-test',
          channel: 1,
          baseUrl: 'http://192.168.7.15',
        },
      },
    };
    const queue = [
      '{"id":"shelly-test"}\n200',
      '{"was_on":false}\n200',
      '{"id":1,"output":true}\n200',
    ];
    jest.mocked(execFile).mockImplementation((_c, _a, _o, cb) => {
      cb(null, queue.shift()!, '');
      return {} as ReturnType<typeof execFile>;
    });
    expect(await setup([group, device]).execute('group', 'turn_on')).toEqual(
      expect.objectContaining({
        status: 'success',
        adapter: 'http',
        affectedDeviceIds: ['relay'],
      }),
    );
  });
  it.each([undefined, 'unexpected', 'read'])(
    'rejects missing, unknown or unwired actions: %s',
    async (action) => {
      const device = {
        ...base,
        capabilities: [
          {
            kind: 'switch' as const,
            actions: [
              'turn_on',
              'turn_off',
              'read',
            ] as RegisteredDevice['capabilities'][number]['actions'],
          },
        ],
      };
      await expect(setup([device]).execute('relay', action)).rejects.toThrow();
      expect(execFile).not.toHaveBeenCalled();
    },
  );
  it('rejects a nonexistent device', async () => {
    await expect(setup([]).execute('relay', 'turn_on')).rejects.toThrow(
      'not found',
    );
  });
  it.each(
    [
      [group],
      [{ ...group, memberDeviceIds: ['group'] }],
      [group, { ...base, trustStatus: 'discovered' as const }],
      [group, { ...base, siteId: 'another-site' }],
      [
        group,
        {
          ...base,
          capabilities: [
            { kind: 'power' as const, actions: ['read' as const] },
          ],
        },
      ],
    ].map((devices) => ({ devices })),
  )(
    'rejects missing, cyclic, unapproved, cross-site and read-only group members',
    async ({ devices }) => {
      expect((await setup(devices).execute('group', 'turn_on')).status).toBe(
        'failed',
      );
      expect(execFile).not.toHaveBeenCalled();
    },
  );
  it('publishes the generic format only to an explicit generic route', async () => {
    expect((await setup([base]).execute('relay', 'turn_on')).status).toBe(
      'pending',
    );
    const args = jest.mocked(execFile).mock.calls[0][1] as string[];
    expect(args[args.indexOf('-t') + 1]).toBe('site/relay/command');
    expect(JSON.parse(args[args.indexOf('-m') + 1])).toEqual(
      expect.objectContaining({
        deviceId: 'relay',
        on: true,
        action: 'turn_on',
      }),
    );
  });
  it('keeps generic transport failure explicit and secret-free', async () => {
    jest.mocked(execFile).mockImplementationOnce((_c, _a, _o, cb) => {
      cb(new Error('private-secret'), { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });
    expect(await setup([base]).execute('relay', 'turn_on')).toEqual(
      expect.objectContaining({
        status: 'failed',
        message: 'MQTT command publication failed.',
      }),
    );
  });
  it('deduplicates direct group members and reports transport failures', async () => {
    jest.mocked(execFile).mockImplementationOnce((_c, _a, _o, cb) => {
      cb(new Error('failed'), { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });
    expect(
      (
        await setup([
          { ...group, memberDeviceIds: ['relay', 'relay'] },
          base,
        ]).execute('group', 'turn_on')
      ).status,
    ).toBe('failed');
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it('blocks an HTTP route if its secret disappears before execution', async () => {
    const device: RegisteredDevice = {
      ...base,
      adapter: { ...base.adapter, driver: 'shelly-rpc', target: 'shelly-test' },
      metadata: {
        physicalId: 'shelly-test',
        channel: 1,
        component: 'switch:1',
      },
      control: {
        status: 'ready',
        reason: 'Configured',
        binding: {
          kind: 'shelly-http',
          enabled: true,
          physicalId: 'shelly-test',
          channel: 1,
          baseUrl: 'http://192.168.7.15',
          credentialRef: 'missing',
        },
      },
    };
    expect(
      (await setup([device]).execute('relay', 'turn_on')).message,
    ).toContain('credential');
    expect(execFile).not.toHaveBeenCalled();
  });
});
