<script setup lang="ts">
import { computed } from 'vue';
import { relayStateFreshness, relayStateValue } from './device-detail-capabilities';

const props = defineProps<{
  values: Record<string, number | boolean | string | null>;
  status: string;
  observedAt: string | null;
  command?: { status: string };
}>();
const state = computed(() => relayStateValue(props.values));
const freshness = computed(() => relayStateFreshness(props.status, props.observedAt));
const stateLabel = computed(() => {
  if (freshness.value === 'offline') return state.value === null ? 'Device offline' : `Last reported ${state.value ? 'On' : 'Off'} · offline`;
  if (freshness.value === 'stale') return state.value === null ? 'Relay state is stale' : `Last reported ${state.value ? 'On' : 'Off'} · stale`;
  if (freshness.value === 'unknown') return 'Relay state unknown';
  return state.value === null ? 'Relay state unknown' : `Relay is ${state.value ? 'On' : 'Off'}`;
});
const commandLabel = computed(() => ({
  pending: 'Waiting for device confirmation',
  acked: 'Confirmed by reported state',
  no_ack: 'Command sent; state not confirmed',
  failed: 'Command failed',
}[props.command?.status || '']));
function timestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'No state update received';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
</script>

<template>
  <section class="relay-status-card" aria-label="Verified switch state">
    <div class="relay-status-icon" aria-hidden="true">⏻</div>
    <div class="relay-status-content">
      <span class="relay-status-eyebrow">Switch state</span>
      <strong>{{ stateLabel }}</strong>
      <time :datetime="observedAt || undefined">Last update · {{ timestamp(observedAt) }}</time>
      <span class="relay-freshness" :class="`is-${freshness}`">{{ freshness === 'fresh' ? 'Fresh' : freshness === 'stale' ? 'Stale' : freshness === 'offline' ? 'Offline' : 'Unknown' }}</span>
      <span v-if="commandLabel" class="relay-command-status" role="status">{{ commandLabel }}</span>
    </div>
  </section>
</template>

<style scoped>
.relay-status-card { display:flex; align-items:center; gap:12px; min-width:0; padding:13px 14px; border:1px solid var(--eg-border,#d8e0ec); border-radius:var(--eg-card-radius,12px); background:var(--eg-surface,#fff); color:var(--eg-text,#111827); }
.relay-status-icon { display:grid; place-items:center; flex:0 0 38px; height:38px; border-radius:11px; background:var(--eg-blue-soft,#eef4ff); color:var(--eg-blue,#2863e6); font-size:21px; }
.relay-status-content { display:grid; grid-template-columns:1fr auto; gap:3px 9px; align-items:center; min-width:0; }
.relay-status-eyebrow { grid-column:1/-1; color:var(--eg-muted,#58677e); font-size:11px; }
.relay-status-content strong { overflow-wrap:anywhere; font-size:14px; }
.relay-status-content time,.relay-command-status { color:var(--eg-muted,#58677e); font-size:11px; }
.relay-status-content time { grid-column:1/-1; }
.relay-freshness { justify-self:start; border-radius:999px; padding:2px 7px; background:var(--eg-surface-soft,#f5f8fc); color:var(--eg-muted,#58677e); font-size:10px; }
.is-fresh { background:var(--eg-success-soft,#e8f7ef); color:var(--eg-success,#138a59); }
.is-stale,.is-offline { background:var(--eg-warning-soft,#fff6e8); color:var(--eg-warning,#a45b08); }
.relay-command-status { grid-column:1/-1; }
</style>
