<script setup lang="ts">
import { computed } from 'vue';
import { canSwitchDevice, type ControlSetupDevice } from './device-control';

const props = defineProps<{
  device: ControlSetupDevice & {
    displayName: string;
    state: {
      values: Record<string, number | boolean | string | null>;
      command?: { status: string; message?: string };
    };
  };
  busy?: boolean;
  error?: string;
}>();
const emit = defineEmits<{ action: [action: 'turn_on' | 'turn_off'] }>();
const pending = computed(
  () => props.device.state.command?.status === 'pending',
);
const disabled = computed(
  () => props.busy || pending.value || !canSwitchDevice(props.device),
);
const reportedOn = computed(() => {
  const v = props.device.state.values;
  const on = v.on ?? v.output ?? v.switch ?? v.powered;
  return typeof on === 'boolean' ? on : null;
});
const failure = computed(
  () =>
    props.error ||
    (['failed', 'no_ack'].includes(props.device.state.command?.status || '')
      ? props.device.state.command?.message || 'Device state was not confirmed.'
      : ''),
);
function send(action: 'turn_on' | 'turn_off') {
  if (!disabled.value) emit('action', action);
}
</script>

<template>
  <div class="device-control-actions">
    <div
      class="device-switch-control"
      :class="{ busy: busy || pending, noAck: !!failure }"
      role="group"
      :aria-label="`Control ${device.displayName}`"
      :aria-busy="!!busy || pending"
    >
      <button
        type="button"
        :class="{ active: reportedOn === false, off: reportedOn === false }"
        :aria-pressed="reportedOn === false"
        :disabled="disabled"
        title="Turn off"
        @click.stop="send('turn_off')"
      >
        Off
      </button>
      <button
        type="button"
        :class="{ active: reportedOn === true, on: reportedOn === true }"
        :aria-pressed="reportedOn === true"
        :disabled="disabled"
        title="Turn on"
        @click.stop="send('turn_on')"
      >
        On
      </button>
    </div>
    <p v-if="failure" class="device-control-error" role="alert">
      {{ failure }}
    </p>
    <p v-else-if="busy || pending" role="status">
      {{ busy ? 'Sending...' : 'Waiting for device confirmation' }}
    </p>
    <p v-else-if="reportedOn === null" role="status">State unknown</p>
  </div>
</template>
