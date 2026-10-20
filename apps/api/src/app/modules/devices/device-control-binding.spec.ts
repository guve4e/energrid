import { execFile } from 'node:child_process';
import { ForbiddenException } from '@nestjs/common';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceObservationService } from './device-observation.service';
import { DeviceMqttMessageRouter } from './mqtt/device-mqtt-message-router';
import { DeviceControlService } from './device-control.service';

const activeEnrollment = { find: async () => ({ status: 'enrolled' }) } as any;
const controlService = (registry: DeviceRegistryService) =>
  new DeviceControlService(registry, activeEnrollment);

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_c, _a, _o, cb) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));
const originalEnv = process.env;
const physicalId = 'shellyplus2pm-001122334455';
const id = `${physicalId}:switch:1`;
const binding = {
  kind: 'shelly-mqtt',
  enabled: true,
  physicalId,
  channel: 1,
  topic: 'shelly/kitchen/rpc',
};
async function discover() {
  const registry = new DeviceRegistryService();
  const router = new DeviceMqttMessageRouter(
    registry,
    new DeviceObservationService(),
    undefined,
    undefined,
    undefined,
    activeEnrollment,
  );
  await router.route({
    topic: 'shelly/kitchen/events/rpc',
    payloadText: '{}',
    payload: {
      src: physicalId,
      params: { 'switch:0': { output: false }, 'switch:1': { output: true } },
    },
  });
  return registry;
}
beforeEach(() => {
  process.env = {};
  jest.mocked(execFile).mockClear();
});
afterAll(() => {
  process.env = originalEnv;
});

