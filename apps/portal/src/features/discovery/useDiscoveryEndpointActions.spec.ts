import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useDiscoveryEndpointActions } from './useDiscoveryEndpointActions';

const endpoint = { scanId: 'scan one', scopeId: 'lab', ipAddress: '172.30.250.3', endpointId: 'rpc' };
const reply = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => value }) as Response;
const path = '/api/portal/network/snapshots/scan%20one/scopes/lab/endpoints/172.30.250.3/rpc';
function setup(options: { request?: (url: string, init?: RequestInit) => Promise<Response>; consent?: boolean; available?: boolean } = {}) {
  const token = ref('token-a');
  const site = ref('tenant:site-a');
  const stateError = ref('');
  const request = vi.fn(options.request || (async () => reply({ candidates: [{ id: 'candidate' }] })));
  const loadState = vi.fn(async () => {});
  const loadNetworkSnapshots = vi.fn(async () => {});
  const navigateToDiscovery = vi.fn();
  const loadLlmProviderAvailability = vi.fn(async () => ({
    mode: 'local-only' as const, provider: 'local', available: options.available ?? true,
    cloudDataConsentRequired: true,
  }));
  const confirmCloudEvidence = vi.fn(async () => options.consent ?? true);
  let model!: ReturnType<typeof useDiscoveryEndpointActions>;
  const wrapper = mount(defineComponent({
    setup() {
      model = useDiscoveryEndpointActions({
        apiBase: '/api', accessToken: token, siteScope: () => site.value,
        stateError, loadState, loadNetworkSnapshots, navigateToDiscovery,
        loadLlmProviderAvailability, confirmCloudEvidence,
        request: request as unknown as typeof import('../../auth/auth-client').authFetch,
      });
      return () => h('div');
    },
  }));
  return { model, token, site, stateError, request, loadState, loadNetworkSnapshots,
    navigateToDiscovery, loadLlmProviderAvailability, confirmCloudEvidence, wrapper };
}
afterEach(() => vi.restoreAllMocks());

describe('site-local discovery endpoint actions', () => {
  it('starts onboarding review without automatically enrolling a device', async () => {
    const ctx = setup();
    await ctx.model.startNetworkEndpointOnboarding(endpoint);
    expect(ctx.request).toHaveBeenCalledWith(`${path}/start-onboarding`, expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer token-a', 'Content-Type': 'application/json' },
    }));
    expect(ctx.loadState).toHaveBeenCalledTimes(1);
    expect(ctx.navigateToDiscovery).toHaveBeenCalledTimes(1);
    expect(ctx.request).toHaveBeenCalledTimes(1);
    expect(ctx.model.onboardingNetworkEndpoint.value).toBe(false);
    ctx.wrapper.unmount();
  });

  it('does not navigate or claim enrollment without verified candidates', async () => {
    const ctx = setup({ request: async () => reply({ candidates: [] }) });
    await ctx.model.startNetworkEndpointOnboarding(endpoint);
    expect(ctx.stateError.value).toContain('No verified onboarding candidates');
    expect(ctx.loadState).not.toHaveBeenCalled();
    expect(ctx.navigateToDiscovery).not.toHaveBeenCalled();
    ctx.wrapper.unmount();
  });

  it('rejects delayed previous-site onboarding results', async () => {
    let release!: (value: Response) => void;
    const ctx = setup({ request: () => new Promise(resolve => { release = resolve; }) });
    const pending = ctx.model.startNetworkEndpointOnboarding(endpoint);
    ctx.site.value = 'tenant:site-b';
    release(reply({ candidates: [{ id: 'wrong-site' }] }));
    await pending;
    expect(ctx.loadState).not.toHaveBeenCalled();
    expect(ctx.navigateToDiscovery).not.toHaveBeenCalled();
    expect(ctx.stateError.value).toBe('');
    ctx.wrapper.unmount();
  });

  it('does not send cloud evidence when explicit consent is refused', async () => {
    const ctx = setup({ consent: false });
    await ctx.model.investigateSnapshotEndpoint(endpoint);
    expect(ctx.loadLlmProviderAvailability).toHaveBeenCalledTimes(1);
    expect(ctx.confirmCloudEvidence).toHaveBeenCalledTimes(1);
    expect(ctx.request).not.toHaveBeenCalled();
    expect(Object.values(ctx.model.networkEndpointInvestigations.value).every(entry => !entry.loading)).toBe(true);
    ctx.wrapper.unmount();
  });

  it('refuses AI investigation if no provider is available', async () => {
    const ctx = setup({ available: false });
    await ctx.model.investigateSnapshotEndpoint(endpoint);
    expect(ctx.confirmCloudEvidence).not.toHaveBeenCalled();
    expect(ctx.request).not.toHaveBeenCalled();
    ctx.wrapper.unmount();
  });

  it('performs only the explicitly requested HTTP probe with bounded arguments', async () => {
    const ctx = setup({ request: async () => reply({ status: 'ok' }) });
    await ctx.model.probeSnapshotEndpoint({ ...endpoint, refreshId: 'refresh-1' });
    expect(ctx.request).toHaveBeenCalledWith(`${path}/probe-http`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ approved: true, refreshId: 'refresh-1' }),
    }));
    expect(ctx.request).toHaveBeenCalledTimes(1);
    ctx.wrapper.unmount();
  });
});
