<script setup lang="ts">
import type { useDiscoveryIntelligence } from './useDiscoveryIntelligence';
const props = defineProps<{ model: ReturnType<typeof useDiscoveryIntelligence> }>();
const { selectedAiDeviceId, selectedAiHistoryId, aiHistory, aiHistoryLoading, aiHistoryErrors, loadAiHistory, openAiHistoryRecord } = props.model;
</script>
<template>
            <section class="device-ai-history">
              <div class="section-row">
                <div>
                  <h4>Investigation history</h4>
                  <p class="section-help">
                    Saved locally · Reopen without AI inference
                  </p>
                </div>

                <button
                  type="button"
                  class="secondary"
                  :disabled="!!aiHistoryLoading[selectedAiDeviceId]"
                  @click="loadAiHistory(selectedAiDeviceId)"
                >
                  Refresh history
                </button>
              </div>

              <p
                v-if="aiHistoryLoading[selectedAiDeviceId]"
                role="status"
                class="section-help"
              >
                Loading saved investigations...
              </p>

              <p
                v-if="aiHistoryErrors[selectedAiDeviceId]"
                role="alert"
                class="error"
              >
                {{ aiHistoryErrors[selectedAiDeviceId] }}
              </p>

              <p
                v-if="
                  !aiHistoryLoading[selectedAiDeviceId] &&
                  !aiHistoryErrors[selectedAiDeviceId] &&
                  !(aiHistory[selectedAiDeviceId]?.length)
                "
                class="section-help"
              >
                No saved investigations yet.
              </p>

              <div
                v-if="aiHistory[selectedAiDeviceId]?.length"
                class="device-ai-history-list"
              >
                <button
                  v-for="record in aiHistory[selectedAiDeviceId]"
                  :key="record.id"
                  type="button"
                  class="device-ai-history-item"
                  :class="{ 'is-selected': selectedAiHistoryId === record.id }"
                  @click="openAiHistoryRecord(record)"
                >
                  <strong>
                    {{ new Date(record.createdAt).toLocaleString() }}
                  </strong>

                  <span>
                    {{ record.result.provider }} /
                    {{ record.result.model }}
                  </span>

                  <small>
                    {{ record.result.evidenceSnapshot?.evidence.length ?? 0 }}
                    evidence records
                    ·
                    {{ record.result.assessment?.hypotheses.length ?? 0 }}
                    hypotheses
                  </small>
                </button>
              </div>
            </section>
</template>
