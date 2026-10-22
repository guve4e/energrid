<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

type TraceOutcome = 'succeeded' | 'denied' | 'failed';

interface TraceSpan {
  stage: string;
  name?: string;
  offsetMs: number;
  durationMs: number;
  outcome: 'ok' | 'error';
}

interface InteractionTrace {
  traceId: string;
  origin: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: TraceOutcome;
  spans: TraceSpan[];
}

const props = defineProps<{
  apiBase: string;
  accessToken: string;
  refreshKey?: number;
  focusTraceId?: string;
}>();

const traces = ref<InteractionTrace[]>([]);
const loading = ref(false);
const error = ref('');
const search = ref('');
const expandedId = ref<string | null>(null);

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();

  if (!term) return traces.value;

  return traces.value.filter(trace =>
    [
      trace.traceId,
      trace.origin,
      trace.outcome,
      ...trace.spans.map(span => `${span.stage} ${span.name ?? ''}`),
    ]
      .join(' ')
      .toLowerCase()
      .includes(term),
  );
});

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) return value;

  return new Date(timestamp).toLocaleString();
}

function stageLabel(span: TraceSpan): string {
  const labels: Record<string, string> = {
    'assistant.turn': 'Assistant conversation',
    'assistant.agent_setup': 'Letta agent setup',
    'assistant.tool': 'Assistant tool',
    'core.command': 'Core command',
    'core.resolve': 'Device resolution',
    'core.authorize': 'Authorization',
    'device.execute': 'Physical device execution',
    'speech.stt': 'Speech recognition',
    'speech.tts': 'Speech synthesis',
  };

  const base = labels[span.stage] ?? span.stage;
  return span.name ? `${base} · ${span.name}` : base;
}

function barStyle(span: TraceSpan, trace: InteractionTrace) {
  const total = Math.max(1, trace.durationMs);
  const left = Math.min(
    100,
    Math.max(0, (span.offsetMs / total) * 100),
  );
  const width = Math.min(
    100 - left,
    Math.max(0.6, (span.durationMs / total) * 100),
  );

  return {
    left: `${left}%`,
    width: `${width}%`,
  };
}

function toggle(traceId: string) {
  expandedId.value =
    expandedId.value === traceId ? null : traceId;
}

async function loadTraces() {
  if (loading.value) return;

  loading.value = true;
  error.value = '';

  try {
    const base = props.apiBase.replace(/\/$/, '');

    const response = await fetch(
      `${base}/portal/assistant/traces`,
      {
        headers: {
          Authorization: `Bearer ${props.accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Could not load interaction traces (HTTP ${response.status})`,
      );
    }

    const data: unknown = await response.json();

    if (
      !data ||
      typeof data !== 'object' ||
      !('traces' in data) ||
      !Array.isArray(data.traces)
    ) {
      throw new Error('Unexpected interaction trace response');
    }

    traces.value = (data.traces as InteractionTrace[]).sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    );
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : 'Could not load interaction traces';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadTraces();
});

watch(
  () => props.refreshKey,
  () => {
    void loadTraces();
  },
);

watch(
  () => props.focusTraceId,
  traceId => {
    if (!traceId) return;

    expandedId.value = traceId;
    search.value = traceId;
  },
  { immediate: true },
);
</script>

