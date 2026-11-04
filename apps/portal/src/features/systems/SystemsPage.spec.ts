import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SystemsPage from './SystemsPage.vue';

describe('SystemsPage', () => {
  it('renders real system policy and does not offer direct control', () => {
    const page = mount(SystemsPage, { props: { systems: [{ id: 'system-1', kind: 'slow_radiant_heating',
      displayName: 'Floor loop', capabilities: [{ kind: 'slow_radiant_zone' }],
      responseProfile: { thermalLagMinutes: 210 }, policy: { requiresApproval: true, safeRange: { min: 16, max: 28, unit: 'C' } },
      learning: { objective: 'Learn lag', signals: ['room temperature'], currentConfidence: 0.2 } }] as any } });
    expect(page.text()).toContain('Floor loop');
    expect(page.text()).toContain('210 min lag');
    expect(page.text()).toContain('16-28C');
    expect(page.find('button').exists()).toBe(false);
  });
});
