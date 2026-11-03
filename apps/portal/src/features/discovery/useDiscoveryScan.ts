import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { DiscoveryNetworkZone, NetworkDevice } from './discovery-contracts';

/** Only an authorized, explicitly confirmed scan may collect new network evidence. */
export type DiscoveryScanResult<Snapshot extends { scanId: string }, Comparison> = {
  zones?: DiscoveryNetworkZone[];
  devices: NetworkDevice[];
  snapshot: Snapshot;
  comparison: Comparison | null;
};

type ScanDependencies<Snapshot extends { scanId: string }, Comparison> = {
  apiBase: string;
  token: Readonly<Ref<string>>;
  siteScope: () => string | null;
  scopes: () => DiscoveryNetworkZone[];
  onScanned: (result: DiscoveryScanResult<Snapshot, Comparison>, isCurrent: () => boolean) => Promise<void> | void;
  onLog: (line: string) => void;
  request?: typeof authFetch;
  confirm?: (message: string) => boolean;
};

/**
 * Owns bounded scan requests, explicit operator consent, cancellation and status.
 * A stale site/session response cannot update the Discovery view. A successful
 * result is passed to the shell only for integration with its existing snapshot
 * projections; enrolling or controlling a device is outside this composable.
 */
export function useDiscoveryScan<Snapshot extends { scanId: string }, Comparison>(dependencies: ScanDependencies<Snapshot, Comparison>) {
  const scanningNetwork = ref(false);
  const scanElapsedSeconds = ref(0);
  const scanFeedback = ref('');
  const scanError = ref('');
  const request = dependencies.request ?? authFetch;
  const confirm = dependencies.confirm ?? ((message: string) => window.confirm(message));
  let generation = 0;
  let activeController: AbortController | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    elapsedTimer = undefined;
    deadlineTimer = undefined;
  }

  function invalidate(): void {
    generation += 1;
    activeController?.abort();
    activeController = undefined;
    clearTimers();
    scanningNetwork.value = false;
    scanElapsedSeconds.value = 0;
    scanFeedback.value = '';
    scanError.value = '';
  }

  // Changing the security context cancels the request and discards its results.
  watch([dependencies.token, dependencies.siteScope], invalidate, { flush: 'sync' });
  onBeforeUnmount(invalidate);

  function cancelNetworkScan(): void {
    activeController?.abort();
  }

  async function scanNetwork(scopeIds?: string[]): Promise<void> {
    if (scanningNetwork.value) return;
    const token = dependencies.token.value;
    const scope = dependencies.siteScope();
    if (!token || !scope) {
      scanError.value = 'Sign in and select a site before scanning.';
      return;
    }
    const availableScopes = dependencies.scopes();
    const selectedScopeIds = scopeIds?.length
      ? scopeIds
      : availableScopes.filter(zone => zone.collectionSource !== 'virtual-lab').map(zone => zone.id);
    const selectedScopes = availableScopes.filter(zone => selectedScopeIds.includes(zone.id));
    if (!selectedScopeIds.length || new Set(selectedScopeIds).size !== selectedScopeIds.length ||
        selectedScopes.length !== selectedScopeIds.length) {
      scanError.value = 'Choose one or more configured network scopes before scanning.';
      return;
    }
    const virtualLabScopes = selectedScopes.filter(zone => zone.collectionSource === 'virtual-lab');
    if (virtualLabScopes.length && virtualLabScopes.length !== selectedScopes.length) {
      scanError.value = 'Scan the Virtual Lab separately from physical networks.';
      return;
    }
    const fullSubnetSelected = selectedScopes.some(zone => !!zone.cidr && zone.collectionSource !== 'virtual-lab');
    if (virtualLabScopes.length && !confirm(
      `This will scan up to 14 usable addresses in the authorized isolated Virtual Lab scope ${virtualLabScopes[0].cidr || 'Lab network'}. No Home networks or addresses outside this scope will be scanned. Continue?`,
    )) return;
    if (fullSubnetSelected && !confirm(
      `This will scan the selected subnet(s): ${selectedScopes.filter(zone => zone.cidr && zone.collectionSource !== 'virtual-lab').map(zone => `${zone.name} ${zone.cidr}`).join(', ')}. Each subnet is limited to 254 addresses; when enabled, Nmap checks a fixed set of TCP service ports with bounded concurrency and timeouts. Continue?`,
    )) return;
    // A confirm dialog is synchronous, but authorization may change while it is open.
    if (dependencies.token.value !== token || dependencies.siteScope() !== scope) return;

    const currentGeneration = ++generation;
    const controller = new AbortController();
    activeController = controller;
    scanningNetwork.value = true;
    scanError.value = '';
    scanFeedback.value = '';
    scanElapsedSeconds.value = 0;
    const startedAt = Date.now();
    let timedOut = false;
    const isCurrent = () => currentGeneration === generation &&
      activeController === controller && dependencies.token.value === token &&
      dependencies.siteScope() === scope;
    elapsedTimer = setInterval(() => {
      if (isCurrent()) scanElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000);
    }, 1000);
    deadlineTimer = setTimeout(() => { timedOut = true; controller.abort(); }, 185_000);
    dependencies.onLog('[discovery] scanning selected networks');
    try {
      const response = await request(`${dependencies.apiBase}/portal/network/scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopeIds: selectedScopeIds, fullSubnetConfirmed: fullSubnetSelected || virtualLabScopes.length > 0 }),
        signal: controller.signal,
      });
      if (!isCurrent() || controller.signal.aborted) return;
      if (!response.ok) {
        const failures: Record<number, string> = {
          401: 'Your Portal session expired. Sign in again before scanning.',
          403: 'This scan is not authorized for the selected network scope.',
          404: 'The selected network scope is no longer available. Refresh the Portal and try again.',
          409: 'Another network scan is already running. Wait for it to finish.',
          429: 'Network discovery is busy. Wait briefly before trying again.',
          503: 'The network discovery collector is unavailable.',
          504: 'Network discovery exceeded its 180-second limit. The observer may not reach the selected subnet; check its route or use an observer on that network. This does not prove any device is offline.',
        };
        throw new Error(failures[response.status] || `Network discovery failed (HTTP ${response.status}). No new snapshot was saved.`);
      }
      const result = await response.json() as DiscoveryScanResult<Snapshot, Comparison>;
      if (!isCurrent() || controller.signal.aborted) return;
      await dependencies.onScanned(result, () => isCurrent() && !controller.signal.aborted);
      if (!isCurrent() || controller.signal.aborted) return;
      scanFeedback.value = `Scan complete · ${result.devices.length} endpoints found · ${result.zones?.length ?? availableScopes.length} networks`;
      dependencies.onLog(`[discovery] snapshot ${result.snapshot.scanId} saved; ${result.devices.length} endpoints visible`);
    } catch (error) {
      if (!isCurrent()) return;
      scanError.value = timedOut
        ? 'The scan timed out after 185 seconds. The observer may not reach the selected network. This does not prove that any device is offline.'
        : controller.signal.aborted
          ? 'The scan was cancelled. Any completed observations remain available in the saved snapshot.'
          : error instanceof Error ? error.message : 'Network scan unavailable';
      scanFeedback.value = `Scan failed: ${scanError.value}`;
      dependencies.onLog(`[discovery] scan failed: ${scanError.value}`);
    } finally {
      if (isCurrent()) {
        scanElapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000);
        clearTimers();
        activeController = undefined;
        scanningNetwork.value = false;
      }
    }
  }

  return { scanningNetwork, scanElapsedSeconds, scanFeedback, scanError, scanNetwork, cancelNetworkScan };
}
