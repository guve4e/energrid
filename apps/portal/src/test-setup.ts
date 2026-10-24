import { afterEach } from 'vitest'
import { clearAuthenticatedSession } from './auth/auth-client'

Object.defineProperty(window, 'fetch', {
  configurable: true,
  writable: true,
  value: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
})

afterEach(() => clearAuthenticatedSession(false))