describe('discovery, approval and control are separate', () => {
  it('retains exact hardware, channel and observed prefix without enabling switching', async () => {
    const registry = await discover();
    const approved = registry.approveDiscoveredDevice(id)!;
    expect(approved.metadata).toEqual(
      expect.objectContaining({
        physicalId,
        channel: 1,
        component: 'switch:1',
        mqttCommandTopic: 'shelly/kitchen/rpc',
      }),
    );
    expect(approved.control?.status).toBe('needs-setup');
    expect(
      await controlService(registry).execute(id, 'turn_on'),
    ).toEqual(
      expect.objectContaining({ status: 'failed', affectedDeviceIds: [] }),
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(
      registry.findApprovedDeviceIdByPhysicalChannel(physicalId, 'switch:1', 1),
    ).toBe(id);
    expect(
      registry.findApprovedDeviceIdByPhysicalChannel(physicalId, 'switch:0', 0),
    ).toBeNull();
  });
  it('publishes only to the explicit route and exact relay, ignoring the old global fallback', async () => {
    process.env.HOME_SHELLY_RPC_TOPIC = 'wrong/global/rpc';
    const registry = await discover();
    registry.approveDiscoveredDevice(id);
    const service = controlService(registry);
    expect(
      service.configure(id, { ...binding, enabled: false }).control?.status,
    ).toBe('disabled');
    await service.execute(id, 'turn_on');
    expect(execFile).not.toHaveBeenCalled();
    service.configure(id, binding);
    expect(execFile).not.toHaveBeenCalled();
    expect((await service.execute(id, 'turn_off')).status).toBe('pending');
    const args = jest.mocked(execFile).mock.calls[0][1] as string[];
    expect(args[args.indexOf('-t') + 1]).toBe(binding.topic);
    expect(JSON.parse(args[args.indexOf('-m') + 1])).toEqual(
      expect.objectContaining({
        dst: physicalId,
        method: 'Switch.Set',
        params: { id: 1, on: false },
      }),
    );
  });
  it('rejects approval bypass, wrong channels and wrong hardware without any I/O', async () => {
    const registry = await discover();
    const service = controlService(registry);
    expect(() => service.configure(id, binding)).toThrow('Approve');
    await expect(service.execute(id, 'turn_on')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    registry.approveDiscoveredDevice(id);
    for (const value of [
      { ...binding, channel: 0 },
      { ...binding, channel: undefined },
      { ...binding, physicalId: 'wrong' },
      { ...binding, kind: 'generic-mqtt' },
    ])
      expect(() => service.configure(id, value)).toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });
  it('keeps readings on MQTT when HTTP is selected and supports disabling/removing control', async () => {
    const registry = await discover();
    registry.approveDiscoveredDevice(id);
    const service = controlService(registry);
    const configured = service.configure(id, {
      ...binding,
      kind: 'shelly-http',
      baseUrl: 'http://192.168.7.15',
    });
    expect(configured.adapter.protocol).toBe('mqtt');
    expect(configured.control?.binding?.kind).toBe('shelly-http');
    expect(service.configure(id, null).control?.status).toBe('needs-setup');
    expect(execFile).not.toHaveBeenCalled();
  });
  it('does not permit a meter channel to become a switch', () => {
    const registry = new DeviceRegistryService();
    registry.registerDiscoveredShellyDevice(physicalId, 'em1:1', 1);
    const meter = `${physicalId}:em1:1`;
    registry.approveDiscoveredDevice(meter);
    expect(() =>
      controlService(registry).configure(meter, binding),
    ).toThrow('capability');
    expect(
      registry.getDevices().find((d) => d.id === meter)?.control?.status,
    ).toBe('read-only');
  });
  it('accepts explicit operator bindings on restart, but never imports routes from a registry announcement', async () => {
    process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = JSON.stringify({
      [id]: binding,
    });
    const registry = await discover();
    registry.approveDiscoveredDevice(id);
    expect(
      registry.getDevices().find((d) => d.id === id)?.control?.status,
    ).toBe('ready');
    process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = '{}';
    const clean = await discover();
    clean.approveDiscoveredDevice(id);
    clean.ingestRegistryPayload({
      devices: [
        {
          id,
          protocol: 'mqtt',
          driver: 'shelly-rpc',
          target: physicalId,
          channel: 1,
          capabilities: ['switch'],
          control: binding,
        },
      ],
    });
    expect(clean.getDevices().find((d) => d.id === id)?.control?.status).toBe(
      'needs-setup',
    );
  });
  it('fails closed for malformed operator bindings and missing HTTP secrets', async () => {
    process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON = '[]';
    expect(() => new DeviceRegistryService()).toThrow();
    delete process.env.HOME_DEVICE_CONTROL_BINDINGS_JSON;
    const registry = await discover();
    registry.approveDiscoveredDevice(id);
    expect(() =>
      controlService(registry).configure(id, {
        ...binding,
        kind: 'shelly-http',
        baseUrl: 'http://192.168.7.15',
        credentialRef: 'missing',
      }),
    ).toThrow('credential');
  });

  it.each([true, false])(
    'reports HTTP confirmation accurately, state read-back available: %s',
    async (confirmed) => {
      const registry = await discover();
      registry.approveDiscoveredDevice(id);
      const service = controlService(registry);
      service.configure(id, {
        ...binding,
        kind: 'shelly-http',
        baseUrl: 'http://192.168.7.15',
      });
      const queue = [
        `${JSON.stringify({ id: physicalId })}\n200`,
        '{"was_on":false}\n200',
        confirmed ? '{"id":1,"output":true}\n200' : '{}\n200',
      ];
      jest.mocked(execFile).mockImplementation((_c, _a, _o, cb) => {
        cb(null, queue.shift()!, '');
        return {} as ReturnType<typeof execFile>;
      });
      const result = await service.execute(id, 'turn_on');
      expect(result.adapter).toBe('http');
      expect(result.status).toBe(confirmed ? 'success' : 'pending');
      expect(result.command?.status).toBe(confirmed ? 'acked' : 'pending');
    },
  );

  it('blocks every group member before sending anything when one route is missing', async () => {
    process.env.HOME_KITCHEN_LIGHT_SHELLY_RPC_DEVICES =
      'first:shelly-first:0,second:shelly-second:1';
    const registry = new DeviceRegistryService();
    const service = controlService(registry);
    service.configure('first', {
      kind: 'shelly-mqtt',
      enabled: true,
      physicalId: 'shelly-first',
      channel: 0,
      topic: 'first/rpc',
    });
    expect((await service.execute('kitchen_light', 'turn_on')).status).toBe(
      'failed',
    );
    expect(execFile).not.toHaveBeenCalled();
    service.configure('second', {
      kind: 'shelly-mqtt',
      enabled: true,
      physicalId: 'shelly-second',
      channel: 1,
      topic: 'second/rpc',
    });
    jest.mocked(execFile).mockImplementation((_c, _a, _o, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });
    expect((await service.execute('kitchen_light', 'turn_on')).status).toBe(
      'pending',
    );
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(registry.getSnapshot().summary.controllable).toBe(3);
  });

  it('does not expose transport credentials on publication failure or fall back to another route', async () => {
    const registry = await discover();
    registry.approveDiscoveredDevice(id);
    const service = controlService(registry);
    service.configure(id, binding);
    jest.mocked(execFile).mockImplementation((_c, _a, _o, cb) => {
      cb(new Error('command --password private-secret'), {
        stdout: '',
        stderr: '',
      });
      return {} as ReturnType<typeof execFile>;
    });
    const result = await service.execute(id, 'turn_on');
    expect(result.status).toBe('failed');
    expect(result.message).toBe('MQTT command publication failed.');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('blocks control and configuration of an approved device in another tenant/site', async () => {
    process.env.HOME_APPROVED_DEVICES_JSON = JSON.stringify([
      {
        id: 'foreign',
        tenantId: 'other',
        siteId: 'elsewhere',
        protocol: 'mqtt',
        driver: 'shelly-rpc',
        physicalId,
        channel: 1,
        capabilities: ['switch'],
      },
    ]);
    const service = controlService(new DeviceRegistryService());
    expect(() => service.configure('foreign', binding)).toThrow('site');
    await expect(service.execute('foreign', 'turn_on')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});
