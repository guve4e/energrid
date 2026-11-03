<script setup lang="ts">
import type { MqttDebugMessage } from './mqtt-model';
import { compactMqttPayload, formatMqttPayload, formatMqttTime } from './mqtt-model';
import { formatBytes } from '../../shared/format-bytes';

defineProps<{ messages: MqttDebugMessage[]; retainedCount: number }>();
</script>
<template>
            <section class="bus-stream">
              <div class="section-row">
                <div>
                  <h3>History</h3>
                  <span class="section-help">
                    {{ messages.length }} shown ·
                    {{ retainedCount }} retained
                  </span>
                </div>
              </div>
              <div
                v-if="messages.length === 0"
                class="discovery-empty compact"
              >
                <strong>No MQTT messages yet</strong>
                <span
                  >Publish a test message, or wait for devices and adapters to
                  emit telemetry on the site bus.</span
                >
              </div>
              <div v-else class="network-table-wrap">
                <table class="network-table bus-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Topic</th>
                      <th>Result</th>
                      <th>Bytes</th>
                      <th>Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="message in messages"
                      :key="`${message.observedAt}-${message.topic}`"
                    >
                      <td data-label="Time">
                        <strong>{{
                          formatMqttTime(message.observedAt)
                        }}</strong>
                        <span>{{ message.observedAt }}</span>
                      </td>
                      <td data-label="Topic">
                        <strong>{{ message.topic }}</strong>
                        <span>{{ message.validJson ? 'json' : 'raw' }}</span>
                      </td>
                      <td data-label="Result">
                        <span
                          :class="[
                            'trust-pill',
                            message.handled
                              ? 'approved'
                              : message.validJson
                                ? 'unknown'
                                : 'discovered',
                          ]"
                        >
                          {{ message.handled ? 'handled' : message.reason }}
                        </span>
                      </td>
                      <td data-label="Bytes">
                        <strong>{{ formatBytes(message.payloadBytes) }}</strong>
                      </td>
                      <td data-label="Payload">
                        <code>{{
                          compactMqttPayload(message.payloadPreview)
                        }}</code>
                        <details class="payload-details compact">
                          <summary>
                            {{
                              message.validJson
                                ? 'Formatted JSON'
                                : 'Raw payload'
                            }}
                          </summary>
                          <pre>{{
                            formatMqttPayload(message.payloadPreview)
                          }}</pre>
                        </details>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
</template>
