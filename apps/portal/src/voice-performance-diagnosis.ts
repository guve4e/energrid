export type VoicePerformanceMetrics = {
  sttMs?: number | null
  firstAudioMs?: number | null
  ttsTotalMs?: number | null
  speechGatePassed?: boolean | null
}

const SLOW_STAGE_MS = 5_000

export function diagnoseVoicePerformance(
  metrics: VoicePerformanceMetrics | null | undefined,
  transcript: string,
  setupError?: string | null,
): string {
  if (setupError) return setupError
  if (!metrics) return 'No completed turn yet.'

  if (metrics.speechGatePassed && !transcript.trim() && !metrics.sttMs) {
    return 'Audio reached the server and passed the speech gate, but STT did not return a transcript before turn end.'
  }
  if (!metrics.speechGatePassed) return 'The speech gate blocked this turn before STT.'

  const slowStages: string[] = []
  if (isSlow(metrics.sttMs)) slowStages.push(`STT ${formatSeconds(metrics.sttMs)}`)

  const ttsDuration = metrics.ttsTotalMs ?? metrics.firstAudioMs
  if (isSlow(ttsDuration)) slowStages.push(`spoken reply ${formatSeconds(ttsDuration)}`)

  if (slowStages.length > 1) {
    return `Both speech recognition and spoken reply were slow (${slowStages.join(', ')}).`
  }
  if (slowStages.length === 1) return `${capitalize(slowStages[0])} was slow.`
  return 'No obvious bottleneck detected.'
}

function isSlow(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > SLOW_STAGE_MS
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
