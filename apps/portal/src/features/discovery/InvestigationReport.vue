<script setup lang="ts">
import type { useDiscoveryIntelligence } from './useDiscoveryIntelligence';
const props = defineProps<{ model: ReturnType<typeof useDiscoveryIntelligence> }>();
const { selectedAiReport, aiActionRunning, aiActionErrors, aiActionResults, executeInvestigationProposal, aiEvidenceLabel, aiConfidenceLabel } = props.model;
</script>
<template>
            <div
              v-if="selectedAiReport"
              class="device-ai-report"
            >
              <p>{{ selectedAiReport.report.summary }}</p>
              <p v-if="selectedAiReport.actionResult" class="section-help" role="status">
                {{ selectedAiReport.actionResult.action.replaceAll('_', ' ') }}:
                {{ selectedAiReport.actionResult.outcome }}
                · {{ selectedAiReport.actionResult.reasonCode }}
                <span v-if="selectedAiReport.actionResult.statusCode"> · HTTP {{ selectedAiReport.actionResult.statusCode }}</span>
              </p>

              <div class="device-ai-report-grid">
                <section>
                  <h4>Observed findings</h4>
                  <ul>
                    <li
                      v-for="(finding, index) in selectedAiReport.report.findings"
                      :key="index"
                    >
                      {{ finding }}
                    </li>
                  </ul>
                </section>

                <section>
                  <h4>Unknowns and evidence gaps</h4>
                  <ul>
                    <li
                      v-for="(unknown, index) in selectedAiReport.report.unknowns"
                      :key="index"
                    >
                      {{ unknown }}
                    </li>
                  </ul>
                </section>

                <section>
                  <h4>Suggested investigations</h4>
                  <ul>
                    <li
                      v-for="(step, index) in selectedAiReport.report.nextSteps"
                      :key="index"
                    >
                      {{ step }}
                    </li>
                  </ul>
                </section>
              </div>

              <!-- Evidence snapshot -->
              <section
                v-if="selectedAiReport.evidenceSnapshot"
                class="device-ai-evidence"
              >
                <div class="section-row">
                  <div>
                    <h4>Evidence snapshot</h4>
                    <p class="section-help">
                      {{ selectedAiReport.evidenceSnapshot.id }}
                      · {{ selectedAiReport.evidenceSnapshot.evidence.length }} records
                    </p>
                  </div>
                </div>

                <p
                  v-if="!selectedAiReport.evidenceSnapshot.evidence.length"
                  class="section-help"
                >
                  No structured observations available.
                </p>

                <div v-else class="device-ai-evidence-list">
                  <article
                    v-for="item in selectedAiReport.evidenceSnapshot.evidence"
                    :key="item.id"
                    class="device-ai-evidence-item"
                  >
                    <div class="device-ai-evidence-heading">
                      <strong>{{ item.attribute }}</strong>
                      <span>{{ item.source }}</span>
                    </div>

                    <div class="device-ai-evidence-value">
                      {{ String(item.value) }}
                    </div>

                    <div class="device-ai-evidence-meta">
                      <code>{{ item.id }}</code>
                      <span>{{ item.confidence }}</span>
                      <time :datetime="item.observedAt">
                        {{ new Date(item.observedAt).toLocaleString() }}
                      </time>
                    </div>
                  </article>
                </div>
              </section>

              <!-- Evidence-backed hypotheses -->
              <section
                v-if="selectedAiReport.assessment"
                class="device-ai-hypotheses"
              >
                <h4>
                  Hypotheses
                  ({{ selectedAiReport.assessment.hypotheses.length }})
                </h4>

                <p
                  v-if="!selectedAiReport.assessment.hypotheses.length"
                  class="section-help"
                >
                  No hypotheses were generated from the available evidence.
                </p>

                <div v-else class="device-ai-card-list">
                  <article
                    v-for="hypothesis in selectedAiReport.assessment.hypotheses"
                    :key="hypothesis.id"
                    class="device-ai-card"
                  >
                    <div class="device-ai-card-heading">
                      <strong>{{ hypothesis.claim }}</strong>
                      <span class="device-ai-confidence">
                        {{ aiConfidenceLabel(hypothesis.confidence) }}
                      </span>
                    </div>

                    <div class="device-ai-card-detail">
                      <strong>Supporting evidence</strong>
                      <ul v-if="hypothesis.supportingEvidenceIds.length">
                        <li
                          v-for="id in hypothesis.supportingEvidenceIds"
                          :key="id"
                        >
                          {{ aiEvidenceLabel(selectedAiReport, id) }}
                          <code>{{ id }}</code>
                        </li>
                      </ul>
                      <p v-else class="section-help">
                        No supporting evidence referenced.
                      </p>
                    </div>

                    <div
                      v-if="hypothesis.contradictingEvidenceIds.length"
                      class="device-ai-card-detail"
                    >
                      <strong>Contradicting evidence</strong>
                      <ul>
                        <li
                          v-for="id in hypothesis.contradictingEvidenceIds"
                          :key="id"
                        >
                          {{ aiEvidenceLabel(selectedAiReport, id) }}
                          <code>{{ id }}</code>
                        </li>
                      </ul>
                    </div>

                    <div
                      v-if="hypothesis.missingEvidence.length"
                      class="device-ai-card-detail"
                    >
                      <strong>Missing evidence</strong>
                      <ul>
                        <li
                          v-for="(gap, index) in hypothesis.missingEvidence"
                          :key="index"
                        >
                          {{ gap }}
                        </li>
                      </ul>
                    </div>
                  </article>
                </div>
              </section>

              <!-- Human-approval-required proposals -->
              <section
                v-if="selectedAiReport.assessment"
                class="device-ai-proposals"
              >
                <h4>
                  Investigation proposals
                  ({{ selectedAiReport.assessment.proposals.length }})
                </h4>

                <p
                  v-if="!selectedAiReport.assessment.proposals.length"
                  class="section-help"
                >
                  No additional investigations proposed.
                </p>

                <div v-else class="device-ai-card-list">
                  <article
                    v-for="proposal in selectedAiReport.assessment.proposals"
                    :key="proposal.id"
                    class="device-ai-card"
                  >
                    <div class="device-ai-card-heading">
                      <strong>
                        {{ proposal.action.replaceAll('_', ' ') }}
                      </strong>
                      <span class="device-ai-approval">
                        Requires approval
                      </span>
                    </div>

                    <p>{{ proposal.reason }}</p>

                    <div
                      v-if="proposal.requiredEvidenceIds.length"
                      class="device-ai-card-detail"
                    >
                      <strong>Evidence references</strong>
                      <ul>
                        <li
                          v-for="id in proposal.requiredEvidenceIds"
                          :key="id"
                        >
                          {{ aiEvidenceLabel(selectedAiReport, id) }}
                          <code>{{ id }}</code>
                        </li>
                      </ul>
                    </div>

                    <button
                      v-if="proposal.action === 'inspect_http_headers' && selectedAiReport.investigationId"
                      type="button"
                      class="secondary"
                      :disabled="!!aiActionRunning[proposal.id]"
                      @click="executeInvestigationProposal(proposal)"
                    >
                      {{ aiActionRunning[proposal.id] ? 'Running diagnostic...' : 'Approve and run HTTP identity check' }}
                    </button>
                    <p v-else class="section-help">
                      Proposed only · No supported executor for this action
                    </p>
                    <p v-if="aiActionErrors[proposal.id]" class="error" role="alert">
                      {{ aiActionErrors[proposal.id] }}
                    </p>
                    <p v-if="aiActionResults[proposal.id]" class="section-help" role="status">
                      Action {{ aiActionResults[proposal.id].outcome }} · {{ aiActionResults[proposal.id].reasonCode }}
                      <span v-if="aiActionResults[proposal.id].statusCode"> · HTTP {{ aiActionResults[proposal.id].statusCode }}</span>
                    </p>
                  </article>
                </div>
              </section>

              <p
                v-if="!selectedAiReport.assessment"
                class="section-help"
              >
                Structured assessment unavailable for this investigation.
              </p>

              <p class="section-help">
                {{ selectedAiReport.provider }} /
                {{ selectedAiReport.model }}
                · AI suggestions are not verified device facts.
                No device commands were executed.
              </p>
            </div>
</template>
