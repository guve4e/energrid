import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { authFetch } from '../../auth/auth-client';
import EnergridChatWidget from './EnergridChatWidget.vue';

vi.mock('../../auth/auth-client', () => ({ authFetch: vi.fn() }));
afterEach(() => vi.mocked(authFetch).mockReset());

describe('Energrid chat rendering', () => {
  it('renders assistant formatting without inserting model-supplied HTML', async () => {
    vi.mocked(authFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        conversationId: 'conversation-1',
        reply: 'Валеж: **0 mm**. `weather_get_forecast`\n<img src=x onerror=alert(1)>',
      }),
    } as Response);
    const widget = mount(EnergridChatWidget, {
      props: { apiBase: '', accessToken: 'test-token' },
    });
    try {
      await widget.get('.energrid-chat-launcher').trigger('click');
      // jsdom does not implement Element.scrollTo(), which browsers provide.
      // Stub only this widget's scroll container so the async send can finish.
      const scrollContainer = widget.get('.energrid-chat-messages').element as HTMLElement;
      const scrollTo = vi.fn();
      Object.defineProperty(scrollContainer, 'scrollTo', {
        value: scrollTo,
        configurable: true,
      });
      await widget.get('textarea').setValue('**Do not format my question**');
      await widget.get('form').trigger('submit');
      await flushPromises();
      const assistant = widget.get('.energrid-chat-message.assistant');
      expect(assistant.get('strong').text()).toBe('0 mm');
      expect(assistant.get('code').text()).toBe('weather_get_forecast');
      expect(assistant.find('img').exists()).toBe(false);
      expect(assistant.text()).toContain('<img src=x onerror=alert(1)>');
      expect(widget.get('.energrid-chat-message.user').text()).toContain('**Do not format my question**');
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      widget.unmount();
    }
  });
});
