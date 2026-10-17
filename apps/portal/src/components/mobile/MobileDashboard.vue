<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DashboardNotification } from '../../notifications';
import WakeWordSamples from '../home/WakeWordSamples.vue';

type Device = {
  id: string;
  displayName: string;
  zoneName: string;
  capabilities: Array<{ kind: string; actions: string[]; unit?: string }>;
  control?: { status?: string };
  state: {
    status: string;
    observedAt: string | null;
    values: Record<string, number | boolean | string | null>;
    command?: { status: string };
  };
};
type Sensor = { id: string; name: string; capability: string; value: number | boolean | null; unit?: string; observedAt: string };

const props = defineProps<{
  siteName: string;
  tenantName: string;
  devices: Device[];
  sensors: Sensor[];
  unreadCount: number;
  notifications: DashboardNotification[];
  actionBusy: Record<string, boolean>;
  actionErrors: Record<string, string>;
  notificationsAvailable: boolean;
}>();
const emit = defineEmits<{
  action: [deviceId: string, action: 'turn_on' | 'turn_off'];
  assistant: [];
  notificationsTest: [];
  notificationRead: [id: string];
}>();

const tab = ref<'home' | 'devices' | 'energy' | 'settings'>('home');
const onlineCount = computed(() => props.devices.filter((device) => device.state.status === 'online').length);
const controllable = computed(() => props.devices.filter((device) =>
  device.capabilities?.some((capability) => capability.actions.includes('turn_on') && capability.actions.includes('turn_off')),
));
const powerDevices = computed(() => props.devices.filter((device) =>
  device.capabilities?.some((capability) => capability.kind === 'power') && typeof device.state.values?.power === 'number',
));
const temperatures = computed(() => props.sensors.filter((sensor) => sensor.capability === 'temperature' && typeof sensor.value === 'number'));
const on = (device: Device) => device.state.values?.on === true;
const statusLabel = (status: string) => status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Unknown';
</script>

