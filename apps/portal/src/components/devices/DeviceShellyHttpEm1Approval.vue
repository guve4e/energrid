<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';

interface HttpEm1Approval {
  approved: boolean;
  approvalStatus: 'approved' | 'missing' | 'different_authority';
  sourceId: 'shelly-http-em1';
  selector: string;
  endpoint: string;
  networkScope: string;
  fields: Array<{ metric: 'power'; rawKey: 'power'; unit: 'W' }>;
}
const props = defineProps<{ deviceId: string; deviceName: string; apiBase: string; accessToken: string }>();
const emit = defineEmits<{ approved: [] }>();
const state = ref<HttpEm1Approval | null>(null);
const loading = ref(false);
const saving = ref(false);
const reviewing = ref(false);
const error = ref('');
let requestRevision = 0;
let requestController: AbortController | undefined;

async function load() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  const revision = ++requestRevision;
  const deviceId = props.deviceId;
  const apiBase = props.apiBase;
  const accessToken = props.accessToken;
  loading.value = true;
  error.value = '';
  state.value = null;
  try {
    const response = await authFetch(`${apiBase}/portal/devices/${encodeURIComponent(deviceId)}/shelly-http-em1-approval`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal,
    });
    if (!response.ok) throw new Error('HTTP power approval details are unavailable.');
    const result = await response.json() as HttpEm1Approval;
    if (result.sourceId !== 'shelly-http-em1' || !/^EM1\.GetStatus\?id=(?:[0-9]|[12][0-9]|3[01])$/.test(result.selector) ||
        typeof result.endpoint !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(result.endpoint) ||
        !['approved', 'missing', 'different_authority'].includes(result.approvalStatus) ||
        result.approved !== (result.approvalStatus === 'approved') ||
        !Array.isArray(result.fields) || result.fields.length !== 1 ||
        result.fields[0].metric !== 'power' || result.fields[0].rawKey !== 'power') {
      throw new Error('HTTP power approval response is invalid.');
    }
    if (revision === requestRevision && props.deviceId === deviceId && props.apiBase === apiBase && props.accessToken === accessToken) {
      state.value = result;
    }
  } catch (cause) {
    if (revision === requestRevision && !controller.signal.aborted) {
      error.value = cause instanceof Error ? cause.message : 'HTTP power approval details are unavailable.';
    }
  } finally {
    if (revision === requestRevision) loading.value = false;
  }
}

async function approve() {
  if (!state.value || state.value.approvalStatus !== 'missing' || saving.value) return;
  const deviceId = props.deviceId;
  const apiBase = props.apiBase;
  const accessToken = props.accessToken;
  const proposal = state.value;
  if (!window.confirm(`Authorize power (W) for ${props.deviceName} (${deviceId}) from ${proposal.sourceId} at ${proposal.endpoint}/${proposal.selector}? Energrid will re-verify identity and EM1 status through the authorized local observer before saving. This does not enable switching.`)) return;
  if (props.deviceId !== deviceId || props.apiBase !== apiBase || props.accessToken !== accessToken || state.value !== proposal) return;
  saving.value = true;
  error.value = '';
  try {
    const response = await authFetch(`${apiBase}/portal/devices/${encodeURIComponent(deviceId)}/shelly-http-em1-approval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmedDeviceId: deviceId, approvedFields: ['power'],
        confirmedSourceId: proposal.sourceId, confirmedSelector: proposal.selector, confirmedEndpoint: proposal.endpoint }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { message?: string; action?: string; code?: string } | null;
      throw new Error(failure?.message || `HTTP power approval failed (${response.status}). Check the site observer and network-scope evidence; no authority was granted.`);
    }
    const result = await response.json() as HttpEm1Approval;
    if (props.deviceId !== deviceId || props.apiBase !== apiBase || props.accessToken !== accessToken) return;
    state.value = result;
    reviewing.value = false;
    emit('approved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'HTTP power approval failed.';
  } finally { saving.value = false; }
}

watch(() => [props.deviceId, props.apiBase, props.accessToken], () => { reviewing.value = false; void load(); });
onMounted(() => void load());
onBeforeUnmount(() => requestController?.abort());
</script>

<template>
  <section class="http-em1-approval" aria-label="HTTP power measurement approval">
    <p v-if="loading" role="status">Checking HTTP power approval…</p>
    <p v-else-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="state?.approvalStatus === 'approved'" role="status" class="approved">
      Power is authorized from <code>{{ state.sourceId }}</code>.
    </p>
    <p v-else-if="state?.approvalStatus === 'different_authority'" role="alert" class="error">
      A different observation authority already exists. Review it before switching sources.
    </p>
    <div v-else-if="state?.approvalStatus === 'missing'">
      <strong>HTTP power observation approval required</strong>
      <p>Enrollment and device capability do not authorize power collection.</p>
      <button v-if="!reviewing" type="button" @click="reviewing = true">Review HTTP power source</button>
      <div v-else>
        <p>Device: {{ deviceName }} · <code>{{ deviceId }}</code></p>
        <p>Source: <code>{{ state.sourceId }}</code> · <code>{{ state.selector }}</code></p>
        <p>Endpoint: <code>{{ state.endpoint }}</code> · Scope: <code>{{ state.networkScope }}</code></p>
        <p>Normalized measurement: <code>power</code> (W). No switching permission is granted.</p>
        <button type="button" :disabled="saving" @click="approve">{{ saving ? 'Verifying…' : 'Verify and approve power' }}</button>
        <button type="button" :disabled="saving" @click="reviewing = false">Cancel</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.http-em1-approval { display: grid; gap: 8px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 10px; padding: 12px; font-size: 12px; }
.http-em1-approval p { margin: 5px 0; color: var(--eg-muted, #58677e); }
.http-em1-approval button { min-height: 36px; width: fit-content; padding: 6px 10px; margin: 4px 6px 0 0; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 8px; color: inherit; background: var(--eg-surface, #fff); cursor: pointer; }
.http-em1-approval button:disabled { opacity: .6; cursor: wait; }
.http-em1-approval .approved { color: var(--eg-success, #138a59); }
.http-em1-approval .error { color: var(--eg-danger, #b42318); }
</style>
