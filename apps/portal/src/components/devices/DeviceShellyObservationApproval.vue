<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';

interface ApprovalState {
  approved: boolean;
  approvalStatus: 'approved' | 'missing' | 'different_authority';
  sourceId: 'shelly-mqtt';
  selector: string;
  fields: Array<{ metric: 'power'; rawKey: 'power'; unit: 'W'; displayUnit: 'W' }>;
}

const props = defineProps<{ deviceId: string; enabled: boolean; apiBase: string; accessToken: string }>();
const emit = defineEmits<{ approved: []; authorization: [approved: boolean] }>();
const state = ref<ApprovalState | null>(null);
const loading = ref(false);
const busy = ref(false);
const reviewing = ref(false);
const error = ref('');

async function load() {
  if (!props.enabled) { state.value = null; emit('authorization', false); return; }
  loading.value = true;
  error.value = '';
  try {
    const response = await authFetch(`${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/shelly-observation-approval`, {
      headers: { Authorization: `Bearer ${props.accessToken}` },
    });
    if (!response.ok) throw new Error('Shelly measurement approval details are unavailable.');
    const result = await response.json() as ApprovalState;
    const physicalId = /^((?:shelly)[a-z0-9._-]{1,114}):(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/i.exec(props.deviceId)?.[1];
    if (!physicalId || result.sourceId !== 'shelly-mqtt' || result.selector !== `${physicalId}/events/rpc` ||
        !Array.isArray(result.fields) || result.fields.length !== 1 || result.fields[0]?.metric !== 'power' ||
        !['approved', 'missing', 'different_authority'].includes(result.approvalStatus) ||
        result.approved !== (result.approvalStatus === 'approved')) throw new Error('The Shelly measurement proposal is invalid.');
    state.value = result;
    emit('authorization', result.approved);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Shelly measurement approval details are unavailable.';
    state.value = null;
    emit('authorization', false);
  } finally { loading.value = false; }
}

async function approve() {
  if (!state.value || state.value.approved || busy.value) return;
  if (!window.confirm(`Approve power readings in watts from ${state.value.sourceId} at ${state.value.selector} for ${props.deviceId}? This does not grant device control.`)) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(`${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/shelly-observation-approval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${props.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmedDeviceId: props.deviceId, approvedFields: ['power'] }),
    });
    if (!response.ok) throw new Error('Shelly measurement approval was not saved. Refresh and review the device state.');
    state.value = await response.json() as ApprovalState;
    reviewing.value = false;
    emit('authorization', state.value.approved);
    emit('approved');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Shelly measurement approval was not saved.'; }
  finally { busy.value = false; }
}

watch(() => [props.deviceId, props.enabled, props.apiBase, props.accessToken], () => { reviewing.value = false; void load(); });
onMounted(() => void load());
</script>

<template>
  <section v-if="enabled" class="shelly-observation-approval" aria-label="Shelly measurement approval">
    <p v-if="loading" role="status">Checking Shelly measurement approval…</p>
    <p v-else-if="error" class="approval-error" role="alert">{{ error }}</p>
    <p v-else-if="state?.approved" class="approval-approved" role="status">Power is explicitly approved from <code>{{ state.sourceId }}</code>.</p>
    <div v-else-if="state?.approvalStatus === 'different_authority'" class="approval-error" role="alert">
      A different measurement authority is saved. It must be reviewed before replacement.
    </div>
    <div v-else-if="state">
      <strong>Measurement approval required</strong>
      <p>LAN RPC verified this component and reported power. MQTT identity alone does not authorize measurements.</p>
      <button v-if="!reviewing" type="button" @click="reviewing = true">Review power proposal</button>
      <div v-else>
        <p><b>Source:</b> <code>{{ state.sourceId }}</code> · <code>{{ state.selector }}</code></p>
        <p><code>power</code> → power (W)</p>
        <p>Approving permits this measurement only. It grants no relay control.</p>
        <button type="button" :disabled="busy" @click="approve">{{ busy ? 'Saving approval…' : 'Approve power measurement' }}</button>
        <button type="button" :disabled="busy" @click="reviewing = false">Cancel</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.shelly-observation-approval { display: grid; gap: 8px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 10px; padding: 12px; font-size: 12px; }
.shelly-observation-approval p { margin: 5px 0; color: var(--eg-muted, #58677e); }
.shelly-observation-approval strong { color: var(--eg-warning, #a45b08); }
.shelly-observation-approval .approval-approved { color: var(--eg-success, #138a59); }
.shelly-observation-approval .approval-error { color: var(--eg-danger, #b42318); }
.shelly-observation-approval button { min-height: 36px; width: fit-content; margin: 4px 6px 0 0; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 8px; padding: 6px 10px; color: inherit; background: var(--eg-surface, #fff); cursor: pointer; font: inherit; }
.shelly-observation-approval button:focus-visible { outline: 2px solid var(--eg-blue, #2863e6); outline-offset: 2px; }
.shelly-observation-approval button:disabled { opacity: .6; cursor: wait; }
</style>
