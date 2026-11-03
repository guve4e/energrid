import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import { formatBytes } from '../../shared/format-bytes';
import {
  buildMqttTree, visibleMqttNodes, mergeMqttMessage, mqttPipelineFor,
  parseMqttPayload, formatMqttPayload, type MqttBusState, type MqttDebugMessage,
} from './mqtt-model';

type Options = { apiBase: string; accessToken: Ref<string>; onLog: (line: string) => void };

/** Owns all Bus view state and the lifetime of its site-scoped EventSource. */
export function useMqttBus({ apiBase, accessToken, onLog }: Options) {
  const mqttBus = ref<MqttBusState | null>(null);
  const mqttBusLoading = ref(false);
  const mqttLoadError = ref('');
  const mqttBusStreamStatus = ref<'idle' | 'connecting' | 'live' | 'error' | 'closed'>('idle');
  const mqttTopicFilter = ref('');
  const mqttPublishTopic = ref('');
  const mqttPublishPayload = ref('{"type":"debug_ping","source":"portal"}');
  const mqttPublishBusy = ref(false);
  const mqttPublishError = ref('');
  const selectedMqttTopic = ref('');
  const expandedMqttTopics = ref<Set<string>>(new Set());
  let events: EventSource | null = null;
  let disposed = false;
  let sessionGeneration = 0;

  const mqttMessages = computed(() => {
    const filter = mqttTopicFilter.value.trim().toLowerCase();
    const messages = mqttBus.value?.recentMessages || [];
    return filter ? messages.filter((message) =>
      `${message.topic} ${message.reason} ${message.payloadPreview}`.toLowerCase().includes(filter)) : messages;
  });
  const mqttTreeNodes = computed(() => buildMqttTree(mqttBus.value));
  const visibleMqttTreeNodes = computed(() => visibleMqttNodes(
    mqttTreeNodes.value, mqttTopicFilter.value, expandedMqttTopics.value,
  ));
  const selectedMqttTopicMessages = computed(() => {
    const topic = selectedMqttTopic.value;
    const messages = mqttBus.value?.recentMessages || [];
    if (!topic) return mqttMessages.value;
    return messages.filter((message) => message.topic === topic || message.topic.startsWith(`${topic}/`));
  });
  const selectedMqttNode = computed(() => selectedMqttTopic.value
    ? mqttTreeNodes.value.find((node) => node.topic === selectedMqttTopic.value) || null : null);
  const selectedMqttLastMessage = computed(() => selectedMqttNode.value?.lastMessage || null);
  const selectedMqttPrettyPayload = computed(() => formatMqttPayload(selectedMqttLastMessage.value?.payloadPreview));
  const selectedMqttPipeline = computed(() => mqttPipelineFor(selectedMqttLastMessage.value));
  const selectedMqttMessageMeta = computed(() => {
    const message = selectedMqttLastMessage.value;
    return message ? {
      topic: message.topic, observedAt: message.observedAt,
      bytes: formatBytes(message.payloadBytes),
      format: message.validJson ? 'JSON' : 'Raw payload',
      outcome: message.handled ? 'Handled' : message.reason,
    } : null;
  });
  const mqttPublishTopicValue = computed(() => {
    const topic = mqttPublishTopic.value.trim();
    if (topic) return topic;
    if (selectedMqttTopic.value && !selectedMqttTopic.value.endsWith('/#')) return selectedMqttTopic.value;
    return `${mqttBus.value?.prefix || 'energrid/tenant-demo/site-home'}/debug/manual`;
  });
  const mqttStats = computed(() => {
    const messages = mqttBus.value?.recentMessages || [];
    return [
      { label: 'Messages', value: `${messages.length}`, detail: 'recent buffer' },
      { label: 'Handled', value: `${messages.filter(m => m.handled).length}`, detail: 'accepted by adapters' },
      { label: 'Invalid', value: `${messages.filter(m => !m.validJson).length}`, detail: 'not JSON' },
      { label: 'Subscriptions', value: `${mqttBus.value?.subscriptions.length || 0}`, detail: mqttBus.value?.status || 'unknown' },
    ];
  });

  async function loadMqttBus(options: { silent?: boolean } = {}) {
    if (mqttBusLoading.value || !accessToken.value || disposed) return;
    const generation = sessionGeneration;
    mqttBusLoading.value = true;
    mqttLoadError.value = '';
    try {
      const response = await authFetch(`${apiBase}/portal/bus/mqtt`, {
        headers: { Authorization: `Bearer ${accessToken.value}` },
      });
      if (!response.ok) throw new Error('MQTT debug state unavailable');
      const mqtt = await response.json() as MqttBusState;
      if (disposed || generation !== sessionGeneration) return;
      mqttBus.value = mqtt;
      if (!options.silent) onLog(`[bus] loaded ${mqtt.recentMessages.length} MQTT messages`);
    } catch (error) {
      if (disposed || generation !== sessionGeneration) return;
      mqttLoadError.value = error instanceof Error ? error.message : 'MQTT debug state unavailable';
      if (!options.silent) onLog(`[bus] load failed: ${mqttLoadError.value}`);
    } finally {
      if (!disposed && generation === sessionGeneration) mqttBusLoading.value = false;
    }
  }

  function startMqttBusStream() {
    if (events || !accessToken.value || disposed) return;
    mqttBusStreamStatus.value = 'connecting';
    const url = new URL(`${apiBase}/portal/bus/mqtt/events`, window.location.href);
    // Keep existing API auth contract; moving the token out of the query requires a separate backend change.
    url.searchParams.set('token', accessToken.value);
    const stream = new EventSource(url.toString());
    events = stream;
    stream.onopen = () => { mqttBusStreamStatus.value = 'live'; onLog('[bus] live MQTT stream connected'); };
    stream.onerror = () => { mqttBusStreamStatus.value = 'error'; onLog('[bus] live MQTT stream interrupted'); };
    stream.addEventListener('mqtt_message', (event) => {
      try {
        const message = JSON.parse((event as MessageEvent).data) as MqttDebugMessage;
        if (mqttBus.value) mqttBus.value = mergeMqttMessage(mqttBus.value, message);
      } catch {
        onLog('[bus] ignored malformed MQTT stream event');
      }
    });
  }

  function stopMqttBusStream() {
    if (!events) return;
    events.close();
    events = null;
    mqttBusStreamStatus.value = 'closed';
  }

  async function publishMqttDebugMessage() {
    if (mqttPublishBusy.value) return;
    mqttPublishBusy.value = true;
    mqttPublishError.value = '';
    try {
      const response = await authFetch(`${apiBase}/portal/bus/mqtt/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: mqttPublishTopicValue.value, payload: parseMqttPayload(mqttPublishPayload.value) }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || 'MQTT publish failed');
      onLog(`[bus] published ${formatBytes(result.payloadBytes || 0)} to ${result.topic}`);
      await loadMqttBus({ silent: true });
    } catch (error) {
      mqttPublishError.value = error instanceof Error ? error.message : String(error);
      onLog(`[bus] publish failed: ${mqttPublishError.value}`);
    } finally {
      mqttPublishBusy.value = false;
    }
  }

  function toggleMqttTopic(topic: string) {
    const next = new Set(expandedMqttTopics.value);
    if (next.has(topic)) next.delete(topic); else next.add(topic);
    expandedMqttTopics.value = next;
  }
  function selectMqttTopic(topic: string) {
    selectedMqttTopic.value = topic;
    mqttPublishTopic.value = topic.endsWith('/#') ? '' : topic;
  }

  function restartForSession() {
    sessionGeneration += 1;
    stopMqttBusStream();
    mqttBus.value = null;
    mqttBusLoading.value = false;
    void loadMqttBus();
    startMqttBusStream();
  }
  onMounted(restartForSession);
  watch(accessToken, restartForSession);
  onBeforeUnmount(() => {
    disposed = true;
    sessionGeneration += 1;
    stopMqttBusStream();
  });

  return {
    mqttBus, mqttBusLoading, mqttLoadError, mqttBusStreamStatus,
    mqttTopicFilter, mqttPublishTopic, mqttPublishPayload, mqttPublishBusy, mqttPublishError,
    selectedMqttTopic, expandedMqttTopics,
    mqttMessages, mqttTreeNodes, visibleMqttTreeNodes, selectedMqttTopicMessages,
    selectedMqttNode, selectedMqttLastMessage, selectedMqttPrettyPayload,
    selectedMqttPipeline, selectedMqttMessageMeta, mqttStats,
    loadMqttBus, publishMqttDebugMessage, toggleMqttTopic, selectMqttTopic,
  };
}
