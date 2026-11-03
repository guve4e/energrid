import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useVoiceTransport } from './useVoiceTransport';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static created: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  send = vi.fn();
  close = vi.fn(() => { this.readyState = FakeSocket.CLOSED; this.dispatchEvent(new Event('close')); });
  constructor(readonly url: string) { super(); FakeSocket.created.push(this); }
  open() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event('open')); }
  message(event: Record<string, unknown>) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }
}
function harness() {
  const token = ref('token-1');
  const onTurnComplete = vi.fn(), onAudioChunk = vi.fn(), onWakeTurnFinished = vi.fn();
  let model!: ReturnType<typeof useVoiceTransport>;
  const wrapper = mount(defineComponent({ setup() {
    model = useVoiceTransport({ accessToken: token, effectiveWsUrl: ref('ws://localhost/voice'),
      onLog: vi.fn(), onTurnComplete, onAudioChunk, onWakeTurnFinished, onDiagnostic: () => 'OK' });
    return () => h('div');
  } }));
  return { wrapper, model, token, onTurnComplete, onAudioChunk };
}
afterEach(() => { vi.unstubAllGlobals(); FakeSocket.created = []; });
describe('authenticated voice transport lifecycle', () => {
  it('authenticates, receives transcript, and closes after turn end', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { wrapper, model, onTurnComplete } = harness();
    const request = model.connectVoice();
    const socket = FakeSocket.created[0];
    socket.open();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'authenticate', token: 'token-1' }));
    socket.message({ type: 'authenticated' });
    await request;
    expect(model.connected.value).toBe(true);
    socket.message({ type: 'stt_final', text: 'Включи лампата' });
    socket.message({ type: 'assistant_final', text: 'Готово' });
    expect(model.transcript.value).toBe('Включи лампата');
    expect(model.assistant.value).toBe('Готово');
    socket.message({ type: 'turn_end', metrics: { totalMs: 1500 } });
    expect(onTurnComplete).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalled();
    expect(model.connected.value).toBe(false);
    wrapper.unmount();
  });
  it('only sends exact unexpired approvals after server confirmation requests', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { wrapper, model } = harness();
    const request = model.connectVoice();
    const socket = FakeSocket.created[0];
    socket.open(); socket.message({ type: 'authenticated' }); await request;
    model.confirmVoiceAction();
    expect(socket.send).toHaveBeenCalledTimes(1); // Authenticate only.
    socket.message({ type: 'action_confirmation_required', approvalId: 'approval-1',
      expiresAt: Date.now() + 1000, actions: [] });
    model.confirmVoiceAction();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'confirm_action', approvalId: 'approval-1' }));
    model.cancelVoiceAction();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'cancel_action', approvalId: 'approval-1' }));
    socket.message({ type: 'action_confirmation_required', approvalId: 'expired',
      expiresAt: Date.now() - 1, actions: [] });
    const count = socket.send.mock.calls.length;
    model.confirmVoiceAction();
    expect(socket.send).toHaveBeenCalledTimes(count);
    wrapper.unmount();
  });
  it('discards late packets after sign-out or socket replacement', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { wrapper, model, token } = harness();
    const request = model.connectVoice();
    const old = FakeSocket.created[0];
    old.open(); old.message({ type: 'authenticated' }); await request;
    token.value = '';
    await Promise.resolve();
    expect(model.connected.value).toBe(false);
    old.message({ type: 'assistant_final', text: 'stale result' });
    expect(model.assistant.value).not.toBe('stale result');
    wrapper.unmount();
  });
});
