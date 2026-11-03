import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import VoiceRunHistory from './VoiceRunHistory.vue';

describe('read-only voice run history', () => {
  it('shows empty state and can request a refresh', async () => {
    const wrapper = mount(VoiceRunHistory, { props: { runs: [], loading: false, error: '' } });
    expect(wrapper.text()).toContain('No saved turns yet');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });
  it('renders stored transcript, assistant, and errors', () => {
    const wrapper = mount(VoiceRunHistory, { props: { loading: false, error: 'History unavailable', runs: [{
      id: 'r1', completedAt: '2026-10-01T12:00:00Z', transcript: 'hello', assistantReply: 'Hi',
      intent: 'question', errors: ['No device command'], metrics: { sttMs: 300 },
    }] } });
    expect(wrapper.text()).toContain('hello');
    expect(wrapper.text()).toContain('Hi');
    expect(wrapper.text()).toContain('History unavailable');
  });
});
