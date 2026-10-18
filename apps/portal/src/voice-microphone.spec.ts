import { describe, expect, it, vi } from 'vitest'
import {
  microphoneRequestError,
  microphoneSetupError,
  stopMicrophoneStream,
} from './voice-microphone'

describe('microphone diagnostics', () => {
  it('explains that non-secure pages cannot access the microphone', () => {
    expect(microphoneSetupError(false, false)).toContain('secure page')
  })

  it('explains when browser microphone capture is unsupported', () => {
    expect(microphoneSetupError(true, false)).toContain('does not provide microphone capture')
  })

  it('returns no setup warning when microphone capture is available', () => {
    expect(microphoneSetupError(true, true)).toBeNull()
  })

  it('maps permission and unavailable-device errors to actionable messages', () => {
    expect(microphoneRequestError(new DOMException('', 'NotAllowedError'))).toContain('permission was denied')
    expect(microphoneRequestError(new DOMException('', 'NotFoundError'))).toContain('No microphone was found')
  })

  it('stops tracks when a stream exists and tolerates an already-cleared stream', () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream

    expect(() => stopMicrophoneStream(null)).not.toThrow()
    stopMicrophoneStream(stream)
    expect(stop).toHaveBeenCalledOnce()
  })
})
