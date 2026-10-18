import { assertVoiceAuthorization, isValidVoiceToken } from './voice-auth'

describe('voice authorization', () => {
  const original = process.env

  beforeEach(() => {
    process.env = { ...original, NODE_ENV: 'production', PORTAL_CONTROL_TOKEN: 'secret-token' }
  })

  afterAll(() => {
    process.env = original
  })

  it('compares a supplied token with the configured portal token', () => {
    expect(isValidVoiceToken('secret-token')).toBe(true)
    expect(isValidVoiceToken('wrong-token')).toBe(false)
    expect(isValidVoiceToken(undefined)).toBe(false)
  })

  it('requires the bearer token for voice run access', () => {
    expect(() =>
      assertVoiceAuthorization({ headers: { authorization: 'Bearer secret-token' } }),
    ).not.toThrow()
    expect(() => assertVoiceAuthorization({ headers: {} })).toThrow(
      'Voice access requires portal authorization.',
    )
  })
})
