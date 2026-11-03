<script setup lang="ts">
import type { VoiceWorkspace } from './useVoiceWorkspace';
import VoiceTalkButton from './VoiceTalkButton.vue';
import VoiceConversation from './VoiceConversation.vue';
import VoiceActionConfirmation from './VoiceActionConfirmation.vue';
const props = defineProps<{ voice: VoiceWorkspace }>();
const emit = defineEmits<{ (event: 'close'): void }>();
const { recording, voiceStatus, voiceSetupError, pendingVoiceAction, voiceActionOutcome,
  transcript, assistant, startRecording, stopRecording, confirmVoiceAction, cancelVoiceAction } = props.voice;
</script>
<template>
    <section class="home-assistant-screen">
      <header class="home-assistant-header">
        <div>
          <span class="home-assistant-eyebrow">ENERGRID HOME</span>
          <h1>Ask Energrid</h1>
          <p>Задай въпрос за дома си или поискай безопасно действие.</p>
        </div>
        <button type="button" class="home-assistant-back" @click="emit('close')">Към дома</button>
      </header>
      <div class="home-assistant-status" :data-state="recording ? 'listening' : voiceStatus">
        <span class="home-assistant-pulse"></span>
        {{ recording ? 'Слушам…' : voiceStatus === 'idle' ? 'Готов за разговор' : voiceStatus }}
      </div>
      <p v-if="voiceSetupError" class="home-assistant-error" role="alert">{{ voiceSetupError }}</p>
      <VoiceTalkButton variant="home" :recording="recording" :status="voiceStatus" :pending="Boolean(pendingVoiceAction)"
        @start="startRecording" @stop="stopRecording" />
      <VoiceActionConfirmation v-if="pendingVoiceAction" variant="home" :pending="pendingVoiceAction"
        @confirm="confirmVoiceAction" @cancel="cancelVoiceAction" />
      <p v-if="voiceActionOutcome" class="home-assistant-error" role="status">{{ voiceActionOutcome }}</p>
      <VoiceConversation variant="home" :transcript="transcript" :assistant="assistant" />
    </section>
</template>
