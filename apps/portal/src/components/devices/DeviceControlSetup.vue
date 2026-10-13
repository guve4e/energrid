<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DeviceControlBinding } from '@energrid/domain-devices';
import { controlRouteLabel, type ControlSetupDevice } from './device-control';

const props = defineProps<{
  device: ControlSetupDevice;
  apiBase: string;
  accessToken: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const mode = ref<'none' | 'mqtt' | 'http'>('none');
const enabled = ref(false);
const topic = ref('');
const address = ref('');
const credentialRef = ref('');
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const shelly = computed(() => props.device.adapter.driver.includes('shelly'));
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
const statusLabel = computed(
  () =>
    ({
      ready: 'Switching configured',
      disabled: 'Switching disabled',
      'needs-setup': 'Control not configured',
      'read-only': 'Read only',
      unapproved: 'Approval required',
    })[props.device.control?.status || 'needs-setup'],
);

watch(
  [
    () => props.device.id,
    () => JSON.stringify(props.device.control?.binding),
    () => props.device.trustStatus,
  ],
  () => {
    const binding = props.device.control?.binding;
    mode.value =
      binding?.kind === 'shelly-http' ? 'http' : binding ? 'mqtt' : 'none';
    enabled.value = binding?.enabled || false;
    topic.value =
      binding && 'topic' in binding
        ? binding.topic
        : String(props.device.metadata?.mqttCommandTopic || '');
    address.value =
      binding?.kind === 'shelly-http'
        ? binding.baseUrl
        : String(props.device.metadata?.httpBaseUrl || '');
    credentialRef.value =
      binding?.kind === 'shelly-http' ? binding.credentialRef || '' : '';
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
  if (mode.value !== 'none') {
    if (!identityComplete.value) {
      error.value = 'Relay identity is incomplete.';
      return;
    }
    if (mode.value === 'http')
      binding = {
        kind: 'shelly-http',
        enabled: enabled.value,
        physicalId: physicalId.value,
        channel: channel.value as number,
        baseUrl: address.value.trim(),
        ...(credentialRef.value.trim()
          ? { credentialRef: credentialRef.value.trim() }
          : {}),
      };
    else
      binding = shelly.value
        ? {
            kind: 'shelly-mqtt',
            enabled: enabled.value,
            physicalId: physicalId.value,
            channel: channel.value as number,
            topic: topic.value.trim(),
          }
        : {
            kind: 'generic-mqtt',
            enabled: enabled.value,
            topic: topic.value.trim(),
          };
  }
  busy.value = true;
  const deviceId = props.device.id;
  try {
    const response = await fetch(
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
      <div v-if="editable">
        <dt>Settings storage</dt>
        <dd>Runtime session</dd>
      </div>
    </dl>
    <form v-if="editable" @submit.prevent="save">
      <label
        >Control through
        <select v-model="mode" :disabled="busy">
          <option value="none">Not configured</option>
          <option value="mqtt">MQTT</option>
          <option v-if="shelly" value="http">HTTP</option>
        </select>
      </label>
      <label v-if="mode === 'mqtt'"
        >MQTT command topic<input
          v-model="topic"
          required
          :disabled="busy"
          autocomplete="off"
          placeholder="device-prefix/rpc"
      /></label>
      <template v-if="mode === 'http'">
        <label
          >Shelly address<input
            v-model="address"
            required
            type="url"
            :disabled="busy"
            placeholder="http://192.168.7.15"
        /></label>
        <label
          >Server credential reference<input
            v-model="credentialRef"
            :disabled="busy"
            autocomplete="off"
            placeholder="Optional"
        /></label>
      </template>
      <label v-if="mode !== 'none'" class="control-permission"
        ><input
          v-model="enabled"
          type="checkbox"
          :disabled="busy || !identityComplete"
        />Allow switching</label
      >
      <p v-if="mode !== 'none' && !identityComplete" role="alert">
        Relay identity is incomplete.
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="saved" role="status">Control settings saved.</p>
      <button
        type="submit"
        :disabled="busy || (mode !== 'none' && !identityComplete)"
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
[role='alert'] {
  color: #d14b4b;
}
</style>
