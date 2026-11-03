import { describe, expect, it } from 'vitest';
import {
  buildMqttTree, compactMqttPayload, formatMqttPayload, mergeMqttMessage,
  mqttPipelineFor, parseMqttPayload, visibleMqttNodes, type MqttBusState,
} from './mqtt-model';

const message = (topic: string, overrides: Partial<MqttBusState['recentMessages'][number]> = {}) => ({
  topic, payloadPreview: '{"output":true}', payloadBytes: 15,
  observedAt: '2026-11-03T13:00:00.000Z', validJson: true, handled: true,
  reason: 'telemetry', ...overrides,
});
const bus = (messages = [message('energrid/site/relay')]): MqttBusState => ({
  enabled: true, status: 'running', broker: { host: 'broker', port: '1883' },
  prefix: 'energrid/site', subscriptions: ['energrid/site/#'],
  legacyTemperatureTopics: [], recentMessages: messages,
});

describe('MQTT Bus diagnostics model', () => {
  it('builds topic ancestry with accurate direct/aggregate counts', () => {
    const tree = buildMqttTree(bus([
      message('energrid/site/relay'),
      message('energrid/site/temp', { payloadPreview: '23' }),
    ]));
    expect(tree.find(n => n.topic === 'energrid/site')?.messageCount).toBe(2);
    // The subscribed '#' wildcard is also a direct child, matching the original Bus tree.
    expect(tree.find(n => n.topic === 'energrid/site')?.childCount).toBe(3);
    expect(tree.find(n => n.topic === 'energrid/site/relay')?.directMessageCount).toBe(1);
  });

  it('only reveals expanded branches unless searching, and preserves subscriptions', () => {
    const tree = buildMqttTree(bus());
    expect(visibleMqttNodes(tree, '', new Set()).map(n => n.topic)).toEqual(['energrid']);
    expect(visibleMqttNodes(tree, '', new Set(['energrid'])).map(n => n.topic)).toContain('energrid/site');
    expect(visibleMqttNodes(tree, 'relay', new Set()).map(n => n.topic)).toEqual(['energrid/site/relay']);
    expect(tree.find(n => n.topic === 'energrid/site/#')?.subscription).toBe(true);
  });

  it('suppresses duplicate events without mutating state and retains at most 200', () => {
    const original = bus();
    expect(mergeMqttMessage(original, original.recentMessages[0])).toBe(original);
    const incoming = message('other', { observedAt: '2026-11-03T13:00:01.000Z' });
    const updated = mergeMqttMessage(original, incoming);
    expect(updated).not.toBe(original);
    expect(original.recentMessages).toHaveLength(1);
    expect(updated.recentMessages[0]).toBe(incoming);
    let many = bus([]);
    for (let i = 0; i < 205; i++) many = mergeMqttMessage(many, message(`topic/${i}`));
    expect(many.recentMessages).toHaveLength(200);
  });

  it('retains the existing JSON/raw publish semantics', () => {
    expect(parseMqttPayload('{"x":1}')).toEqual({ x: 1 });
    expect(parseMqttPayload('not-json')).toBe('not-json');
    expect(parseMqttPayload(' ')).toBe('');
    expect(formatMqttPayload('{"x":1}')).toContain('  "x": 1');
    expect(compactMqttPayload('A'.repeat(150))).toHaveLength(143);
  });

  it('keeps pipeline status read-only and tied to actual recorded evidence', () => {
    expect(mqttPipelineFor(null).every(step => step.status === 'idle')).toBe(true);
    const failed = mqttPipelineFor(message('t', { handled: false, validJson: false, reason: 'invalid' }));
    expect(failed.find(step => step.id === 'parsed')?.status).toBe('failed');
    expect(failed.find(step => step.id === 'registry')?.status).toBe('failed');
    const accepted = mqttPipelineFor(message('t'));
    expect(accepted.find(step => step.id === 'registry')?.status).toBe('passed');
  });
});
