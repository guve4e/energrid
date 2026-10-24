<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { onMounted, ref, watch } from 'vue';

interface ProposalField {
  metric: 'temperature' | 'humidity';
  rawKey: 'temperatureC' | 'humidityPct';
  unit: string;
  displayUnit: string;
}
interface ApprovalState {
  approved: boolean;
  approvalStatus: 'approved' | 'missing' | 'different_authority';
  sourceId: string;
  selector: string;
  fields: ProposalField[];
}

const props = defineProps<{
  deviceId: string;
  enabled: boolean;
  apiBase: string;
  accessToken: string;
}>();

const state = ref<ApprovalState | null>(null);
const loading = ref(false);
const busy = ref(false);
const reviewing = ref(false);
const error = ref('');

async function load() {
  if (!props.enabled) { state.value = null; return; }
  loading.value = true;
  error.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/observation-approval`,
      { headers: { Authorization: `Bearer ${props.accessToken}` } },
    );
    if (!response.ok) throw new Error('Observation approval details are unavailable.');
    const result = await response.json() as ApprovalState;
    if (typeof result.approved !== 'boolean' || !['approved', 'missing', 'different_authority'].includes(result.approvalStatus) || result.approved !== (result.approvalStatus === 'approved') || result.sourceId !== 'energrid-http-status' ||
        result.selector !== '/api/v1/status' || !Array.isArray(result.fields) || result.fields.length !== 2) {
      throw new Error('The observation approval proposal is invalid.');
    }
    state.value = result;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Observation approval details are unavailable.';
    state.value = null;
  } finally {
    loading.value = false;
  }
}

async function approve() {
  if (!state.value || state.value.approved || busy.value) return;
  const fields = state.value.fields.map(field => `${field.metric} (${field.displayUnit})`).join(' and ');
  if (!window.confirm(`Approve ${fields} from ${state.value.sourceId} at ${state.value.selector} for ${props.deviceId}? This does not grant device control.`)) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/observation-approval`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${props.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmedDeviceId: props.deviceId, approvedFields: ['temperature', 'humidity'] }),
      },
    );
    if (!response.ok) throw new Error('Observation approval was not saved. Refresh and review the device state.');
    const result = await response.json() as ApprovalState;
    state.value = result;
    reviewing.value = false;
    emit('approved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Observation approval was not saved.';
  } finally {
    busy.value = false;
  }
}

const emit = defineEmits<{ approved: [] }>();
watch(() => [props.deviceId, props.enabled, props.apiBase, props.accessToken], () => { reviewing.value = false; void load(); });
onMounted(() => void load());
</script>

<template>
  <section v-if="enabled" class="observation-approval" aria-label="Measurement approval">
    <p v-if="loading" class="approval-muted" role="status">Checking measurement approval…</p>
    <p v-else-if="error" class="approval-error" role="alert">{{ error }}</p>
    <div v-else-if="state?.approvalStatus === 'approved'" class="approval-approved" role="status">
      Temperature and humidity are explicitly approved from <code>{{ state.sourceId }}</code>.
    </div>
    <div v-else-if="state?.approvalStatus === 'different_authority'" class="approval-error" role="alert">
      A different measurement authority is already saved. This proposal cannot replace it automatically; review the existing installation approval first.
    </div>
    <div v-else-if="state" class="approval-pending">
      <strong>Measurement approval required</strong>
      <p>Enrollment alone does not authorize readings. Review the proposed source and fields before approving.</p>
      <button v-if="!reviewing" type="button" @click="reviewing = true">Review measurement proposal</button>
      <div v-else class="approval-review">
        <p><b>Source:</b> <code>{{ state.sourceId }}</code> · <code>{{ state.selector }}</code></p>
        <ul>
          <li v-for="field in state.fields" :key="field.metric">
            {{ field.rawKey }} → {{ field.metric }} ({{ field.displayUnit }})
          </li>
        </ul>
        <p>This grants observation authority for these two fields only. It grants no control authority.</p>
        <button type="button" :disabled="busy" @click="approve">{{ busy ? 'Saving approval…' : 'Approve these two readings' }}</button>
        <button type="button" class="approval-cancel" :disabled="busy" @click="reviewing = false">Cancel</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.observation-approval { display: grid; gap: 8px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 10px; padding: 12px; font-size: 12px; }
.approval-pending strong { color: var(--eg-warning, #a45b08); }
.approval-pending p, .approval-review p { margin: 5px 0; color: var(--eg-muted, #58677e); }
.approval-review ul { margin: 6px 0; padding-left: 20px; }
.approval-approved { color: var(--eg-success, #138a59); }
.approval-muted { margin: 0; color: var(--eg-muted, #58677e); }
.approval-error { margin: 0; color: var(--eg-danger, #b42318); }
.observation-approval button { min-height: 36px; width: fit-content; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 8px; padding: 6px 10px; color: inherit; background: var(--eg-surface, #fff); cursor: pointer; font: inherit; }
.observation-approval button:focus-visible { outline: 2px solid var(--eg-blue, #2863e6); outline-offset: 2px; }
.observation-approval button:disabled { opacity: .6; cursor: wait; }
.observation-approval .approval-cancel { margin-left: 6px; }
</style>
