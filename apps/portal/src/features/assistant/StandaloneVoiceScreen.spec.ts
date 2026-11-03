import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import StandaloneVoiceScreen from './StandaloneVoiceScreen.vue';
import type { VoiceWorkspace } from './useVoiceWorkspace';

describe('standalone Bulgarian voice view', () => {
  it('reuses conversation, talk, and approval controls', async () => {
    const close = vi.fn();
    const voice = {
      recording: ref(false), voiceStatus: ref('idle'), voiceSetupError: ref(''),
      pendingVoiceAction: ref(null), voiceActionOutcome: ref(''),
      transcript: ref('Добър ден'), assistant: ref('Здравейте'),
      startRecording: vi.fn(), stopRecording: vi.fn(), confirmVoiceAction: vi.fn(), cancelVoiceAction: vi.fn(),
    } as unknown as VoiceWorkspace;
    const wrapper = mount(StandaloneVoiceScreen, { props: { voice }, attrs: { onClose: close } });
    expect(wrapper.text()).toContain('Добър ден');
    expect(wrapper.find('.home-assistant-talk').exists()).toBe(true);
    await wrapper.get('.home-assistant-back').trigger('click');
    expect(close).toHaveBeenCalledOnce();
  });
});
