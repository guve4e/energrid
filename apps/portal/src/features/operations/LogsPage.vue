<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PortalState } from '../../portal-state';
import InteractionTraces from '../../components/observability/InteractionTraces.vue';
import { useOperationalLogs } from './useOperationalLogs';
const props = defineProps<{
  logs: NonNullable<PortalState['logs']>;
  clientMessages: string[];
  apiBase: string;
  accessToken: string;
}>();
const emit = defineEmits<{ refresh: [] }>();
const logView = ref<'events'|'interactions'>('events');
const { logSearch, logLevelFilter, logSourceFilter, logSummary, logSources,
  visibleLogEntries, formatLogTime, logMeta, logDetails } = useOperationalLogs(
    computed(() => props.logs), computed(() => props.clientMessages),
  );
</script>
<template>
        <section
          class="panel workspace-panel"
        >
          <div class="page-heading split-heading">
            <div>
              <p class="eyebrow">Operations</p>
              <h2>Logs</h2>
              <span
                >Follow device commands, MQTT adapter decisions,
                acknowledgements, and portal-side diagnostics in one
                timeline.</span
              >
            </div>
            <button class="primary" type="button" @click="emit('refresh')">
              Refresh logs
            </button>
          </div>

          <div
            style="display: flex; gap: 8px; margin: 18px 0; flex-wrap: wrap"
            role="group"
            aria-label="Log views"
          >
            <button
              type="button"
              :class="logView === 'events' ? 'primary' : ''"
              :aria-pressed="logView === 'events'"
              @click="logView = 'events'"
            >
              Events
            </button>
            <button
              type="button"
              :class="logView === 'interactions' ? 'primary' : ''"
              :aria-pressed="logView === 'interactions'"
              @click="logView = 'interactions'"
            >
              Interactions
            </button>
          </div>

          <template v-if="logView === 'events'">
          <div class="network-stat-grid compact-stats log-summary">
            <div v-for="item in logSummary" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <small>{{ item.detail }}</small>
            </div>
          </div>

          <div class="device-inventory-toolbar log-toolbar">
            <label class="inventory-search">
              <span class="search-icon">⌕</span>
              <input
                v-model="logSearch"
                placeholder="Search logs, topics, devices"
              />
            </label>
            <select v-model="logLevelFilter">
              <option value="all">All levels</option>
              <option value="error">Errors</option>
              <option value="warn">Warnings</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
            <select v-model="logSourceFilter">
              <option value="all">All sources</option>
              <option
                v-for="source in logSources"
                :key="source"
                :value="source"
              >
                {{ source }}
              </option>
            </select>
            <span>{{ visibleLogEntries.length }} shown</span>
          </div>

          <div v-if="visibleLogEntries.length === 0" class="discovery-empty">
            <strong>No logs match this view</strong>
            <span
              >Run a device command, refresh the bus, or clear the
              filters.</span
            >
          </div>
          <div v-else class="network-table-wrap">
            <table class="network-table log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Event</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in visibleLogEntries" :key="entry.id">
                  <td data-label="Time">
                    <strong>{{ formatLogTime(entry.observedAt) }}</strong>
                    <span>{{ entry.observedAt }}</span>
                  </td>
                  <td data-label="Level">
                    <span :class="['trust-pill', `log-${entry.level}`]">
                      {{ entry.level }}
                    </span>
                  </td>
                  <td data-label="Source">
                    <strong>{{ entry.source }}</strong>
                    <span>{{ logMeta(entry) || 'site runtime' }}</span>
                  </td>
                  <td data-label="Event">
                    <strong>{{ entry.event }}</strong>
                    <span>{{ entry.status || 'recorded' }}</span>
                  </td>
                  <td data-label="Message">
                    <strong>{{ entry.message }}</strong>
                    <span v-if="logDetails(entry)">{{
                      logDetails(entry)
                    }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          </template>

          <InteractionTraces
            v-else
            :api-base="apiBase"
            :access-token="accessToken"
          />
        </section>

</template>
