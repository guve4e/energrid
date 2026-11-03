import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MqttMessageHistory from './MqttMessageHistory.vue';

const message = { topic: 'lab/test', payloadPreview: '{"ok":true}', payloadBytes: 11,
  observedAt: '2026-11-03T13:00:00.000Z', validJson: true, handled: false, reason: 'unmapped' };

describe('MQTT message history', () => {
  it('renders empty state and formatted payload without interpreting traffic as device state', () => {
    const view = mount(MqttMessageHistory, { props: { messages: [], retainedCount: 0 } });
    expect(view.text()).toContain('No MQTT messages yet');
    view.unmount();
    const history = mount(MqttMessageHistory, { props: { messages: [message], retainedCount: 4 } });
    expect(history.text()).toContain('1 shown');
    expect(history.text()).toContain('4 retained');
    expect(history.text()).toContain('unmapped');
    expect(history.get('pre').text()).toContain('"ok": true');
    history.unmount();
  });
});
