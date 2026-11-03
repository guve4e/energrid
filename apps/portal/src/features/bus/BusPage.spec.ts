import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import BusPage from './BusPage.vue';
import { authFetch } from '../../auth/auth-client';

vi.mock('../../auth/auth-client', () => ({ authFetch: vi.fn() }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, callback: EventListener) {
    this.listeners.set(name, callback as (event: MessageEvent) => void);
  }
  emitMessage(message: unknown) {
    this.listeners.get('mqtt_message')?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  close() { this.closed = true; }
}

const msg = { topic: 'lab/relay', payloadPreview: '{"output":false}', payloadBytes: 16,
  observedAt: '2026-11-03T13:00:00.000Z', validJson: true, handled: true, reason: 'telemetry' };
const snapshot = { enabled: true, status: 'running', broker: { host: 'broker', port: '1883' },
  prefix: 'lab', subscriptions: ['lab/#'], legacyTemperatureTopics: [], recentMessages: [msg] };

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/publish')) {
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ topic: body.topic, payloadBytes: 8 }) } as Response;
    }
    return { ok: true, json: async () => structuredClone(snapshot) } as Response;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Bus feature lifecycle', () => {
  it('loads diagnostics, merges live events once and closes stream on unmount', async () => {
    const view = mount(BusPage, { props: { apiBase: '', accessToken: 'token' } });
    await flushPromises();
    expect(view.text()).toContain('MQTT debug');
    expect(view.text()).toContain('broker');
    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = FakeEventSource.instances[0];
    const event = { ...msg, topic: 'lab/kitchen', observedAt: '2026-11-03T13:01:00.000Z' };
    stream.emitMessage(event);
    stream.emitMessage(event);
    await flushPromises();
    expect(view.text()).toContain('2 retained');
    view.unmount();
    expect(stream.closed).toBe(true);
  });

  it('publishes with the existing authenticated endpoint and payload contract', async () => {
    const view = mount(BusPage, { props: { apiBase: '', accessToken: 'token' } });
    await flushPromises();
    await view.get('.mqtt-publish-drawer textarea').setValue('{"x":1}');
    await view.get('.mqtt-publish-drawer input').setValue('lab/manual');
    await view.get('.mqtt-publish-drawer button').trigger('click');
    await flushPromises();
    const call = vi.mocked(authFetch).mock.calls.find(([url]) => String(url).endsWith('/publish'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]?.body))).toEqual({ topic: 'lab/manual', payload: { x: 1 } });
    view.unmount();
  });

  it('does not keep old-site streams after authentication changes', async () => {
    const view = mount(BusPage, { props: { apiBase: '', accessToken: 'old-token' } });
    await flushPromises();
    const old = FakeEventSource.instances[0];
    await view.setProps({ accessToken: 'new-token' });
    await flushPromises();
    expect(old.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain('new-token');
    view.unmount();
  });
});
