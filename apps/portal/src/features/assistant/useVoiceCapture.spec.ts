import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useVoiceCapture } from './useVoiceCapture';
import type { useVoiceTransport } from './useVoiceTransport';

function session() {
  const trace = ref({ connectStartAt: 0, connectedAt: 0, recordStartAt: 1, releaseAt: 2,
    firstServerEventAt: 0, firstTranscriptAt: 0, firstAssistantTextAt: 0, firstAudioAt: 0,
    audioChunksSent: 0, audioBytesSent: 0, maxClientPeak: 0, sumSquares: 0, sampleCount: 0 });
  const transport = { connectVoice: vi.fn().mockResolvedValue(undefined),
    isVoiceReady: vi.fn().mockReturnValue(true), voiceStatus: ref('idle'),
    clientTrace: trace, resetTurn: vi.fn(), startClientRecording: vi.fn(),
    finishClientRecording: vi.fn(), trackClientAudio: vi.fn(),
    sendPcmChunk: vi.fn().mockReturnValue(true), sendEndOfTurn: vi.fn().mockReturnValue(true),
    disconnectVoice: vi.fn() } as unknown as ReturnType<typeof useVoiceTransport>;
  const voiceSetupError = ref('');
  let capture!: ReturnType<typeof useVoiceCapture>;
  const wrapper = mount(defineComponent({ setup() {
    capture = useVoiceCapture({ transport, voiceSetupError, onLog: vi.fn() });
    return () => h('div');
  } }));
  return { capture, transport, voiceSetupError, wrapper };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('microphone resource lifecycle', () => {
  it('reports microphone denial without opening a socket', async () => {
    const { capture, transport, voiceSetupError, wrapper } = session();
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')),
    } });
    await capture.startRecording();
    expect(voiceSetupError.value).toContain('permission was denied');
    expect(transport.connectVoice).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('releases a delayed stream if the user cancels before capture starts', async () => {
    const { capture, transport, wrapper } = session();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    let complete!: (stream: MediaStream) => void;
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; })),
    } });
    const pending = capture.startRecording();
    capture.cancelCapture();
    complete({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await pending;
    expect(stop).toHaveBeenCalledOnce();
    expect(transport.connectVoice).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
