import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import VoiceActionConfirmation from './VoiceActionConfirmation.vue';

const action = { type: 'light.turn_on', deviceId: 'relay-1', room: null, value: null, risk: 'low' };
describe('shared explicit confirmation', () => {
  it('requires an explicit click and renders the authorized action', async () => {
    const wrapper = mount(VoiceActionConfirmation, { props: {
      pending: { approvalId: 'p1', expiresAt: Date.now() + 10000, actions: [action] },
    } });
    expect(wrapper.text()).toContain('relay-1');
    expect(wrapper.emitted('confirm')).toBeUndefined();
    await wrapper.get('.approval-actions .primary').trigger('click');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    await wrapper.get('.approval-actions .secondary').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
  it('does not offer confirmation after expiry', () => {
    const wrapper = mount(VoiceActionConfirmation, { props: {
      variant: 'home', pending: { approvalId: 'p2', expiresAt: Date.now() - 100, actions: [action] },
    } });
    expect(wrapper.get('.home-assistant-confirm').attributes('disabled')).toBeDefined();
  });
});
