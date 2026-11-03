<script setup lang="ts">
import type { useDiscoveryIntelligence } from './useDiscoveryIntelligence';
import InvestigationHistory from './InvestigationHistory.vue';
import MqttProfileReview from './MqttProfileReview.vue';
import InvestigationReport from './InvestigationReport.vue';
const props = defineProps<{ model: ReturnType<typeof useDiscoveryIntelligence> }>();
const { selectedAiDeviceId, selectedAiDevice, selectedAiError, llmProviderAvailability,
  aiInvestigating } = props.model;
const model = props.model;
const closeInvestigation = () => { selectedAiDeviceId.value = null; };
</script>
<template>
          <section
            v-if="selectedAiDeviceId"
            class="panel discovery-intelligence-panel"
            aria-label="Device Intelligence investigation"
          >
            <div class="section-row">
              <div>
                <p class="eyebrow">Device Intelligence</p>
                <h3>
                  {{ selectedAiDevice?.hostname ||
                     selectedAiDevice?.ipAddress ||
                     selectedAiDeviceId }}
                </h3>
                <span class="section-help">
                  {{ selectedAiDevice?.ipAddress || selectedAiDeviceId }}
                  · Evidence-based AI investigation
                </span>
              </div>

              <button
                type="button"
                class="secondary"
                @click="closeInvestigation"
              >
                Close
              </button>
            </div>

            <p
              v-if="llmProviderAvailability && !llmProviderAvailability.available"
              class="section-help"
              role="status"
            >
              AI investigation unavailable: {{ llmProviderAvailability.provider || 'provider' }}
              · {{ llmProviderAvailability.reasonCode }}. Discovery and device operation remain available.
            </p>
            <p
              v-else-if="llmProviderAvailability?.cloudDataConsentRequired"
              class="section-help"
            >
              Cloud AI is enabled. The Portal asks before sending network identifiers or captured evidence.
            </p>
            <p
              v-if="aiInvestigating[selectedAiDeviceId]"
              role="status"
            >
              Investigating device evidence...
            </p>

            <p
              v-if="selectedAiError"
              role="alert"
              class="error"
            >
              {{ selectedAiError }}
            </p>

            <InvestigationHistory :model="model" />

            <!-- Read-only MQTT profile investigation review -->
            <MqttProfileReview :model="model" />

            <InvestigationReport :model="model" />
          </section>
</template>