<template>
  <section class="interaction-traces">
    <div class="interaction-toolbar">
      <div>
        <h3>Interaction Traces</h3>
        <p>Assistant activity, Core decisions and execution latency.</p>
      </div>

      <button
        type="button"
        class="primary"
        :disabled="loading"
        @click="loadTraces"
      >
        {{ loading ? 'Loading…' : 'Refresh interactions' }}
      </button>
    </div>

    <div class="interaction-toolbar">
      <input
        v-model="search"
        class="interaction-search"
        type="search"
        placeholder="Search trace IDs, stages or tools"
        aria-label="Search interactions"
      />
      <span>{{ filtered.length }} interactions</span>
    </div>

    <p v-if="error" class="interaction-error" role="alert">
      {{ error }}
    </p>

    <div
      v-else-if="!loading && filtered.length === 0"
      class="interaction-empty"
    >
      <strong>No interactions found</strong>
      <p>Send an Energrid Chat command, then refresh this view.</p>
    </div>

    <div
      v-for="trace in filtered"
      :key="trace.traceId"
      class="interaction-card"
    >
      <button
        type="button"
        class="interaction-heading"
        :aria-expanded="expandedId === trace.traceId"
        @click="toggle(trace.traceId)"
      >
        <div class="interaction-identity">
          <strong>{{ trace.origin === 'chat' ? 'Chat interaction' : trace.origin }}</strong>
          <small>{{ formatDate(trace.startedAt) }}</small>
          <small class="interaction-trace-id">
            {{ trace.traceId }}
          </small>
        </div>

        <div class="interaction-status">
          <span :class="['interaction-outcome', trace.outcome]">
            {{ trace.outcome }}
          </span>
          <strong>{{ formatDuration(trace.durationMs) }}</strong>
          <span aria-hidden="true">
            {{ expandedId === trace.traceId ? '▴' : '▾' }}
          </span>
        </div>
      </button>

      <div
        v-if="expandedId === trace.traceId"
        class="interaction-detail"
      >
        <p class="interaction-note">
          Bars show positions in the total interaction.
          Nested stages overlap; their durations must not be added together.
        </p>

        <div
          v-for="(span, index) in [...trace.spans].sort(
            (a, b) => a.offsetMs - b.offsetMs
          )"
          :key="`${trace.traceId}-${index}`"
          class="interaction-stage"
        >
          <div class="interaction-stage-name">
            <strong>{{ stageLabel(span) }}</strong>
            <small>{{ span.outcome }}</small>
          </div>

          <div class="interaction-track">
            <div
              :class="['interaction-bar', span.outcome]"
              :style="barStyle(span, trace)"
              :title="`${stageLabel(span)}: ${formatDuration(span.durationMs)}`"
            />
          </div>

          <div class="interaction-stage-time">
            <strong>{{ formatDuration(span.durationMs) }}</strong>
            <small>+{{ formatDuration(span.offsetMs) }}</small>
          </div>
        </div>

        <p v-if="trace.spans.length === 0" class="interaction-note">
          This trace contains no timed stages.
        </p>

        <div class="interaction-footer">
          <span>Started: {{ formatDate(trace.startedAt) }}</span>
          <span>Finished: {{ formatDate(trace.finishedAt) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.interaction-traces {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}

.interaction-toolbar,
.interaction-heading,
.interaction-status,
.interaction-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.interaction-toolbar {
  flex-wrap: wrap;
}

.interaction-toolbar h3 {
  margin: 0 0 4px;
}

.interaction-toolbar p,
.interaction-note,
.interaction-empty p {
  margin: 0;
  opacity: 0.7;
  font-size: 13px;
}

.interaction-search {
  min-width: min(340px, 100%);
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--border-color, #71809655);
  border-radius: 8px;
  color: inherit;
  background: transparent;
}

.interaction-card {
  border: 1px solid var(--border-color, #71809644);
  border-radius: 12px;
  overflow: hidden;
}

.interaction-heading {
  width: 100%;
  padding: 15px;
  background: transparent;
  color: inherit;
  border: 0;
  cursor: pointer;
  text-align: left;
}

.interaction-heading:hover {
  background: rgba(120, 140, 170, 0.07);
}

.interaction-identity {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.interaction-identity small {
  opacity: 0.65;
}

.interaction-trace-id {
  font-family: monospace;
  overflow-wrap: anywhere;
}

.interaction-status {
  flex-shrink: 0;
}

.interaction-outcome {
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(130, 140, 160, 0.15);
}

.interaction-outcome.succeeded {
  color: #16a34a;
}

.interaction-outcome.denied {
  color: #d97706;
}

.interaction-outcome.failed,
.interaction-error {
  color: #dc2626;
}

.interaction-detail {
  padding: 16px;
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--border-color, #71809644);
}

.interaction-stage {
  display: grid;
  grid-template-columns: minmax(120px, 210px) minmax(80px, 1fr) 80px;
  align-items: center;
  gap: 12px;
}

.interaction-stage-name,
.interaction-stage-time {
  display: grid;
  gap: 3px;
}

.interaction-stage-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.interaction-stage-name strong,
.interaction-stage-time strong {
  font-size: 12px;
}

.interaction-stage-name small,
.interaction-stage-time small {
  opacity: 0.6;
  font-size: 11px;
}

.interaction-stage-time {
  text-align: right;
}

.interaction-track {
  position: relative;
  height: 12px;
  border-radius: 6px;
  background: rgba(130, 140, 160, 0.14);
  overflow: hidden;
}

.interaction-bar {
  position: absolute;
  height: 100%;
  border-radius: 5px;
  background: #648bc7;
}

.interaction-bar.error {
  background: #dc2626;
}

.interaction-footer {
  flex-wrap: wrap;
  font-size: 11px;
  opacity: 0.65;
  padding-top: 8px;
  border-top: 1px solid var(--border-color, #71809633);
}

.interaction-empty {
  padding: 24px;
  text-align: center;
}

@media (max-width: 650px) {
  .interaction-stage {
    grid-template-columns: minmax(90px, 120px) minmax(50px, 1fr) 60px;
    gap: 6px;
  }

  .interaction-heading {
    align-items: flex-start;
  }

  .interaction-status {
    gap: 7px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}
</style>
