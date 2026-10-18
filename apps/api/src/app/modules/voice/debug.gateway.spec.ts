import { EventEmitter } from 'node:events'
import { DebugGateway } from './debug.gateway'

class TestSocket extends EventEmitter {
  close = jest.fn(() => this.emit('close'))
  send = jest.fn()
}

describe('DebugGateway', () => {
  const original = process.env

  afterEach(() => {
    process.env = original
  })

  it('keeps debug access disabled by default', () => {
    process.env = { ...original, VOICE_DEBUG_ENABLED: 'false' }
    const events = { addClient: jest.fn(), removeClient: jest.fn() }
    const socket = new TestSocket()

    new DebugGateway(events as never).handleConnection(socket as never)

    expect(socket.close).toHaveBeenCalledWith(1008, 'Voice debug is disabled')
    expect(events.addClient).not.toHaveBeenCalled()
  })

  it('only subscribes a debug client after portal-token authentication', () => {
    process.env = {
      ...original,
      NODE_ENV: 'production',
      PORTAL_CONTROL_TOKEN: 'debug-test-token',
      VOICE_DEBUG_ENABLED: 'true',
    }
    const events = { addClient: jest.fn(), removeClient: jest.fn() }
    const socket = new TestSocket()

    new DebugGateway(events as never).handleConnection(socket as never)
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'authenticate', token: 'debug-test-token' })),
      false,
    )

    expect(events.addClient).toHaveBeenCalledWith(socket)
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'debug_authenticated' }),
    )
  })
})
