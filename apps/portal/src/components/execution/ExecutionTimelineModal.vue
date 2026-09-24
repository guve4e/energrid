<template>
  <template v-if="trace">
    <div class="trace-modal-backdrop" @click="emit('close')"></div>

    <aside class="trace-modal execution-diagnostic-modal">
      <div class="device-sheet-head">
        <div>
          <span class="eyebrow">Execution investigation</span>

          <h3>
            {{ trace.action }}
            ·
            {{ trace.outcome }}
          </h3>

          <p class="execution-subtitle">
            {{ trace.deviceId }}
          </p>
        </div>

        <button class="icon-button" type="button" @click="emit('close')">
          ×
        </button>
      </div>

      <div class="execution-summary">
        <div>
          <small>ACTOR</small>
          <strong>
            {{ trace.actor?.name || trace.actor?.type || 'Unknown' }}
          </strong>
        </div>

        <div>
          <small>DEVICE</small>
          <strong>{{ trace.deviceId }}</strong>
        </div>

        <div>
          <small>DURATION</small>
          <strong>
            {{ trace.durationMs != null ? `${trace.durationMs}ms` : 'running' }}
          </strong>
        </div>

        <div>
          <small>OUTCOME</small>
          <strong>{{ trace.outcome }}</strong>
        </div>
      </div>

      <section
        v-if="trace.diagnosis"
        class="diagnosis-card"
        :class="`diagnosis-${trace.diagnosis.category}`"
      >
        <div class="diagnosis-head">
          <div>
            <span class="eyebrow">Diagnosis</span>
            <h3>{{ trace.diagnosis.summary }}</h3>
          </div>

          <div class="diagnosis-confidence">
            <small>CONFIDENCE</small>
            <strong>
              {{ Math.round(trace.diagnosis.confidence * 100) }}%
            </strong>
          </div>
        </div>

        <div class="diagnosis-meta">
          <div>
            <small>FAILURE CATEGORY</small>
            <strong>{{ trace.diagnosis.category }}</strong>
          </div>

          <div>
            <small>FAILED / CURRENT STAGE</small>
            <strong>{{ trace.diagnosis.stage }}</strong>
          </div>
        </div>
      </section>

      <section
        v-if="trace.diagnosis?.evidence?.length"
        class="investigation-section"
      >
        <div class="section-heading">
          <span class="eyebrow">Evidence</span>
          <h3>What Energrid observed</h3>
        </div>

        <div class="evidence-list">
          <div
            v-for="evidence in trace.diagnosis.evidence"
            :key="`${evidence.label}-${evidence.value}`"
            class="evidence-row"
            :class="`evidence-${evidence.status}`"
          >
            <span class="evidence-icon">
              {{
                evidence.status === 'success'
                  ? '✓'
                  : evidence.status === 'error'
                    ? '!'
                    : '?'
              }}
            </span>

            <div>
              <strong>{{ evidence.label }}</strong>
              <small>{{ evidence.value }}</small>
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="trace.diagnosis?.suspects?.length"
        class="investigation-section"
      >
        <div class="section-heading">
          <span class="eyebrow">Suspects</span>
          <h3>Likely causes</h3>
        </div>

        <div class="suspect-list">
          <article
            v-for="suspect in trace.diagnosis.suspects"
            :key="suspect.title"
            class="suspect-card"
          >
            <div class="suspect-head">
              <strong>{{ suspect.title }}</strong>
              <span>{{ Math.round(suspect.confidence * 100) }}%</span>
            </div>

            <p>{{ suspect.explanation }}</p>

            <div class="confidence-track">
              <div
                class="confidence-fill"
                :style="{ width: `${Math.round(suspect.confidence * 100)}%` }"
              ></div>
            </div>
          </article>
        </div>
      </section>

      <section
        v-if="trace.diagnosis?.recommendations?.length"
        class="investigation-section"
      >
        <div class="section-heading">
          <span class="eyebrow">Recommended actions</span>
          <h3>Next investigation steps</h3>
        </div>

        <div class="recommendation-actions">
          <button
            v-for="recommendation in trace.diagnosis.recommendations"
            :key="recommendation.id"
            type="button"
            class="secondary recommendation-button"
            @click="emit('recommendation', recommendation.id)"
          >
            {{ recommendation.label }}
          </button>
        </div>
      </section>

      <section class="investigation-section">
        <div class="section-heading">
          <span class="eyebrow">Execution path</span>
          <h3>Command lifecycle</h3>
        </div>

        <ExecutionSimulator :key="trace.id" :trace="trace" />
      </section>
    </aside>
  </template>
