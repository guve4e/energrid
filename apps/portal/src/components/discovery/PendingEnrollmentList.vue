<script setup lang="ts">
import { ref } from 'vue';
import type { PendingEnrollmentCardModel } from './pending-enrollment';

defineProps<{
  cards: PendingEnrollmentCardModel[];
  busyByCandidateId: Readonly<Record<string, string>>;
}>();

const emit = defineEmits<{
  review: [candidateId: string];
  decide: [candidateId: string, action: 'approve' | 'block'];
  rename: [candidateId: string];
}>();

const expandedCardKey = ref<string | null>(null);

function formatObservationTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'time unavailable';
}

function brokerEvidenceLabel(status: string | null): string {
  switch (status) {
    case 'rpc_verified': return 'Exact Shelly RPC identity matched';
    case 'rpc_mismatch': return 'RPC identity mismatch · not a verified LAN address';
    case 'rpc_unreachable': return 'RPC unreachable · not a verified LAN address';
    case 'not_plausible': return 'Not a LAN candidate · broker evidence only';
    case 'publisher_observed': return 'Publisher correlated · LAN identity not verified';
    default: return 'Broker evidence only · LAN identity not verified';
  }
}

function toggleReview(cardKey: string) {
  expandedCardKey.value = expandedCardKey.value === cardKey ? null : cardKey;
}
</script>

<template>
  <div class="discovery-list pending-enrollment-list">
    <article v-for="card in cards" :key="card.key" :id="`pending-record-${encodeURIComponent(card.key)}`" class="pending-device-card">
      <header class="pending-device-heading">
        <div class="pending-device-title">
          <h3>{{ card.title }}</h3>
          <p>{{ card.typeLabel }} · {{ card.protocolLabel }}</p>
          <span class="pending-lifecycle">{{ card.lifecycleLabel }}</span>
        </div>
        <div class="pending-network-summary" :class="{ 'is-unknown': !card.ipAddress }">
          <span v-if="!card.ipAddress">{{ card.networkLabel }}</span>
          <template v-if="card.ipAddress">
            <span>{{ card.networkLabel }}</span>
            <strong class="pending-ip-address">{{ card.ipAddress }}</strong>
            <small v-if="card.networkObservedAt">Observed {{ formatObservationTime(card.networkObservedAt) }}</small>
            <span v-if="card.macAddress">MAC {{ card.macAddress }}</span>
            <span v-if="card.deviceReportedMacAddress && card.deviceReportedMacAddress !== card.macAddress">
              Shelly-reported MAC {{ card.deviceReportedMacAddress }}
            </span>
            <span v-if="card.currentOccupantMacAddress">
              Current device at this IP · MAC {{ card.currentOccupantMacAddress }}
            </span>
            <span v-if="card.hostname || card.network">{{ [card.hostname, card.network].filter(Boolean).join(' · ') }}</span>
            <small v-if="card.networkEvidenceStatus">{{ card.networkEvidenceStatus }}</small>
          </template>
          <strong v-else>{{ card.unknownNetworkMessage }}</strong>
          <div v-if="card.brokerObservedPeerIpAddress" class="broker-peer-evidence">
            <span>Last broker-observed peer</span>
            <strong>{{ card.brokerObservedPeerIpAddress }}</strong>
            <small>
              {{ card.brokerObservedAt ? formatObservationTime(card.brokerObservedAt) : 'Time unavailable' }}
              · {{ brokerEvidenceLabel(card.brokerIdentityVerification) }}
            </small>
          </div>
        </div>
      </header>

      <div class="pending-device-summary">
        <div>
          <span>Components</span>
          <strong>{{ card.componentSummary }}</strong>
          <code v-if="card.components.length">{{ card.components.join(' · ') }}</code>
        </div>
        <div>
          <span>Capabilities</span>
          <strong>{{ card.capabilities.length ? card.capabilities.join(' · ') : 'Not reported' }}</strong>
        </div>
        <button
          class="pending-review-button"
          type="button"
          :aria-expanded="expandedCardKey === card.key"
          @click="toggleReview(card.key)"
        >
          {{ expandedCardKey === card.key ? 'Close review' : 'Review' }}
        </button>
      </div>

      <section v-if="expandedCardKey === card.key" class="pending-review-details" aria-label="Device evidence and actions">
        <article v-for="item in card.details" :key="item.candidateId" class="pending-channel-detail">
          <header>
            <div>
              <strong>{{ item.displayName }}</strong>
              <span>{{ item.componentId || 'Component not identified' }} · {{ item.capabilities.join(' · ') || 'Capabilities not reported' }}</span>
            </div>
            <div class="pending-secondary-actions">
              <button type="button" :disabled="!!busyByCandidateId[item.candidateId]" @click="emit('decide', item.candidateId, 'approve')">
                {{ busyByCandidateId[item.candidateId] === 'approve' ? 'Approving…' : item.retired ? 'Approve reenrollment' : 'Approve' }}
              </button>
              <button type="button" :disabled="!!busyByCandidateId[item.candidateId]" @click="emit('rename', item.candidateId)">Rename</button>
              <button type="button" :disabled="!!busyByCandidateId[item.candidateId]" @click="emit('decide', item.candidateId, 'block')">
                {{ busyByCandidateId[item.candidateId] === 'block' ? 'Blocking…' : 'Block' }}
              </button>
            </div>
          </header>
          <dl>
            <div><dt>Logical candidate</dt><dd><code>{{ item.logicalCandidateId }}</code></dd></div>
            <div><dt>Physical hardware</dt><dd>{{ item.physicalHardwareId || 'Not established' }}</dd></div>
            <div><dt>Physical inventory record</dt><dd>{{ item.physicalDeviceId || 'Not established' }}</dd></div>
            <div><dt>Discovery</dt><dd>{{ item.source }} · {{ item.protocol }}</dd></div>
            <div><dt>Protocol endpoint</dt><dd><code>{{ item.endpoint || 'Not reported' }}</code></dd></div>
            <div><dt>Evidence provenance</dt><dd>{{ item.evidenceSource }}</dd></div>
            <div><dt>Last observation</dt><dd>{{ item.observedAt ? new Date(item.observedAt).toLocaleString() : 'Not recorded' }}</dd></div>
            <div v-if="item.brokerObservedPeerIpAddress"><dt>Broker peer evidence</dt><dd>{{ item.brokerObservedPeerIpAddress }} · {{ item.brokerObservedAt ? formatObservationTime(item.brokerObservedAt) : 'time unavailable' }} · {{ brokerEvidenceLabel(item.brokerIdentityVerification) }}</dd></div>
            <div><dt>Confidence heuristic</dt><dd>{{ item.confidence === null ? 'Not reported' : `${Math.round(item.confidence * 100)}%` }}</dd></div>
            <div><dt>Identity evidence</dt><dd>{{ item.verificationStatus }} · {{ item.reason }}</dd></div>
          </dl>
        </article>
      </section>
    </article>
  </div>
