<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { onMounted, ref, watch } from 'vue';
type IdentityEvidence = {
  ipAddress: string;
  macAddress?: string;
  hostname?: string;
  gatewayId?: string;
  networkZoneId: string;
  networkZoneName: string;
  observedAt: string;
  evidenceSource: string;
  verificationStatus: 'user_confirmed' | 'hardware_verified';
  associatedAt: string;
  hardwareVerifiedAt?: string;
  isCurrent?: boolean;
};
type PhysicalDevice = {
  physicalDeviceId: string;
  vendor?: string;
  hardwareModel?: string;
  firmwareVersion?: string;
  verificationStatus: string;
  identity?: { namespace: string; value: string };
  components: Array<{ key: string; capabilities: string[] }>;
  endpoints: Array<{ protocol: string; kind: string; address: string }>;
  assignments: Array<{ deviceId: string; componentKey?: string; role?: string }>;
};

const props = defineProps<{
  deviceId: string;
  deviceName: string;
  enrollmentStatus: 'enrolled' | 'suspended' | 'retired' | 'not_enrolled' | 'unknown';
  protocol: string;
  protocolEndpoint?: string;
  apiBase: string;
  accessToken: string;
}>();

const association = ref<IdentityEvidence | null>(null);
const history = ref<IdentityEvidence[]>([]);
const physicalDevice = ref<PhysicalDevice | null>(null);
const logicalAssignment = ref<PhysicalDevice['assignments'][number] | null>(null);
const logicalRole = ref('');
const editingRole = ref(false);
const busy = ref(false);
const error = ref('');
const emit = defineEmits<{ retired: []; reenrolled: [] }>();

async function load() {
  if (props.enrollmentStatus === 'not_enrolled' || props.enrollmentStatus === 'unknown') {
    association.value = null;
    history.value = [];
    physicalDevice.value = null;
    logicalAssignment.value = null;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/network-identity`,
      { headers: { Authorization: `Bearer ${props.accessToken}` } },
    );
    if (!response.ok) throw new Error('Network identity could not be loaded');
    const result = await response.json();
    association.value = result.association || null;
    history.value = Array.isArray(result.history) ? result.history : [];
    physicalDevice.value = result.physicalDevice || null;
    logicalAssignment.value = result.logicalAssignment || null;
    logicalRole.value = result.logicalAssignment?.role || '';
  } catch {
    error.value = 'Network identity details are currently unavailable.';
  } finally {
    busy.value = false;
  }
}

async function saveRole() {
  if (!physicalDevice.value || !logicalAssignment.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/component-assignment`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${props.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          physicalDeviceId: physicalDevice.value.physicalDeviceId,
          ...(logicalAssignment.value.componentKey ? { componentKey: logicalAssignment.value.componentKey } : {}),
          ...(logicalRole.value.trim() ? { role: logicalRole.value.trim() } : {}),
        }),
      },
    );
    if (response.status === 409) throw new Error('The discovered physical assignment changed. Reload before editing its role.');
    if (!response.ok) throw new Error('The logical role could not be saved.');
    editingRole.value = false;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The component assignment could not be saved.';
  } finally {
    busy.value = false;
  }
}

async function retire() {
  if (busy.value || !window.confirm(`Remove ${props.deviceName}? This revokes observation and command authority. Reenrollment will require explicit approval.`)) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/retire`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${props.accessToken}` },
      },
    );
    if (!response.ok) throw new Error('The device could not be removed.');
    emit('retired');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The device could not be removed.';
  } finally {
    busy.value = false;
  }
}

