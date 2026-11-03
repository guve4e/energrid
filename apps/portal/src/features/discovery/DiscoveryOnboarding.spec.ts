import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import DiscoveryOnboarding from './DiscoveryOnboarding.vue';

describe('Discovery onboarding presentation', () => {
  it('renders pending review without silently approving it', async () => {
    const approve = vi.fn();
    const model = {
      discoveredDevices: ref([{ id: 'new-device' }]),
      approvedOnboardingDevices: ref([]), pendingEnrollmentCards: ref([{ id: 'new-device' }]),
      state: ref({ site: { name: 'Lab' }, tenant: { name: 'Owner' }, zones: [] }),
      discoveryDecisionBusy: ref({}), shellyVerificationMessages: ref({}),
      discoveryDecisionError: ref(''), applyPendingDecision: approve,
      verifyPendingShelly: vi.fn(), renamePendingCandidate: vi.fn(),
      openApprovedDevice: vi.fn(),
    };
    const wrapper = mount(DiscoveryOnboarding, {
      props: { model: model as any },
      global: { stubs: { PendingEnrollmentList: { template: '<button @click="$emit(\'decide\', \'new-device\', \'approve\')">Approve</button>' } } },
    });
    expect(wrapper.text()).toContain('1 pending');
    expect(approve).not.toHaveBeenCalled();
    await wrapper.find('button').trigger('click');
    expect(approve).toHaveBeenCalledWith('new-device', 'approve');
  });

  it('opens approved devices via the shared navigation callback', async () => {
    const open = vi.fn();
    const approved = { id: 'enrolled-1', displayName: 'Lab relay', zoneName: 'Lab', adapter: { driver: 'Shelly', protocol: 'http' }, capabilities: [{ kind: 'switch' }] };
    const wrapper = mount(DiscoveryOnboarding, {
      props: { model: {
        discoveredDevices: ref([]), approvedOnboardingDevices: ref([approved]), pendingEnrollmentCards: ref([]),
        state: ref(null), discoveryDecisionBusy: ref({}), shellyVerificationMessages: ref({}),
        discoveryDecisionError: ref(''), applyPendingDecision: vi.fn(), verifyPendingShelly: vi.fn(),
        renamePendingCandidate: vi.fn(), openApprovedDevice: open,
      } as any },
    });
    await wrapper.find('button.primary').trigger('click');
    expect(open).toHaveBeenCalledWith(approved);
  });
});
