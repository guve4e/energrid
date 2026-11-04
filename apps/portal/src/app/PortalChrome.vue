<script setup lang="ts">
import type { PortalState } from '../portal-state';
type User = { id: string; email: string; name: string; role: string } | null;
type NavItem = { id: string; label: string; active: boolean };
defineProps<{
  theme: string;
  mobileMenuOpen: boolean;
  notificationsOpen: boolean;
  userMenuOpen: boolean;
  userInitials: string;
  user: User;
  navItems: NavItem[];
  state: PortalState | null;
  siteSwitchBusy: boolean;
  siteSwitchError: string;
}>();
const emit = defineEmits<{
  openMobileMenu: []; closeMobileMenu: [];
  toggleNotifications: []; toggleTheme: []; toggleUserMenu: [];
  logout: []; navigate: [id: string]; siteSwitch: [event: Event];
}>();
const notifications = [
  { tone: 'green', text: 'Kitchen temperature sensor online' },
  { tone: 'blue', text: 'Voice gateway ready' },
  { tone: 'amber', text: 'Local STT can be slow on Pi CPU' },
];
</script>
<template>
  <main
    :class="['admin-shell', `theme-${theme}`, { 'menu-open': mobileMenuOpen }]"
  >
    <header class="mobile-appbar">
      <button
        class="menu-button"
        type="button"
        aria-label="Open navigation"
        @click="emit('openMobileMenu')"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>
      <div class="brand-lockup">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <strong>Energrid</strong>
          <span>Бъдещето е тук</span>
        </div>
      </div>
      <div class="mobile-actions">
        <div class="notification-area">
          <button
            class="icon-button"
            type="button"
            aria-label="Notifications"
            @click="emit('toggleNotifications')"
          >
            <span aria-hidden="true">●</span>
          </button>
          <div v-if="notificationsOpen" class="popover notification-popover">
            <strong>Notifications</strong>
            <ul>
              <li
                v-for="notification in notifications"
                :key="notification.text"
              >
                <span :class="['dot', notification.tone]"></span>
                {{ notification.text }}
              </li>
            </ul>
          </div>
        </div>
        <button
          class="icon-button"
          type="button"
          :aria-label="theme === 'light' ? 'Use dark theme' : 'Use light theme'"
          @click="emit('toggleTheme')"
        >
          <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☼' }}</span>
        </button>
        <button
          class="avatar-button mobile-avatar"
          type="button"
          aria-label="Account menu"
          @click="emit('toggleUserMenu')"
        >
          <span>{{ userInitials }}</span>
        </button>
      </div>
    </header>

    <button
      v-if="mobileMenuOpen"
      class="drawer-backdrop"
      type="button"
      aria-label="Close navigation"
      @click="emit('closeMobileMenu')"
    ></button>

    <aside class="sidebar">
      <button
        class="drawer-close"
        type="button"
        aria-label="Close navigation"
        @click="emit('closeMobileMenu')"
      >
        ×
      </button>
      <div class="brand-lockup">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <strong>Energrid</strong>
          <span>Бъдещето е тук</span>
        </div>
      </div>

      <nav class="side-nav" aria-label="Portal navigation">
        <button
          v-for="item in navItems"
          :key="item.label"
          :class="{ active: item.active }"
          type="button"
          @click="emit('navigate', item.id)"
        >
          <span class="nav-icon" aria-hidden="true">
            <svg v-if="item.id === 'assistant'" viewBox="0 0 24 24">
              <path d="M4 11.5 12 5l8 6.5" />
              <path d="M7 10.5V19h10v-8.5" />
            </svg>
            <svg v-else-if="item.id === 'devices'" viewBox="0 0 24 24">
              <path d="M6 6h5v5H6zM13 6h5v5h-5zM6 13h5v5H6zM13 13h5v5h-5z" />
            </svg>
            <svg v-else-if="item.id === 'automations'" viewBox="0 0 24 24">
              <path d="M6 7h5l2 10h5" />
              <path d="M6 17h5l2-10h5" />
              <path d="M4 7h2M18 7h2M4 17h2M18 17h2" />
            </svg>
            <svg v-else-if="item.id === 'discovery'" viewBox="0 0 24 24">
              <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
              <path
                d="M8.5 8.5 6.4 6.4M15.5 15.5l2.1 2.1M15.5 8.5l2.1-2.1M8.5 15.5l-2.1 2.1"
              />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else-if="item.id === 'network-intelligence'" viewBox="0 0 24 24">
              <circle cx="5" cy="7" r="2" />
              <circle cx="18" cy="5" r="2" />
              <circle cx="16" cy="18" r="2" />
              <circle cx="6" cy="17" r="2" />
              <path d="m7 7 9-2M6 9l0 6M8 17l6 1M17 7l-1 9" />
            </svg>
            <svg v-else-if="item.id === 'bus'" viewBox="0 0 24 24">
              <path d="M5 7h14M5 12h14M5 17h14" />
              <path d="M8 5v4M16 10v4M11 15v4" />
            </svg>
            <svg v-else viewBox="0 0 24 24">
              <path d="M7 7h10M7 12h10M7 17h10" />
            </svg>
          </span>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section class="side-card">
        <span>Current site</span>
        <label class="site-selector-label">
          <span class="sr-only">Select site</span>
          <select
            :value="state?.site.id || 'site-home'"
            :disabled="siteSwitchBusy"
            aria-label="Select site"
            @change="emit('siteSwitch', $event)"
          >
            <option v-for="site in state?.sites || []" :key="site.id" :value="site.id">
              {{ site.name }}
            </option>
          </select>
        </label>
        <small>{{ state?.tenant.name || 'Energrid Demo' }}</small>
        <small v-if="siteSwitchError" role="alert">{{ siteSwitchError }}</small>
      </section>
    </aside>

    <section class="app-main">
      <header class="topbar">
        <div class="top-actions">
          <div class="notification-area">
            <button
              class="icon-button"
              type="button"
              aria-label="Notifications"
              @click="emit('toggleNotifications')"
            >
              <span aria-hidden="true">●</span>
            </button>
            <div v-if="notificationsOpen" class="popover notification-popover">
              <strong>Notifications</strong>
              <ul>
                <li
                  v-for="notification in notifications"
                  :key="notification.text"
                >
                  <span :class="['dot', notification.tone]"></span>
                  {{ notification.text }}
                </li>
              </ul>
            </div>
          </div>
          <button
            class="icon-button"
            type="button"
            :aria-label="
              theme === 'light' ? 'Use dark theme' : 'Use light theme'
            "
            @click="emit('toggleTheme')"
          >
            <span aria-hidden="true">{{ theme === 'light' ? '☾' : '☼' }}</span>
          </button>
          <div class="user-menu">
            <button
              class="avatar-button"
              type="button"
              aria-label="Account menu"
              @click="emit('toggleUserMenu')"
            >
              <span>{{ userInitials }}</span>
            </button>
            <div v-if="userMenuOpen" class="popover user-popover">
              <strong>{{ user?.name }}</strong>
              <span>{{ user?.email }}</span>
              <button class="secondary wide" type="button" @click="emit('logout')">
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <section class="workspace">
        <slot />
      </section>
      <slot name="modal" />
    </section>
    <slot name="floating" />
  </main>
</template>
