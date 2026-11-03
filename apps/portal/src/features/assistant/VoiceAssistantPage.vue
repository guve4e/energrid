<script setup lang="ts">
import type { VoiceWorkspace } from './useVoiceWorkspace';
import InteractionTraces from '../../components/observability/InteractionTraces.vue';
import VoiceTalkButton from './VoiceTalkButton.vue';
import VoiceConversation from './VoiceConversation.vue';
import VoiceActionConfirmation from './VoiceActionConfirmation.vue';
import VoiceDiagnostics from './VoiceDiagnostics.vue';
import VoiceRunHistory from './VoiceRunHistory.vue';
const props = defineProps<{
  voice: VoiceWorkspace; serverLabel: string; sttProvider: string;
  apiBase: string; accessToken: string;
}>();
const { recording, voiceStatus, pendingVoiceAction, voiceActionOutcome, transcript, assistant,
  voiceLinkStatus, voiceSetupError, endpointMode, canUseLanDirect, lanPortalUrl,
  effectiveRouteLabel, assistantTraceRefresh, assistantLatestTraceId,
  startRecording, stopRecording, confirmVoiceAction, cancelVoiceAction, setEndpointMode,
  compactMetrics, clientDiagnostics, bottleneckMessage, displayVoiceLogs,
  voiceRuns, voiceRunsLoading, voiceRunsError, loadVoiceRuns } = props.voice;
</script>
<template>
        <section

          class="panel assistant-panel premium-panel"
        >
          <div class="assistant-heading">
            <div>
              <p class="eyebrow">Energrid Assistant</p>
              <h2>Ask once. Let the site respond safely.</h2>
              <span
                >Hold the button, speak naturally, release to send the
                turn.</span
              >
            </div>
            <div class="voice-orb" :class="{ listening: recording }">
              <span>{{ recording ? 'REC' : 'AI' }}</span>
            </div>
          </div>

          <div class="assistant-status-row">
            <span
              ><span :class="['dot', voiceLinkStatus.tone]"></span
              >{{ voiceLinkStatus.label }}</span
            >
            <span>API {{ serverLabel }}</span>
            <span>Route {{ effectiveRouteLabel }}</span>
            <span>STT {{ sttProvider }}</span>
            <span>{{ voiceStatus }}</span>
          </div>

          <section
            class="assistant-chat-workspace"
            style="margin: 22px 0 26px"
          >
            <div style="margin-bottom: 12px">
              <h3>Talk to Energrid</h3>
              <p>
                Open Ask Energrid in the lower-right corner to type, or hold
                the button below to speak. Interaction timing updates after
                each response.
              </p>
            </div>

            <InteractionTraces
              v-if="accessToken"
              :api-base="apiBase"
              :access-token="accessToken"
              :refresh-key="assistantTraceRefresh"
              :focus-trace-id="assistantLatestTraceId"
            />
          </section>

          <div class="route-controls">
            <div>
              <span>Network route</span>
              <strong>{{
                endpointMode === 'lan' ? 'LAN direct' : 'Public domain'
              }}</strong>
            </div>
            <div class="segmented">
              <button
                :class="{ active: endpointMode === 'same-origin' }"
                type="button"
                @click="setEndpointMode('same-origin')"
              >
                Domain
              </button>
              <button
                :class="{ active: endpointMode === 'lan' }"
                type="button"
                @click="setEndpointMode('lan')"
              >
                LAN
              </button>
            </div>
            <a
              v-if="endpointMode === 'lan' && !canUseLanDirect"
              :href="lanPortalUrl"
              >Open LAN portal</a
            >
          </div>
          <p v-if="voiceSetupError" class="route-note" role="alert">
            {{ voiceSetupError }}
          </p>
          <p
            v-if="endpointMode === 'lan' && !canUseLanDirect"
            class="route-note"
          >
            This HTTPS page cannot use ws://192.168.1.60 directly. Open the LAN
            portal, or later use split DNS/local HTTPS for the fast path.
          </p>

          <div class="talk-stage">
            <VoiceTalkButton :recording="recording" :status="voiceStatus" :pending="Boolean(pendingVoiceAction)"
              @start="startRecording" @stop="stopRecording" />
          </div>

          <VoiceConversation :transcript="transcript" :assistant="assistant" />

          <VoiceActionConfirmation v-if="pendingVoiceAction" :pending="pendingVoiceAction"
            @confirm="confirmVoiceAction" @cancel="cancelVoiceAction" />
          <p v-if="voiceActionOutcome" class="voice-action-outcome" role="status">{{ voiceActionOutcome }}</p>

          <VoiceDiagnostics :bottleneck="bottleneckMessage" :server-metrics="compactMetrics"
            :client-metrics="clientDiagnostics" />

          <div class="voice-log">
            <div class="section-row">
              <h2>Live log</h2>
              <span>{{ displayVoiceLogs.length }} entries</span>
            </div>
            <pre>{{
              displayVoiceLogs.join('\n') || 'Hold the button to start a voice turn.'
            }}</pre>
          </div>

          <VoiceRunHistory :runs="voiceRuns" :loading="voiceRunsLoading" :error="voiceRunsError"
            @refresh="loadVoiceRuns" />
        </section>


</template>
