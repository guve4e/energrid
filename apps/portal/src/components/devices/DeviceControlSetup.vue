<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, ref, watch } from 'vue';
import type { DeviceControlBinding } from '@energrid/domain-devices';
import { controlRouteLabel, type ControlSetupDevice } from './device-control';
import {
  discoveredShellyAddress,
  type NetworkIdentity,
} from './device-network';

const props = defineProps<{
  device: ControlSetupDevice;
  apiBase: string;
  accessToken: string;
  networkDevices?: NetworkIdentity[];
}>();
const emit = defineEmits<{ saved: [] }>();
const mode = ref<'none' | 'mqtt'>('none');
const enabled = ref(false);
const topic = ref('');
const discoveredAddress = computed(() =>
  discoveredShellyAddress(props.device, props.networkDevices || []),
);
const knownAddress = discoveredAddress;
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const shelly = computed(() => props.device.adapter.driver.includes('shelly'));
const scopeResolvedShelly = computed(() =>
  ['shelly-lan', 'shelly-discovered'].includes(props.device.adapter.driver) &&
  typeof props.device.metadata?.networkScope === 'string' &&
  props.device.metadata.networkScope.trim().length > 0,
);
const savedShellyRoute = computed(() => {
  const binding = props.device.control?.binding;
  return binding && ['shelly-mqtt', 'shelly-http', 'shelly-virtual-lab'].includes(binding.kind)
    ? binding
    : null;
});
const canConfigureShellyPermission = computed(() =>
  scopeResolvedShelly.value || savedShellyRoute.value !== null,
);
const physicalId = computed(() =>
  String(
    props.device.metadata?.physicalId || props.device.adapter.target || '',
  ),
);
const channel = computed(() => props.device.metadata?.channel);
const editable = computed(
  () =>
    props.device.trustStatus === 'approved' &&
    !props.device.memberDeviceIds?.length &&
    props.device.adapter.protocol !== 'simulated' &&
    props.device.capabilities.some(
      (c) => c.actions.includes('turn_on') && c.actions.includes('turn_off'),
    ),
);
const identityComplete = computed(
  () =>
    !shelly.value ||
    (typeof channel.value === 'number' &&
      Number.isInteger(channel.value) &&
      !!physicalId.value),
);
const statusLabel = computed(() => {
  if (props.device.control?.binding?.kind === 'shelly-switch')
    return enabled.value ? 'Switching permission enabled' : 'Switching permission disabled';
  return (
    ({
      ready: 'Switching configured',
      disabled: 'Switching disabled',
      'needs-setup': 'Control not configured',
      'read-only': 'Read only',
      unapproved: 'Approval required',
    })[props.device.control?.status || 'needs-setup']
  );
});

watch(
  [
    () => props.device.id,
    () => JSON.stringify(props.device.control?.binding),
    () => props.device.trustStatus,
  ],
  () => {
    const binding = props.device.control?.binding;
    mode.value = binding?.kind === 'generic-mqtt' ? 'mqtt' : 'none';
    enabled.value = binding?.enabled || false;
    topic.value =
      binding && 'topic' in binding
        ? binding.topic
        : String(props.device.metadata?.mqttCommandTopic || '');
    error.value = '';
    saved.value = false;
  },
  { immediate: true },
);

