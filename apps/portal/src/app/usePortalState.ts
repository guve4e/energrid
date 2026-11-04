import { ref, watch, type Ref } from 'vue';
import { authFetch } from '../auth/auth-client';
import type { PortalState } from '../portal-state';
import { createVoiceOnlyState, type VoiceConfig } from './voice-only-fallback';

/** Site-scoped Portal snapshot. Business rules remain in Core and feature models. */
export function usePortalState(options: {
  apiBase: string;
  accessToken: Ref<string>;
  activePage: Ref<string>;
  serverLabel: Ref<string>;
  onLog: (message: string) => void;
  loadMembership: () => Promise<unknown>;
  loadDiscoveryMemory: () => Promise<unknown>;
  beforeSiteSwitch: () => void;
  onSiteSwitchFailure: () => void;
}) {
  const state = ref<PortalState | null>(null);
  const loadingState = ref(false);
  const stateError = ref('');
  const siteSwitchBusy = ref(false);
  const siteSwitchError = ref('');
  let requestGeneration = 0;
  // Sign-out invalidates in-flight snapshots, even if a server replies later.
  watch(options.accessToken, token => {
    if (!token) {
      requestGeneration += 1;
      state.value = null;
      loadingState.value = false;
    }
  }, { flush: 'sync' });
  const stillCurrent = (generation: number) => generation === requestGeneration && !!options.accessToken.value;

  async function loadState() {
    const generation = ++requestGeneration;
    loadingState.value = true;
    stateError.value = '';
    try {
      options.onLog(`[portal] loading state from ${options.serverLabel.value}`);
      const response = await authFetch(`${options.apiBase}/portal/state`, {
        headers: { Authorization: `Bearer ${options.accessToken.value}` },
      });
      if (!stillCurrent(generation)) return;
      if (response.status === 404) {
        options.onLog('[portal] /portal/state missing, using /voice/config fallback');
        const configResponse = await authFetch(`${options.apiBase}/voice/config`);
        if (!configResponse.ok) throw new Error('Voice config unavailable');
        const config = (await configResponse.json()) as VoiceConfig;
        if (stillCurrent(generation)) state.value = createVoiceOnlyState(config);
        return;
      }
      if (!response.ok) throw new Error('State unavailable');
      const snapshot = (await response.json()) as PortalState;
      if (!stillCurrent(generation)) return;
      state.value = snapshot;
      await options.loadMembership();
      if (!stillCurrent(generation)) return;
      if (options.activePage.value === 'discovery') await options.loadDiscoveryMemory();
    } catch (error) {
      if (stillCurrent(generation)) stateError.value = error instanceof Error ? error.message : 'State unavailable';
    } finally {
      if (generation === requestGeneration) loadingState.value = false;
    }
  }

  async function switchPortalSite(event: Event) {
    const siteId = (event.target as HTMLSelectElement | null)?.value;
    if (!siteId || siteId === state.value?.site.id) return;
    siteSwitchBusy.value = true;
    requestGeneration += 1;
    loadingState.value = false;
    options.beforeSiteSwitch();
    siteSwitchError.value = '';
    try {
      const response = await authFetch(`${options.apiBase}/portal/site-selection`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.accessToken.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId }),
      });
      if (!response.ok) throw new Error('The selected site could not be opened.');
      window.location.reload();
    } catch (error) {
      siteSwitchError.value = error instanceof Error ? error.message : 'The selected site could not be opened.';
      options.onSiteSwitchFailure();
    } finally {
      siteSwitchBusy.value = false;
    }
  }

  return { state, loadingState, stateError, siteSwitchBusy, siteSwitchError, loadState, switchPortalSite };
}
