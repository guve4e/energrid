<script setup lang="ts">
import type { PortalExecutionTrace } from '../../portal-state';
const props = defineProps<{ traces: PortalExecutionTrace[] }>();
const emit = defineEmits<{ refresh: []; openTrace: [id: string] }>();
</script>
<template>
        <section
          class="panel workspace-panel"
        >
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Operations</p>
              <h2>Executions</h2>
              <span>
                Review device commands from request to telemetry, verification,
                and settlement.
              </span>
            </div>

            <button class="primary" type="button" @click="emit('refresh')">
              Refresh executions
            </button>
          </div>

          <div v-if="!traces.length" class="discovery-empty">
            <strong>No executions yet</strong>
            <span> Run a device command to generate execution history. </span>
          </div>

          <div v-else class="network-table-wrap">
            <table class="network-table execution-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Duration</th>
                  <th>Completed</th>
                </tr>
              </thead>

              <tbody>
                <tr
                  v-for="trace in traces"
                  :key="trace.id"
                  class="execution-row"
                  @click="emit('openTrace', trace.id)"
                >
                  <td>
                    <strong>{{ trace.deviceId }}</strong>
                  </td>

                  <td>
                    <strong>
                      {{ trace.actor?.name || trace.actor?.type || 'unknown' }}
                    </strong>
                  </td>

                  <td>
                    {{ trace.action }}
                  </td>

                  <td>
                    <span :class="['trust-pill', `execution-${trace.outcome}`]">
                      {{ trace.outcome }}
                    </span>
                  </td>

                  <td>{{ trace.durationMs || 0 }}ms</td>

                  <td>
                    {{ trace.completedAt || trace.requestedAt }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

</template>
