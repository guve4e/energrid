import { formatBytes } from '../../shared/format-bytes';

/** Canonical Portal MQTT diagnostics contract. This is not a device-control contract. */
export type MqttBusState = {
  enabled: boolean;
  status: 'disabled' | 'running' | 'stopped';
  broker: {
    host: string;
    port: string;
  };
  prefix: string;
  subscriptions: string[];
  legacyTemperatureTopics: string[];
  recentMessages: Array<{
    topic: string;
    payloadPreview: string;
    payloadBytes: number;
    observedAt: string;
    validJson: boolean;
    handled: boolean;
    reason: string;
  }>;
};

export type MqttDebugMessage = MqttBusState['recentMessages'][number];

export type MqttTreeNode = {
  key: string;
  topic: string;
  label: string;
  depth: number;
  messageCount: number;
  directMessageCount: number;
  childCount: number;
  lastMessage: MqttDebugMessage | null;
  subscription: boolean;
};

export type MqttPipelineStep = {
  id: string;
  label: string;
  detail: string;
  status: 'passed' | 'warning' | 'failed' | 'idle';
};

export function buildMqttTree(bus: MqttBusState | null): MqttTreeNode[] {
  if (!bus) return [];
  const nodeMap = new Map<string, MqttTreeNode>();
  const ensureNode = (topic: string, subscription = false) => {
    const parts = topic.split('/').filter(Boolean);
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      if (!nodeMap.has(path)) {
        nodeMap.set(path, {
          key: path, topic: path, label: part, depth: index,
          messageCount: 0, directMessageCount: 0, childCount: 0,
          lastMessage: null, subscription: false,
        });
      }
    });
    const node = nodeMap.get(topic);
    if (node) node.subscription = node.subscription || subscription;
  };

  for (const subscription of bus.subscriptions) ensureNode(subscription, true);
  for (const message of bus.recentMessages) {
    const parts = message.topic.split('/').filter(Boolean);
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      let node = nodeMap.get(path);
      if (!node) {
        node = {
          key: path, topic: path, label: part, depth: index,
          messageCount: 0, directMessageCount: 0, childCount: 0,
          lastMessage: null, subscription: false,
        };
        nodeMap.set(path, node);
      }
      node.messageCount += 1;
      if (!node.lastMessage || Date.parse(message.observedAt) > Date.parse(node.lastMessage.observedAt)) {
        node.lastMessage = message;
      }
    });
    const leaf = nodeMap.get(message.topic);
    if (leaf) leaf.directMessageCount += 1;
  }

  for (const node of nodeMap.values()) {
    const parent = node.topic.split('/').slice(0, -1).join('/');
    const parentNode = nodeMap.get(parent);
    if (parentNode) parentNode.childCount += 1;
  }
  return [...nodeMap.values()].sort((left, right) => left.topic.localeCompare(right.topic));
}

export function visibleMqttNodes(nodes: MqttTreeNode[], filter: string, expanded: Set<string>): MqttTreeNode[] {
  const search = filter.trim().toLowerCase();
  return nodes.filter((node) => {
    if (search) return `${node.topic} ${node.lastMessage?.payloadPreview || ''}`.toLowerCase().includes(search);
    if (node.depth === 0) return true;
    return expanded.has(node.topic.split('/').slice(0, -1).join('/'));
  });
}

export function mergeMqttMessage(bus: MqttBusState, message: MqttDebugMessage): MqttBusState {
  const messageKey = `${message.observedAt}:${message.topic}:${message.payloadBytes}`;
  if (bus.recentMessages.some(candidate =>
    `${candidate.observedAt}:${candidate.topic}:${candidate.payloadBytes}` === messageKey)) return bus;
  return { ...bus, recentMessages: [message, ...bus.recentMessages].slice(0, 200) };
}

export function parseMqttPayload(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try { return JSON.parse(trimmed); } catch { return value; }
}

export function formatMqttPayload(value?: string): string {
  if (!value) return 'No selected topic value yet.';
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

export function compactMqttPayload(value?: string): string {
  if (!value) return 'No selected topic value yet.';
  return value.length <= 140 ? value : `${value.slice(0, 140)}...`;
}

export function formatMqttTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

export function mqttPipelineFor(message: MqttDebugMessage | null): MqttPipelineStep[] {
  if (!message) {
    return [
      {
        id: 'received',
        label: 'MQTT received',
        detail: 'Select a topic containing at least one message.',
        status: 'idle',
      },
      {
        id: 'parsed',
        label: 'Payload parsed',
        detail: 'Waiting for a selected MQTT message.',
        status: 'idle',
      },
      {
        id: 'handler',
        label: 'Handler selected',
        detail: 'Waiting for parser classification.',
        status: 'idle',
      },
      {
        id: 'registry',
        label: 'Registry outcome',
        detail: 'No adapter result is available yet.',
        status: 'idle',
      },
      {
        id: 'portal',
        label: 'Portal visibility',
        detail: 'No normalized result is available yet.',
        status: 'idle',
      },
    ];
  }

  const reason = message.reason.toLowerCase();
  const registryUpdated =
    message.handled &&
    [
      'telemetry',
      'status',
      'registry',
      'legacy framework device',
      'legacy temperature',
      'shelly',
    ].some((token) => reason.includes(token));

  const adapterOnly = message.handled && !registryUpdated;

  return [
    {
      id: 'received',
      label: 'MQTT received',
      detail: `${formatBytes(message.payloadBytes)} received on ${message.topic}.`,
      status: 'passed',
    },
    {
      id: 'parsed',
      label: 'Payload parsed',
      detail: message.validJson
        ? 'Payload decoded as valid JSON.'
        : 'Payload could not be decoded as JSON.',
      status: message.validJson ? 'passed' : 'failed',
    },
    {
      id: 'handler',
      label: 'Handler selected',
      detail: message.handled
        ? `Accepted as ${message.reason}.`
        : message.validJson
          ? `No known adapter accepted this JSON message: ${message.reason}.`
          : 'No adapter processing was attempted for invalid JSON.',
      status: message.handled
        ? 'passed'
        : message.validJson
          ? 'warning'
          : 'failed',
    },
    {
      id: 'registry',
      label: 'Registry outcome',
      detail: registryUpdated
        ? 'Normalized device information was passed into the device registry.'
        : adapterOnly
          ? 'Handled by an adapter, but no registry update is inferred.'
          : 'No device registry update was produced.',
      status: registryUpdated ? 'passed' : adapterOnly ? 'warning' : 'failed',
    },
    {
      id: 'portal',
      label: 'Portal visibility',
      detail: registryUpdated
        ? 'The normalized state can be exposed through the portal snapshot.'
        : message.handled
          ? 'The event is visible in diagnostics, but may not represent device state.'
          : 'The event remains visible only as raw MQTT diagnostic traffic.',
      status: registryUpdated
        ? 'passed'
        : message.handled
          ? 'warning'
          : 'failed',
    },
  ];
}
