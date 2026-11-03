import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MqttTopicTree from './MqttTopicTree.vue';
import { buildMqttTree, type MqttBusState } from './mqtt-model';

const bus: MqttBusState = {
  enabled: true, status: 'running', broker: { host: 'lab-broker', port: '1883' },
  prefix: 'lab', subscriptions: ['lab/#'], legacyTemperatureTopics: [],
  recentMessages: [{ topic: 'lab/relay', payloadPreview: 'ON', payloadBytes: 2,
    observedAt: '2026-11-03T13:00:00.000Z', validJson: false, handled: false, reason: 'raw' }],
};

describe('MQTT topic tree', () => {
  it('renders topics, publishes selection, and emits branch toggling separately', async () => {
    const nodes = buildMqttTree(bus);
    const view = mount(MqttTopicTree, {
      props: { bus, nodes, selectedTopic: '', expandedTopics: new Set(), filter: '' },
    });
    expect(view.text()).toContain('lab-broker');
    await view.find('button.mqtt-tree-row').trigger('click');
    expect(view.emitted('select')?.[0]).toEqual(['lab']);
    await view.find('.mqtt-tree-toggle').trigger('click');
    expect(view.emitted('toggle')?.[0]).toEqual(['lab']);
    await view.find('input').setValue('relay');
    expect(view.emitted('update:filter')?.[0]).toEqual(['relay']);
    view.unmount();
  });
});
