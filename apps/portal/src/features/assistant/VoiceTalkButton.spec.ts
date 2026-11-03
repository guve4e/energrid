import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import VoiceTalkButton from './VoiceTalkButton.vue';

describe('reusable hold-to-talk control', () => {
  it('emits press and release pointer events', async () => {
    const page = mount(VoiceTalkButton, { props: { recording: false, status: 'idle', pending: false } });
    await page.get('button').trigger('pointerdown');
    await page.get('button').trigger('pointerup');
    expect(page.emitted('start')).toHaveLength(1);
    expect(page.emitted('stop')).toHaveLength(1);
  });
  it('disables both variants while confirmation is pending', async () => {
    const page = mount(VoiceTalkButton, { props: { variant: 'home', recording: false, status: 'idle', pending: true } });
    expect(page.get('button').attributes('disabled')).toBeDefined();
    await page.get('button').trigger('pointerdown');
    expect(page.emitted('start')).toBeUndefined();
    expect(page.text()).toContain('Натисни');
  });
});
