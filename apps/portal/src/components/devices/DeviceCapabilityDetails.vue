<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';
import DeviceMeasurementHistory from './DeviceMeasurementHistory.vue';
import DeviceElectricalHistory from './DeviceElectricalHistory.vue';
import DeviceObservationApproval from './DeviceObservationApproval.vue';
import DeviceShellyObservationApproval from './DeviceShellyObservationApproval.vue';
import DeviceShellyHttpEm1Approval from './DeviceShellyHttpEm1Approval.vue';
import DeviceRelayStatus from './DeviceRelayStatus.vue';
import DeviceSwitchControl from './DeviceSwitchControl.vue';
import type { ControlSetupDevice } from './device-control';
import { deviceDetailPresentation } from './device-detail-capabilities';

const props = defineProps<{
  device: ControlSetupDevice & {
    displayName: string;
    capabilities: Array<{ kind: string; actions: string[]; unit?: string }>;
    supportedCapabilities?: Array<{ kind: string; actions: string[]; unit?: string }>;
    state: { values: Record<string, number | boolean | string | null>; status: string; observedAt: string | null; fieldObservedAt?: Record<string, string>; command?: { status: string; message?: string } };
  };
  apiBase: string;
  accessToken: string;
  now?: number;
  approvalRevision: number;
  controlReady: boolean;
  controlIdentityVerified?: boolean;
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  action: [action: 'turn_on' | 'turn_off'];
  approved: [];
  bindings: [result: { deviceId: string; metrics: Array<'temperature' | 'humidity'> }];
}>();
const boundMetrics = ref<Array<'temperature' | 'humidity'>>([]);
const authorizedBindings = ref<Array<'temperature' | 'humidity'>>([]);
const authorizedElectricalMetrics = ref<Array<'power' | 'energy_import_total' | 'energy_export_total'>>([]);
const shellyHttpEm1 = computed(() =>
  props.device.trustStatus === 'approved' && props.device.adapter.driver === 'shelly-lan' &&
  props.device.adapter.protocol === 'http' && /^em1:(?:[0-9]|[12][0-9]|3[01])$/.test(String(props.device.metadata?.component || '')),
);
const shellyApprovalRequired = computed(() =>
  props.device.metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
  props.device.metadata?.componentEvidenceSource === 'verified_site_local_shelly_rpc' &&
  props.device.metadata?.shellyMqttObservationApprovalRequired === true,
);
const presentation = computed(() => deviceDetailPresentation(props.device, boundMetrics.value, authorizedBindings.value));
let authorityController: AbortController | undefined;
let authorityRevision = 0;
let electricalAuthorityController: AbortController | undefined;
let electricalAuthorityRevision = 0;