<template>
  <main class="mobile-experience">
    <header class="mobile-header">
      <div><span class="mobile-eyebrow">ENERGRID · {{ tenantName }}</span><h1>{{ siteName }}</h1><p><span class="mobile-live-dot"></span>{{ onlineCount }} of {{ devices.length }} devices online</p></div>
      <button class="mobile-bell" type="button" aria-label="Notifications" @click="tab = 'alerts'"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span v-if="unreadCount">{{ unreadCount > 9 ? '9+' : unreadCount }}</span></button>
    </header>

    <section v-if="tab === 'home'" class="mobile-content">
      <div class="mobile-section-heading"><h2>Home now</h2><span>Live site data</span></div>
      <div class="mobile-metric-grid">
        <article><span>Indoor temperature</span><strong>{{ temperatures.length ? `${Number(temperatures[0].value).toFixed(1)}°` : '—' }}</strong><small>{{ temperatures[0]?.name || 'No temperature sensor' }}</small></article>
        <article><span>Connected</span><strong>{{ onlineCount }}<small> / {{ devices.length }}</small></strong><small>registered devices</small></article>
      </div>
      <div class="mobile-section-heading"><h2>Quick controls</h2><button type="button" @click="tab = 'devices'">All devices</button></div>
      <div v-if="controllable.length" class="mobile-controls">
        <article v-for="device in controllable.slice(0, 4)" :key="device.id" class="mobile-device-row">
          <div><strong>{{ device.displayName }}</strong><small>{{ device.zoneName }} · {{ statusLabel(device.state.status) }}</small><small v-if="actionErrors[device.id]" class="mobile-error">{{ actionErrors[device.id] }}</small></div>
          <button type="button" :disabled="actionBusy[device.id] || device.state.command?.status === 'pending' || device.control?.status !== 'ready'" :aria-label="`${on(device) ? 'Turn off' : 'Turn on'} ${device.displayName}`" @click="emit('action', device.id, on(device) ? 'turn_off' : 'turn_on')">{{ actionBusy[device.id] ? '…' : on(device) ? 'On' : 'Off' }}</button>
        </article>
      </div>
      <p v-else class="mobile-empty">No controllable devices are configured.</p>
      <section v-if="unreadCount" class="mobile-alert-strip"><strong>{{ unreadCount }} unread alert{{ unreadCount === 1 ? '' : 's' }}</strong><span>Open Settings to review this browser's notification inbox.</span></section>
    </section>

    <section v-else-if="tab === 'devices'" class="mobile-content">
      <div class="mobile-section-heading"><h2>Devices</h2><span>{{ devices.length }} total</span></div>
      <article v-for="device in devices" :key="device.id" class="mobile-device-card">
        <div class="mobile-device-title"><div><strong>{{ device.displayName }}</strong><small>{{ device.zoneName }}</small></div><span :class="['mobile-status', device.state.status]">{{ statusLabel(device.state.status) }}</span></div>
        <div v-if="device.capabilities.some((capability) => capability.actions.includes('turn_on') && capability.actions.includes('turn_off'))" class="mobile-device-control">
          <span>{{ on(device) ? 'On' : 'Off' }}</span><div><button type="button" :disabled="actionBusy[device.id] || device.control?.status !== 'ready'" @click="emit('action', device.id, 'turn_off')">Off</button><button type="button" :disabled="actionBusy[device.id] || device.control?.status !== 'ready'" @click="emit('action', device.id, 'turn_on')">On</button></div>
        </div>
        <p v-if="actionErrors[device.id]" class="mobile-error">{{ actionErrors[device.id] }}</p>
        <small class="mobile-updated">{{ device.state.observedAt ? `Updated ${new Date(device.state.observedAt).toLocaleTimeString()}` : 'No recent reading' }}</small>
      </article>
    </section>

    <section v-else-if="tab === 'energy'" class="mobile-content">
      <div class="mobile-section-heading"><h2>Energy</h2><span>Measured device readings</span></div>
      <article v-for="device in powerDevices" :key="device.id" class="mobile-device-card"><div class="mobile-device-title"><div><strong>{{ device.displayName }}</strong><small>{{ device.zoneName }}</small></div><strong>{{ Number(device.state.values.power).toFixed(0) }} W</strong></div></article>
      <p v-if="!powerDevices.length" class="mobile-empty">No live power readings are configured for this site yet.</p>
    </section>

    <section v-else-if="tab === 'alerts'" class="mobile-content">
      <div class="mobile-section-heading"><button type="button" @click="tab = 'home'">Back</button><h2>Notifications</h2><span>{{ unreadCount }} unread</span></div>
      <article v-for="notification in notifications" :key="notification.id" :class="['mobile-notification', { unread: !notification.readAt }]" @click="emit('notificationRead', notification.id)">
        <span :class="['notification-mark', notification.severity]"></span><div><strong>{{ notification.title }}</strong><p>{{ notification.message }}</p><small>{{ new Date(notification.createdAt).toLocaleString() }}</small></div>
      </article>
      <p v-if="!notifications.length" class="mobile-empty">You're all caught up.</p>
    </section>

    <section v-else class="mobile-content">
      <div class="mobile-section-heading"><h2>Settings</h2><span>Energrid Mobile</span></div>
      <WakeWordSamples />
      <article class="mobile-settings-row"><div><strong>Phone notifications</strong><small>Send a test alert to the Android notification shade.</small></div><button type="button" :disabled="!notificationsAvailable" @click="emit('notificationsTest')">Send test</button></article>
      <p v-if="!notificationsAvailable" class="mobile-empty">Native notification testing is available in the Energrid Android app.</p>
      <article class="mobile-settings-row"><div><strong>Assistant</strong><small>Open the existing Energrid assistant.</small></div><button type="button" @click="emit('assistant')">Open</button></article>
    </section>

    <nav class="mobile-tabbar" aria-label="Main navigation">
      <button :class="{ selected: tab === 'home' }" @click="tab = 'home'"><span>⌂</span>Home</button>
      <button :class="{ selected: tab === 'devices' }" @click="tab = 'devices'"><span>▦</span>Devices</button>
      <button :class="{ selected: tab === 'energy' }" @click="tab = 'energy'"><span>ϟ</span>Energy</button>
      <button @click="emit('assistant')"><span>◉</span>Assistant</button>
      <button :class="{ selected: tab === 'settings' }" @click="tab = 'settings'"><span>⚙</span>Settings</button>
    </nav>
  </main>
</template>

