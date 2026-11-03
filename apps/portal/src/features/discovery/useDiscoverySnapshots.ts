import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { NetworkSnapshot, NetworkSnapshotDiff, NmapCapability, NetworkRuntime } from '../../portal-state';

/** History is site evidence, not current reachability, ownership, or permission to control. */
export function useDiscoverySnapshots(deps: {
  apiBase: string;
  token: Readonly<Ref<string>>;
  siteScope: () => string | null;
  request?: typeof authFetch;
}) {
  const networkSnapshots = ref<NetworkSnapshot[]>([]);
  const latestNetworkSnapshot = ref<NetworkSnapshot | null>(null);
  const networkSnapshotComparison = ref<NetworkSnapshotDiff | null>(null);
  const networkSnapshotsError = ref('');
  const nmapCapability = ref<NmapCapability | null>(null);
  const networkRuntime = ref<NetworkRuntime | null>(null);
  const request = deps.request ?? authFetch;
  let generation = 0;

  function invalidate(): void {
    generation += 1;
    networkSnapshots.value = [];
    latestNetworkSnapshot.value = null;
    networkSnapshotComparison.value = null;
    networkSnapshotsError.value = '';
    nmapCapability.value = null;
    networkRuntime.value = null;
  }
  watch([deps.token, deps.siteScope], invalidate, { flush: 'sync' });
  onBeforeUnmount(invalidate);

  async function loadNetworkSnapshots(): Promise<void> {
    const token = deps.token.value;
    const scope = deps.siteScope();
    const run = ++generation;
    if (!token || !scope) { invalidate(); return; }
    const current = () => run === generation && deps.token.value === token && deps.siteScope() === scope;
    networkSnapshotsError.value = '';
    try {
      const response = await request(`${deps.apiBase}/portal/network/snapshots`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!current()) return;
      if (!response.ok) throw new Error(`Network snapshots unavailable (${response.status})`);
      const payload = await response.json() as { snapshots: NetworkSnapshot[] };
      if (!current()) return;
      const capabilityResponse = await request(`${deps.apiBase}/portal/network/capabilities`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!current()) return;
      if (capabilityResponse.ok) {
        const capability = await capabilityResponse.json() as { nmap: NmapCapability; observer?: NetworkRuntime };
        if (!current()) return;
        nmapCapability.value = capability.nmap;
        networkRuntime.value = capability.observer || null;
      }
      networkSnapshots.value = payload.snapshots;
      latestNetworkSnapshot.value = payload.snapshots[0] || null;
      networkSnapshotComparison.value = null;
      if (payload.snapshots.length > 1 && latestNetworkSnapshot.value) {
        const latest = latestNetworkSnapshot.value;
        const previous = payload.snapshots.find(snapshot => snapshot.scanId !== latest.scanId &&
          snapshot.scopes.some(oldScope => latest.scopes.some(scope => scope.id === oldScope.id && scope.cidr === oldScope.cidr)));
        if (previous) {
          const compare = await request(`${deps.apiBase}/portal/network/snapshots/${encodeURIComponent(previous.scanId)}/compare/${encodeURIComponent(latest.scanId)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!current()) return;
          if (compare.ok) {
            const comparison = await compare.json() as NetworkSnapshotDiff;
            if (current()) networkSnapshotComparison.value = comparison;
          }
        }
      }
    } catch (error) {
      if (current()) networkSnapshotsError.value = error instanceof Error ? error.message : 'Network snapshots unavailable';
    }
  }

  return { networkSnapshots, latestNetworkSnapshot, networkSnapshotComparison,
    networkSnapshotsError, nmapCapability, networkRuntime, loadNetworkSnapshots };
}
