import { ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { useOperationalLogs } from './useOperationalLogs';

const logs = [{ id: 'a', observedAt: '2026-11-03T19:00:00Z', level: 'error' as const,
  source: 'device-control' as const, event: 'command.no_ack', message: 'no ack', deviceId: 'relay-1' }];

describe('useOperationalLogs', () => {
  it('merges server and local diagnostics without changing either source', () => {
    const server = ref([...logs]);
    const messages = ref(['22:00 failed connection']);
    const model = useOperationalLogs(server, messages);
    expect(model.visibleLogEntries.value).toHaveLength(2);
    expect(model.logSummary.value.find(item => item.label === 'No ack')?.value).toBe('1');
    expect(server.value).toHaveLength(1);
    model.logLevelFilter.value = 'error';
    expect(model.visibleLogEntries.value.map(e => e.id)).toEqual(['a']);
  });
  it('searches site diagnostics and handles invalid timestamps', () => {
    const model = useOperationalLogs(ref([...logs]), ref<string[]>([]));
    model.logSearch.value = 'relay-1';
    expect(model.visibleLogEntries.value).toHaveLength(1);
    model.logSourceFilter.value = 'voice';
    expect(model.visibleLogEntries.value).toHaveLength(0);
    expect(model.formatLogTime('invalid date')).toBe('invalid date');
  });
});
