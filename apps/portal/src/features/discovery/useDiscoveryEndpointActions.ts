import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { LlmProviderAvailability } from './useDiscoveryIntelligence';
import { networkEndpointInvestigationKey, type NetworkEndpointInvestigationState, type NetworkEndpointHttpProbeState, type NetworkEndpointIdentityRefreshState, type NetworkEndpointInvestigationResult, type NetworkEndpointHttpProbeResult, type NetworkEndpointIdentityRefreshResult } from '../../components/discovery/network-endpoint-investigation';


type ShellyReconciliationProposal = {
  deviceId: string; displayName: string; room: string; physicalId: string; component: string;
  evidenceScanId: string; observerId: string; observedAt: string; endpoint: string; model: string;
  physicalInventoryId: string; identityVerifiedAt: string; componentVerifiedAt: string; evidenceFresh: boolean;
  firmwareVersion: string; verifiedMeasurementFields: string[]; currentIdentitySource: string;
  currentDriver: string; mqttTopicRequiresOperatorBinding: true; reconciled?: boolean;
};

type SiteLocalEvidenceImport = {
  status: string; scanId: string; observerId: string; physicalId: string;
  reconciliationProposals: ShellyReconciliationProposal[];
  reconciliationConflicts: Array<{ deviceId: string; component: string; reason: string; reasonCode?: string }>;
  historicalComponentConflicts: string[];
};

