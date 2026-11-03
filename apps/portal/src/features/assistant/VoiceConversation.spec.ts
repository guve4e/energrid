import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import VoiceConversation from './VoiceConversation.vue';

describe('shared voice conversation', () => {
  it('renders both transcript and assistant output in the Portal', () => {
    const wrapper = mount(VoiceConversation, { props: { transcript: 'Light on', assistant: 'Done' } });
    expect(wrapper.text()).toContain('Light on');
    expect(wrapper.text()).toContain('Done');
  });
  it('uses the Bulgarian home presentation with honest empty states', () => {
    const wrapper = mount(VoiceConversation, { props: { variant: 'home', transcript: '', assistant: '' } });
    expect(wrapper.find('.home-assistant-conversation').exists()).toBe(true);
    expect(wrapper.text()).toContain('Тук ще се покаже');
  });
});
