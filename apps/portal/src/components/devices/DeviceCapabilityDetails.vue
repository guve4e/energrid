<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';
import DeviceMeasurementHistory from './DeviceMeasurementHistory.vue';
import DeviceElectricalHistory from './DeviceElectricalHistory.vue';
import DeviceObservationApproval from './DeviceObservationApproval.vue';
import DeviceShellyObservationApproval from './DeviceShellyObservationApproval.vue';
import DeviceRelayStatus from './DeviceRelayStatus.vue';
import DeviceSwitchControl from './DeviceSwitchControl.vue';
import type { ControlSetupDevice } from './device-control';
import { deviceDetailPresentation } from './device-detail-capabilities';

const props = defineProps<{
  device: ControlSetupDevice & {
    displayName: string;
    capabilities: Array<{ kind: string; actions: string[]; unit?: string }>;
    supportedCapabilities?: Array<{ kind: string; actions: string[]; unit?: string }>;
    state: { values: Record<string, number | boolean | string | null>; status: string; observedAt: string | null; command?: { status: string; message?: string } };
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
const shellyPowerAuthorized = ref(false);
const shellyApprovalRequired = computed(() =>
  props.device.metadata?.identityEvidenceSource === 'verified_site_local_shelly_rpc' &&
  props.device.metadata?.componentEvidenceSource === 'verified_site_local_shelly_rpc' &&
  props.device.metadata?.shellyMqttObservationApprovalRequired === true,
);
const presentation = computed(() => deviceDetailPresentation(props.device, boundMetrics.value, authorizedBindings.value));
let authorityController: AbortController | undefined;
let authorityRevision = 0;

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

watch(() => [props.device.id, props.device.metadata?.observationApprovalRequired, props.apiBase, props.accessToken], () => void loadAuthorizedBindings());
onMounted(() => void loadAuthorizedBindings());
onBeforeUnmount(() => authorityController?.abort());
</script>

<template>
  <section v-if="presentation.showRelayState" class="device-observation-overview" aria-label="Switch status and control">
    <DeviceRelayStatus :values="device.state.values" :status="device.state.status" :observed-at="device.state.observedAt" :command="device.state.command" :now="now" />
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
      @authorization="shellyPowerAuthorized = $event"
      @approved="emit('approved')"
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
      v-if="presentation.showElectrical && (!shellyApprovalRequired || shellyPowerAuthorized)"
      :key="`${device.id}-electrical`"
      :device-id="device.id"
      :device-status="device.state.status"
      :api-base="apiBase"
      :access-token="accessToken"
    />
  </section>
</template>
