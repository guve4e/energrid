import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useDiscoveryScan } from './useDiscoveryScan';
import type { DiscoveryNetworkZone } from './discovery-contracts';

type Snapshot = { scanId: string };
type Diff = { fromScanId: string };
const home: DiscoveryNetworkZone = { id: 'home', name: 'Home', cidr: '192.168.1.0/24', seedIps: [], collectionSource: 'local' };
const lab: DiscoveryNetworkZone = { id: 'lab', name: 'Virtual Lab', cidr: '172.30.250.0/28', seedIps: [], collectionSource: 'virtual-lab' };
const result = (scanId: string) => ({ zones: [home], devices: [], snapshot: { scanId }, comparison: null });
const response = (scanId: string) => ({ ok: true, json: async () => result(scanId) }) as Response;

function createHarness(config: { scopes?: DiscoveryNetworkZone[]; confirm?: boolean; request?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const token = ref('token-a');
  const site = ref('tenant:site-a');
  const scopes = ref(config.scopes || [home, lab]);
  const requestImpl: (url: string, init?: RequestInit) => Promise<Response> = config.request || (async () => response('scan-1'));
  const request = vi.fn(requestImpl);
  const onScanned = vi.fn(async (_result: unknown) => {});
  const onLog = vi.fn();
  const confirm = vi.fn(() => config.confirm ?? true);
  let scan!: ReturnType<typeof useDiscoveryScan<Snapshot, Diff>>;
  const wrapper = mount(defineComponent({
    setup() {
      scan = useDiscoveryScan<Snapshot, Diff>({
        apiBase: '/api', token, siteScope: () => site.value, scopes: () => scopes.value,
        request: request as unknown as typeof import('../../auth/auth-client').authFetch,
        confirm, onScanned, onLog,
      });
      return () => h('div');
    },
  }));
  return { wrapper, scan, request, token, site, scopes, onScanned, onLog, confirm };
}

afterEach(() => vi.restoreAllMocks());

describe('authorized Discovery scan lifecycle', () => {
  it('requires deliberate consent and keeps physical networks separate from Virtual Lab', async () => {
    const model = createHarness({ confirm: false });
    await model.scan.scanNetwork(['lab']);
    expect(model.request).not.toHaveBeenCalled();
    expect(model.confirm).toHaveBeenCalledWith(expect.stringContaining('authorized isolated Virtual Lab'));
    model.wrapper.unmount();

    const mixed = createHarness();
    await mixed.scan.scanNetwork(['home', 'lab']);
    expect(mixed.scan.scanError.value).toContain('separately');
    expect(mixed.request).not.toHaveBeenCalled();
    mixed.wrapper.unmount();
  });

  it('rejects unknown and duplicated scope IDs without making a request', async () => {
    const model = createHarness();
    await model.scan.scanNetwork(['home', 'unknown']);
    expect(model.scan.scanError.value).toContain('configured network scopes');
    await model.scan.scanNetwork(['home', 'home']);
    expect(model.request).not.toHaveBeenCalled();
    model.wrapper.unmount();
  });

  it('preserves the Lab scan request contract and produces read-only evidence', async () => {
    const model = createHarness();
    await model.scan.scanNetwork(['lab']);
    expect(model.request).toHaveBeenCalledWith('/api/portal/network/scan', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer token-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeIds: ['lab'], fullSubnetConfirmed: true }),
    }));
    expect(model.onScanned).toHaveBeenCalledWith(result('scan-1'), expect.any(Function));
    expect(model.scan.scanFeedback.value).toContain('Scan complete');
    expect(model.scan.scanningNetwork.value).toBe(false);
    model.wrapper.unmount();
  });

  it('prevents duplicate in-flight scans and allows explicit cancellation', async () => {
    let signal!: AbortSignal;
    const model = createHarness({ request: (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } });
    const pending = model.scan.scanNetwork(['home']);
    await model.scan.scanNetwork(['home']);
    expect(model.request).toHaveBeenCalledTimes(1);
    model.scan.cancelNetworkScan();
    await pending;
    expect(signal.aborted).toBe(true);
    expect(model.scan.scanError.value).toContain('cancelled');
    expect(model.scan.scanningNetwork.value).toBe(false);
    model.wrapper.unmount();
  });

  it('discards a delayed old-site result, cancels on sign out, and clears timers', async () => {
    let release!: (value: Response) => void;
    const model = createHarness({ request: () => new Promise<Response>(resolve => { release = resolve; }) });
    const pending = model.scan.scanNetwork(['lab']);
    model.site.value = 'tenant:site-b';
    expect(model.scan.scanningNetwork.value).toBe(false);
    release(response('old-site-scan'));
    await pending;
    expect(model.onScanned).not.toHaveBeenCalled();
    expect(model.scan.scanFeedback.value).toBe('');
    const second = model.scan.scanNetwork(['lab']);
    model.token.value = '';
    release(response('signed-out-scan'));
    await second;
    expect(model.onScanned).not.toHaveBeenCalled();
    expect(model.scan.scanningNetwork.value).toBe(false);
    model.wrapper.unmount();
  });

  it('reports explicit HTTP failures and never accepts their evidence', async () => {
    const model = createHarness({ request: async () => ({ ok: false, status: 403 }) as Response });
    await model.scan.scanNetwork(['home']);
    expect(model.scan.scanError.value).toContain('not authorized');
    expect(model.onScanned).not.toHaveBeenCalled();
    model.wrapper.unmount();
  });
});
