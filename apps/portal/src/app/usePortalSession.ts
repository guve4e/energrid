import { ref } from 'vue';
import { clearAuthenticatedSession, getAccessToken, logoutRequest,
  onAuthState, restoreSession, setAuthenticatedSession } from '../auth/auth-client';

type User = { id: string; email: string; name: string; role: 'admin'|'installer'|'viewer' };
type LoginResponse = { accessToken: string; expiresIn: number; user: User };

/** Login and token lifecycle. Feature cleanup is injected by the application coordinator. */
export function usePortalSession(options: {
  apiBase: string;
  onSignedIn: () => Promise<void>;
  onRestored: () => void;
  onSignedOut: () => void;
}) {
  const email = ref('');
  const password = ref('');
  const loginError = ref('');
  const accessToken = ref('');
  const user = ref<User|null>(null);
  const isAuthRestoring = ref(true);

  const unsubscribe = onAuthState(profile => {
    accessToken.value = getAccessToken();
    user.value = profile;
    if (!profile) options.onSignedOut();
  });

  async function login() {
    loginError.value = '';
    const response = await window.fetch(`${options.apiBase}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ email: email.value, password: password.value }),
    });
    if (!response.ok) {
      loginError.value = response.status === 429
        ? 'Too many sign-in attempts. Wait a little and try again.'
        : response.status === 401 ? 'Email or password is incorrect.' : 'Sign-in is temporarily unavailable.';
      return;
    }
    const data = (await response.json()) as LoginResponse;
    setAuthenticatedSession(data);
    accessToken.value = data.accessToken;
    user.value = data.user;
    await options.onSignedIn();
  }

  async function logout() {
    try { await logoutRequest(); }
    finally {
      clearAuthenticatedSession();
      accessToken.value = '';
      user.value = null;
      options.onSignedOut();
    }
  }

  async function restore() {
    try {
      const profile = await restoreSession();
      if (profile) {
        accessToken.value = getAccessToken();
        user.value = profile;
        options.onRestored();
      }
    } catch {
      clearAuthenticatedSession();
      accessToken.value = '';
      user.value = null;
    } finally { isAuthRestoring.value = false; }
  }

  function handleAuthExpired() {
    clearAuthenticatedSession();
    accessToken.value = '';
    user.value = null;
    options.onSignedOut();
  }
  window.addEventListener('energrid:auth-expired', handleAuthExpired);
  function dispose() {
    unsubscribe();
    window.removeEventListener('energrid:auth-expired', handleAuthExpired);
  }
  return { email, password, loginError, accessToken, user, isAuthRestoring, login, logout, restore, dispose };
}