async function loadAuthorizedBindings() {
  authorityController?.abort();
  boundMetrics.value = [];
  authorizedBindings.value = [];
  emit('bindings', { deviceId: props.device.id, metrics: [] });
  // This registry marker means observation authority is managed separately
  // from generic capabilities. The read-only endpoint reports its field
  // contract and approval state for this installed device.
  if (props.device.metadata?.observationApprovalRequired !== true) return;
  const controller = new AbortController();
  authorityController = controller;
  const revision = ++authorityRevision;
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.device.id)}/observation-approval`,
      { headers: { Authorization: `Bearer ${props.accessToken}` }, signal: controller.signal },
    );
    if (!response.ok) return;
    const result = await response.json() as {
      approved?: boolean;
      approvalStatus?: string;
      sourceId?: string;
      selector?: string;
      fields?: Array<{ metric?: string; rawKey?: string }>;
    };
    if (revision !== authorityRevision || !['approved', 'missing'].includes(result.approvalStatus || '') ||
        result.sourceId !== 'energrid-http-status' || result.selector !== '/api/v1/status' || !Array.isArray(result.fields)) return;
    const metrics = result.fields
      .map(field => field.metric)
      .filter((metric): metric is 'temperature' | 'humidity' => metric === 'temperature' || metric === 'humidity');
    boundMetrics.value = metrics;
    if (result.approved === true && result.approvalStatus === 'approved') authorizedBindings.value = metrics;
    emit('bindings', { deviceId: props.device.id, metrics });
  } catch {
    // Other verified capability evidence still renders its normal state.
  }
}

async function loadElectricalHistoryAuthorization() {
  electricalAuthorityController?.abort();
  authorizedElectricalMetrics.value = [];
  const deviceId = props.device.id;
  if (props.device.trustStatus !== 'approved' || !presentation.value.showElectrical) return;
  const controller = new AbortController();
  electricalAuthorityController = controller;
  const revision = ++electricalAuthorityRevision;
  const apiBase = props.apiBase;
  const accessToken = props.accessToken;
  try {
    const response = await authFetch(
      `${apiBase}/portal/devices/${encodeURIComponent(deviceId)}/read-model`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal },
    );
    if (!response.ok) return;
    const result = await response.json() as {
      identity?: { id?: string };
      installation?: { status?: string };
      history?: { authorizedMetrics?: unknown };
    };
    if (revision !== electricalAuthorityRevision || props.device.id !== deviceId ||
        props.apiBase !== apiBase || props.accessToken !== accessToken ||
        result.identity?.id !== deviceId || result.installation?.status !== 'enrolled' ||
        !Array.isArray(result.history?.authorizedMetrics)) return;
    authorizedElectricalMetrics.value = result.history.authorizedMetrics.filter((metric): metric is 'power' | 'energy_import_total' | 'energy_export_total' =>
      metric === 'power' || metric === 'energy_import_total' || metric === 'energy_export_total',
    );
  } catch {
    // History remains hidden when the authoritative read-model decision is unavailable.
  }
}

function refreshHistoryAuthorizationAfterApproval() {
  void loadElectricalHistoryAuthorization();
  emit('approved');
}

watch(() => [props.device.id, props.device.metadata?.observationApprovalRequired, props.apiBase, props.accessToken], () => void loadAuthorizedBindings());
watch(() => [props.device.id, props.device.trustStatus, props.approvalRevision, presentation.value.showElectrical, props.apiBase, props.accessToken], () => void loadElectricalHistoryAuthorization(), { immediate: true });
onMounted(() => void loadAuthorizedBindings());
onBeforeUnmount(() => {
  authorityController?.abort();
  electricalAuthorityController?.abort();
});
</script>

<template>
  <section v-if="presentation.showRelayState" class="device-observation-overview" aria-label="Switch status and control">
    <DeviceRelayStatus :values="device.state.values" :status="device.state.status" :observed-at="device.state.fieldObservedAt?.on || device.state.observedAt" :command="device.state.command" :now="now" />
    <DeviceSwitchControl v-if="controlReady" :device="device" :identity-verified="controlIdentityVerified" :busy="busy" :error="error" @action="emit('action', $event)" />
    <p v-if="device.adapter.protocol === 'mqtt'" class="device-observation-route">MQTT endpoint <code>{{ device.adapter.target }}</code></p>
  </section>

  <section v-if="presentation.climateMetrics.length || presentation.showElectrical" class="device-observation-overview" aria-label="Supported measurements">
    <div class="device-observation-heading">
      <div><span class="device-observation-eyebrow">Verified device capability</span><h4>Measurements</h4></div>
      <span class="device-observation-protocol">{{ device.adapter.protocol.toUpperCase() }}</span>
    </div>
    <DeviceObservationApproval
      v-if="presentation.climateMetrics.length"
      :key="`${device.id}-observation-approval`"
      :device-id="device.id"
      :enabled="device.metadata?.observationApprovalRequired === true"
      :api-base="apiBase"
      :access-token="accessToken"
      @approved="emit('approved')"
    />
    <DeviceShellyObservationApproval
      v-if="shellyApprovalRequired"
      :key="`${device.id}-shelly-observation-approval`"
      :device-id="device.id"
      :enabled="shellyApprovalRequired"
      :api-base="apiBase"
      :access-token="accessToken"
      @approved="refreshHistoryAuthorizationAfterApproval"
    />
    <DeviceShellyHttpEm1Approval
      v-if="shellyHttpEm1"
      :key="`${device.id}-shelly-http-em1-approval`"
      :device-id="device.id"
      :device-name="device.displayName"
      :api-base="apiBase"
      :access-token="accessToken"
      @approved="refreshHistoryAuthorizationAfterApproval"
    />
    <DeviceMeasurementHistory
      v-if="presentation.climateMetrics.length"
      :key="`${device.id}-${approvalRevision}`"
      :device-id="device.id"
      :device-status="device.state.status"
      :supported-metrics="presentation.climateMetrics"
      :api-base="apiBase"
      :access-token="accessToken"
    />
    <DeviceElectricalHistory
      v-if="presentation.showElectrical && authorizedElectricalMetrics.includes('power')"
      :key="`${device.id}-electrical`"
      :device-id="device.id"
      :device-status="device.state.status"
      :authorized-metrics="authorizedElectricalMetrics"
      :api-base="apiBase"
      :access-token="accessToken"
    />
  </section>
</template>
