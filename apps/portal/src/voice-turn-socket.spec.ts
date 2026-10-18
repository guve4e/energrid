import { describe, expect, it, vi } from 'vitest'
import { closeCompletedTurnSocket } from './voice-turn-socket'

describe('closeCompletedTurnSocket', () => {
  it('closes the active socket after one completed turn', () => {
    const socket = { readyState: 1, close: vi.fn() }

    expect(closeCompletedTurnSocket(socket, socket)).toBe(true)
    expect(socket.close).toHaveBeenCalledWith(1000, 'turn complete')
  })

  it('does not close a replaced socket or a socket that is not open', () => {
    const active = { readyState: 1, close: vi.fn() }
    const stale = { readyState: 1, close: vi.fn() }
    const connecting = { readyState: 0, close: vi.fn() }

    expect(closeCompletedTurnSocket(stale, active)).toBe(false)
    expect(closeCompletedTurnSocket(connecting, connecting)).toBe(false)
    expect(stale.close).not.toHaveBeenCalled()
    expect(connecting.close).not.toHaveBeenCalled()
  })
})
