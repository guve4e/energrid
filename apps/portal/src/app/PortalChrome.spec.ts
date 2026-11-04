import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PortalChrome from './PortalChrome.vue';

const props = {
  theme: 'dark', mobileMenuOpen: false, notificationsOpen: false,
  userMenuOpen: false, userInitials: 'TE',
  user: { id: '1', email: 'technician@example.test', name: 'Test Engineer', role: 'admin' },
  navItems: [{ id: 'devices', label: 'Devices', active: true }, { id: 'discovery', label: 'Discovery', active: false }],
  state: { tenant: { id: 't', name: 'Tenant' }, site: { id: 'site-home', name: 'Home' },
    sites: [{ id: 'site-home', name: 'Home' }, { id: 'site-lab', name: 'Lab' }] } as any,
  siteSwitchBusy: false, siteSwitchError: '',
};

describe('PortalChrome', () => {
  it('keeps navigation and site switching explicit at the app boundary', async () => {
    const page = mount(PortalChrome, { props, slots: { default: '<p class="content-marker">content</p>' } });
    expect(page.get('.content-marker').text()).toBe('content');
    expect(page.get('button.active').text()).toContain('Devices');
    await page.findAll('.side-nav button')[1].trigger('click');
    expect(page.emitted('navigate')?.[0]).toEqual(['discovery']);
    await page.get('select[aria-label="Select site"]').setValue('site-lab');
    const events = page.emitted('siteSwitch');
    expect(events).toHaveLength(1);
    expect((events?.[0]?.[0] as Event).target).toBeTruthy();
  });
  it('exposes sign-out and theme controls without modifying auth state itself', async () => {
    const page = mount(PortalChrome, { props: { ...props, userMenuOpen: true } });
    await page.get('.user-popover button').trigger('click');
    expect(page.emitted('logout')).toHaveLength(1);
    await page.get('.topbar button[aria-label="Use light theme"]').trigger('click');
    expect(page.emitted('toggleTheme')).toHaveLength(1);
  });
});
