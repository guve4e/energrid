<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{
  device: {
    id: string; ipAddress: string; hostname?: string; vendor?: string;
    model?: string; app?: string; protocol: string; macAddress?: string;
    networkZoneName: string; networkZoneId: string; status: string;
    identityConflict?: { reason: 'multiple_macs_for_endpoint'; macAddresses: string[] };
    reason: string; settingsUrl?: string;
  };
  badge: string;
  badgeClass: string;
  investigating?: boolean;
  hasSsh?: boolean;
  hasChannels?: boolean;
  proxyUrl?: string;
}>();
defineEmits<{ review: []; investigate: []; channels: []; copySsh: [] }>();
const name = computed(() => props.device.hostname || props.device.vendor || 'Network device');
const actions = ref<HTMLDetailsElement>();
function closeActions() {
  if (!actions.value) return;
  actions.value.open = false;
  actions.value.querySelector('summary')?.focus();
}
</script>

<template>
  <article class="network-discovery-card" :aria-label="`${name} · ${device.ipAddress}`">
    <div class="network-device-identity">
      <strong>{{ name }}</strong>
      <span>{{ [device.vendor, device.model || device.app || device.protocol].filter(Boolean).join(' · ') }}</span>
    </div>
    <div class="network-device-address">
      <strong>{{ device.ipAddress }}</strong>
      <span>{{ device.networkZoneName }}</span>
    </div>
    <div class="network-device-status">
      <span class="connectivity" :class="{ 'is-online': device.status === 'online' }">{{ device.status }}</span>
      <span :class="['trust-pill', badgeClass]">{{ badge }}</span>
    </div>
    <div class="network-device-inspect">
      <button type="button" class="secondary" :aria-label="`Review intelligence for ${name} at ${device.ipAddress}`" @click="$emit('review')">Review intelligence</button>
    </div>
    <details ref="actions" class="network-device-more" @keydown.esc.stop.prevent="closeActions">
      <summary :aria-label="`More actions and details for ${name} at ${device.ipAddress}`">More <span aria-hidden="true">⌄</span></summary>
      <div class="network-device-expanded">
        <div class="network-device-action-list" aria-label="Device actions">
          <button type="button" class="secondary" :disabled="investigating" @click="$emit('investigate')">{{ investigating ? 'Investigating…' : 'Investigate with AI' }}</button>
          <button v-if="hasChannels" type="button" class="secondary" @click="$emit('channels')">Review channels</button>
          <template v-if="hasSsh">
            <a :href="`ssh://${device.ipAddress}`" title="Open SSH using your system’s registered SSH handler">SSH ↗</a>
            <button type="button" class="secondary" @click="$emit('copySsh')">Copy SSH</button>
          </template>
          <a v-if="device.settingsUrl" :href="device.settingsUrl" target="_blank" rel="noreferrer">Open settings ↗</a>
          <a v-if="proxyUrl" :href="proxyUrl">Via gateway</a>
        </div>
        <dl class="network-device-details">
          <div><dt>Device ID</dt><dd>{{ device.id }}</dd></div>
          <div><dt>MAC address</dt><dd>{{ device.macAddress || 'Not observed' }}</dd></div>
          <div v-if="device.identityConflict" role="status"><dt>Identity evidence conflict</dt><dd>Multiple MAC addresses were observed for this network endpoint: {{ device.identityConflict.macAddresses.join(', ') }}</dd></div>
          <div><dt>Network zone ID</dt><dd>{{ device.networkZoneId }}</dd></div>
          <div><dt>Discovery evidence</dt><dd>{{ device.reason }}</dd></div>
          <div v-if="!hasChannels"><dt>Integration</dt><dd>{{ device.vendor === 'Shelly' ? 'Channels unavailable' : 'Adapter needed' }}</dd></div>
        </dl>
      </div>
    </details>
  </article>
</template>

<style scoped>
.network-discovery-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 12px; padding: 16px; border-bottom: 1px solid var(--discovery-border, #d8e0ec); align-items: center; }
.network-discovery-card:last-child { border-bottom: 0; }
.network-discovery-card > * { min-width: 0; }
.network-device-identity { grid-column: 1 / -1; }
.network-device-identity strong, .network-device-address strong { display: block; color: var(--discovery-text, #172b32); font-size: 15px; overflow-wrap: anywhere; }
.network-device-identity span, .network-device-address span { display: block; color: var(--discovery-muted, #52636b); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
.network-device-address strong { font-variant-numeric: tabular-nums; font-size: 13px; }
.network-device-status { display: flex; align-items: flex-end; flex-direction: column; gap: 6px; font-size: 12px; }
.connectivity { color: var(--discovery-muted, #52636b); }
.connectivity::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #829193; }
.connectivity.is-online::before { background: #20ac7c; }
.network-device-status .trust-pill { font-size: 10px; padding: 4px 7px; white-space: normal; }
.network-device-inspect button { min-height: 44px; font-size: 12px; width: 100%; }
.network-device-more { display: contents; }
.network-device-more > summary { grid-column: 2; display: flex; justify-content: center; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border: 1px solid var(--discovery-border, #d8e0ec); border-radius: 6px; cursor: pointer; font-size: 12px; list-style: none; }
.network-device-more > summary::-webkit-details-marker { display: none; }
.network-device-more[open] > summary span { transform: rotate(180deg); }
.network-device-expanded { grid-column: 1 / -1; padding-top: 12px; border-top: 1px dashed var(--discovery-border, #d8e0ec); }
.network-device-more:not([open]) > .network-device-expanded { display: none; }
.network-device-action-list { display: flex; flex-wrap: wrap; gap: 8px; }
.network-device-action-list > * { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 12px; font-size: 12px; color: inherit; border: 1px solid var(--discovery-border, #d8e0ec); border-radius: 6px; text-decoration: none; max-width: 100%; white-space: normal; }
.network-device-details { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 16px 0 0; }
.network-device-details dt { color: var(--discovery-muted, #52636b); font-size: 11px; margin-bottom: 4px; }
.network-device-details dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.network-discovery-card :is(button, a, summary):focus-visible { outline: 2px solid #20ac7c; outline-offset: 3px; }
@container device-list (min-width: 650px) {
  .network-discovery-card { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto auto; gap: 16px; }
  .network-device-identity { grid-column: auto; }
  .network-device-more > summary { grid-column: 5; }
  .network-device-status { align-items: flex-start; }
  .network-device-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
