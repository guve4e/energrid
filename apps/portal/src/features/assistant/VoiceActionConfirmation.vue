<script setup lang="ts">
import type { PendingVoiceAction } from './voice-types';
import { voiceActionLabel } from './voice-format';
withDefaults(defineProps<{ variant?: 'home' | 'portal'; pending: PendingVoiceAction }>(), { variant: 'portal' });
const emit = defineEmits<{ (event: 'confirm'): void; (event: 'cancel'): void }>();
</script>
<template>
  <section v-if="variant === 'home'" class="home-assistant-approval" aria-live="assertive">
    <div>
      <strong>Потвърди действието</strong>
      <ul><li v-for="(action, index) in pending.actions" :key="`${action.type}:${action.deviceId}:${index}`">{{ voiceActionLabel(action) }}</li></ul>
      <small>Нищо няма да се промени, докато не потвърдиш.</small>
    </div>
    <button class="home-assistant-back" type="button" @click="emit('cancel')">Отказ</button>
    <button class="home-assistant-confirm" type="button" :disabled="pending.expiresAt <= Date.now()" @click="emit('confirm')">Потвърди</button>
  </section>
  <section v-else class="voice-action-approval" aria-live="assertive">
    <div>
      <p class="eyebrow">Confirmation required</p><h3>Review before anything changes</h3>
      <ul><li v-for="(action, index) in pending.actions" :key="`${action.type}:${action.deviceId}:${index}`">{{ voiceActionLabel(action) }}</li></ul>
      <p class="approval-expiry">Expires {{ new Date(pending.expiresAt).toLocaleTimeString() }}. No change happens unless you confirm.</p>
    </div>
    <div class="approval-actions">
      <button class="secondary" type="button" @click="emit('cancel')">Cancel</button>
      <button class="primary" type="button" :disabled="pending.expiresAt <= Date.now()" @click="emit('confirm')">Confirm action</button>
    </div>
  </section>
</template>
