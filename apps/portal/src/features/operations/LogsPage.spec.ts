import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LogsPage from './LogsPage.vue';

const logs = [{ id: 'e1', observedAt: '2026-11-03T19:00:00Z', level: 'warn',
  source: 'device-control', event: 'command.no_ack', message: 'Readback missing', deviceId: 'lab-relay' }];

describe('LogsPage', () => {
  it('filters evidence locally and keeps refresh explicit', async () => {
    const page = mount(LogsPage, { props: { logs: logs as any, clientMessages: [], apiBase: '', accessToken: 'test' },
      global: { stubs: { InteractionTraces: true } } });
    expect(page.text()).toContain('Readback missing');
    await page.get('input[placeholder="Search logs, topics, devices"]').setValue('no matching evidence');
    expect(page.text()).toContain('No logs match this view');
    await page.get('button.primary').trigger('click');
    expect(page.emitted('refresh')).toHaveLength(1);
  });
  it('switches to the existing read-only interaction viewer', async () => {
    const page = mount(LogsPage, { props: { logs: [] as any, clientMessages: [], apiBase: '', accessToken: '' },
      global: { stubs: { InteractionTraces: true } } });
    await page.findAll('[role="group"][aria-label="Log views"] button')[1].trigger('click');
    expect(page.find('interaction-traces-stub').exists()).toBe(true);
  });
});
