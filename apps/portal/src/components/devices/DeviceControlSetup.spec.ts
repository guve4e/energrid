import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DeviceControlSetup from './DeviceControlSetup.vue';
import {
  canSwitchDevice,
  controlRouteLabel,
  type ControlSetupDevice,
} from './device-control';

const physicalId = 'shellyplus2pm-001122334455';
const device: ControlSetupDevice = {
  id: `${physicalId}:switch:1`,
  trustStatus: 'approved',
  capabilities: [{ actions: ['turn_on', 'turn_off'] }],
  adapter: {
    protocol: 'mqtt',
    driver: 'shelly-discovered',
    target: physicalId,
  },
  metadata: {
    physicalId,
    channel: 1,
    component: 'switch:1',
    mqttCommandTopic: 'shelly/kitchen/rpc',
  },
  control: {
    status: 'needs-setup',
    binding: null,
    reason: 'No explicit control route.',
  },
};
let page: ReturnType<typeof mount> | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  vi.unstubAllGlobals();
});
function fetchMock(
  ok = true,
  payload: Record<string, unknown> = { persistence: 'runtime' },
) {
  return vi.fn(async (_url: string, _options?: RequestInit) => ({
    ok,
    json: async () => payload,
  }));
}
function render(value = device, fetch = fetchMock()) {
  vi.stubGlobal('fetch', fetch);
  page = mount(DeviceControlSetup, {
    props: { device: value, apiBase: '', accessToken: 'unit-only' },
  });
  return { page, fetch };
}
describe('explicit device control UI', () => {
  it('leaves an unknown address truly empty, with no sample IP, and keeps its known-address status while typing', async () => {
    const { page, fetch } = render();
    await page.get('select').setValue('http');
    const input = page.get('input[type="url"]');
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(input.attributes('placeholder')).toBeUndefined();
    expect(page.text()).toContain('Known addressNot discovered');
    expect(
      page.get('button[type="submit"]').attributes('disabled'),
    ).toBeDefined();
    await page.get('form').trigger('submit');
    expect(fetch).not.toHaveBeenCalled();
    await input.setValue('http://192.168.7.99');
    expect(page.text()).toContain('Known addressNot discovered');
    expect((input.element as HTMLInputElement).value).toBe(
      'http://192.168.7.99',
    );
  });
  it.each([
    'http://example.com',
    'http://127.0.0.1',
    'http://192.168.7.21/path',
    'not-an-address',
  ])(
    'rejects an invalid HTTP draft before sending configuration: %s',
    async (address) => {
      const { page, fetch } = render();
      await page.get('select').setValue('http');
      await page.get('input[type="url"]').setValue(address);
      await page.get('form').trigger('submit');
      expect(fetch).not.toHaveBeenCalled();
      expect(page.get('[role="alert"]').text()).not.toBe('');
    },
  );
  const networkDevice = { id: physicalId, ipAddress: '192.168.7.21' };
  it('prefills an MQTT-discovered device from its matching cached LAN address without a request or permission change', async () => {
    const { page, fetch } = render();
    await page.setProps({ networkDevices: [networkDevice] });
    await page.get('select').setValue('http');
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.21');
    expect(
      (page.get('input[type="checkbox"]').element as HTMLInputElement).checked,
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fills a late discovery result while preserving the chosen transport and switching permission', async () => {
    const { page } = render();
    await page.get('select').setValue('http');
    await page.setProps({ networkDevices: [networkDevice] });
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.21');
    expect(page.get('select').element.value).toBe('http');
    expect(
      (page.get('input[type="checkbox"]').element as HTMLInputElement).checked,
    ).toBe(false);
  });
  it('preserves a manually entered draft during background discovery changes', async () => {
    const { page } = render();
    await page.get('select').setValue('http');
    await page.get('input[type="url"]').setValue('http://192.168.7.99');
    await page.setProps({ networkDevices: [networkDevice] });
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.99');
  });
  it('keeps a saved HTTP route ahead of discovered address suggestions', async () => {
    const { page } = render({
      ...device,
      control: {
        status: 'ready',
        reason: '',
        binding: {
          kind: 'shelly-http',
          enabled: true,
          physicalId,
          channel: 1,
          baseUrl: 'http://192.168.7.99',
        },
      },
    });
    await page.setProps({ networkDevices: [networkDevice] });
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.99');
  });
  it('requests address discovery explicitly and uses the result only in the unsaved draft', async () => {
    const { page, fetch } = render();
    await page.get('select').setValue('http');
    await page.get('input[type="url"]').setValue('http://192.168.7.99');
    await page
      .findAll('button')
      .find((b) => b.text() === 'Find address')!
      .trigger('click');
    expect(page.emitted('find-address')).toHaveLength(1);
    await page.setProps({ findingAddress: true });
    expect(page.get('input[type="url"]').attributes('disabled')).toBeDefined();
    expect(
      page.get('button[type="submit"]').attributes('disabled'),
    ).toBeDefined();
    await page.get('form').trigger('submit');
    expect(fetch).not.toHaveBeenCalled();
    await page.setProps({
      networkDevices: [networkDevice],
      findingAddress: false,
    });
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.21');
    expect(fetch).not.toHaveBeenCalled();
    expect(page.emitted('saved')).toBeUndefined();
  });
  it('explains a missing local address and reports a failed search without calling it offline', async () => {
    const { page } = render();
    await page.get('select').setValue('http');
    expect(page.text()).toContain('No local address is known');
    await page
      .findAll('button')
      .find((b) => b.text() === 'Find address')!
      .trigger('click');
    await page.setProps({ findingAddress: true });
    await page.setProps({ findingAddress: false });
    expect(page.text()).toContain('No matching device was found');
    await page.setProps({ addressSearchError: 'Network scan unavailable' });
    expect(page.get('[role="alert"]').text()).toBe('Network scan unavailable');
  });
  it('preserves an unsaved route when the same device is refreshed', async () => {
    const { page } = render();
    await page.get('select').setValue('http');
    await page.get('input[type="url"]').setValue('http://192.168.7.99');
    await page.setProps({
      device: { ...device, control: { ...device.control! } },
    });
    expect(page.get('select').element.value).toBe('http');
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.99');
  });
  it('does not apply a previous relay lookup after selecting different hardware', async () => {
    const { page, fetch } = render();
    await page.get('select').setValue('http');
    await page
      .findAll('button')
      .find((b) => b.text() === 'Find address')!
      .trigger('click');
    await page.setProps({ findingAddress: true });
    const nextPhysicalId = 'shellyplus1-aabbccddeeff';
    await page.setProps({
      device: {
        ...device,
        id: `${nextPhysicalId}:switch:0`,
        metadata: {
          physicalId: nextPhysicalId,
          channel: 0,
          component: 'switch:0',
        },
      },
    });
    await page.setProps({
      networkDevices: [networkDevice],
      findingAddress: false,
    });
    await page.get('select').setValue('http');
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('can explicitly replace a saved route address in the draft without saving the route', async () => {
    const configured: ControlSetupDevice = {
      ...device,
      control: {
        status: 'disabled',
        reason: '',
        binding: {
          kind: 'shelly-http',
          enabled: false,
          physicalId,
          channel: 1,
          baseUrl: 'http://192.168.7.99',
        },
      },
    };
    const { page, fetch } = render(configured);
    await page
      .findAll('button')
      .find((b) => b.text() === 'Find address')!
      .trigger('click');
    await page.setProps({ findingAddress: true });
    await page.setProps({
      findingAddress: false,
      networkDevices: [networkDevice],
    });
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.21');
    expect(configured.control?.binding).toMatchObject({
      baseUrl: 'http://192.168.7.99',
      enabled: false,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(page.emitted('saved')).toBeUndefined();
  });
  it('prefills a discovered HTTP address without enabling switching', async () => {
    const { page, fetch } = render({
      ...device,
      metadata: { ...device.metadata, httpBaseUrl: 'http://192.168.7.21' },
    });
    await page.get('select').setValue('http');
    expect(
      (page.get('input[type="url"]').element as HTMLInputElement).value,
    ).toBe('http://192.168.7.21');
    expect(
      (page.get('input[type="checkbox"]').element as HTMLInputElement).checked,
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shows a useful error when a failed response is not JSON', async () => {
    const fetch = fetchMock(false);
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => {
        throw new Error('Not JSON');
      },
    });
    const { page } = render(device, fetch);
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toBe(
      'Control settings could not be saved.',
    );
  });
  it('handles network errors without claiming settings were saved', async () => {
    const fetch = fetchMock();
    fetch.mockRejectedValueOnce(new Error('Network unavailable'));
    const { page } = render(device, fetch);
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toBe('Network unavailable');
    expect(page.emitted('saved')).toBeUndefined();
  });
  it('does not duplicate a pending configuration request', async () => {
    let resolve!: (value: {
      ok: boolean;
      json: () => Promise<Record<string, unknown>>;
    }) => void;
    const fetch = fetchMock();
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { page } = render(device, fetch);
    await page.get('form').trigger('submit');
    await page.get('form').trigger('submit');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.get('button[type="submit"]').text()).toBe('Saving...');
    resolve({ ok: true, json: async () => ({ persistence: 'runtime' }) });
    await flushPromises();
    expect(page.emitted('saved')).toHaveLength(1);
  });
  it('resets unsaved settings when a different relay is selected', async () => {
    const { page, fetch } = render();
    await page.get('select').setValue('http');
    await page.get('input[type="url"]').setValue('http://192.168.7.15');
    await page.setProps({
      device: {
        ...device,
        id: 'another-relay',
        metadata: { ...device.metadata, channel: 0 },
      },
    });
    expect(page.get('select').element.value).toBe('none');
    expect(page.text()).toContain('Relay channel0');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps approval separate from switching and does not send commands when opened', () => {
    const { page, fetch } = render();
    expect(page.text()).toContain('ReadingsMQTT');
    expect(page.text()).toContain('Control not configured');
    expect(page.text()).toContain('Relay channel1');
    expect(page.text()).toContain('Runtime session');
    expect(page.get('select').element.value).toBe('none');
    expect(fetch).not.toHaveBeenCalled();
    expect(canSwitchDevice(device)).toBe(false);
  });
  it('prefills the observed topic but does not grant switching permission', async () => {
    const { page, fetch } = render();
    await page.get('select').setValue('mqtt');
    expect(
      (
        page.get('input[placeholder="device-prefix/rpc"]')
          .element as HTMLInputElement
      ).value,
    ).toBe('shelly/kitchen/rpc');
    expect(
      (page.get('input[type="checkbox"]').element as HTMLInputElement).checked,
    ).toBe(false);
    await page.get('form').trigger('submit');
    await flushPromises();
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `/portal/devices/${encodeURIComponent(device.id)}/control`,
    );
    expect(options.headers).toEqual({
      Authorization: 'Bearer unit-only',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(options.body))).toEqual({
      binding: {
        kind: 'shelly-mqtt',
        enabled: false,
        physicalId,
        channel: 1,
        topic: 'shelly/kitchen/rpc',
      },
    });
    expect(page.emitted('saved')).toHaveLength(1);
    expect(
      fetch.mock.calls.every((c) => !String(c[0]).includes('/actions')),
    ).toBe(true);
  });
  it('saves an explicit HTTP route without changing the readings transport or exposing passwords', async () => {
    const { page, fetch } = render();
    await page.get('select').setValue('http');
    await page.get('input[type="url"]').setValue('http://192.168.7.15');
    await page.get('input[placeholder="Optional"]').setValue('kitchen');
    await page.get('input[type="checkbox"]').setValue(true);
    await page.get('form').trigger('submit');
    await flushPromises();
    const options = (
      fetch.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(JSON.parse(String(options.body))).toEqual({
      binding: {
        kind: 'shelly-http',
        enabled: true,
        physicalId,
        channel: 1,
        baseUrl: 'http://192.168.7.15',
        credentialRef: 'kitchen',
      },
    });
    expect(page.text()).toContain('ReadingsMQTT');
    expect(page.find('input[type="password"]').exists()).toBe(false);
  });
  it('can remove a route explicitly without a switch command', async () => {
    const value = {
      ...device,
      control: {
        status: 'ready' as const,
        reason: 'configured',
        binding: {
          kind: 'shelly-mqtt' as const,
          enabled: true,
          physicalId,
          channel: 1,
          topic: 'shelly/kitchen/rpc',
        },
      },
    };
    const { page, fetch } = render(value);
    await page.get('select').setValue('none');
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(
      JSON.parse(
        String(
          (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body,
        ),
      ),
    ).toEqual({ binding: null });
  });
  it('shows server validation failures without claiming the route was saved', async () => {
    const { page } = render(
      device,
      fetchMock(false, { message: 'Wrong relay channel.' }),
    );
    await page.get('select').setValue('mqtt');
    await page.get('form').trigger('submit');
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toBe('Wrong relay channel.');
    expect(page.emitted('saved')).toBeUndefined();
  });
  it('rejects a missing relay identity locally and does not assume channel zero', async () => {
    const { page, fetch } = render({ ...device, metadata: { physicalId } });
    await page.get('select').setValue('mqtt');
    expect(
      page.get('button[type="submit"]').attributes('disabled'),
    ).toBeDefined();
    await page.get('form').trigger('submit');
    expect(fetch).not.toHaveBeenCalled();
    expect(page.text()).toContain('Relay identity is incomplete.');
  });
  it.each([
    { ...device, trustStatus: 'discovered' },
    {
      ...device,
      capabilities: [{ actions: ['read'] }],
      control: {
        status: 'read-only' as const,
        binding: null,
        reason: 'No relay',
      },
    },
    { ...device, memberDeviceIds: ['member'] },
    { ...device, adapter: { ...device.adapter, protocol: 'simulated' } },
  ])(
    'does not configure unapproved, read-only, group or simulated hardware',
    (value) => {
      const { page, fetch } = render(value);
      expect(page.find('form').exists()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('uses ready control state, not merely the presence of an adapter', () => {
    const binding = {
      kind: 'shelly-mqtt' as const,
      enabled: true,
      physicalId,
      channel: 1,
      topic: 'shelly/kitchen/rpc',
    };
    const ready = {
      ...device,
      control: { status: 'ready' as const, binding, reason: 'Configured' },
    };
    expect(canSwitchDevice(ready)).toBe(true);
    expect(canSwitchDevice({ ...ready, trustStatus: 'discovered' })).toBe(
      false,
    );
    expect(
      canSwitchDevice({
        ...ready,
        control: { ...ready.control, status: 'disabled' },
      }),
    ).toBe(false);
    expect(
      canSwitchDevice({ ...ready, capabilities: [{ actions: ['read'] }] }),
    ).toBe(false);
    expect(controlRouteLabel(ready)).toBe(
      'MQTT · relay 1 · shelly/kitchen/rpc',
    );
    expect(
      controlRouteLabel({
        ...ready,
        control: {
          ...ready.control,
          binding: {
            kind: 'shelly-http',
            enabled: true,
            physicalId,
            channel: 1,
            baseUrl: 'http://192.168.7.15',
          },
        },
      }),
    ).toContain('HTTP · relay 1');
    expect(controlRouteLabel({ ...device, memberDeviceIds: ['member'] })).toBe(
      'Member control routes',
    );
    expect(
      controlRouteLabel({
        ...device,
        adapter: { ...device.adapter, protocol: 'simulated' },
      }),
    ).toBe('Simulation');
  });
});
