import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';

/** A Discovery candidate is only evidence; approval remains a separate authorized action. */
export type DiscoveryCandidateDecision = {
  id: string;
  displayName: string;
  metadata?: Record<string, string | number | boolean>;
};

type DecisionDependencies = {
  apiBase: string;
  token: Readonly<Ref<string>>;
  siteScope: () => string | null;
  onRefresh: () => Promise<void>;
  onApproved?: () => void;
  onLog: (message: string) => void;
  request?: typeof authFetch;
  confirm?: (message: string) => boolean;
};

/**
 * Owns pending-candidate approval/block and fresh Shelly verification requests.
 * Busy state is keyed to candidates, requests are isolated by session/site,
 * and no verification response can silently enroll or authorize device control.
 */
export function useDiscoveryDecisions(dependencies: DecisionDependencies) {
  const discoveryDecisionBusy = ref<Record<string, 'approve' | 'block' | 'verify'>>({});
  const shellyVerificationMessages = ref<Record<string, string>>({});
  const discoveryDecisionError = ref('');
  const request = dependencies.request ?? authFetch;
  const confirm = dependencies.confirm ?? ((message: string) => window.confirm(message));
  let generation = 0;
  const pending = new Map<string, AbortController>();

  function invalidate(): void {
    generation += 1;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    discoveryDecisionBusy.value = {};
    shellyVerificationMessages.value = {};
    discoveryDecisionError.value = '';
  }
  watch([dependencies.token, dependencies.siteScope], invalidate, { flush: 'sync' });
  onBeforeUnmount(invalidate);

  function begin(candidateId: string, action: 'approve' | 'block' | 'verify') {
    const token = dependencies.token.value;
    const scope = dependencies.siteScope();
    if (!token || !scope || pending.has(candidateId)) return null;
    const controller = new AbortController();
    const currentGeneration = generation;
    pending.set(candidateId, controller);
    discoveryDecisionBusy.value = { ...discoveryDecisionBusy.value, [candidateId]: action };
    discoveryDecisionError.value = '';
    const isCurrent = () => currentGeneration === generation && pending.get(candidateId) === controller &&
      dependencies.token.value === token && dependencies.siteScope() === scope && !controller.signal.aborted;
    const finish = () => {
      if (currentGeneration !== generation || pending.get(candidateId) !== controller) return;
      pending.delete(candidateId);
      const busy = { ...discoveryDecisionBusy.value };
      delete busy[candidateId];
      discoveryDecisionBusy.value = busy;
    };
    return { token, controller, isCurrent, finish };
  }

  async function applyDiscoveryDecision(candidate: DiscoveryCandidateDecision, action: 'approve' | 'block', zoneId?: string): Promise<void> {
    if (pending.has(candidate.id)) return;
    const beforeConsentToken = dependencies.token.value;
    const beforeConsentScope = dependencies.siteScope();
    const conflict = action === 'approve' && candidate.metadata?.requiresProfileReconciliation === true;
    if (conflict && !confirm(
      `Fresh Shelly RPC confirms ${String(candidate.metadata?.component || 'the current component profile')}. Historical MQTT component evidence (${String(candidate.metadata?.historicalComponentConflicts || 'unknown')}) will be preserved and is not being deleted or reclassified. Continue to enrollment review?`,
    )) return;
    if (beforeConsentToken !== dependencies.token.value || beforeConsentScope !== dependencies.siteScope()) return;
    const operation = begin(candidate.id, action);
    if (!operation) return;
    const { token, controller, isCurrent, finish } = operation;
    dependencies.onLog(`[discovery] ${action} requested for ${candidate.displayName}`);
    try {
      const withBody = !!zoneId || conflict;
      const response = await request(`${dependencies.apiBase}/portal/discovery/${encodeURIComponent(candidate.id)}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(withBody ? { 'Content-Type': 'application/json' } : {}) },
        ...(withBody ? { body: JSON.stringify({ ...(zoneId ? { zoneId } : {}), ...(conflict ? { profileConflictAcknowledged: true } : {}) }) } : {}),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const result = await response.json().catch(() => null) as { message?: string; status?: string } | null;
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(result?.message || `Discovery ${action} failed`);
      dependencies.onLog(`[discovery] ${candidate.displayName} ${result?.status || action}`);
      await dependencies.onRefresh();
      if (!isCurrent()) return;
      if (action === 'approve') dependencies.onApproved?.();
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : `Discovery ${action} failed`;
      discoveryDecisionError.value = message;
      dependencies.onLog(`[discovery] ${action} failed for ${candidate.displayName}: ${message}`);
    } finally {
      finish();
    }
  }

  async function verifyPendingShelly(candidateId: string): Promise<void> {
    const operation = begin(candidateId, 'verify');
    if (!operation) return;
    const { token, controller, isCurrent, finish } = operation;
    const contextGeneration = generation;
    const originalScope = dependencies.siteScope();
    shellyVerificationMessages.value = { ...shellyVerificationMessages.value, [candidateId]: '' };
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 25_000);
    try {
      const response = await request(`${dependencies.apiBase}/portal/discovery/${encodeURIComponent(candidateId)}/verify-shelly`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!isCurrent()) return;
      const result = await response.json().catch(() => null) as { message?: string; physicalId?: string } | null;
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(typeof result?.message === 'string' ? result.message : `Verification failed (${response.status}).`);
      await dependencies.onRefresh();
      if (!isCurrent()) return;
      shellyVerificationMessages.value = {
        ...shellyVerificationMessages.value,
        [candidateId]: `Fresh identity and component RPC evidence saved for ${result?.physicalId}. Enrollment is still a separate operator action.`,
      };
    } catch (error) {
      // Timeout retains a user-facing error but stale site/session results do not.
      if (!isCurrent() && !timedOut) return;
      if (timedOut && generation === contextGeneration &&
          dependencies.token.value === token && dependencies.siteScope() === originalScope) {
        shellyVerificationMessages.value = {
          ...shellyVerificationMessages.value,
          [candidateId]: 'The Portal request exceeded 25 seconds. No enrollment or device control was performed; check API and authorized observer connectivity before retrying.',
        };
      } else if (isCurrent()) {
        shellyVerificationMessages.value = {
          ...shellyVerificationMessages.value,
          [candidateId]: error instanceof Error ? error.message : 'Selected-device verification failed.',
        };
      }
    } finally {
      clearTimeout(deadline);
      finish();
    }
  }

  return { discoveryDecisionBusy, shellyVerificationMessages, discoveryDecisionError, applyDiscoveryDecision, verifyPendingShelly };
}
