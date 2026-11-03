<script setup lang="ts">
import type { useDiscoveryIntelligence } from './useDiscoveryIntelligence';
const props = defineProps<{ model: ReturnType<typeof useDiscoveryIntelligence> }>();
const { selectedAiDeviceId, mqttProfileLoading, loadMqttProfileHistory, previewMqttProfile, mqttProfileRunning, investigateMqttProfile, mqttProfileErrors, mqttProfileHistory, mqttProfileSelected, selectedMqttProfile, kitchenCaptureStatus, kitchenCaptureError, kitchenCaptureLoading, loadKitchenCaptureStatus } = props.model;
</script>
<template>
            <section
              class="device-ai-history"
              style="margin-top: 20px"
              aria-label="MQTT profile investigations"
            >
              <div class="section-row">
                <div>
                  <h4>MQTT profile investigations</h4>
                  <p class="section-help">
                    MQTT evidence has its own source identity; a LAN match is not assumed.
                    Captured evidence · AI proposal · Deterministic replay
                  </p>
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap">
                  <button
                    type="button"
                    class="secondary"
                    :disabled="!!mqttProfileLoading[selectedAiDeviceId]"
                    @click="loadMqttProfileHistory(selectedAiDeviceId)"
                  >
                    Refresh
                  </button>

                                    <button
                    type="button"
                    class="secondary"
                    @click="previewMqttProfile(selectedAiDeviceId)"
                  >
                    Preview replay
                  </button>

<button
                    type="button"
                    :disabled="!!mqttProfileRunning[selectedAiDeviceId]"
                    @click="investigateMqttProfile(selectedAiDeviceId)"
                  >
                    {{
                      mqttProfileRunning[selectedAiDeviceId]
                        ? 'Investigating...'
                        : 'Investigate MQTT evidence'
                    }}
                  </button>
                </div>
              </div>

              <p class="section-help">
                Read-only investigation. Captured MQTT evidence must
                already exist. No device commands or installations.
              </p>

              <div class="device-ai-card-detail evidence-source-note" style="margin: 12px 0">
                <strong>Kitchen ESP8266 — real MQTT evidence</strong>
                <p class="section-help">
                  Independent MQTT source; association with the selected LAN
                  device is unverified. Topic: <code>devices/temp-kitchen/data</code>
                </p>
                <button
                  type="button"
                  class="secondary"
                  :disabled="kitchenCaptureLoading"
                  @click="loadKitchenCaptureStatus()"
                >
                  {{ kitchenCaptureLoading ? 'Checking...' : 'Check kitchen evidence' }}
                </button>
                <p v-if="kitchenCaptureError" role="alert" class="error">
                  {{ kitchenCaptureError }}
                </p>
                <p v-if="kitchenCaptureStatus" class="section-help">
                  Capture:
                  {{ kitchenCaptureStatus.enabled ? 'Enabled' : 'Disabled' }}
                  · Stored samples returned:
                  {{ kitchenCaptureStatus.samplesInWindow }} (maximum 8)
                  · Latest capture:
                  {{ kitchenCaptureStatus.latestCapturedAt || 'None' }}
                </p>
              </div>

              <p
                v-if="mqttProfileLoading[selectedAiDeviceId]"
                class="section-help"
                role="status"
              >
                Loading saved MQTT profiles...
              </p>

              <p
                v-if="mqttProfileErrors[selectedAiDeviceId]"
                class="error"
                role="alert"
              >
                {{ mqttProfileErrors[selectedAiDeviceId] }}
              </p>

              <p
                v-if="
                  !mqttProfileLoading[selectedAiDeviceId] &&
                  !mqttProfileErrors[selectedAiDeviceId] &&
                  !mqttProfileHistory[selectedAiDeviceId]?.length
                "
                class="section-help"
              >
                No saved MQTT profile investigations yet.
              </p>

              <div
                v-if="mqttProfileHistory[selectedAiDeviceId]?.length"
                class="device-ai-history-list"
              >
                <button
                  v-for="record in mqttProfileHistory[selectedAiDeviceId]"
                  :key="record.id"
                  type="button"
                  class="device-ai-history-item"
                  :class="{
                    'is-selected': selectedMqttProfile?.id === record.id,
                  }"
                  @click="mqttProfileSelected[selectedAiDeviceId] = record"
                >
                  <strong>
                    {{ new Date(record.createdAt).toLocaleString() }}
                  </strong>
                  <span>
                    {{ record.result.provider }} /
                    {{ record.result.model }}
                  </span>
                  <small>
                    Replay: {{ record.result.replay.status }}
                    · {{ record.result.replay.testedSamples }} samples
                    · Not installed
                  </small>
                </button>
              </div>

              <article
                v-if="selectedMqttProfile"
                class="device-ai-card"
                style="margin-top: 16px"
              >
                <p
                  v-if="selectedMqttProfile.result.provider === 'offline-preview'"
                  class="section-help synthetic-preview-note"
                  role="status"
                >
                  SYNTHETIC PREVIEW — Not captured, not AI-generated,
                  not saved to investigation history.
                </p>


                <div class="device-ai-card-heading">
                  <strong>Observation profile proposal</strong>
                  <span class="device-ai-approval">
                    Proposed · Not installed
                  </span>
                </div>

                <p>
                  <strong>MQTT topic:</strong>
                  <code>
                    {{ selectedMqttProfile.result.proposal.selector }}
                  </code>
                </p>

                <div class="device-ai-card-detail">
                  <strong>Proposed field mappings</strong>
                  <ul>
                    <li
                      v-for="(mapping, field) in selectedMqttProfile.result.proposal.fields"
                      :key="field"
                    >
                      <code>{{ field }}</code>
                      ←
                      <code>{{ mapping.rawKey }}</code>
                      ({{ mapping.type }})
                    </li>
                  </ul>
                </div>

                <div class="device-ai-card-detail">
                  <strong>Deterministic replay</strong>
                  <p>
                    Result:
                    <strong>
                      {{ selectedMqttProfile.result.replay.status }}
                    </strong>
                    ·
                    {{ selectedMqttProfile.result.replay.acceptedSamples }}
                    accepted /
                    {{ selectedMqttProfile.result.replay.testedSamples }}
                    tested
                    ·
                    {{ selectedMqttProfile.result.replay.rejectedSamples }}
                    rejected
                  </p>

                  <strong>Replayed field values</strong>
                  <ul>
                    <li
                      v-for="(value, field) in selectedMqttProfile.result.replay.observedFields"
                      :key="field"
                    >
                      <code>{{ field }}</code>: {{ value }}
                    </li>
                  </ul>
                </div>

                <details>
                  <summary>Replay decisions and evidence</summary>
                  <ul>
                    <li
                      v-for="step in selectedMqttProfile.result.replay.steps"
                      :key="step.evidenceId"
                    >
                      <code>{{ step.evidenceId }}</code>
                      · {{ step.passed ? 'Passed' : 'Failed' }}
                      · {{ step.reason }}
                      <span v-if="step.rejectedFields.length">
                        · Rejected fields:
                        {{ step.rejectedFields.join(', ') }}
                      </span>
                    </li>
                  </ul>

                  <p class="section-help">
                    Supporting evidence references:
                    {{
                      selectedMqttProfile.result.proposal
                        .supportingEvidenceIds.join(', ')
                    }}
                  </p>
                </details>

                <p class="section-help">
                  Replay validates behavior against captured samples,
                  not physical sensor identity or measurement accuracy.
                  This profile has not been approved or installed.
                </p>
              </article>
            </section>
</template>
