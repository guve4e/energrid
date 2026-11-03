<script setup lang="ts">
import PendingEnrollmentList from '../../components/discovery/PendingEnrollmentList.vue';
import type { useDiscoveryWorkspace } from './useDiscoveryWorkspace';
const props = defineProps<{ model: ReturnType<typeof useDiscoveryWorkspace> }>();
const { discoveredDevices, pendingEnrollmentCards, discoveryDecisionBusy,
  shellyVerificationMessages, state, applyPendingDecision, verifyPendingShelly,
  renamePendingCandidate, discoveryDecisionError, approvedOnboardingDevices,
  openApprovedDevice } = props.model;
</script>
<template>
          <details id="pending-onboarding" class="discovery-accordion discovery-onboarding-accordion">
            <summary>
              <strong>Add Devices</strong>
              <span>{{ discoveredDevices.length }} pending</span>
            </summary>

          <div class="discovery-empty" v-if="discoveredDevices.length === 0">
            <strong>No unverified candidates observed for this site</strong>
            <span>Site-attributed MQTT observations and existing discovery evidence appear here for review. Protocol-reported identity still requires independent verification before enrollment.</span>
          </div>

          <PendingEnrollmentList
            v-else
            :cards="pendingEnrollmentCards"
            :busy-by-candidate-id="discoveryDecisionBusy"
            :verification-message-by-candidate-id="shellyVerificationMessages"
            :zones="state?.zones || []"
            @decide="applyPendingDecision"
            @verify="verifyPendingShelly"
            @rename="renamePendingCandidate"
          />
          <p v-if="discoveryDecisionError" class="error" role="alert">{{ discoveryDecisionError }}</p>
          <p v-if="discoveredDevices.some(device => device.metadata?.observationApprovalRequired === true)" class="discovery-empty compact">
            Enrollment uses the current {{ state?.tenant.name }} / {{ state?.site.name }} scope. Sensor measurements require a separate approval after enrollment.
          </p>

          </details>

          <div id="approved-onboarding" class="section-row discovery-section-title">
            <h3>Approved from onboarding</h3>
            <span>{{ approvedOnboardingDevices.length }} approved</span>
          </div>

          <div
            class="discovery-empty compact"
            v-if="approvedOnboardingDevices.length === 0"
          >
            <strong>No approved onboarding devices yet</strong>
            <span
              >Approved devices will stay visible here and also appear on the
              Devices page.</span
            >
          </div>

          <div v-else class="discovery-list">
            <article
              v-for="device in approvedOnboardingDevices"
              :key="`approved-${device.id}`"
              class="discovery-card approved-discovery-card"
              role="button"
              tabindex="0"
              @click="openApprovedDevice(device)"
              @keydown.enter="openApprovedDevice(device)"
            >
              <div>
                <span class="discovery-source approved">approved</span>
                <h3>{{ device.displayName }}</h3>
                <p>
                  {{ device.adapter.driver }} ·
                  {{ device.adapter.target || device.adapter.protocol }}
                </p>
              </div>
              <dl class="device-facts">
                <div>
                  <dt>Room</dt>
                  <dd>{{ device.zoneName }}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {{
                      device.capabilities
                        .map((capability) => capability.kind)
                        .join(', ')
                    }}
                  </dd>
                </div>
              </dl>
              <div class="discovery-actions">
                <button
                  class="primary"
                  type="button"
                  @click.stop="openApprovedDevice(device)"
                >
                  Open in Devices
                </button>
              </div>
            </article>
          </div>
</template>
