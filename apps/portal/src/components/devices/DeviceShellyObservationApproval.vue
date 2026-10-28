<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';

interface ApprovalState {
  approved: boolean;
  approvalStatus: 'approved' | 'partially_approved' | 'missing' | 'different_authority';
  sourceId: 'shelly-mqtt';
  broker: string;
  selector: string;
  approvedFields: string[];
  evidenceFresh: boolean;
  evidence: {
    provenance: string;
    observerId: string;
    snapshotId: string;
    endpoint: string;
    networkScope: string;
    identityVerifiedAt: string;
    componentVerifiedAt: string;
  };
  fields: Array<{ metric: 'power' | 'energy_import_total' | 'energy_export_total'; rawKey: string; unit: 'W' | 'kWh'; displayUnit: 'W' | 'kWh' }>;
}

const props = defineProps<{ deviceId: string; enabled: boolean; apiBase: string; accessToken: string }>();
const emit = defineEmits<{ approved: []; authorization: [approved: boolean] }>();
const state = ref<ApprovalState | null>(null);
const loading = ref(false);
const busy = ref(false);
const reviewing = ref(false);
const error = ref('');
const mqttTopic = ref('');
const powerAuthorized = () => state.value?.approvedFields.includes('power') === true;
const fieldLabel = (field: string) => ({ power: 'Power', energy_import_total: 'Imported energy total', energy_export_total: 'Exported energy total' }[field] || field);
const validMqttTopic = (value: string) => value.length <= 192 &&
  /^(?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+\/events\/rpc$/.test(value) &&
  !value.split('/').some(part => !part || part === '.' || part === '..');

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
    if (!physicalId || result.sourceId !== 'shelly-mqtt' ||
        typeof result.broker !== 'string' || !/^[a-z0-9.-]{1,253}:\d{1,5}$/.test(result.broker) ||
        (result.selector !== '' && !validMqttTopic(result.selector)) ||
        typeof result.evidenceFresh !== 'boolean' || !result.evidence || typeof result.evidence.provenance !== 'string' ||
        typeof result.evidence.identityVerifiedAt !== 'string' || typeof result.evidence.componentVerifiedAt !== 'string' ||
        !Array.isArray(result.fields) || !result.fields.length || !Array.isArray(result.approvedFields) ||
        result.fields.some(field => !['power', 'energy_import_total', 'energy_export_total'].includes(field.metric)) ||
        !['approved', 'partially_approved', 'missing', 'different_authority'].includes(result.approvalStatus) ||
        result.approved !== (result.approvalStatus === 'approved')) throw new Error('The Shelly measurement proposal is invalid.');
    state.value = result;
    mqttTopic.value = result.selector;
    emit('authorization', powerAuthorized());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Shelly measurement approval details are unavailable.';
    state.value = null;
    emit('authorization', false);
  } finally { loading.value = false; }
}

async function approve(field: ApprovalState['fields'][number]) {
  if (!state.value || state.value.approvedFields.includes(field.metric) || busy.value || !validMqttTopic(mqttTopic.value)) return;
  if (!window.confirm(`Bind broker ${state.value.broker} and exact MQTT topic ${mqttTopic.value} to independently RPC-verified ${props.deviceId}, then approve ${fieldLabel(field.metric)} (${field.unit})? The topic and MQTT payload are not cryptographic device identity. This does not grant device control.`)) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(`${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/shelly-observation-approval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${props.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmedDeviceId: props.deviceId, confirmedBroker: state.value.broker, approvedFields: [field.metric], mqttTopic: mqttTopic.value }),
    });
    if (!response.ok) throw new Error('Shelly measurement approval was not saved. Refresh and review the device state.');
    state.value = await response.json() as ApprovalState;
    mqttTopic.value = state.value.selector;
    reviewing.value = false;
    emit('authorization', powerAuthorized());
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
    <p v-else-if="state?.approved" class="approval-approved" role="status">All reported measurements are explicitly approved from <code>{{ state.sourceId }}</code>.</p>
    <div v-else-if="state?.approvalStatus === 'different_authority'" class="approval-error" role="alert">
      A different measurement authority is saved. It must be reviewed before replacement.
    </div>
    <div v-else-if="state">
      <strong>Measurement approval required</strong>
      <p>Site-local RPC evidence verified this component and the listed measurements. MQTT identity alone does not authorize them.</p>
      <button v-if="!reviewing" type="button" @click="reviewing = true">Review measurement proposals</button>
      <div v-else>
        <label class="topic-binding">Exact MQTT event topic
          <input v-model.trim="mqttTopic" :readonly="!!state.selector" autocomplete="off" spellcheck="false" placeholder="shelly/washer@other/events/rpc" aria-label="Exact MQTT event topic" />
        </label>
        <p>RPC evidence: <code>{{ state.evidence.provenance }}</code> · observer <code>{{ state.evidence.observerId || 'direct LAN observer' }}</code> · {{ state.evidence.endpoint }} · {{ state.evidence.networkScope }}</p>
        <p>Snapshot <code>{{ state.evidence.snapshotId || 'not recorded' }}</code> · identity verified {{ state.evidence.identityVerifiedAt }} · component verified {{ state.evidence.componentVerifiedAt }}</p>
        <p v-if="!state.evidenceFresh" class="approval-error" role="alert">This accepted RPC evidence is historical. Capture and reconcile fresh identity and component evidence before recording new measurement authority.</p>
        <p>The topic is a reviewed source selector, not proof of device identity. The device identity and component were verified independently over Shelly RPC.</p>
        <p><b>Broker:</b> <code>{{ state.broker }}</code> · <b>Source:</b> <code>{{ state.sourceId }}</code> · <code>{{ validMqttTopic(mqttTopic) ? mqttTopic : 'enter an exact event topic' }}</code></p>
        <p v-for="field in state.fields" :key="field.metric">
          <code>{{ field.metric }}</code> → {{ fieldLabel(field.metric) }} ({{ field.unit }})
          <span v-if="state.approvedFields.includes(field.metric)" class="approval-approved"> · Approved</span>
          <button v-else type="button" :disabled="busy || !state.evidenceFresh || !validMqttTopic(mqttTopic)" @click="approve(field)">{{ busy ? 'Saving…' : `Approve ${fieldLabel(field.metric)}` }}</button>
        </p>
        <p>Each approval applies to that measurement only. It does not grant device control.</p>
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
.shelly-observation-approval .topic-binding { display: grid; gap: 5px; max-width: 520px; color: var(--eg-muted, #58677e); }
.shelly-observation-approval input { min-height: 36px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 8px; padding: 6px 10px; color: inherit; background: var(--eg-surface, #fff); font: inherit; }
</style>
