import { formatBytes } from '../../shared/format-bytes';
import type { PendingVoiceAction, VoiceRunRecord, VoiceMetrics } from './voice-types';

export function voiceActionLabel(action: PendingVoiceAction['actions'][number]) {
  const names: Record<string, string> = {
    'light.turn_on': 'Turn on light',
    'light.turn_off': 'Turn off light',
    'thermostat.set_target': 'Set thermostat target',
    'mode.set': 'Change home mode',
    'alarm.disarm': 'Disarm alarm',
  };
  const target = action.deviceId || action.room;
  const value = action.value == null ? '' : ` to ${action.value}`;
  return `${names[action.type] || action.type}${target ? `: ${target}` : ''}${value}`;
}

export function confirmationOutcome(status: string, results: Array<{ status: string; message: string }> = []) {
  if (status === 'completed') {
    const failed = results.find((result) => result.status === 'failed');
    if (failed) return `Action failed: ${failed.message}`;
    const skipped = results.find((result) => result.status === 'skipped');
    if (skipped) return `Not completed: ${skipped.message}`;
    if (results.some((result) => result.status === 'pending')) return 'Command sent; waiting for device acknowledgement.';
    if (results.length && results.every((result) => result.status === 'success')) return 'Device confirmed the action.';
    return 'The plan completed without a device action.';
  }
  const messages: Record<string, string> = {
    cancelled: 'Action cancelled.',
    expired: 'Confirmation expired. Nothing was switched.',
    unavailable: 'This confirmation is no longer available. Nothing was switched.',
    failed: 'The action could not be completed. Check device diagnostics.',
  };
  return messages[status] || 'Action status unavailable.';
}

function redactAudio(event: Record<string, any>) {
  if (event.type !== 'assistant_audio_chunk') return event;
  return {
    ...event,
    audioBase64: `<${Math.round((event.audioBase64 || '').length / 1024)}KB base64>`,
  };
}

export function formatEvent(event: Record<string, any>) {
  if (event.type === 'turn_end') {
    const m = event.metrics || {};
    return [
      '[server] turn_end',
      `total=${formatMs(m.totalMs)}`,
      `stt=${formatMs(m.sttMs)}`,
      `firstAudio=${formatMs(m.firstAudioMs)}`,
      `gate=${m.speechGatePassed ? 'passed' : 'blocked'}`,
      `rms=${formatDb(m.audioRmsDb)}`,
      `peak=${formatDb(m.audioPeakDb)}`,
      `chunks=${m.chunkCount ?? 0}`,
    ].join(' ');
  }
  if (event.type === 'assistant_audio_chunk') {
    return `[server] audio chunk index=${event.chunkIndex ?? '?'} bytes=${formatBytes(Math.round((event.audioBase64 || '').length * 0.75))}`;
  }
  if (event.type === 'home_action_plan') {
    return `[server] plan intent=${event.plan?.intent || '?'} actions=${event.plan?.actions?.length ?? 0} confirmation=${event.plan?.requiresConfirmation ? 'yes' : 'no'}`;
  }
  if (event.type === 'home_action_execution') {
    const results = Array.isArray(event.results) ? event.results : [];
    return `[server] execution ${results.map((result) => `${result.action?.deviceId || result.action?.type}:${result.status}:${result.adapter}`).join(', ')}`;
  }
  if (event.type === 'assistant_text_delta')
    return `[server] text delta "${event.delta || ''}" full=${(event.full || '').length} chars`;
  if (event.type === 'stt_final')
    return `[server] stt_final "${event.full || event.text || ''}"`;
  if (event.type === 'session_start')
    return `[server] session_start ${event.sessionId}`;
  return JSON.stringify(redactAudio(event));
}

export function formatMs(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value)}ms`
    : '--';
}

export function formatDb(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} dB`
    : '--';
}

export function amplitudeToDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : null;
}

export function formatRunMetric(run: VoiceRunRecord, key: keyof VoiceMetrics) {
  return formatMs(run.metrics?.[key] as number | null | undefined);
}

export function formatRunTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function summarizeRunExecution(run: VoiceRunRecord) {
  if (run.errors?.length) return run.errors[0];
  const firstResult = run.executionResults?.[0];
  if (firstResult)
    return `${firstResult.status || 'unknown'} via ${firstResult.adapter || 'adapter'}`;
  if (run.plan?.requiresConfirmation) return 'waiting for confirmation';
  return run.intent || 'no intent';
}

export function formatVoiceRunJson(run: VoiceRunRecord) {
  return JSON.stringify(run, null, 2);
}

export function delta(start: number, end: number) {
  return start && end ? `${Math.round(end - start)}ms` : '--';
}
