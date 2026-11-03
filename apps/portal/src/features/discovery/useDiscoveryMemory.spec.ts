import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useDiscoveryMemory } from './useDiscoveryMemory';
import type { DiscoveryMemoryResponse } from './discovery-contracts';

const record = (known: number): DiscoveryMemoryResponse => ({
  summary: { lastScanId: 'scan-1', known, observedInLatestScan: known, notObservedInLatestScan: 0 },
  devices: [],
});
const response = (value: DiscoveryMemoryResponse) => ({
  ok: true, json: async () => value,
}) as Response;

describe('discovery memory client', () => {
  it('fetches saved evidence through the existing authenticated route', async () => {
    const token = ref('token-1');
    const scope = ref('tenant-a:site-a');
    const request = vi.fn(async () => response(record(2)));
    const model = useDiscoveryMemory('/api', token, () => scope.value, request);
    await model.loadDiscoveryMemory();
    expect(request).toHaveBeenCalledWith('/api/portal/network/memory', {
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(model.discoveryMemory.value?.summary.known).toBe(2);
    expect(model.discoveryMemoryLoading.value).toBe(false);
  });

  it('rejects a delayed previous-site response after scope changes', async () => {
    const token = ref('token-1');
    const scope = ref('tenant-a:site-a');
    let resolveFirst!: (value: Response) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => response(record(4)));
    const model = useDiscoveryMemory('/api', token, () => scope.value, request);
    const previous = model.loadDiscoveryMemory();
    scope.value = 'tenant-a:site-b';
    expect(model.discoveryMemory.value).toBeNull();
    await model.loadDiscoveryMemory();
    resolveFirst(response(record(100)));
    await previous;
    expect(model.discoveryMemory.value?.summary.known).toBe(4);
    expect(model.discoveryMemoryLoading.value).toBe(false);
  });

  it('discards saved evidence at logout and does not issue anonymous requests', async () => {
    const token = ref('token-1');
    const scope = ref('tenant-a:site-a');
    const request = vi.fn(async () => response(record(3)));
    const model = useDiscoveryMemory('/api', token, () => scope.value, request);
    await model.loadDiscoveryMemory();
    token.value = '';
    expect(model.discoveryMemory.value).toBeNull();
    await model.loadDiscoveryMemory();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
