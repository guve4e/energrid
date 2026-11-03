<script setup lang="ts">
const props = withDefaults(defineProps<{
  variant?: 'home' | 'portal'; recording: boolean; status: string; pending: boolean;
}>(), { variant: 'portal' });
const emit = defineEmits<{ (event: 'start', pointer: PointerEvent): void; (event: 'stop', pointer: PointerEvent): void }>();
</script>
<template>
  <button v-if="props.variant === 'home'" class="home-assistant-talk" :class="{ listening: recording }"
    :disabled="pending" type="button"
    @pointerdown="!pending && emit('start', $event)" @pointerup="emit('stop', $event)"
    @pointercancel="emit('stop', $event)" @lostpointercapture="emit('stop', $event)">
    <span class="home-assistant-mic" aria-hidden="true">{{ recording ? '■' : '●' }}</span>
    <strong>{{ recording ? 'Отпусни, за да изпратиш' : ['connecting', 'authenticating'].includes(status) ? 'Свързване…' : 'Натисни и задръж' }}</strong>
    <small>{{ recording ? 'Говори на български' : 'Натисни бутона и говори' }}</small>
  </button>
  <button v-else class="primary talk-button" :class="{ recording }" :disabled="pending" type="button"
    @pointerdown="!pending && emit('start', $event)" @pointerup="emit('stop', $event)"
    @pointercancel="emit('stop', $event)" @lostpointercapture="emit('stop', $event)">
    <span>{{ recording ? 'Release to send' : pending ? 'Confirm or cancel first'
      : ['connecting', 'authenticating'].includes(status) ? 'Connecting' : 'Hold to talk' }}</span>
    <small>{{ recording ? 'Listening now' : 'Press and hold' }}</small>
  </button>
</template>
