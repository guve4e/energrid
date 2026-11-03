import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { PortalState } from '../../portal-state';
import { useDeviceMembership } from './useDeviceMembership';
import { testDevice, testState } from './device-test-fixtures';

function harness(requestImpl: (url: string) => Promise<Response>) {
  const accessToken = ref('token-a');
  const state = ref<PortalState | null>(testState());
  const request = vi.fn(requestImpl);
  let model!: ReturnType<typeof useDeviceMembership>;
  const wrapper = mount(defineComponent({ setup() {
    model = useDeviceMembership({ apiBase: '/api', accessToken, state,
      request: request as unknown as typeof import('../../auth/auth-client').authFetch });
    return () => h('div');
  } }));
  return { wrapper, state, model, request, accessToken };
}

describe('device enrollment membership', () => {
  it('reads enrolled membership and physical assignments without inventing them', async () => {
    const d = testDevice();
    const h = harness(async () => ({ ok: true, json: async () => ({ enrollments: [{
      tenantId: d.tenantId, siteId: d.siteId, deviceId: d.id, status: 'enrolled',
      physicalAssignments: [{ physicalDeviceId: 'shellyplus1-001', componentKey: 'switch:0' }],
    }] }) } as Response));
    await h.model.loadEnrollmentMembership();
    expect(h.model.enrolledDeviceKeys.value.has(JSON.stringify([d.tenantId, d.siteId, d.id]))).toBe(true);
    expect(h.model.lifecycleEnrollmentRecords.value[0].physicalAssignments).toHaveLength(1);
    h.wrapper.unmount();
  });
  it('fails closed for a malformed enrollment payload', async () => {
    const h = harness(async () => ({ ok: true, json: async () => ({ enrollments: [{ id: 'unsafe' }] }) } as Response));
    await h.model.loadEnrollmentMembership();
    expect(h.model.enrolledDeviceKeys.value.size).toBe(0);
    expect(h.model.enrollmentError.value).toContain('Invalid enrollment record');
    h.wrapper.unmount();
  });
  it('discards a delayed response after site switching', async () => {
    let release!: (response: Response) => void;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const old = h.model.loadEnrollmentMembership();
    h.state.value = testState([], 'site-b');
    release({ ok: true, json: async () => ({ enrollments: [{
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'old', status: 'enrolled',
    }] }) } as Response);
    await old;
    expect(h.model.enrolledDeviceKeys.value.size).toBe(0);
    h.wrapper.unmount();
  });
});
