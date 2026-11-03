import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import InvestigationHistory from './InvestigationHistory.vue';

describe('saved investigation history', () => {
  it('shows the empty history state and does not start inference on refresh', async () => {
    const refresh = vi.fn();
    const wrapper = mount(InvestigationHistory, { props: { model: {
      selectedAiDeviceId: ref('dev'), selectedAiHistoryId: ref(null), aiHistory: ref({}),
      aiHistoryLoading: ref({}), aiHistoryErrors: ref({}),
      loadAiHistory: refresh, openAiHistoryRecord: vi.fn(),
    } as any } });
    expect(wrapper.text()).toContain('No saved investigations yet');
    await wrapper.find('button.secondary').trigger('click');
    expect(refresh).toHaveBeenCalledWith('dev');
  });
});