async function reenroll() {
  if (busy.value || !window.confirm(`Approve ${props.deviceName} for reenrollment? This restores its previously approved authority.`)) return;
  busy.value = true;
  error.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/reenroll`,
      { method: 'POST', headers: { Authorization: `Bearer ${props.accessToken}` } },
    );
    if (!response.ok) throw new Error('The device could not be reenrolled.');
    emit('reenrolled');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The device could not be reenrolled.';
  } finally {
    busy.value = false;
  }
}

function observedAt(value?: string): string {
  if (!value) return 'Not identified';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function evidenceSourceLabel(value?: string): string {
  if (!value) return 'Not identified';
  if (value === 'lan_discovery') return 'LAN Discovery';
  return value.replaceAll('_', ' ');
}

onMounted(load);
watch(() => [props.deviceId, props.enrollmentStatus], load);
</script>

<template>
  <section class="device-network-identity" aria-label="Enrolled device network identity">
    <h4>Network identity</h4>
    <p><strong>Enrollment status</strong> · {{ enrollmentStatus === 'not_enrolled' ? 'Not enrolled' : enrollmentStatus === 'unknown' ? 'Unknown' : enrollmentStatus }}</p>
    <dl class="device-network-identity-facts">
      <div><dt>Logical device ID</dt><dd>{{ deviceId }}</dd></div>
      <div><dt>IP address</dt><dd>{{ association?.ipAddress || 'Not identified' }}</dd></div>
      <div><dt>MAC address</dt><dd>{{ association?.macAddress || 'Not identified' }}</dd></div>
      <div><dt>Hostname</dt><dd>{{ association?.hostname || 'Not identified' }}</dd></div>
      <div><dt>Gateway / network</dt><dd>{{ [association?.gatewayId, association?.networkZoneName || association?.networkZoneId].filter(Boolean).join(' · ') || 'Not identified' }}</dd></div>
      <div><dt>Last observed</dt><dd>{{ observedAt(association?.observedAt) }}</dd></div>
      <div><dt>Endpoint</dt><dd>{{ protocol.toUpperCase() }} · {{ protocolEndpoint || 'Not identified' }}</dd></div>
      <div><dt>Evidence source</dt><dd>{{ evidenceSourceLabel(association?.evidenceSource) }}</dd></div>
      <div>
        <dt>Identity verification</dt>
        <dd v-if="association">
          {{ association.verificationStatus === 'hardware_verified' ? 'Hardware independently verified' : 'User confirmed' }}
          <span v-if="association.macAddress && !association.hardwareVerifiedAt"> · MAC not independently verified</span>
        </dd>
        <dd v-else>Not identified</dd>
      </div>
    </dl>

    <p v-if="!association">No LAN identity is associated with {{ deviceName }}.</p>
    <div v-if="physicalDevice" class="physical-device-summary">
      <p><strong>Physical device ID</strong> · {{ physicalDevice.physicalDeviceId }}</p>
      <h5>Physical device · {{ physicalDevice.physicalDeviceId }}</h5>
      <p>Component ID · {{ logicalAssignment?.componentKey || 'Not assigned to a component' }}</p>
      <p v-if="logicalAssignment?.role">Logical role · {{ logicalAssignment.role }}</p>
      <p>Identity status · {{ physicalDevice.verificationStatus.replaceAll('_', ' ') }}</p>
      <p v-if="physicalDevice.vendor || physicalDevice.hardwareModel || physicalDevice.firmwareVersion">
        Hardware · {{ [physicalDevice.vendor, physicalDevice.hardwareModel, physicalDevice.firmwareVersion].filter(Boolean).join(' · ') }}
      </p>
      <p v-if="physicalDevice.identity">Protocol identity · {{ physicalDevice.identity.namespace }} · {{ physicalDevice.identity.value }}</p>
      <p v-else>Physical identity · Not identified</p>
      <div v-for="component in physicalDevice.components" :key="component.key" class="physical-component">
        <strong>Component {{ component.key }}</strong>
        <span> · {{ component.capabilities.length ? component.capabilities.join(', ') : 'Capabilities not identified' }}</span>
        <span v-for="assignment in physicalDevice.assignments.filter(item => item.componentKey === component.key)" :key="assignment.deviceId">
          · {{ assignment.role || assignment.deviceId }}
        </span>
      </div>
      <div v-if="logicalAssignment && enrollmentStatus === 'enrolled'">
        <button type="button" class="ghost" :disabled="busy" @click="editingRole = !editingRole">
          {{ editingRole ? 'Cancel role edit' : 'Assign logical role' }}
        </button>
        <div v-if="editingRole" class="device-network-identity-association">
          <label>Logical role or name<input v-model="logicalRole" type="text" placeholder="Boiler, Oven..." :disabled="busy"></label>
          <button type="button" class="primary" :disabled="busy" @click="saveRole">{{ busy ? 'Saving...' : 'Save role' }}</button>
        </div>
      </div>
      <p v-if="physicalDevice.endpoints.length">
        Endpoints · {{ physicalDevice.endpoints.map(endpoint => `${endpoint.protocol.toUpperCase()} ${endpoint.address}`).join(', ') }}
      </p>
    </div>
    <button v-if="['enrolled', 'suspended'].includes(enrollmentStatus)" type="button" class="ghost" :disabled="busy" @click="retire">
      {{ busy ? 'Removing...' : 'Remove device' }}
    </button>
    <div v-if="enrollmentStatus === 'retired'">
      <p>This device is retired and cannot report observations or receive commands.</p>
      <button type="button" class="primary" :disabled="busy" @click="reenroll">{{ busy ? 'Approving...' : 'Approve reenrollment' }}</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <details v-if="history.length > 1" class="device-network-identity-history">
      <summary>Network observations · {{ history.length }}</summary>
      <ul>
        <li v-for="item in history" :key="`${item.observedAt}-${item.ipAddress}`">
          {{ item.ipAddress }} · {{ observedAt(item.observedAt) }}
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.device-network-identity { border-top: 1px solid var(--line, #d8e1ed); padding: 16px 0; }
.device-network-identity-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 20px; }
.device-network-identity-facts div { min-width: 0; }
.device-network-identity-facts dt { color: var(--muted, #9aa8b7); font-size: .78rem; }
.device-network-identity-facts dd { min-width: 0; margin: 3px 0 0; overflow-wrap: break-word; word-break: normal; }
.device-network-identity-association { display: grid; gap: 10px; margin-top: 12px; }
.device-network-identity-association label { display: grid; gap: 6px; }
.device-network-identity-association input { min-width: 0; padding: 10px; }
.physical-component { margin: 6px 0; }
.device-network-identity-history { margin-top: 12px; }
@media (max-width: 600px) {
  .device-network-identity-facts { grid-template-columns: minmax(0, 1fr); }
}
</style>
