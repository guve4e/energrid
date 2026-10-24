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

  it('only subscribes a debug client after access-token authentication', async () => {
    process.env = {
      ...original,
      NODE_ENV: 'production',
      NODE_ENV: 'test',
      VOICE_DEBUG_ENABLED: 'true',
    }
    const events = { addClient: jest.fn(), removeClient: jest.fn() }
    const socket = new TestSocket()

    const auth = { authenticateAccessToken: jest.fn().mockResolvedValue({ userId: 'u', email: 'a@b.test', name: 'A', role: 'admin', sessionId: 's', sessionVersion: 1 }) }
    new DebugGateway(events as never, auth as never).handleConnection(socket as never)
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'authenticate', token: 'signed-access-jwt' })),
      false,
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(events.addClient).toHaveBeenCalledWith(socket)
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'debug_authenticated' }),
    )
    socket.emit('close')
  })
})
