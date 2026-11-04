import { computed, ref, type Ref } from 'vue';
const themeKey = 'energrid.portal.theme.v2';
const labels = [
  ['home','Home'], ['mobile','Mobile'], ['display','Display'], ['assistant','Assistant'],
  ['devices','Devices'], ['discovery','Discovery'], ['network-intelligence','Network Intelligence'],
  ['bus','Bus'], ['systems','Systems'], ['energy','Energy'], ['expenses','Expenses'],
  ['weather','Weather'], ['executions','Executions'], ['logs','Logs'],
] as const;
/** Visual shell state. Navigation and authorization remain in the application coordinator. */
export function usePortalChromeState(activePage: Ref<string>, user: Ref<{name:string; email:string}|null>) {
  const theme = ref(localStorage.getItem(themeKey) || 'dark');
  const userMenuOpen = ref(false);
  const notificationsOpen = ref(false);
  const mobileMenuOpen = ref(false);
  const navItems = computed(() => labels.map(([id,label]) => ({ id, label, active: activePage.value === id })));
  const userInitials = computed(() => (user.value?.name || user.value?.email || 'EG')
    .split(/[\s@.]+/).filter(Boolean).slice(0,2).map(part => part[0]?.toUpperCase()).join(''));
  function toggleTheme() { theme.value = theme.value === 'light' ? 'dark' : 'light'; localStorage.setItem(themeKey, theme.value); }
  function toggleNotifications() { notificationsOpen.value = !notificationsOpen.value; userMenuOpen.value = false; }
  function toggleUserMenu() { userMenuOpen.value = !userMenuOpen.value; notificationsOpen.value = false; }
  function closeMobileMenu() { mobileMenuOpen.value = false; }
  function resetMenus() { userMenuOpen.value = false; notificationsOpen.value = false; mobileMenuOpen.value = false; }
  return { theme, userMenuOpen, notificationsOpen, mobileMenuOpen, navItems, userInitials,
    toggleTheme, toggleNotifications, toggleUserMenu, closeMobileMenu, resetMenus };
}
