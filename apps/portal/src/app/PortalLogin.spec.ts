import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PortalLogin from './PortalLogin.vue';

describe('PortalLogin', () => {
  it('keeps credentials controlled and emits deliberate sign-in', async () => {
    const page = mount(PortalLogin, { props: { email: '', password: '', theme: 'dark', loginError: '' } });
    await page.get('#email').setValue('technician@example.test');
    await page.get('#password').setValue('not-a-real-password');
    expect(page.emitted('update:email')?.at(-1)?.[0]).toBe('technician@example.test');
    expect(page.emitted('update:password')?.at(-1)?.[0]).toBe('not-a-real-password');
    await page.get('button.primary').trigger('click');
    expect(page.emitted('login')).toHaveLength(1);
  });
  it('displays authentication errors without authorizing a session', () => {
    const page = mount(PortalLogin, { props: { email: '', password: '', theme: 'light', loginError: 'Sign-in is temporarily unavailable.' } });
    expect(page.get('.error').text()).toContain('Sign-in is temporarily unavailable.');
    expect(page.classes()).toContain('theme-light');
    expect(page.emitted('login')).toBeUndefined();
  });
});
