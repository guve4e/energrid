import { computed, ref, type MaybeRefOrGetter, toValue } from 'vue';
import type { DiscoveryMemoryResponse, NetworkDevice, SnapshotMarker } from './discovery-contracts';
import { mergeCurrentAndRememberedDevices } from './discovery-network';

/** Shared read model for Discovery and device setup; never infers current connectivity from history. */
export function useDiscoveryNetworkModel(
  live: MaybeRefOrGetter<NetworkDevice[]>,
  memory: MaybeRefOrGetter<DiscoveryMemoryResponse | null>,
  snapshots: MaybeRefOrGetter<SnapshotMarker[]>,
) {
  const networkDevices = computed(() =>
    mergeCurrentAndRememberedDevices(toValue(live), toValue(memory)),
  );
  const historicalNetworkDevices = computed(() => {
    const data = toValue(memory);
    return (data?.devices || []).map(record => ({
      ...record,
      observedInLatestScan:
        data?.summary.lastScanId !== null && record.lastScanId === data?.summary.lastScanId,
    }));
  });
  const latestMemoryMarkerVerification = computed(() => {
    const marker = toValue(memory)?.summary.lastScanId;
    if (!marker) return null;
    return toValue(snapshots).find(snapshot =>
      snapshot.methods.includes('operator_selected_shelly_read_only_rpc') &&
      snapshot.completedAt === marker,
    ) || null;
  });
  return { networkDevices, historicalNetworkDevices, latestMemoryMarkerVerification };
}

/** Feature-owned view state survives navigation within one authenticated Portal session. */
export function useDiscoveryInventoryUiState() {
  return {
    search: ref(''),
    view: ref<'all' | 'capable'>('all'),
    memoryExpanded: ref(false),
  };
}
export type DiscoveryInventoryUiState = ReturnType<typeof useDiscoveryInventoryUiState>;