async function save() {
  if (!editable.value || busy.value) return;
  error.value = '';
  saved.value = false;
  let binding: DeviceControlBinding | null = null;
  if (shelly.value) {
    if (!identityComplete.value) {
      error.value = 'Relay identity is incomplete.';
      return;
    }
    if (scopeResolvedShelly.value) {
      binding = {
        kind: 'shelly-switch',
        enabled: enabled.value,
        physicalId: physicalId.value,
        channel: channel.value as number,
      };
    } else if (savedShellyRoute.value) {
      // Preserve an existing, explicitly authorized route for legacy Shelly
      // profiles. The installer can change permission, but cannot select or
      // replace its transport here.
      binding = { ...savedShellyRoute.value, enabled: enabled.value };
    } else {
      error.value = 'No authorized execution route is configured for this Shelly.';
      return;
    }
  } else if (mode.value === 'mqtt') {
    binding = { kind: 'generic-mqtt', enabled: enabled.value, topic: topic.value.trim() };
  }
  busy.value = true;
  const deviceId = props.device.id;
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(deviceId)}/control`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${props.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ binding }),
      },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        result?.message || 'Control settings could not be saved.',
      );
    if (props.device.id === deviceId) {
      saved.value = true;
      emit('saved');
    }
  } catch (cause) {
    if (props.device.id === deviceId)
      error.value =
        cause instanceof Error
          ? cause.message
          : 'Control settings could not be saved.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="control-setup" aria-label="Device control settings">
    <h4>Control settings</h4>
    <dl>
      <div>
        <dt>Readings</dt>
        <dd>{{ device.adapter.protocol.toUpperCase() }}</dd>
      </div>
      <div>
        <dt>Control</dt>
        <dd>{{ statusLabel }}</dd>
      </div>
      <div>
        <dt>Route</dt>
        <dd>{{ controlRouteLabel(device) }}</dd>
      </div>
      <div v-if="shelly">
        <dt>Hardware</dt>
        <dd>{{ physicalId }}</dd>
      </div>
      <div v-if="shelly">
        <dt>Relay channel</dt>
        <dd>{{ channel ?? 'Unknown' }}</dd>
      </div>
      <div v-if="shelly">
        <dt>Last observed address</dt>
        <dd>{{ knownAddress || 'Uses saved site-owned evidence' }}</dd>
      </div>
      <div v-if="shelly && device.metadata?.networkScope">
        <dt>Authorized scope</dt>
        <dd>{{ device.metadata.networkScope }}</dd>
      </div>
      <div v-if="shelly">
        <dt>Assistant control</dt>
        <dd>Separate permission</dd>
      </div>
      <div v-if="editable">
        <dt>Settings storage</dt>
        <dd>Local persistent store</dd>
      </div>
    </dl>
    <form v-if="editable" @submit.prevent="save">
      <label v-if="!shelly"
        >Control through
        <select v-model="mode" :disabled="busy">
          <option value="none">Not configured</option>
          <option value="mqtt">MQTT</option>
        </select>
      </label>
      <p v-if="scopeResolvedShelly" class="muted">
        The API resolves the execution route from this component’s verified identity, saved site-owned endpoint, and authorized network scope. This permission does not grant measurement or assistant-control authority.
      </p>
      <p v-else-if="shelly && savedShellyRoute" class="muted">
        The existing authorized Shelly route is retained. This setting only changes switching permission; route selection, measurements, and assistant control are separate.
      </p>
      <p v-else-if="shelly" class="muted">
        No authorized execution route is available for this Shelly profile. Switching remains unavailable until a supported route is configured.
      </p>
      <label v-if="!shelly && mode === 'mqtt'"
        >MQTT command topic<input
          v-model="topic"
          required
          :disabled="busy"
          autocomplete="off"
          placeholder="device-prefix/rpc"
      /></label>
      <label v-if="shelly || mode !== 'none'" class="control-permission"
        ><input
          v-model="enabled"
          type="checkbox"
          :disabled="busy || !identityComplete || (shelly && !canConfigureShellyPermission)"
        />Allow switching</label
      >
      <p v-if="shelly && !identityComplete" role="alert">
        Relay identity is incomplete.
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="saved" role="status">Control settings saved.</p>
      <button
        type="submit"
        :disabled="
          busy ||
          (shelly && !identityComplete) ||
          (shelly && !canConfigureShellyPermission) ||
          (!shelly && mode === 'mqtt' && !topic.trim())
        "
      >
        {{ busy ? 'Saving...' : 'Save control settings' }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.control-setup {
  border-top: 1px solid var(--border, #d7dfeb);
  padding-top: 16px;
  margin-top: 16px;
}
h4 {
  margin: 0 0 12px;
  font-size: 16px;
}
dl {
  margin: 0 0 16px;
  display: grid;
  gap: 8px;
}
dl div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 12px;
}
dt {
  color: var(--muted, #64748b);
  font-size: 12px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
}
form {
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
input,
select,
button {
  font: inherit;
  box-sizing: border-box;
  max-width: 100%;
  border: 1px solid var(--border, #d7dfeb);
  border-radius: 6px;
  padding: 9px;
  color: inherit;
  background: var(--surface, transparent);
}
input,
select {
  min-width: 0;
  width: 100%;
}
.control-permission {
  display: flex;
  align-items: center;
  gap: 9px;
}
.control-permission input {
  width: 16px;
  height: 16px;
  margin: 0;
}
button {
  cursor: pointer;
  justify-self: start;
  font-weight: 700;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
p {
  margin: 0;
  font-size: 13px;
}
.address-discovery {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.address-discovery p {
  flex: 1 1 200px;
  color: var(--muted, #64748b);
}
.address-discovery [role='alert'] {
  color: #d14b4b;
}
.address-discovery button {
  min-height: 44px;
}
[role='alert'] {
  color: #d14b4b;
}
</style>
