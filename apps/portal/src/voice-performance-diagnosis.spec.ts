import { describe, expect, it } from 'vitest'
import { diagnoseVoicePerformance } from './voice-performance-diagnosis'

describe('diagnoseVoicePerformance', () => {
  it('reports STT and speech generation when both stages are slow', () => {
    expect(diagnoseVoicePerformance({
      sttMs: 7106,
      firstAudioMs: 3480,
      ttsTotalMs: 7510,
      speechGatePassed: true,
    }, 'Здрасти, можеш ли да ми пуснеш лампите?')).toBe(
      'Both speech recognition and spoken reply were slow (STT 7.1s, spoken reply 7.5s).',
    )
  })

  it('identifies a single slow stage', () => {
    expect(diagnoseVoicePerformance({ sttMs: 6100, speechGatePassed: true }, 'hello'))
      .toBe('STT 6.1s was slow.')
  })

  it('preserves setup, speech-gate, and missing-transcript diagnoses', () => {
    expect(diagnoseVoicePerformance(null, '', 'Voice service unavailable.'))
      .toBe('Voice service unavailable.')
    expect(diagnoseVoicePerformance({ speechGatePassed: false }, ''))
      .toBe('The speech gate blocked this turn before STT.')
    expect(diagnoseVoicePerformance({ speechGatePassed: true }, ''))
      .toContain('STT did not return a transcript')
  })

  it('does not call stages slow at or below the five-second threshold', () => {
    expect(diagnoseVoicePerformance({
      sttMs: 5000,
      firstAudioMs: 4500,
      ttsTotalMs: 5000,
      speechGatePassed: true,
    }, 'hello')).toBe('No obvious bottleneck detected.')
  })
})
