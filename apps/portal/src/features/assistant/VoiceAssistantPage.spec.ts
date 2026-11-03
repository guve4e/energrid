import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import VoiceAssistantPage from './VoiceAssistantPage.vue';
import type { VoiceWorkspace } from './useVoiceWorkspace';

describe('Voice Assistant feature page', () => {
  it('renders reusable controls and retains route selection', async () => {
    const setEndpointMode = vi.fn();
    const voice = {
      recording: ref(false), voiceStatus: ref('idle'), pendingVoiceAction: ref(null),
      voiceActionOutcome: ref(''), transcript: ref(''), assistant: ref(''),
      voiceLinkStatus: ref({ label: 'standby', tone: 'blue' }), voiceSetupError: ref(''),
      endpointMode: ref('same-origin'), canUseLanDirect: ref(true), lanPortalUrl: 'http://localhost',
      effectiveRouteLabel: ref('Public domain'), assistantTraceRefresh: ref(0), assistantLatestTraceId: ref(''),
      startRecording: vi.fn(), stopRecording: vi.fn(), confirmVoiceAction: vi.fn(), cancelVoiceAction: vi.fn(),
      setEndpointMode, compactMetrics: ref([]), clientDiagnostics: ref([]), bottleneckMessage: ref('No completed turn yet.'),
      displayVoiceLogs: ref([]), voiceRuns: ref([]), voiceRunsLoading: ref(false), voiceRunsError: ref(''),
      loadVoiceRuns: vi.fn(),
    } as unknown as VoiceWorkspace;
    const wrapper = mount(VoiceAssistantPage, { props: {
      voice, serverLabel: 'Local', sttProvider: 'local', apiBase: '', accessToken: '',
    }, global: { stubs: { InteractionTraces: true } } });
    expect(wrapper.find('.talk-button').exists()).toBe(true);
    expect(wrapper.text()).toContain('No saved turns yet');
    await wrapper.findAll('.route-controls button')[1].trigger('click');
    expect(setEndpointMode).toHaveBeenCalledWith('lan');
  });
});
