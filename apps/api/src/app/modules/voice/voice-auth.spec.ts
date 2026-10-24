import { authenticateVoiceToken } from './voice-auth'

describe('voice websocket authentication', () => {
  it('accepts only an active administrator access-token principal', async () => {
    const auth = { authenticateAccessToken: jest.fn().mockResolvedValue({ userId: 'u', email: 'a@b.test', name: 'A', role: 'admin', sessionId: 's', sessionVersion: 1 }) }
    await expect(authenticateVoiceToken(auth as never, 'signed-access-jwt')).resolves.toMatchObject({ userId: 'u', role: 'admin' })
    auth.authenticateAccessToken.mockRejectedValueOnce(new Error('expired'))
    await expect(authenticateVoiceToken(auth as never, 'expired')).resolves.toBeNull()
    auth.authenticateAccessToken.mockResolvedValueOnce({ role: 'viewer' })
    await expect(authenticateVoiceToken(auth as never, 'viewer-token')).resolves.toBeNull()
  })
})
