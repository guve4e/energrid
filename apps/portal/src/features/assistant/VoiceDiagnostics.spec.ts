import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import VoiceDiagnostics from './VoiceDiagnostics.vue';

describe('voice diagnostics', () => {
  it('shows the measured stages without inventing values', () => {
    const wrapper = mount(VoiceDiagnostics, { props: { bottleneck: 'No completed turn yet.',
      serverMetrics: [{ label: 'STT', value: '--' }], clientMetrics: [{ label: 'Held', value: '120ms' }] } });
    expect(wrapper.text()).toContain('No completed turn yet.');
    expect(wrapper.text()).toContain('120ms');
    expect(wrapper.text()).toContain('STT');
  });
});
