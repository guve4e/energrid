import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ExecutionsPage from './ExecutionsPage.vue';

describe('ExecutionsPage', () => {
  it('renders execution evidence and emits selection without issuing commands', async () => {
    const page = mount(ExecutionsPage, { props: { traces: [{ id: 'trace-1', deviceId: 'lab-relay',
      action: 'turn_on', outcome: 'acked', durationMs: 20, requestedAt: '2026-11-03T19:00:00Z',
      completedAt: null, actor: { type: 'user', name: 'Installer' } }] as any } });
    expect(page.text()).toContain('lab-relay');
    await page.get('.execution-row').trigger('click');
    expect(page.emitted('openTrace')?.[0]).toEqual(['trace-1']);
    await page.get('button.primary').trigger('click');
    expect(page.emitted('refresh')).toHaveLength(1);
  });
  it('shows an honest empty state with no invented history', () => {
    const page = mount(ExecutionsPage, { props: { traces: [] } });
    expect(page.text()).toContain('No executions yet');
    expect(page.find('.execution-row').exists()).toBe(false);
  });
});