</template>

<script setup lang="ts">
interface ExecutionEvidence {
  label: string;
  value: string;
  status: 'success' | 'warning' | 'error';
}

interface ExecutionSuspect {
  title: string;
  confidence: number;
  explanation: string;
}

interface ExecutionRecommendation {
  id: string;
  label: string;
}

interface ExecutionDiagnosis {
  category:
    | 'success'
    | 'ack_missing'
    | 'mapping_mismatch'
    | 'verification_failed'
    | 'transport_failure'
    | 'device_offline'
    | 'unknown';
  stage:
    | 'command'
    | 'transport'
    | 'telemetry'
    | 'matching'
    | 'verification'
    | 'settling';
  confidence: number;
  summary: string;
  evidence: ExecutionEvidence[];
  suspects: ExecutionSuspect[];
  recommendations: ExecutionRecommendation[];
}

interface ExecutionTrace {
  id: string;
  action: string;
  outcome: string;
  deviceId: string;
  durationMs: number | null;
  actor?: {
    type: string;
    name?: string;
  };
  diagnosis?: ExecutionDiagnosis;
  stages: Array<{
    stage: string;
    status: string;
    message: string;
    observedAt: string;
  }>;
}

defineProps<{
  trace: ExecutionTrace | null;
}>();

const emit = defineEmits<{
  close: [];
  recommendation: [id: string];
}>();
</script>

<style scoped>
.execution-diagnostic-modal {
  overflow-y: auto;
}

.execution-subtitle {
  margin: 6px 0 0;
  color: #64748b;
  font-size: 13px;
}

.diagnosis-card,
.investigation-section {
  margin-top: 20px;
  padding: 20px;
  border: 1px solid #dbe4f5;
  border-radius: 18px;
  background: white;
}

.diagnosis-head,
.diagnosis-meta,
.suspect-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.diagnosis-head h3,
.section-heading h3 {
  margin: 4px 0 0;
}

.diagnosis-confidence {
  min-width: 96px;
  text-align: right;
}

.diagnosis-confidence strong {
  display: block;
  margin-top: 4px;
  font-size: 24px;
}

.diagnosis-meta {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #e5e7eb;
}

.diagnosis-meta > div {
  flex: 1;
}

.diagnosis-meta small,
.execution-summary small,
.diagnosis-confidence small {
  display: block;
  color: #64748b;
}

.evidence-list,
.suspect-list {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.evidence-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
}

.evidence-row small {
  display: block;
  margin-top: 3px;
  color: #64748b;
}

.evidence-icon {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 999px;
  font-weight: 700;
  background: #f1f5f9;
}

.evidence-success .evidence-icon {
  background: #ecfdf5;
}

.evidence-warning .evidence-icon {
  background: #fffbeb;
}

.evidence-error .evidence-icon {
  background: #fef2f2;
}

.suspect-card {
  padding: 16px;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
}

.suspect-card p {
  margin: 8px 0 12px;
  color: #64748b;
  line-height: 1.5;
}

.suspect-head span {
  font-weight: 700;
}

.confidence-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: #e2e8f0;
}

.confidence-fill {
  height: 100%;
  background: currentColor;
}

.recommendation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.recommendation-button {
  cursor: pointer;
}

@media (max-width: 720px) {
  .diagnosis-head,
  .diagnosis-meta {
    flex-direction: column;
  }

  .diagnosis-confidence {
    text-align: left;
  }
}
</style>
