import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DeviceSwitchControl from './DeviceSwitchControl.vue';

const device = {
  id: 'relay',
  displayName: 'Kitchen relay',
  trustStatus: 'approved',
  capabilities: [{ actions: ['turn_on', 'turn_off'] }],
  adapter: { protocol: 'mqtt', driver: 'shelly-discovered' },
  control: { status: 'ready' as const, binding: null, reason: 'Configured' },
  state: {
    values: {} as Record<string, boolean>,
    command: undefined as { status: string; message?: string } | undefined,
  },
};
describe('device switch control', () => {
  it('does not label an unknown state as Off', () => {
    const page = mount(DeviceSwitchControl, { props: { device } });
    expect(page.findAll('button[aria-pressed="true"]')).toHaveLength(0);
    expect(page.get('[role="status"]').text()).toBe('State unknown');
  });
  it.each([true, false])('uses reported relay state: %s', (on) => {
    const page = mount(DeviceSwitchControl, {
      props: { device: { ...device, state: { values: { output: on } } } },
    });
    expect(page.get('button[aria-pressed="true"]').text()).toBe(
      on ? 'On' : 'Off',
    );
  });
  it('emits one requested action without optimistic state changes', async () => {
    const page = mount(DeviceSwitchControl, { props: { device } });
    await page.findAll('button')[1].trigger('click');
    expect(page.emitted('action')).toEqual([['turn_on']]);
    expect(page.findAll('button[aria-pressed="true"]')).toHaveLength(0);
  });
  it.each([
    { device, busy: true },
    {
      device: {
        ...device,
        state: { values: {}, command: { status: 'pending' } },
      },
    },
    { device: { ...device, trustStatus: 'discovered' } },
    {
      device: {
        ...device,
        control: { ...device.control, status: 'disabled' as const },
      },
    },
  ])(
    'blocks switching during pending requests or without permission',
    async (props) => {
      const page = mount(DeviceSwitchControl, { props: { device: props.device, busy: props.busy ?? false } });
      expect(page.findAll('button:disabled')).toHaveLength(2);
      await page.findAll('button')[0].trigger('click');
      expect(page.emitted('action')).toBeUndefined();
    },
  );
  it('shows transport failures and missing acknowledgement beside the controls', async () => {
    const page = mount(DeviceSwitchControl, {
      props: { device, error: 'Broker unavailable' },
    });
    expect(page.get('[role="alert"]').text()).toBe('Broker unavailable');
    const failedProps = {
      error: '',
      device: {
        ...device,
        state: { values: {}, command: { status: 'no_ack' } },
      },
    };
    await page.setProps(failedProps as Parameters<typeof page.setProps>[0]);
    expect(page.get('[role="alert"]').text()).toContain('not confirmed');
  });
});