/** Bounded operations. None of these endpoints grants enrollment or control automatically. */
export function useDiscoveryEndpointActions(deps: {
  apiBase: string;
  accessToken: Readonly<Ref<string>>;
  siteScope: () => string | null;
  stateError: Ref<string>;
  loadState: () => Promise<void>;
  loadNetworkSnapshots: () => Promise<void>;
  navigateToDiscovery: () => void;
  loadLlmProviderAvailability: () => Promise<LlmProviderAvailability>;
  confirmCloudEvidence: (status: LlmProviderAvailability) => Promise<boolean>;
  request?: typeof authFetch;
}) {
  const request = deps.request ?? authFetch;
  const networkEndpointInvestigations = ref<Record<string, NetworkEndpointInvestigationState>>({});
  const networkEndpointHttpProbes = ref<Record<string, NetworkEndpointHttpProbeState>>({});
  const networkEndpointIdentityRefreshes = ref<Record<string, NetworkEndpointIdentityRefreshState>>({});
  const onboardingNetworkEndpoint = ref(false);
  const siteLocalEvidenceImport = ref<SiteLocalEvidenceImport | null>(null);
  const siteLocalEvidenceImportBusy = ref(false);
  const siteLocalEvidenceImportError = ref('');
  let generation = 0;

  function invalidate(): void {
    generation += 1;
    networkEndpointInvestigations.value = {};
    networkEndpointHttpProbes.value = {};
    networkEndpointIdentityRefreshes.value = {};
    onboardingNetworkEndpoint.value = false;
    siteLocalEvidenceImport.value = null;
    siteLocalEvidenceImportBusy.value = false;
    siteLocalEvidenceImportError.value = '';
  }
  watch([deps.accessToken, deps.siteScope], invalidate, { flush: 'sync' });
  onBeforeUnmount(invalidate);

  function context() {
    const token = deps.accessToken.value;
    const scope = deps.siteScope();
    const version = generation;
    return { token, current: () => !!token && !!scope && version === generation &&
      token === deps.accessToken.value && scope === deps.siteScope() };
  }
  function endpointPath(value: { scanId: string; scopeId: string; ipAddress: string; endpointId: string }) {
    return `${deps.apiBase}/portal/network/snapshots/${encodeURIComponent(value.scanId)}/scopes/${encodeURIComponent(value.scopeId)}/endpoints/${encodeURIComponent(value.ipAddress)}/${encodeURIComponent(value.endpointId)}`;
  }
  async function json(response: Response, failure: string): Promise<unknown> {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result && typeof result === 'object' && 'message' in result
        ? (result as { message: unknown }).message : undefined;
      throw new Error(typeof message === 'string' ? message :
        Array.isArray(message) ? message.join(', ') : `${failure} (${response.status})`);
    }
    return result;
  }

  async function investigateSnapshotEndpoint(value: { scanId: string; scopeId: string; ipAddress: string; endpointId: string }): Promise<void> {
    const key = networkEndpointInvestigationKey(value.scanId, value.scopeId, value.ipAddress, value.endpointId);
    if (networkEndpointInvestigations.value[key]?.loading) return;
    const op = context(); if (!op.current()) return;
    networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value, [key]: { loading: true } };
    try {
      const provider = await deps.loadLlmProviderAvailability();
      if (!op.current()) return;
      if (!provider.available) throw new Error(`Investigation provider unavailable (${provider.reasonCode || 'unavailable'}).`);
      if (!(await deps.confirmCloudEvidence(provider)) || !op.current()) return;
      const response = await request(`${endpointPath(value)}/investigate`, {
        method: 'POST', headers: { Authorization: `Bearer ${op.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloudDataConsent: provider.cloudDataConsentRequired }),
      });
      if (!op.current()) return;
      const result = await json(response, 'Investigation failed') as NetworkEndpointInvestigationResult;
      if (op.current()) networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value, [key]: { loading: false, result } };
    } catch (error) {
      if (op.current()) networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value,
        [key]: { loading: false, error: error instanceof Error ? error.message : 'Investigation failed' } };
    } finally {
      if (op.current() && networkEndpointInvestigations.value[key]?.loading)
        networkEndpointInvestigations.value = { ...networkEndpointInvestigations.value, [key]: { loading: false } };
    }
  }

  async function probeSnapshotEndpoint(value: { scanId: string; scopeId: string; ipAddress: string; endpointId: string; refreshId: string }): Promise<void> {
    const key = networkEndpointInvestigationKey(value.scanId, value.scopeId, value.ipAddress, value.endpointId);
    if (networkEndpointHttpProbes.value[key]?.loading) return;
    const op = context(); if (!op.current()) return;
    networkEndpointHttpProbes.value = { ...networkEndpointHttpProbes.value, [key]: { loading: true } };
    try {
      const response = await request(`${endpointPath(value)}/probe-http`, {
        method: 'POST', headers: { Authorization: `Bearer ${op.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true, refreshId: value.refreshId }),
      });
      if (!op.current()) return;
      const result = await json(response, 'HTTP check failed') as NetworkEndpointHttpProbeResult;
      if (op.current()) networkEndpointHttpProbes.value = { ...networkEndpointHttpProbes.value, [key]: { loading: false, result } };
    } catch (error) {
      if (op.current()) networkEndpointHttpProbes.value = { ...networkEndpointHttpProbes.value,
        [key]: { loading: false, error: error instanceof Error ? error.message : 'HTTP check failed' } };
    }
  }

  async function refreshSnapshotEndpointIdentity(value: { scanId: string; scopeId: string; ipAddress: string; endpointId: string }): Promise<void> {
    const key = networkEndpointInvestigationKey(value.scanId, value.scopeId, value.ipAddress, value.endpointId);
    if (networkEndpointIdentityRefreshes.value[key]?.loading) return;
    const op = context(); if (!op.current()) return;
    networkEndpointIdentityRefreshes.value = { ...networkEndpointIdentityRefreshes.value, [key]: { loading: true } };
    try {
      const response = await request(`${endpointPath(value)}/refresh-identity`, {
        method: 'POST', headers: { Authorization: `Bearer ${op.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      if (!op.current()) return;
      const result = await json(response, 'Identity refresh failed') as NetworkEndpointIdentityRefreshResult;
      if (op.current()) networkEndpointIdentityRefreshes.value = { ...networkEndpointIdentityRefreshes.value, [key]: { loading: false, result } };
    } catch (error) {
      if (op.current()) networkEndpointIdentityRefreshes.value = { ...networkEndpointIdentityRefreshes.value,
        [key]: { loading: false, error: error instanceof Error ? error.message : 'Identity refresh failed' } };
    }
  }

  async function startNetworkEndpointOnboarding(value: { scanId: string; scopeId: string; ipAddress: string; endpointId: string }): Promise<void> {
    if (onboardingNetworkEndpoint.value) return;
    const op = context(); if (!op.current()) return;
    onboardingNetworkEndpoint.value = true;
    deps.stateError.value = '';
    try {
      const response = await request(`${endpointPath(value)}/start-onboarding`, {
        method: 'POST', headers: { Authorization: `Bearer ${op.token}`, 'Content-Type': 'application/json' },
      });
      if (!op.current()) return;
      const result = await json(response, 'Onboarding failed') as { candidates?: unknown[] };
      if (!op.current()) return;
      if (!Array.isArray(result.candidates) || !result.candidates.length)
        throw new Error('No verified onboarding candidates were returned.');
      await deps.loadState();
      if (op.current()) deps.navigateToDiscovery();
    } catch (error) {
      if (op.current()) deps.stateError.value = error instanceof Error ? error.message : 'Could not start onboarding.';
    } finally {
      if (op.current()) onboardingNetworkEndpoint.value = false;
    }
  }

  async function importSiteLocalShellyEvidence(value: { report?: unknown; error?: string }): Promise<void> {
    siteLocalEvidenceImportError.value = value.error || '';
    if (value.error || value.report === undefined || siteLocalEvidenceImportBusy.value) return;
    const op = context(); if (!op.current()) return;
    siteLocalEvidenceImportBusy.value = true;
    siteLocalEvidenceImportError.value = '';
    try {
      const response = await request(`${deps.apiBase}/portal/network/site-local-shelly-evidence`, {
        method: 'POST', headers: { Authorization: `Bearer ${op.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(value.report),
      });
      if (!op.current()) return;
      const result = await json(response, 'Evidence import failed') as SiteLocalEvidenceImport;
      if (!op.current()) return;
      siteLocalEvidenceImport.value = result;
      await deps.loadNetworkSnapshots();
    } catch (error) {
      if (op.current()) siteLocalEvidenceImportError.value = error instanceof Error ? error.message : 'Site-local Shelly evidence import failed.';
    } finally { if (op.current()) siteLocalEvidenceImportBusy.value = false; }
  }

  async function reviewSavedSiteLocalShellyEvidence(scanId: string): Promise<void> {
    if (siteLocalEvidenceImportBusy.value) return;
    const op = context(); if (!op.current()) return;
    siteLocalEvidenceImportBusy.value = true;
    siteLocalEvidenceImportError.value = '';
    try {
      const response = await request(`${deps.apiBase}/portal/network/site-local-shelly-evidence/${encodeURIComponent(scanId)}/review`, {
        headers: { Authorization: `Bearer ${op.token}` },
      });
      if (!op.current()) return;
      const result = await json(response, 'Saved evidence review failed') as SiteLocalEvidenceImport;
      if (op.current()) siteLocalEvidenceImport.value = result;
    } catch (error) {
      if (op.current()) siteLocalEvidenceImportError.value = error instanceof Error ? error.message : 'Saved evidence review failed.';
    } finally { if (op.current()) siteLocalEvidenceImportBusy.value = false; }
  }

  async function reconcileSiteLocalShellyEvidence(value: { scanId: string; deviceId: string; component: string }): Promise<void> {
    if (siteLocalEvidenceImportBusy.value) return;
    const op = context(); if (!op.current()) return;
    siteLocalEvidenceImportBusy.value = true;
    siteLocalEvidenceImportError.value = '';
    try {
      const response = await request(`${deps.apiBase}/portal/network/site-local-shelly-evidence/${encodeURIComponent(value.scanId)}/reconcile`, {
        method: 'POST', headers: { Authorization: `Bearer ${op.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: value.deviceId, component: value.component }),
      });
      if (!op.current()) return;
      await json(response, 'Identity reconciliation failed');
      if (!op.current()) return;
      if (siteLocalEvidenceImport.value) siteLocalEvidenceImport.value = {
        ...siteLocalEvidenceImport.value,
        reconciliationProposals: siteLocalEvidenceImport.value.reconciliationProposals.map(proposal =>
          proposal.deviceId === value.deviceId ? { ...proposal, reconciled: true } : proposal),
      };
      await deps.loadState();
    } catch (error) {
      if (op.current()) siteLocalEvidenceImportError.value = error instanceof Error ? error.message : 'Identity reconciliation failed.';
    } finally { if (op.current()) siteLocalEvidenceImportBusy.value = false; }
  }

  return {
    networkEndpointInvestigations, networkEndpointHttpProbes, networkEndpointIdentityRefreshes,
    onboardingNetworkEndpoint, siteLocalEvidenceImport, siteLocalEvidenceImportBusy, siteLocalEvidenceImportError,
    investigateSnapshotEndpoint, probeSnapshotEndpoint, refreshSnapshotEndpointIdentity,
    startNetworkEndpointOnboarding, importSiteLocalShellyEvidence,
    reviewSavedSiteLocalShellyEvidence, reconcileSiteLocalShellyEvidence,
  };
}