<style scoped>
.mobile-experience{min-height:100dvh;background:#f4f7fb;color:#111827;padding:20px 18px 94px;font-family:Inter,system-ui,sans-serif}.mobile-header{display:flex;justify-content:space-between;align-items:flex-start;max-width:720px;margin:0 auto 24px}.mobile-eyebrow{font-size:11px;color:#2863e6;font-weight:800}.mobile-header h1{font-size:28px;margin:5px 0}.mobile-header p{margin:0;color:#65728a;font-size:13px}.mobile-live-dot{display:inline-block;width:8px;height:8px;background:#16a56a;border-radius:50%;margin-right:7px}.mobile-bell{position:relative;width:44px;height:44px;border:1px solid #dce3ee;border-radius:14px;background:#fff;color:#192334;font-size:20px}.mobile-bell span{position:absolute;right:-5px;top:-5px;border-radius:10px;background:#d92d20;color:#fff;padding:2px 5px;font-size:10px}.mobile-content{max-width:720px;margin:auto;display:grid;gap:14px}.mobile-section-heading{display:flex;align-items:center;justify-content:space-between;margin-top:8px}.mobile-section-heading h2{font-size:18px;margin:0}.mobile-section-heading span,.mobile-section-heading button{font-size:12px;color:#667085}.mobile-section-heading button{border:0;background:none;font-weight:700}.mobile-metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mobile-metric-grid article,.mobile-device-card,.mobile-controls,.mobile-alert-strip,.mobile-settings-row{background:#fff;border:1px solid #dfe6ef;border-radius:12px;padding:15px}.mobile-metric-grid article{display:grid;gap:6px}.mobile-metric-grid span,.mobile-metric-grid small,.mobile-device-row small,.mobile-device-title small,.mobile-settings-row small{font-size:12px;color:#68758c}.mobile-metric-grid strong{font-size:28px}.mobile-metric-grid strong small{font-size:15px}.mobile-controls{padding:0 14px}.mobile-device-row,.mobile-device-title,.mobile-device-control,.mobile-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.mobile-device-row{padding:13px 0;border-bottom:1px solid #edf0f5}.mobile-device-row:last-child{border-bottom:0}.mobile-device-row div,.mobile-device-title div,.mobile-settings-row div{display:grid;gap:4px}.mobile-device-row button,.mobile-settings-row button{min-width:54px;border:1px solid #d6dfeb;border-radius:9px;background:#f7f9fc;padding:8px 10px;font-weight:800}.mobile-device-card{display:grid;gap:12px}.mobile-status{font-size:11px;font-weight:800}.mobile-status.online{color:#168253}.mobile-status.offline{color:#c3342b}.mobile-status.unknown{color:#9a6812}.mobile-device-control{padding-top:11px;border-top:1px solid #edf0f5}.mobile-device-control div{display:flex;gap:6px}.mobile-device-control button{border:1px solid #d6dfeb;border-radius:8px;background:#f8fafc;padding:7px 14px}.mobile-updated{color:#758198;font-size:11px}.mobile-error{color:#c3342b;font-size:12px}.mobile-empty{padding:18px;border:1px dashed #cbd5e1;border-radius:12px;color:#667085;font-size:13px;line-height:1.5}.mobile-alert-strip{display:grid;gap:4px;border-color:#f2d38d;background:#fff9e9}.mobile-alert-strip span{font-size:12px;color:#765919}.mobile-tabbar{position:fixed;z-index:30;bottom:0;left:0;right:0;display:flex;justify-content:space-around;padding:8px 4px max(8px,env(safe-area-inset-bottom));background:#fff;border-top:1px solid #e2e8f0}.mobile-tabbar button{display:grid;gap:2px;justify-items:center;border:0;background:transparent;color:#667085;font-size:10px;min-width:52px}.mobile-tabbar button span{font-size:18px}.mobile-tabbar button.selected{color:#2863e6;font-weight:800}@media(min-width:700px){.mobile-experience{padding-top:34px}.mobile-header h1{font-size:34px}}
.mobile-experience{background:#111821;color:#f3f6fa}.mobile-bell,.mobile-metric-grid article,.mobile-device-card,.mobile-controls,.mobile-alert-strip,.mobile-settings-row,.mobile-tabbar,.mobile-notification{background:#1b2632;border-color:#334155;color:#f3f6fa}.mobile-tabbar{border-top-color:#334155}.mobile-tabbar button{color:#a4b0c0}.mobile-tabbar button.selected{color:#75a4ff}.mobile-metric-grid span,.mobile-metric-grid small,.mobile-device-row small,.mobile-device-title small,.mobile-settings-row small,.mobile-section-heading span,.mobile-section-heading button,.mobile-header p{color:#a5b1c2}.mobile-device-row,.mobile-device-control{border-color:#334155}.mobile-device-row button,.mobile-settings-row button,.mobile-device-control button{background:#253240;border-color:#405168;color:#f3f6fa}.mobile-empty{border-color:#405168;color:#a5b1c2}.mobile-alert-strip{background:#302817;border-color:#6b5728}.mobile-alert-strip span{color:#eed795}.mobile-live-dot{background:#48c78e}.mobile-section-heading h2,.mobile-device-row strong,.mobile-device-title strong,.mobile-settings-row strong{color:#f3f6fa}.mobile-device-control>span{color:#d9e2ef}.mobile-status.online{color:#48c78e}.mobile-status.offline{color:#ff897e}.mobile-status.unknown{color:#f5bd55}.mobile-bell svg{width:20px;height:20px}.mobile-section-heading>button{border:0;background:transparent;color:#75a4ff;font-weight:800}.mobile-notification{display:flex;gap:12px;padding:15px;border:1px solid #334155;border-radius:12px}.mobile-notification.unread{background:#202e3e}.mobile-notification>div{min-width:0}.mobile-notification strong{font-size:14px}.mobile-notification p{margin:4px 0;color:#c1ccda;font-size:13px;overflow-wrap:anywhere}.mobile-notification small{color:#93a0b3;font-size:11px}.notification-mark{width:9px;height:9px;flex:0 0 auto;margin-top:5px;border-radius:50%;background:#75a4ff}.notification-mark.warning{background:#f5bd55}.notification-mark.critical{background:#ff746a}
</style>
