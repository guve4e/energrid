import { ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { DiscoveryMemoryResponse } from './discovery-contracts';

/**
 * Saved discovery evidence is scoped to the authenticated tenant/site.
 * A delayed response from a previous session or site must not enter the new view.
 * Endpoint history is read-only and never certifies current connectivity.
 */
export function useDiscoveryMemory(
  apiBase: string,
  accessToken: Readonly<Ref<string>>,
  siteScope: () => string | null,
  request: typeof authFetch = authFetch,
) {
  const discoveryMemory = ref<DiscoveryMemoryResponse | null>(null);
  const discoveryMemoryLoading = ref(false);
  const discoveryMemoryError = ref('');
  let generation = 0;

  function invalidate(): void {
    generation += 1;
    discoveryMemory.value = null;
    discoveryMemoryLoading.value = false;
    discoveryMemoryError.value = '';
  }

  // Synchronous invalidation prevents stale data from surviving a site switch
  // before the next async view refresh is scheduled.
  watch([accessToken, siteScope], invalidate, { flush: 'sync' });

  async function loadDiscoveryMemory(): Promise<void> {
    const token = accessToken.value;
    const scope = siteScope();
    const requestGeneration = ++generation;
    if (!token) {
      invalidate();
      return;
    }

    discoveryMemoryLoading.value = true;
    discoveryMemoryError.value = '';
    try {
      const response = await request(`${apiBase}/portal/network/memory`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Discovery Memory unavailable (${response.status})`);
      const result = (await response.json()) as DiscoveryMemoryResponse;
      if (requestGeneration === generation && accessToken.value === token && siteScope() === scope) {
        discoveryMemory.value = result;
      }
    } catch (error) {
      if (requestGeneration === generation && accessToken.value === token && siteScope() === scope) {
        discoveryMemoryError.value = error instanceof Error ? error.message : 'Discovery Memory unavailable';
      }
    } finally {
      if (requestGeneration === generation) discoveryMemoryLoading.value = false;
    }
  }

  return { discoveryMemory, discoveryMemoryLoading, discoveryMemoryError, loadDiscoveryMemory };
}
