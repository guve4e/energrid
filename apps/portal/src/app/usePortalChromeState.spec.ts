import { ref } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePortalChromeState } from './usePortalChromeState';

describe('usePortalChromeState', () => {
  beforeEach(() => localStorage.clear());
  it('derives navigation and initials reactively rather than storing copies', () => {
    const page = ref('devices');
    const user = ref({ name: 'Test Engineer', email: 'person@example.test' });
    const model = usePortalChromeState(page, user);
    expect(model.userInitials.value).toBe('TE');
    expect(model.navItems.value.find(item => item.id === 'devices')?.active).toBe(true);
    page.value = 'discovery';
    expect(model.navItems.value.find(item => item.id === 'discovery')?.active).toBe(true);
  });
  it('coordinates menu exclusivity and persists only visual preferences', () => {
    const model = usePortalChromeState(ref('home'), ref(null));
    model.toggleUserMenu();
    expect(model.userMenuOpen.value).toBe(true);
    model.toggleNotifications();
    expect(model.userMenuOpen.value).toBe(false);
    expect(model.notificationsOpen.value).toBe(true);
    model.toggleTheme();
    expect(localStorage.getItem('energrid.portal.theme.v2')).toBe('light');
    model.resetMenus();
    expect(model.notificationsOpen.value).toBe(false);
  });
});
