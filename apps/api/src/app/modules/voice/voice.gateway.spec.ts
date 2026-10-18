import { EventEmitter } from 'node:events'
import { VoiceGateway } from './voice.gateway'

class TestSocket extends EventEmitter {
  close = jest.fn(() => this.emit('close'))
  send = jest.fn()
}

describe('VoiceGateway', () => {
  const original = process.env
let sessions: {
  openSession: jest.Mock
  closeSession: jest.Mock
  pushAudio: jest.Mock
  endTurn: jest.Mock
  confirmPendingAction: jest.Mock
  cancelPendingAction: jest.Mock
}
  let gateway: VoiceGateway

  beforeEach(() => {
    process.env = { ...original, NODE_ENV: 'production', PORTAL_CONTROL_TOKEN: 'voice-test-token' }
    sessions = {
      openSession: jest.fn().mockResolvedValue(undefined),
      closeSession: jest.fn().mockResolvedValue(undefined),
      pushAudio: jest.fn().mockResolvedValue(undefined),
      endTurn: jest.fn().mockResolvedValue(undefined),
      confirmPendingAction: jest.fn().mockResolvedValue(undefined),
      cancelPendingAction: jest.fn(),
    }
    gateway = new VoiceGateway(sessions as never)
  })

  afterAll(() => {
    process.env = original
  })

  it('rejects audio before authentication', async () => {
    const socket = new TestSocket()
    await gateway.handleConnection(socket as never)

    socket.emit('message', Buffer.from([1, 2]), true)

    expect(socket.close).toHaveBeenCalledWith(1008, 'Authenticate before sending audio')
    expect(sessions.openSession).not.toHaveBeenCalled()
  })

  it('opens a voice session only after the portal token is validated', async () => {
    const socket = new TestSocket()
    await gateway.handleConnection(socket as never)
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'authenticate', token: 'voice-test-token' })),
      false,
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(sessions.openSession).toHaveBeenCalledWith(socket)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'authenticated' }))
  })

  it('routes approvals through the authenticated socket without accepting a client action plan', async () => {
    const socket = new TestSocket()
    await gateway.handleConnection(socket as never)
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'authenticate', token: 'voice-test-token' })),
      false,
    )
    await new Promise((resolve) => setImmediate(resolve))

    socket.emit(
      'message',
      Buffer.from(JSON.stringify({
        type: 'confirm_action',
        approvalId: 'approval-on-server',
        actions: [{ type: 'light.turn_on', deviceId: 'untrusted-device' }],
      })),
      false,
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(sessions.confirmPendingAction).toHaveBeenCalledWith(socket, 'approval-on-server')
    expect(sessions.confirmPendingAction).not.toHaveBeenCalledWith(
      socket,
      expect.objectContaining({ actions: expect.any(Array) }),
    )
  })
})
