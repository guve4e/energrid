import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { VoiceRunRecord } from './voice-types';

/** Saved voice-run history is read-only and scoped to the current authenticated session. */
export function useVoiceRuns(options: { apiBase: string; accessToken: Ref<string> }) {
  const voiceRuns = ref<VoiceRunRecord[]>([]);
  const voiceRunsLoading = ref(false);
  const voiceRunsError = ref('');
  let generation = 0;
  let controller: AbortController | null = null;

  async function loadVoiceRuns() {
    const token = options.accessToken.value;
    const request = ++generation;
    controller?.abort();
    if (!token) {
      voiceRuns.value = [];
      voiceRunsError.value = '';
      voiceRunsLoading.value = false;
      return;
    }
    const abort = new AbortController();
    controller = abort;
    voiceRunsLoading.value = true;
    voiceRunsError.value = '';
    try {
      const response = await authFetch(`${options.apiBase}/voice/runs?limit=8`, {
        headers: { Authorization: `Bearer ${token}` }, signal: abort.signal,
      });
      if (!response.ok) throw new Error('Voice runs unavailable');
      const body = (await response.json()) as { runs?: VoiceRunRecord[] };
      if (request !== generation || options.accessToken.value !== token) return;
      voiceRuns.value = Array.isArray(body.runs) ? body.runs : [];
    } catch (error) {
      if (request !== generation || options.accessToken.value !== token || abort.signal.aborted) return;
      voiceRunsError.value = error instanceof Error ? error.message : 'Voice runs unavailable';
    } finally {
      if (request === generation) {
        voiceRunsLoading.value = false;
        controller = null;
      }
    }
  }

  watch(options.accessToken, () => {
    generation += 1;
    controller?.abort();
    controller = null;
    voiceRuns.value = [];
    voiceRunsLoading.value = false;
    voiceRunsError.value = '';
  }, { flush: 'sync' });
  onBeforeUnmount(() => { generation += 1; controller?.abort(); });
  return { voiceRuns, voiceRunsLoading, voiceRunsError, loadVoiceRuns };
}
