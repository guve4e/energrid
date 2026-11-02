<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, onMounted, ref, watch } from 'vue';
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
  identities?: Array<{ namespace: string; value: string }>;
  components: Array<{ key: string; capabilities: string[] }>;
  endpoints: Array<{ protocol: string; kind: string; address: string }>;
  assignments: Array<{ deviceId: string; physicalDeviceId?: string; componentKey?: string; role?: string }>;
};
type IdentityRecovery = {
  status: 'ready' | 'verification_required' | 'not_recoverable';
  reason: string;
  physicalDeviceId?: string;
  physicalId?: string;
  componentKey?: string;
};
type RpcVerification = {
  status: 'verified' | 'not_verified';
  identityVerifiedAt?: string | null;
  componentVerifiedAt?: string | null;
  observerId?: string | null;
  networkScope?: string | null;
  endpoint?: string | null;
  physicalId?: string | null;
  component?: string | null;
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
const recovery = ref<IdentityRecovery | null>(null);
const rpcVerification = ref<RpcVerification | null>(null);
const displayedIdentity = computed(() =>
  physicalDevice.value?.identities?.find(item => item.namespace === 'mqtt:shelly-protocol-id')
    || physicalDevice.value?.identity || null,
);
const isShelly = computed(() => physicalDevice.value?.vendor === 'Shelly' ||
  displayedIdentity.value?.namespace === 'mqtt:shelly-protocol-id' || /^shelly/i.test(props.deviceId));
const logicalRole = ref('');
const editingRole = ref(false);
const busy = ref(false);
const error = ref('');
const emit = defineEmits<{ retired: []; reenrolled: []; recovered: [] }>();

async function fetchIdentity(): Promise<boolean> {
  if (props.enrollmentStatus === 'not_enrolled' || props.enrollmentStatus === 'unknown') {
    association.value = null;
    history.value = [];
    physicalDevice.value = null;
    logicalAssignment.value = null;
    recovery.value = null;
    rpcVerification.value = null;
    return true;
  }
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
    recovery.value = result.recovery || null;
    rpcVerification.value = result.rpcVerification || null;
    return true;
  } catch {
    error.value = 'Network identity details are currently unavailable.';
    recovery.value = null;
    return false;
  }
}

async function load() {
  busy.value = true;
  error.value = '';
  try {
    await fetchIdentity();
  } finally {
    busy.value = false;
  }
}

