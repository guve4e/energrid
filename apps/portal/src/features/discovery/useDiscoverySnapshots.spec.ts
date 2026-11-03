import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useDiscoverySnapshots } from './useDiscoverySnapshots';
import type { NetworkSnapshot } from '../../portal-state';

const snapshot = (scanId: string) => ({ scanId, scopes: [{ id: 'lab', cidr: '172.30.250.0/28' }] }) as NetworkSnapshot;
const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function setup(request: (url: string) => Promise<Response>) {
  const token = ref('token-a');
  const scope = ref('tenant:site-a');
  const mockedRequest = vi.fn(request);
  let model!: ReturnType<typeof useDiscoverySnapshots>;
  const wrapper = mount(defineComponent({
    setup() {
      model = useDiscoverySnapshots({
        apiBase: '/api', token, siteScope: () => scope.value,
        request: mockedRequest as unknown as typeof import('../../auth/auth-client').authFetch,
      });
      return () => h('div');
    },
  }));
  return { model, token, scope, request: mockedRequest, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('site-scoped network snapshot history', () => {
  it('loads saved evidence and a comparison using the authenticated read-only API', async () => {
    const ctx = setup(async url => {
      if (url.endsWith('/snapshots')) return reply({ snapshots: [snapshot('new'), snapshot('old')] });
      if (url.endsWith('/capabilities')) return reply({ nmap: { available: true, enabled: true } });
      return reply({ fromScanId: 'old', toScanId: 'new' });
    });
    await ctx.model.loadNetworkSnapshots();
    expect(ctx.request).toHaveBeenCalledWith('/api/portal/network/snapshots', {
      headers: { Authorization: 'Bearer token-a' },
    });
    expect(ctx.request.mock.calls.some(([url]) => url.includes('/old/compare/new'))).toBe(true);
    expect(ctx.model.latestNetworkSnapshot.value?.scanId).toBe('new');
    expect(ctx.model.networkSnapshotComparison.value?.fromScanId).toBe('old');
    ctx.wrapper.unmount();
  });

  it('discards a delayed previous-site response instead of leaking evidence', async () => {
    let release!: (value: Response) => void;
    const ctx = setup(async url => url.endsWith('/snapshots')
      ? new Promise<Response>(resolve => { release = resolve; })
      : reply({ nmap: { available: true, enabled: true } }));
    const pending = ctx.model.loadNetworkSnapshots();
    ctx.scope.value = 'tenant:site-b';
    release(reply({ snapshots: [snapshot('old-site')] }));
    await pending;
    expect(ctx.model.networkSnapshots.value).toEqual([]);
    expect(ctx.model.latestNetworkSnapshot.value).toBeNull();
    expect(ctx.request).toHaveBeenCalledTimes(1);
    ctx.wrapper.unmount();
  });

  it('clears snapshots on signout without anonymous requests', async () => {
    const ctx = setup(async url => url.endsWith('/snapshots')
      ? reply({ snapshots: [snapshot('site-a')] })
      : reply({ nmap: { available: false, enabled: false } }));
    await ctx.model.loadNetworkSnapshots();
    ctx.token.value = '';
    expect(ctx.model.networkSnapshots.value).toEqual([]);
    expect(ctx.model.nmapCapability.value).toBeNull();
    await ctx.model.loadNetworkSnapshots();
    expect(ctx.request).toHaveBeenCalledTimes(2);
    ctx.wrapper.unmount();
  });

  it('accepts only the latest overlapping request for one site', async () => {
    let release!: (value: Response) => void;
    const ctx = setup(vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }))
      .mockImplementationOnce(async () => reply({ snapshots: [snapshot('latest')] }))
      .mockImplementationOnce(async () => reply({ nmap: { available: false, enabled: false } })));
    const old = ctx.model.loadNetworkSnapshots();
    await ctx.model.loadNetworkSnapshots();
    release(reply({ snapshots: [snapshot('stale')] }));
    await old;
    expect(ctx.model.latestNetworkSnapshot.value?.scanId).toBe('latest');
    ctx.wrapper.unmount();
  });
});
