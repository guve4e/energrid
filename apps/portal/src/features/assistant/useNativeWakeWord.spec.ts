import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useNativeWakeWord } from './useNativeWakeWord';
import type { useVoiceTransport } from './useVoiceTransport';
import type { useVoiceCapture } from './useVoiceCapture';

afterEach(() => { vi.restoreAllMocks(); delete window.EnergridWakeWord; });
describe('optional native wake-word bridge', () => {
  it('opens a voice turn, streams PCM, and ends without auto-confirming actions', async () => {
    const beginCommandCapture = vi.fn(), assistantTurnFinished = vi.fn();
    window.EnergridWakeWord = { getStatus: () => JSON.stringify({ enabled: true, status: 'ready' }),
      setEnabled: vi.fn(), beginCommandCapture,
      startManualCommandCapture: vi.fn(), endManualCommandCapture: vi.fn(), assistantTurnFinished };
    const transport = { connectVoice: vi.fn().mockResolvedValue(undefined), isVoiceReady: vi.fn().mockReturnValue(true),
      voiceStatus: ref('idle') } as unknown as ReturnType<typeof useVoiceTransport>;
    const capture = { beginNativeRecording: vi.fn(), finishNativeRecording: vi.fn(),
      enqueueAndFlush: vi.fn() } as unknown as ReturnType<typeof useVoiceCapture>;
    let native!: ReturnType<typeof useNativeWakeWord>;
    const wrapper = mount(defineComponent({ setup() {
      native = useNativeWakeWord({ transport, capture, voiceSetupError: ref(''), onLog: vi.fn() });
      return () => h('div');
    } }));
    expect(native.nativeWakeEnabled.value).toBe(true);
    window.dispatchEvent(new Event('energrid-native-wake-word'));
    await Promise.resolve(); await Promise.resolve();
    expect(beginCommandCapture).toHaveBeenCalledOnce();
    expect(capture.beginNativeRecording).toHaveBeenCalledOnce();
    const pcm = new Uint8Array([1, 0, 2, 0]);
    window.energridNativeVoiceAudio?.(btoa(String.fromCharCode(...pcm)));
    expect(capture.enqueueAndFlush).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('energrid-native-command-ended'));
    expect(capture.finishNativeRecording).toHaveBeenCalledOnce();
    native.finishWakeTurn();
    expect(assistantTurnFinished).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(window.energridNativeVoiceAudio).toBeUndefined();
  });
});
