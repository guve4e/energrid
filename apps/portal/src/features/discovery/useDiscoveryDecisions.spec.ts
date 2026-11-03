import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useDiscoveryDecisions } from './useDiscoveryDecisions';

const candidate = { id: 'shellyplus1-001', displayName: 'Lab Shelly', metadata: {} };
const response = (body: object = { status: 'approved' }, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response;

function harness(config: { request?: (url: string, init?: RequestInit) => Promise<Response>; confirm?: boolean } = {}) {
  const token = ref('token-a');
  const site = ref('tenant:site-a');
  const requestImpl: (url: string, init?: RequestInit) => Promise<Response> = config.request || (async () => response());
  const request = vi.fn(requestImpl);
  const onRefresh = vi.fn(async () => {});
  const onLog = vi.fn();
  const onApproved = vi.fn();
  const confirm = vi.fn(() => config.confirm ?? true);
  let model!: ReturnType<typeof useDiscoveryDecisions>;
  const wrapper = mount(defineComponent({
    setup() {
      model = useDiscoveryDecisions({
        apiBase: '/api', token, siteScope: () => site.value,
        request: request as unknown as typeof import('../../auth/auth-client').authFetch,
        onRefresh, onLog, onApproved, confirm,
      });
      return () => h('div');
    },
  }));
  return { model, wrapper, token, site, request, onRefresh, onLog, onApproved, confirm };
}

afterEach(() => vi.restoreAllMocks());

describe('Discovery decision lifecycle', () => {
  it('preserves distinct approval and block contracts and refreshes only after success', async () => {
    const setup = harness();
    await setup.model.applyDiscoveryDecision(candidate, 'approve', 'kitchen');
    expect(setup.request).toHaveBeenCalledWith('/api/portal/discovery/shellyplus1-001/approve', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer token-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoneId: 'kitchen' }),
    }));
    expect(setup.onRefresh).toHaveBeenCalledTimes(1);
    expect(setup.onApproved).toHaveBeenCalledTimes(1);
    await setup.model.applyDiscoveryDecision(candidate, 'block');
    expect(setup.onApproved).toHaveBeenCalledTimes(1);
    expect(setup.onRefresh).toHaveBeenCalledTimes(2);
    expect(setup.model.discoveryDecisionBusy.value).toEqual({});
    setup.wrapper.unmount();
  });

  it('does not silently acknowledge a contradictory device profile', async () => {
    const setup = harness({ confirm: false });
    await setup.model.applyDiscoveryDecision({ ...candidate, metadata: {
      requiresProfileReconciliation: true, component: 'switch:0', historicalComponentConflicts: 'switch:1',
    } }, 'approve');
    expect(setup.confirm).toHaveBeenCalledWith(expect.stringContaining('Historical MQTT component evidence'));
    expect(setup.request).not.toHaveBeenCalled();
    setup.wrapper.unmount();
    const accepted = harness();
    await accepted.model.applyDiscoveryDecision({ ...candidate, metadata: { requiresProfileReconciliation: true } }, 'approve');
    expect(accepted.request.mock.calls[0][1]?.body).toBe(JSON.stringify({ profileConflictAcknowledged: true }));
    accepted.wrapper.unmount();
  });

  it('verifies physical identity but never enrolls without a separate decision', async () => {
    const setup = harness({ request: async () => response({ physicalId: 'shellyplus1-001' }) });
    await setup.model.verifyPendingShelly(candidate.id);
    expect(setup.request).toHaveBeenCalledWith('/api/portal/discovery/shellyplus1-001/verify-shelly', expect.objectContaining({ method: 'POST' }));
    expect(setup.model.shellyVerificationMessages.value[candidate.id]).toContain('Enrollment is still a separate operator action');
    expect(setup.onApproved).not.toHaveBeenCalled();
    setup.wrapper.unmount();
  });

  it('refuses duplicate concurrent requests and discards a previous-site result', async () => {
    let release!: (response: Response) => void;
    const setup = harness({ request: () => new Promise(resolve => { release = resolve; }) });
    const pending = setup.model.applyDiscoveryDecision(candidate, 'approve');
    await setup.model.applyDiscoveryDecision(candidate, 'block');
    expect(setup.request).toHaveBeenCalledTimes(1);
    setup.site.value = 'tenant:site-b';
    release(response());
    await pending;
    expect(setup.onRefresh).not.toHaveBeenCalled();
    expect(setup.onApproved).not.toHaveBeenCalled();
    expect(setup.model.discoveryDecisionBusy.value).toEqual({});
    setup.wrapper.unmount();
  });

  it('clears private verification results on logout and rejects server errors', async () => {
    const setup = harness({ request: async () => response({ message: 'Approval forbidden' }, false, 403) });
    await setup.model.applyDiscoveryDecision(candidate, 'approve');
    expect(setup.model.discoveryDecisionError.value).toBe('Approval forbidden');
    expect(setup.onRefresh).not.toHaveBeenCalled();
    setup.token.value = '';
    expect(setup.model.discoveryDecisionError.value).toBe('');
    await setup.model.verifyPendingShelly(candidate.id);
    expect(setup.request).toHaveBeenCalledTimes(1);
    setup.wrapper.unmount();
  });
});
