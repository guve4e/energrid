<script setup lang="ts">
import type { VoiceRunRecord } from './voice-types';
import { formatRunMetric, formatRunTimestamp, summarizeRunExecution, formatVoiceRunJson } from './voice-format';
defineProps<{ runs: VoiceRunRecord[]; loading: boolean; error: string }>();
const emit = defineEmits<{ (event: 'refresh'): void }>();
</script>
<template>
          <div class="voice-runs">
            <div class="section-row">
              <h2>Recent voice runs</h2>
              <button
                class="secondary compact-button"
                type="button"
                @click="emit('refresh')"
              >
                {{ loading ? 'Loading' : 'Refresh' }}
              </button>
            </div>
            <p v-if="error" class="inline-error">
              {{ error }}
            </p>
            <div v-if="runs.length === 0" class="run-empty">
              No saved turns yet. Complete one voice command and it will appear
              here.
            </div>
            <details
              v-for="run in runs"
              :key="run.id"
              class="voice-run-card"
            >
              <summary>
                <span>
                  <strong>{{ formatRunTimestamp(run.completedAt) }}</strong>
                  <em>{{ run.intent || 'unknown' }}</em>
                </span>
                <span>{{ summarizeRunExecution(run) }}</span>
              </summary>
              <div class="run-body">
                <div>
                  <span>Transcript</span>
                  <p>{{ run.transcript || 'No transcript' }}</p>
                </div>
                <div>
                  <span>Assistant</span>
                  <p>{{ run.assistantReply || 'No assistant reply' }}</p>
                </div>
                <dl class="metric-grid mini">
                  <div>
                    <dt>Total</dt>
                    <dd>{{ formatRunMetric(run, 'totalMs') }}</dd>
                  </div>
                  <div>
                    <dt>STT</dt>
                    <dd>{{ formatRunMetric(run, 'sttMs') }}</dd>
                  </div>
                  <div>
                    <dt>Audio</dt>
                    <dd>{{ formatRunMetric(run, 'firstAudioMs') }}</dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>{{ run.runtime?.sttProvider || '--' }}</dd>
                  </div>
                </dl>
                <details class="payload-details compact">
                  <summary>Full run JSON</summary>
                  <pre>{{ formatVoiceRunJson(run) }}</pre>
                </details>
              </div>
            </details>
          </div>
</template>