</template>

<style scoped>
.pending-enrollment-list { display: grid; gap: 10px; }
.pending-device-card { min-width: 0; padding: 14px 16px; border: 1px solid var(--discovery-border); border-radius: 12px; background: var(--discovery-surface); color: var(--discovery-text); }
.pending-device-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 0.72fr); gap: 14px 24px; align-items: start; }
.pending-device-title h3 { margin: 0; color: var(--discovery-text); font-size: 17px; overflow-wrap: anywhere; }
.pending-device-title p { margin: 4px 0; color: var(--discovery-muted); font-size: 12px; }
.pending-lifecycle { color: var(--discovery-muted); font-size: 11px; }
.pending-network-summary { display: grid; justify-items: start; gap: 3px; min-width: 0; }
.pending-network-summary > span, .pending-network-summary > small { color: var(--discovery-muted); font-size: 11px; overflow-wrap: anywhere; }
.pending-network-summary > strong { font-size: 13px; overflow-wrap: anywhere; }
.broker-peer-evidence { display: grid; justify-items: start; gap: 2px; margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--discovery-border); }
.broker-peer-evidence > span, .broker-peer-evidence > small { color: var(--discovery-muted); font-size: 10px; overflow-wrap: anywhere; }
.broker-peer-evidence > strong { color: var(--discovery-text); font-size: 13px; font-variant-numeric: tabular-nums; }
.pending-network-summary .pending-ip-address { color: var(--discovery-text); font-size: 18px; font-variant-numeric: tabular-nums; }
.pending-network-summary.is-unknown { min-height: 64px; align-content: center; }
.pending-device-summary { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px 20px; align-items: center; margin-top: 10px; }
.pending-device-summary > div { display: grid; gap: 3px; min-width: 0; }
.pending-device-summary > div > span { color: var(--discovery-muted); font-size: 11px; }
.pending-device-summary > div > strong { font-size: 12px; overflow-wrap: anywhere; }
.pending-device-summary code { color: var(--discovery-muted); font-size: 10px; overflow-wrap: anywhere; }
.pending-review-button { min-height: 40px; padding: 8px 18px; border: 1px solid transparent; border-radius: 999px; background: var(--discovery-text); color: var(--discovery-surface); font-weight: 700; cursor: pointer; }
.pending-review-button:focus-visible, .pending-secondary-actions button:focus-visible { outline: 2px solid #20ac7c; outline-offset: 2px; }
.pending-review-details { display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--discovery-border); }
.pending-channel-detail { min-width: 0; padding: 12px; border: 1px solid var(--discovery-border); border-radius: 8px; }
.pending-channel-detail > header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; }
.pending-channel-detail > header > div:first-child { display: grid; gap: 3px; min-width: 0; }
.pending-channel-detail > header strong { font-size: 13px; overflow-wrap: anywhere; }
.pending-channel-detail > header span { color: var(--discovery-muted); font-size: 11px; }
.pending-secondary-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.pending-secondary-actions button { min-height: 34px; padding: 5px 10px; border: 1px solid var(--discovery-border); border-radius: 7px; background: transparent; color: var(--discovery-text); font-size: 11px; cursor: pointer; }
.pending-secondary-actions button:disabled { opacity: 0.55; cursor: wait; }
.pending-channel-detail dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 18px; margin: 12px 0 0; }
.pending-channel-detail dl > div { display: grid; grid-template-columns: minmax(110px, 0.34fr) minmax(0, 1fr); gap: 8px; min-width: 0; }
.pending-channel-detail dt { color: var(--discovery-muted); font-size: 10px; }
.pending-channel-detail dd { min-width: 0; margin: 0; font-size: 11px; overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .pending-device-card { padding: 12px; }
  .pending-device-heading { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .pending-device-summary { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  .pending-review-button { grid-column: 1 / -1; width: 100%; }
  .pending-channel-detail dl { grid-template-columns: minmax(0, 1fr); }
  .pending-channel-detail dl > div { grid-template-columns: minmax(110px, 0.38fr) minmax(0, 1fr); }
}
</style>
