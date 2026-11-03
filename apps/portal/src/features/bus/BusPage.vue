<script setup lang="ts">
import { toRef } from 'vue';
import { compactMqttPayload, formatMqttTime } from './mqtt-model';
import MqttTopicTree from './MqttTopicTree.vue';
import MqttMessageHistory from './MqttMessageHistory.vue';
import { useMqttBus } from './useMqttBus';

const props = defineProps<{ apiBase: string; accessToken: string }>();
const emit = defineEmits<{ log: [line: string] }>();
const {
  mqttBus, mqttBusLoading, mqttLoadError, mqttBusStreamStatus,
  mqttTopicFilter, mqttPublishTopic, mqttPublishPayload, mqttPublishBusy, mqttPublishError,
  selectedMqttTopic, expandedMqttTopics, visibleMqttTreeNodes,
  selectedMqttTopicMessages, selectedMqttNode, selectedMqttLastMessage,
  selectedMqttPrettyPayload, selectedMqttPipeline, selectedMqttMessageMeta,
  mqttStats, loadMqttBus, publishMqttDebugMessage, toggleMqttTopic, selectMqttTopic,
} = useMqttBus({ apiBase: props.apiBase, accessToken: toRef(props, 'accessToken'), onLog: line => emit('log', line) });
</script>
<template>
        <section class="panel workspace-panel">
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Site Bus</p>
              <h2>MQTT debug</h2>
              <span
                >Inspect broker traffic, trace adapter decisions, and confirm
                how MQTT messages reach the Energrid device registry.</span
              >
            </div>
            <div class="bus-actions">
              <span :class="['live-indicator', mqttBusStreamStatus]">
                <span
                  :class="[
                    'dot',
                    mqttBusStreamStatus === 'live'
                      ? 'green'
                      : mqttBusStreamStatus === 'error'
                        ? 'amber'
                        : 'blue',
                  ]"
                ></span>
                {{
                  mqttBusStreamStatus === 'live'
                    ? 'Live stream'
                    : mqttBusStreamStatus === 'connecting'
                      ? 'Connecting stream'
                      : mqttBusStreamStatus === 'error'
                        ? 'Stream retrying'
                        : 'Stream idle'
                }}
              </span>
              <button
                class="primary"
                type="button"
                :disabled="mqttBusLoading"
                @click="loadMqttBus()"
              >
                {{ mqttBusLoading ? 'Refreshing...' : 'Refresh bus' }}
              </button>
            </div>
          </div>

          <p v-if="mqttLoadError" class="error" role="alert">{{ mqttLoadError }}</p>
          <div v-if="mqttBus" class="bus-page">
            <div class="scan-origin bus-status-grid">
              <div>
                <span>Status</span>
                <strong>{{ mqttBus.status }}</strong>
              </div>
              <div>
                <span>Broker</span>
                <strong
                  >{{ mqttBus.broker.host }}:{{ mqttBus.broker.port }}</strong
                >
              </div>
              <div>
                <span>Prefix</span>
                <strong>{{ mqttBus.prefix }}</strong>
              </div>
            </div>

            <section class="mqtt-explorer">
              <MqttTopicTree
                :bus="mqttBus"
                :nodes="visibleMqttTreeNodes"
                :selected-topic="selectedMqttTopic"
                :expanded-topics="expandedMqttTopics"
                :filter="mqttTopicFilter"
                @update:filter="mqttTopicFilter = $event"
                @select="selectMqttTopic"
                @toggle="toggleMqttTopic"
              />

              <section class="mqtt-detail-panel">
                <div class="section-row">
                  <div>
                    <h3>{{ selectedMqttTopic || 'Select a topic' }}</h3>
                    <span class="section-help">
                      {{
                        selectedMqttNode
                          ? `${selectedMqttNode.messageCount} messages in this branch`
                          : `${mqttBus.recentMessages.length} retained in recent buffer`
                      }}
                    </span>
                  </div>
                  <span
                    v-if="selectedMqttNode?.lastMessage"
                    :class="[
                      'trust-pill',
                      selectedMqttNode.lastMessage.handled
                        ? 'approved'
                        : selectedMqttNode.lastMessage.validJson
                          ? 'unknown'
                          : 'discovered',
                    ]"
                  >
                    {{
                      selectedMqttNode.lastMessage.handled
                        ? 'handled'
                        : selectedMqttNode.lastMessage.reason
                    }}
                  </span>
                </div>

                <div class="mqtt-value-card">
                  <span>Last value</span>
                  <code>{{
                    compactMqttPayload(selectedMqttLastMessage?.payloadPreview)
                  }}</code>
                  <details
                    v-if="selectedMqttLastMessage"
                    class="payload-details"
                  >
                    <summary>Formatted JSON</summary>
                    <pre>{{ selectedMqttPrettyPayload }}</pre>
                  </details>
                </div>

                <details class="mqtt-publish-drawer" open>
                  <summary>Publish</summary>
                  <label>
                    Topic
                    <input
                      v-model="mqttPublishTopic"
                      :placeholder="`${mqttBus.prefix}/debug/manual`"
                      autocomplete="off"
                    />
                  </label>
                  <label>
                    Payload
                    <textarea v-model="mqttPublishPayload" rows="5"></textarea>
                  </label>
                  <button
                    class="primary"
                    type="button"
                    :disabled="mqttPublishBusy"
                    @click="publishMqttDebugMessage"
                  >
                    {{ mqttPublishBusy ? 'Publishing...' : 'Publish message' }}
                  </button>
                  <p v-if="mqttPublishError" class="error">
                    {{ mqttPublishError }}
                  </p>
                </details>
              </section>

              <aside class="mqtt-pipeline-panel">
                <div class="mqtt-pipeline-heading">
                  <div>
                    <span>Processing trace</span>
                    <h3>Message pipeline</h3>
                  </div>
                  <span
                    v-if="selectedMqttLastMessage"
                    :class="[
                      'trust-pill',
                      selectedMqttLastMessage.handled
                        ? 'approved'
                        : selectedMqttLastMessage.validJson
                          ? 'unknown'
                          : 'discovered',
                    ]"
                  >
                    {{
                      selectedMqttLastMessage.handled
                        ? 'accepted'
                        : 'not handled'
                    }}
                  </span>
                </div>

                <div v-if="selectedMqttMessageMeta" class="mqtt-message-meta">
                  <div>
                    <span>Topic</span>
                    <strong>{{ selectedMqttMessageMeta.topic }}</strong>
                  </div>
                  <div>
                    <span>Observed</span>
                    <strong>{{
                      formatMqttTime(selectedMqttMessageMeta.observedAt)
                    }}</strong>
                  </div>
                  <div>
                    <span>Format</span>
                    <strong>{{ selectedMqttMessageMeta.format }}</strong>
                  </div>
                  <div>
                    <span>Size</span>
                    <strong>{{ selectedMqttMessageMeta.bytes }}</strong>
                  </div>
                </div>

                <div class="mqtt-pipeline">
                  <article
                    v-for="(step, index) in selectedMqttPipeline"
                    :key="step.id"
                    :class="['mqtt-pipeline-step', step.status]"
                  >
                    <div class="mqtt-pipeline-rail">
                      <span class="mqtt-pipeline-marker">
                        {{
                          step.status === 'passed'
                            ? '✓'
                            : step.status === 'failed'
                              ? '×'
                              : step.status === 'warning'
                                ? '!'
                                : '·'
                        }}
                      </span>
                      <span
                        v-if="index < selectedMqttPipeline.length - 1"
                        class="mqtt-pipeline-line"
                      ></span>
                    </div>
                    <div>
                      <strong>{{ step.label }}</strong>
                      <span>{{ step.detail }}</span>
                    </div>
                  </article>
                </div>

                <div class="mqtt-pipeline-outcome">
                  <span>Adapter decision</span>
                  <strong>
                    {{
                      selectedMqttMessageMeta?.outcome ||
                      'Select a topic to inspect its latest message'
                    }}
                  </strong>
                </div>

                <div class="network-stat-grid compact-stats">
                  <div v-for="item in mqttStats" :key="item.label">
                    <span>{{ item.label }}</span>
                    <strong>{{ item.value }}</strong>
                    <small>{{ item.detail }}</small>
                  </div>
                </div>
              </aside>
            </section>

            <MqttMessageHistory
              :messages="selectedMqttTopicMessages"
              :retained-count="mqttBus.recentMessages.length"
            />
          </div>

          <div v-else class="discovery-empty">
            <strong>MQTT debug state unavailable</strong>
            <span>Load the bus state after the API is online.</span>
          </div>
        </section>

</template>
