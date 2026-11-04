import { computed, ref, type Ref } from 'vue';
import type { PortalState } from '../../portal-state';
type OperationalLogEntry = NonNullable<PortalState['logs']>[number];

/** Read-only projection of server operations and ephemeral browser diagnostics. */
export function useOperationalLogs(serverLogs: Ref<OperationalLogEntry[]>, clientMessages: Ref<string[]>) {
  const logLevelFilter = ref('all');
  const logSourceFilter = ref('all');
  const logSearch = ref('');
  const clientLogEntries = computed<OperationalLogEntry[]>(() => clientMessages.value.slice(-80).reverse().map((line, index) => ({
    id: `client:${index}:${line}`, observedAt: new Date().toISOString(),
    level: line.includes('failed') || line.includes('error') ? 'warn' : 'debug',
    source: 'portal', event: 'client.log', message: line,
  })));
  const allLogEntries = computed(() => [...serverLogs.value, ...clientLogEntries.value]
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)));
  const visibleLogEntries = computed(() => {
    const search = logSearch.value.trim().toLowerCase();
    return allLogEntries.value.filter(entry => {
      if (logLevelFilter.value !== 'all' && entry.level !== logLevelFilter.value) return false;
      if (logSourceFilter.value !== 'all' && entry.source !== logSourceFilter.value) return false;
      return !search || `${entry.level} ${entry.source} ${entry.event} ${entry.message} ${entry.deviceId || ''} ${entry.topic || ''}`.toLowerCase().includes(search);
    });
  });
  const logSummary = computed(() => {
    const entries = allLogEntries.value;
    return [
      { label: 'Events', value: `${entries.length}`, detail: 'recent buffer' },
      { label: 'Warnings', value: `${entries.filter(entry => entry.level === 'warn').length}`, detail: 'needs attention' },
      { label: 'Errors', value: `${entries.filter(entry => entry.level === 'error').length}`, detail: 'failed actions' },
      { label: 'No ack', value: `${entries.filter(entry => entry.event === 'command.no_ack').length}`, detail: 'device command misses' },
    ];
  });
  const logSources = computed(() => [...new Set(allLogEntries.value.map(entry => entry.source))].sort());
  function formatLogTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
  }
  function logMeta(entry: OperationalLogEntry) { return [entry.deviceId, entry.topic, entry.status].filter(Boolean).join(' · '); }
  function logDetails(entry: OperationalLogEntry) {
    if (!entry.details || Object.keys(entry.details).length === 0) return '';
    return Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(' · ');
  }
  return { logSearch, logLevelFilter, logSourceFilter, logSummary, logSources, visibleLogEntries,
    formatLogTime, logMeta, logDetails };
}
