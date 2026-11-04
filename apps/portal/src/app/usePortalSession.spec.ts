import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePortalSession } from './usePortalSession';
import { clearAuthenticatedSession, logoutRequest, onAuthState, restoreSession, setAuthenticatedSession } from '../auth/auth-client';

vi.mock('../auth/auth-client', () => ({
  clearAuthenticatedSession: vi.fn(), getAccessToken: vi.fn(() => 'issued-token'),
  logoutRequest: vi.fn(async () => {}), onAuthState: vi.fn(() => () => {}),
  restoreSession: vi.fn(async () => null), setAuthenticatedSession: vi.fn(),
}));
const user = { id: 'u', email: 'installer@example.test', name: 'Installer', role: 'admin' as const };

describe('usePortalSession', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('submits credentials only through the explicit login action', async () => {
    const originalFetch = window.fetch;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ accessToken: 'issued-token', expiresIn: 900, user }) }));
    window.fetch = fetchMock as any;
    const onSignedIn = vi.fn(async () => {});
    const model = usePortalSession({ apiBase: '', onSignedIn, onRestored: vi.fn(), onSignedOut: vi.fn() });
    try {
      model.email.value = user.email;
      model.password.value = 'redacted-test-password';
      await model.login();
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/auth/login');
      expect(setAuthenticatedSession).toHaveBeenCalledTimes(1);
      expect(onSignedIn).toHaveBeenCalledTimes(1);
      expect(model.accessToken.value).toBe('issued-token');
    } finally { model.dispose(); window.fetch = originalFetch; }
  });
  it('restores asynchronously and disposes its auth listeners', async () => {
    vi.mocked(restoreSession).mockResolvedValueOnce(user);
    const onRestored = vi.fn();
    const model = usePortalSession({ apiBase: '', onSignedIn: vi.fn(async () => {}), onRestored, onSignedOut: vi.fn() });
    await model.restore();
    expect(model.isAuthRestoring.value).toBe(false);
    expect(model.user.value?.id).toBe('u');
    expect(onRestored).toHaveBeenCalledTimes(1);
    model.dispose();
    expect(onAuthState).toHaveBeenCalled();
  });
  it('does not retain a session after explicit logout', async () => {
    const onSignedOut = vi.fn();
    const model = usePortalSession({ apiBase: '', onSignedIn: vi.fn(async () => {}), onRestored: vi.fn(), onSignedOut });
    await model.logout();
    expect(logoutRequest).toHaveBeenCalledTimes(1);
    expect(clearAuthenticatedSession).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(model.accessToken.value).toBe('');
    model.dispose();
  });
});