async function verifySelectedDevice() {
  if (busy.value || recovery.value?.status !== 'verification_required' ||
      !recovery.value.physicalId || !recovery.value.componentKey) return;
  busy.value = true;
  error.value = '';
  try {
    const selected = recovery.value;
    const response = await authFetch(
      `${props.apiBase}/portal/discovery/${encodeURIComponent(`${selected.physicalId}:${selected.componentKey}`)}/verify-shelly`,
      { method: 'POST', headers: { Authorization: `Bearer ${props.accessToken}` } },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : 'Selected-device verification failed.');
    if (result.status !== 'verified' || result.physicalId !== selected.physicalId ||
        !Array.isArray(result.componentKeys) || !result.componentKeys.includes(selected.componentKey)) {
      throw new Error('Verification returned without confirming this physical identity and component.');
    }
    if (!await fetchIdentity()) return;
    const refreshedRecovery = recovery.value as IdentityRecovery | null;
    if (refreshedRecovery?.status !== 'ready') {
      throw new Error(refreshedRecovery?.reason || 'Fresh verification did not make the existing association recoverable.');
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Selected-device verification failed.';
  } finally {
    busy.value = false;
  }
}

async function completeIdentityAssociation() {
  if (busy.value || recovery.value?.status !== 'ready' || !recovery.value.physicalDeviceId ||
      !recovery.value.physicalId || !recovery.value.componentKey) return;
  busy.value = true;
  error.value = '';
  const expected = { ...recovery.value };
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/discovery/${encodeURIComponent(`${expected.physicalId}:${expected.componentKey}`)}/approve`,
      { method: 'POST', headers: { Authorization: `Bearer ${props.accessToken}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : 'Identity association could not be completed.');
    if (result.status !== 'approved' || result.enrollment !== 'enrolled' || result.device?.id !== props.deviceId) {
      throw new Error('The server response did not confirm recovery of this existing enrollment.');
    }
    if (!await fetchIdentity()) return;
    if (physicalDevice.value?.physicalDeviceId !== expected.physicalDeviceId ||
        logicalAssignment.value?.deviceId !== props.deviceId ||
        logicalAssignment.value?.physicalDeviceId !== expected.physicalDeviceId ||
        logicalAssignment.value?.componentKey !== expected.componentKey) {
      throw new Error('The request returned, but the authoritative physical identity association is still incomplete. Reload to inspect the current state.');
    }
    recovery.value = null;
    emit('recovered');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Identity association could not be completed.';
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
    <div class="device-identity-heading">
      <div><span class="device-identity-eyebrow">Connection evidence</span><h4>Network identity</h4></div>
      <span class="device-identity-enrollment">{{ enrollmentStatus === 'not_enrolled' ? 'Not enrolled' : enrollmentStatus === 'unknown' ? 'Unknown enrollment' : enrollmentStatus }}</span>
    </div>

    <dl class="device-network-identity-facts">
      <div><dt>Logical device ID</dt><dd><code>{{ deviceId }}</code></dd><small>Portal device record</small></div>
      <div><dt>Physical inventory ID</dt><dd>{{ physicalDevice?.physicalDeviceId || 'Not linked' }}</dd><small>Separate from the logical device ID</small></div>
      <div><dt>Firmware identity</dt><dd>{{ displayedIdentity ? `${displayedIdentity.namespace} · ${displayedIdentity.value}` : 'Unknown' }}</dd><small>{{ displayedIdentity?.namespace === 'mqtt:shelly-protocol-id' ? 'Shelly protocol identity' : 'Primary inventory identity claim' }}</small></div>
      <div>
        <dt>{{ association?.isCurrent ? 'Current IP address' : association ? 'Last known IP address' : 'IP address' }}</dt>
        <dd>{{ association?.ipAddress || 'Unknown' }}</dd>
        <small :class="['device-identity-evidence', association?.isCurrent ? 'is-current' : '']">{{ association ? association.isCurrent ? 'Current scoped evidence' : 'Last observed; ownership may have changed' : 'No network evidence' }}</small>
      </div>
      <div><dt>Network scope</dt><dd>{{ association?.networkZoneName || association?.networkZoneId || 'Unknown' }}</dd><small>{{ association?.gatewayId || 'Gateway not identified' }}</small></div>
      <div><dt>{{ association?.hardwareVerifiedAt ? 'Verified MAC address' : 'Observed MAC address' }}</dt><dd>{{ association?.macAddress || 'Unknown' }}</dd><small>{{ association?.hardwareVerifiedAt ? 'Hardware verified' : association?.macAddress ? 'Not independently verified' : 'No MAC evidence' }}</small></div>
      <div><dt>Enrollment</dt><dd>{{ enrollmentStatus === 'not_enrolled' ? 'Not enrolled' : enrollmentStatus }}</dd><small>{{ physicalDevice?.verificationStatus?.replaceAll('_', ' ') || 'Physical identity not linked' }}</small></div>
    </dl>

    <p v-if="!association" class="device-identity-empty">No LAN identity is associated with {{ deviceName }}.</p>

    <div v-if="recovery && isShelly" class="device-identity-recovery">
      <strong v-if="recovery.status === 'not_recoverable'">Partial enrollment recovery unavailable</strong>
      <p>{{ recovery.reason }}</p>
      <p v-if="recovery.status === 'ready'">Link this existing component to Physical Inventory {{ recovery.physicalDeviceId }} as {{ recovery.componentKey }}. No measurement or control authority is added.</p>
      <button v-if="recovery.status === 'verification_required'" type="button" class="ghost" :disabled="busy" @click="verifySelectedDevice">
        {{ busy ? 'Verifying…' : 'Verify selected device' }}
      </button>
      <button v-else-if="recovery.status === 'ready'" type="button" class="primary" :disabled="busy" @click="completeIdentityAssociation">
        {{ busy ? 'Completing…' : 'Complete identity association' }}
      </button>
    </div>

    <details class="device-identity-technical">
      <summary>Endpoint, provenance and physical components</summary>
      <dl class="device-identity-technical-grid">
        <div><dt>Endpoint</dt><dd>{{ protocol.toUpperCase() }} · {{ protocolEndpoint || 'Unknown' }}</dd></div>
        <div><dt>Evidence source</dt><dd>{{ evidenceSourceLabel(association?.evidenceSource) }}</dd></div>
        <div><dt>Last observed</dt><dd>{{ observedAt(association?.observedAt) }}</dd></div>
        <div><dt>MAC address last verified</dt><dd>{{ association?.hardwareVerifiedAt || association?.verificationStatus === 'hardware_verified' ? observedAt(association?.hardwareVerifiedAt || association?.observedAt) : 'No independent MAC verification recorded' }}</dd></div>
        <div v-if="rpcVerification && isShelly"><dt>Shelly RPC identity and component</dt><dd>{{ rpcVerification.status === 'verified' ? 'Verified' : 'Not verified' }}</dd><small v-if="rpcVerification.status === 'verified'">{{ rpcVerification.physicalId }} · {{ rpcVerification.component }} · {{ rpcVerification.endpoint }} · {{ rpcVerification.networkScope }}</small><small v-else>The stored protocol identity claim is not fresh, site-local RPC evidence for this component.</small></div>
        <div v-if="rpcVerification?.status === 'verified'"><dt>RPC evidence</dt><dd>{{ observedAt(rpcVerification.identityVerifiedAt || undefined) }}</dd><small>Identity verified by {{ rpcVerification.observerId || 'authorized site observer' }}; component status at {{ observedAt(rpcVerification.componentVerifiedAt || undefined) }}. This is historical verification evidence, separate from the MAC association.</small></div>
        <div><dt>Hostname</dt><dd>{{ association?.hostname || 'Unknown' }}</dd></div>
        <div><dt>Protocol identity</dt><dd>{{ displayedIdentity ? `${displayedIdentity.namespace} · ${displayedIdentity.value}` : 'Unknown' }}</dd></div>
        <div v-if="physicalDevice?.vendor || physicalDevice?.hardwareModel || physicalDevice?.firmwareVersion"><dt>Inventory metadata</dt><dd>{{ [physicalDevice?.vendor, physicalDevice?.hardwareModel, physicalDevice?.firmwareVersion].filter(Boolean).join(' · ') }}</dd><small>Stored inventory details; firmware health reports its current version separately.</small></div>
        <div><dt>Component and role</dt><dd>{{ [logicalAssignment?.componentKey, logicalAssignment?.role].filter(Boolean).join(' · ') || 'Not assigned' }}</dd></div>
      </dl>
      <div v-if="physicalDevice" class="physical-components">
        <article v-for="component in physicalDevice.components" :key="component.key" class="physical-component">
          <strong>{{ component.key }}</strong><span>{{ component.capabilities.length ? component.capabilities.join(', ') : 'Capabilities unknown' }}</span>
          <span v-for="assignment in physicalDevice.assignments.filter(item => item.componentKey === component.key)" :key="assignment.deviceId">{{ assignment.role || assignment.deviceId }}</span>
        </article>
      </div>
      <p v-if="physicalDevice?.endpoints.length" class="device-identity-endpoints">Stored endpoints: {{ physicalDevice.endpoints.map(endpoint => `${endpoint.protocol.toUpperCase()} ${endpoint.address}`).join(' · ') }}</p>
      <div v-if="logicalAssignment && enrollmentStatus === 'enrolled'" class="device-network-identity-role">
        <button type="button" class="ghost" :disabled="busy" @click="editingRole = !editingRole">{{ editingRole ? 'Cancel role edit' : 'Assign logical role' }}</button>
        <div v-if="editingRole" class="device-network-identity-association">
          <label>Logical role or name<input v-model="logicalRole" type="text" placeholder="Boiler, Oven..." :disabled="busy"></label>
          <button type="button" class="primary" :disabled="busy" @click="saveRole">{{ busy ? 'Saving…' : 'Save role' }}</button>
        </div>
      </div>
    </details>

    <button v-if="['enrolled', 'suspended'].includes(enrollmentStatus)" type="button" class="ghost" :disabled="busy" @click="retire">
      {{ busy ? 'Removing…' : 'Remove device' }}
    </button>
    <div v-if="enrollmentStatus === 'retired'">
      <p>This device is retired and cannot report observations or receive commands.</p>
      <button type="button" class="primary" :disabled="busy" @click="reenroll">{{ busy ? 'Approving...' : 'Approve reenrollment' }}</button>
    </div>
    <p v-if="error" class="device-identity-error" role="alert">{{ error }}</p>
    <details v-if="history.length > 1" class="device-network-identity-history">
      <summary>Network observations · {{ history.length }}</summary>
      <ul>
        <li v-for="item in history" :key="`${item.observedAt}-${item.ipAddress}`">
          {{ item.ipAddress }} · {{ observedAt(item.observedAt) }} · {{ item.evidenceSource.replaceAll('_', ' ') }}
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.device-network-identity { display: grid; gap: 12px; min-width: 0; padding: 14px 0; border-top: 1px solid var(--eg-border, #d8e0ec); color: var(--eg-text, #111827); }
.device-identity-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.device-identity-heading h4 { margin: 3px 0 0; color: var(--eg-text, #111827); }
.device-identity-eyebrow { color: var(--eg-muted, #58677e); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.device-identity-enrollment, .device-identity-evidence { display: inline-flex; width: fit-content; border-radius: 999px; padding: 4px 8px; background: var(--eg-blue-soft, #eef4ff); color: var(--eg-blue, #2863e6); font-size: 11px; font-weight: 700; text-transform: capitalize; }
.device-network-identity-facts, .device-identity-technical-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; }
.device-network-identity-facts > div, .device-identity-technical-grid > div { display: grid; gap: 4px; min-width: 0; padding: 10px 11px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); background: var(--eg-surface-soft, #f5f8fc); }
.device-network-identity-facts dt, .device-identity-technical-grid dt { color: var(--eg-muted, #58677e); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.device-network-identity-facts dd, .device-identity-technical-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 12px; }
.device-network-identity-facts small { color: var(--eg-muted, #58677e); font-size: 10px; line-height: 1.35; }
.device-identity-evidence { padding: 0; background: transparent; color: var(--eg-warning, #a45b08); }
.device-identity-evidence.is-current { color: var(--eg-success, #138a59); }
.device-identity-technical { border-top: 1px solid var(--eg-border, #d8e0ec); padding-top: 10px; }
.device-identity-technical > summary, .device-network-identity-history > summary { min-height: 36px; cursor: pointer; color: var(--eg-blue, #2863e6); font-size: 12px; font-weight: 700; }
.device-identity-empty, .device-identity-error, .device-identity-endpoints { margin: 0; color: var(--eg-muted, #58677e); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.device-identity-error { color: var(--eg-danger, #b42318); }
.physical-components { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); gap: 8px; margin-top: 10px; }
.physical-component { display: grid; gap: 4px; min-width: 0; padding: 10px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); font-size: 11px; overflow-wrap: anywhere; }
.physical-component span { color: var(--eg-muted, #58677e); }
.device-network-identity-role { margin-top: 10px; }
.device-identity-recovery { display: grid; justify-items: start; gap: 8px; padding: 12px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); background: var(--eg-surface-soft, #f5f8fc); }
.device-identity-recovery p { margin: 0; color: var(--eg-muted, #58677e); font-size: 12px; }
.device-network-identity-association { display: grid; gap: 10px; margin-top: 10px; }
.device-network-identity-association label { display: grid; gap: 6px; }
.device-network-identity-association input { min-width: 0; padding: 10px; }
.device-network-identity-history { border-top: 1px solid var(--eg-border, #d8e0ec); padding-top: 10px; }
.device-network-identity-history ul { display: grid; gap: 6px; padding-left: 18px; color: var(--eg-muted, #58677e); font-size: 11px; }
.device-network-identity :is(button, summary, input):focus-visible { outline: 2px solid var(--eg-blue, #2863e6); outline-offset: 2px; }
@media (max-width: 520px) { .device-network-identity-facts, .device-identity-technical-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
