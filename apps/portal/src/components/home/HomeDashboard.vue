<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import HomeIntelligence from './HomeIntelligence.vue';
import { authFetch } from '../../auth/auth-client';
import { canSwitchDevice, type ControlSetupDevice } from '../devices/device-control';

type Device = Omit<ControlSetupDevice, 'capabilities' | 'adapter'> & {
  id: string;
  displayName: string;
  zoneName: string;
  capabilities: Array<{ kind: string; unit?: string; actions: string[] }>;
  adapter: ControlSetupDevice['adapter'] & { configured?: boolean };
  state: {
    values: Record<string, number | boolean | string | null>;
    observedAt: string | null;
    status: 'online' | 'offline' | 'unknown';
    observerReachability?: {
      status: 'reachable' | 'unreachable';
      checkedAt: string;
      targetIpAddress: string;
      networkScopeId: string;
      observer: { host: string };
    };
    command?: { status?: string };
  };
};

type PortalState = {
  site?: { name: string };
  devices?: Device[];
};

const props = defineProps<{
  apiBase: string;
  accessToken: string;
  nativeWakeAvailable: boolean;
  nativeWakeEnabled: boolean;
  nativeWakeStatus: string;
}>();
const emit = defineEmits<{
  'toggle-wake-word': [];
  assistant: [];
}>();

const now = ref(new Date());
const state = ref<PortalState | null>(null);
const error = ref('');
const loading = ref(true);

let clockTimer: ReturnType<typeof setInterval> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;

const time = computed(() =>
  new Intl.DateTimeFormat('bg-BG', {
    timeZone: 'Europe/Sofia',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now.value),
);

const date = computed(() =>
  new Intl.DateTimeFormat('bg-BG', {
    timeZone: 'Europe/Sofia',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now.value),
);

const devices = computed(() => state.value?.devices ?? []);

const climate = computed(() =>
  devices.value
    .filter((device) => {
      const hasClimateCapability = device.capabilities?.some(
        (capability) =>
          capability.kind === 'temperature' ||
          capability.kind === 'humidity',
      );
      const hasAuthorizedMeasurement = ['temperature', 'humidity'].some(
        (key) => {
          const value = device.state.values?.[key];
          return typeof value === 'number' && Number.isFinite(value);
        },
      );

      return device.trustStatus === 'approved' &&
        device.adapter?.protocol !== 'simulated' &&
        (hasClimateCapability || hasAuthorizedMeasurement) &&
        !/motion|occupancy|presence/i.test(device.displayName);
    })
    .sort((a, b) => {
      const priority = (device: Device) => {
        const name = `${device.zoneName} ${device.displayName}`.toLowerCase();
        if (name.includes('kitchen')) return 0;
        if (name.includes('garage')) return 1;
        if (name.includes('boiler')) return 2;
        return 3;
      };
      return priority(a) - priority(b);
    }),
);

const relayDevices = computed(() =>
  devices.value.filter((device) => {
    const description = `${device.displayName} ${device.adapter?.driver || ''} ${device.capabilities.map((capability) => capability.kind).join(' ')}`;
    return device.trustStatus === 'approved' &&
      device.adapter?.configured === true &&
      /shelly|relay|switch|light/i.test(description) &&
      device.capabilities.some((capability) =>
        capability.actions.includes('turn_on') && capability.actions.includes('turn_off'),
      );
  }),
);

const actionBusy = ref<Record<string, boolean>>({});
const actionFeedback = ref<Record<string, string>>({});

const onlineCount = computed(() =>
  devices.value.filter((device) => device.state.status === 'online').length,
);
const observerUnreachableCount = computed(() =>
  devices.value.filter((device) => device.state.observerReachability?.status === 'unreachable').length,
);

function fresh(device: Device): boolean {
  const observedAt = device.state.observedAt;
  if (!observedAt) return false;

  const timestamp = Date.parse(observedAt);
  const age = Date.now() - timestamp;

  return (
    Number.isFinite(timestamp) &&
    age >= 0 &&
    age < 10 * 60 * 1000 &&
    device.state.status !== 'offline'
  );
}

function reading(device: Device, capability: string, digits = 1): string {
  if (!fresh(device)) return '—';

  const value = device.state.values?.[capability];

  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '—';
}

function freshnessLabel(device: Device): string {
  const observerReachability = device.state.observerReachability;
  if (!device.state.observedAt) {
    return observerReachability?.status === 'unreachable'
      ? `Observer cannot reach ${observerReachability.targetIpAddress} · no measurements yet`
      : 'No observations';
  }

  const timestamp = Date.parse(device.state.observedAt);
  if (!Number.isFinite(timestamp)) return 'Unknown observation time';

  const minutes = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60000),
  );

  if (observerReachability?.status === 'unreachable') {
    const ageLabel = minutes < 1 ? 'updated just now' : `last reading ${minutes}m ago`;
    const checkedAt = Date.parse(observerReachability.checkedAt);
    const checkAge = Number.isFinite(checkedAt)
      ? `check ${Math.max(0, Math.floor((Date.now() - checkedAt) / 60000))}m ago`
      : 'check time unavailable';
    return `${observerReachability.observer.host} could not reach ${observerReachability.targetIpAddress} · ${checkAge} · ${ageLabel}`;
  }

  if (device.state.status === 'offline') return `Device unreachable · ${minutes}m ago`;
  if (!fresh(device)) return `Measurement stale · ${minutes}m ago`;
  if (!Object.values(device.state.values).some(value => value !== null)) return 'No measurement available';
  if (minutes < 1) return 'Updated just now';

  return `Updated ${minutes}m ago`;
}

function deviceConnectivityLabel(device: Device): string {
  if (device.state.observerReachability?.status === 'unreachable') return freshnessLabel(device);
  return device.state.status === 'offline' ? 'Device unreachable' : freshnessLabel(device);
}

function relayValue(device: Device): string {
  const value = device.state.values?.on ?? device.state.values?.output ?? device.state.values?.switch ?? device.state.values?.powered;
  if (value === true || value === 'on') return 'On';
  if (value === false || value === 'off') return 'Off';
  return 'State unavailable';
}

async function sendRelayAction(device: Device, action: 'turn_on' | 'turn_off') {
  if (actionBusy.value[device.id]) return;
  actionBusy.value = { ...actionBusy.value, [device.id]: true };
  actionFeedback.value = { ...actionFeedback.value, [device.id]: '' };
  try {
    const response = await fetch(`${props.apiBase}/portal/devices/${encodeURIComponent(device.id)}/actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${props.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.status === 'failed') {
      throw new Error(result?.message || `Device action failed (${response.status})`);
    }
    actionFeedback.value = {
      ...actionFeedback.value,
      [device.id]: result.status === 'pending' ? 'Command sent · awaiting device confirmation' : 'Command accepted',
    };
    await refresh();
  } catch (cause) {
    actionFeedback.value = {
      ...actionFeedback.value,
      [device.id]: cause instanceof Error ? cause.message : 'Device action unavailable',
    };
  } finally {
    const next = { ...actionBusy.value };
    delete next[device.id];
    actionBusy.value = next;
  }
}

async function refresh() {
  controller?.abort();
  const current = new AbortController();
  controller = current;

  try {
    const response = await authFetch(`${props.apiBase}/portal/state`, {
      headers: {
        Authorization: `Bearer ${props.accessToken}`,
      },
      signal: current.signal,
    });

    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'Authentication required'
          : `API unavailable (${response.status})`,
      );
    }

    const result = (await response.json()) as PortalState;

    if (controller !== current) return;

    state.value = result;
    error.value = '';
  } catch (cause) {
    if (current.signal.aborted) return;

    error.value =
      cause instanceof Error ? cause.message : 'Connection unavailable';

    state.value = null;
  } finally {
    if (controller === current) loading.value = false;
  }
}

onMounted(() => {
  void refresh();

  clockTimer = setInterval(() => {
    now.value = new Date();
  }, 1000);

  refreshTimer = setInterval(() => {
    void refresh();
  }, 15000);
});

onBeforeUnmount(() => {
  controller?.abort();
  if (clockTimer) clearInterval(clockTimer);
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <main class="energrid-home">
    <header class="home-header">
      <div class="brand">
        <img
          class="home-brand-logo"
          src="/images/energrid-logo-symbol.png"
          alt="Energrid"
        />
        <div>
          <strong>ENERGRID</strong>
          <span>HOME INTELLIGENCE</span>
        </div>
      </div>

      <div class="site-name">
        {{ state?.site?.name || 'My Home' }}
      </div>

      <div class="home-header-actions">
        <button
          class="assistant-navigation"
          type="button"
          @click="emit('assistant')"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
          </svg>
          Assistant
        </button>
        <button
          v-if="nativeWakeAvailable"
          class="wake-word-control"
          type="button"
          :aria-pressed="nativeWakeEnabled"
          @click="emit('toggle-wake-word')"
        >
          <span class="wake-word-dot" :class="{ active: nativeWakeEnabled && nativeWakeStatus === 'listening' }"></span>
          {{ nativeWakeEnabled ? 'Wake word on' : 'Wake word off' }}
        </button>
        <span v-if="nativeWakeAvailable" class="wake-word-status">
          {{ nativeWakeStatus === 'model_missing' ? 'Wake model needed' : nativeWakeStatus.replaceAll('_', ' ') }}
        </span>
        <div class="connection" :class="{ disconnected: !!error }">
          <span class="connection-dot"></span>
          {{ error ? 'Disconnected' : loading ? 'Connecting' : 'Connected' }}
        </div>
      </div>
    </header>

    <section class="home-hero">
      <div class="clock-section">
        <p class="eyebrow">WELCOME HOME</p>
        <div class="home-clock">{{ time }}</div>
        <p class="home-date">{{ date }}</p>
      </div>

      <div class="hero-status">
        <p class="eyebrow">YOUR HOME AT A GLANCE</p>
        <div class="hero-status-value">{{ onlineCount }}</div>
        <p>Devices last reported online</p>
        <span>{{ devices.length }} registered devices</span>
        <span v-if="observerUnreachableCount" class="observer-reachability-summary">
          Observer could not reach {{ observerUnreachableCount }} endpoint{{ observerUnreachableCount === 1 ? '' : 's' }}; device power and Wi-Fi are unknown.
        </span>
      </div>
    </section>

    <div class="tablet-top-row">
      <div class="tablet-climate">
    <section class="home-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">LIVE ENVIRONMENT</p>
          <h2>Indoor climate</h2>
        </div>
        <span>Updates every 15 seconds</span>
      </div>

      <div class="climate-list">
        <article
          v-for="device in climate"
          :key="device.id"
          class="climate-row"
        >
          <div class="climate-room">
            <strong>{{ device.zoneName || device.displayName }}</strong>
            <small>{{ freshnessLabel(device) }}</small>
          </div>
          <div class="climate-readings">
            <strong :class="{ unavailable: !fresh(device) }">
              {{ reading(device, 'temperature') }}°C
            </strong>
            <small v-if="reading(device, 'humidity', 0) !== '—'">
              {{ reading(device, 'humidity', 0) }}% RH
            </small>
          </div>
        </article>

        <p v-if="error" class="climate-empty">
          Sensor data unavailable while the Energrid API is disconnected.
        </p>
        <p v-else-if="!climate.length" class="climate-empty">
          No temperature sensors registered.
        </p>
      </div>
    </section>
      </div>

      <HomeIntelligence
        :api-base="apiBase"
        :access-token="accessToken"
      />
    </div>

    <section v-if="relayDevices.length" class="home-section relay-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">SWITCHES &amp; RELAYS</p>
          <h2>Lights &amp; relays</h2>
        </div>
        <span>Actions appear only when a control route is authorized</span>
      </div>
      <div class="relay-grid">
        <article v-for="device in relayDevices" :key="device.id" class="relay-card">
          <div>
            <strong>{{ device.zoneName || device.displayName }}</strong>
            <span>{{ device.displayName }}</span>
            <small>{{ relayValue(device) }} · {{ deviceConnectivityLabel(device) }}</small>
          </div>
          <div class="relay-actions">
            <template v-if="canSwitchDevice(device)">
              <button type="button" :disabled="!!actionBusy[device.id]" @click="sendRelayAction(device, 'turn_on')">On</button>
              <button type="button" :disabled="!!actionBusy[device.id]" @click="sendRelayAction(device, 'turn_off')">Off</button>
            </template>
            <span v-else class="relay-read-only">Read only · {{ device.control?.reason || 'Control route not configured.' }}</span>
          </div>
          <p v-if="actionFeedback[device.id]" class="relay-feedback" aria-live="polite">{{ actionFeedback[device.id] }}</p>
        </article>
      </div>
    </section>

    <footer class="home-footer">
      <span>ENERGRID · LOCAL INTELLIGENCE</span>
      <span v-if="error" class="footer-error">{{ error }}</span>
      <span v-else>Live device registry</span>
    </footer>
  </main>
</template>

<style scoped>
.energrid-home {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 28px clamp(20px, 4vw, 72px);
  background:
    radial-gradient(ellipse at 80% 0%, rgba(40, 99, 230, 0.2) 0%, transparent 45%),
    radial-gradient(ellipse at 0% 90%, rgba(247, 198, 106, 0.045) 0%, transparent 42%),
    var(--home-page);
  color: var(--home-text);
  font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
}

.home-header,
.brand,
.connection,
.home-hero,
.section-heading,
.card-top,
.humidity,
.home-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.home-header {
  gap: 24px;
  padding-bottom: 25px;
  border-bottom: 1px solid var(--home-border);
}

.home-header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
}

.assistant-navigation {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--home-border);
  border-radius: 6px;
  padding: 0 14px;
  background: var(--home-primary);
  color: #edf4f2;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.assistant-navigation svg {
  width: 16px;
  height: 16px;
}

.assistant-navigation:hover {
  background: #1e4fc3;
}

.assistant-navigation:focus-visible {
  outline: 3px solid var(--home-accent);
  outline-offset: 2px;
}

.wake-word-control {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--home-border);
  border-radius: 6px;
  padding: 0 12px;
  background: var(--home-blue-soft);
  color: var(--home-text);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.wake-word-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--home-muted);
}

.wake-word-dot.active {
  background: var(--home-success);
  box-shadow: 0 0 10px rgba(120, 228, 169, 0.47);
}

.wake-word-status {
  color: var(--home-muted);
  font-size: 11px;
}

.brand {
  gap: 12px;
  justify-content: flex-start;
}

.brand-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid #35517c;
  border-radius: 13px;
  color: var(--home-accent);
  font-size: 25px;
  font-weight: 800;
}

.brand strong {
  display: block;
  letter-spacing: 0.18em;
  font-size: 14px;
}

.brand span {
  display: block;
  color: var(--home-muted);
  font-size: 9px;
  letter-spacing: 0.2em;
  margin-top: 4px;
}

.site-name {
  color: var(--home-muted);
  font-size: 14px;
}

.connection {
  justify-content: flex-end;
  gap: 9px;
  font-size: 12px;
  color: var(--home-muted);
}

.connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--home-success);
  box-shadow: 0 0 12px rgba(120, 228, 169, 0.47);
}

.disconnected .connection-dot {
  background: var(--home-danger);
  box-shadow: none;
}

.home-hero {
  align-items: flex-end;
  gap: 24px;
  padding: 55px 0 50px;
}

.eyebrow {
  color: var(--home-accent);
  font-size: 11px;
  letter-spacing: 0.2em;
  font-weight: 700;
  text-transform: uppercase;
}

.home-clock {
  font-size: clamp(84px, 12vw, 180px);
  font-weight: 250;
  letter-spacing: -0.075em;
  line-height: 1.08;
  font-variant-numeric: tabular-nums;
}

.home-date {
  margin: 10px 0 0;
  color: var(--home-muted);
  font-size: clamp(17px, 2vw, 24px);
  text-transform: capitalize;
}

.hero-status {
  text-align: right;
  padding-bottom: 15px;
}

.hero-status-value {
  font-size: 72px;
  font-weight: 300;
  color: var(--home-accent);
}

.hero-status p {
  margin: 0;
  color: var(--home-text);
}

.hero-status span {
  display: block;
  margin-top: 8px;
  color: var(--home-muted);
  font-size: 12px;
}

.home-section {
  margin-bottom: 40px;
}

.section-heading {
  margin-bottom: 20px;
}

.section-heading h2 {
  margin: 6px 0 0;
  font-size: 25px;
  font-weight: 500;
}

.section-heading > span {
  color: var(--home-muted);
  font-size: 12px;
}

.climate-grid,
.power-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 16px;
}

.home-card {
  padding: 24px;
  border: 1px solid var(--home-border);
  border-radius: 20px;
  background: linear-gradient(145deg, var(--home-surface-raised), var(--home-surface-soft));
  box-shadow: 0 15px 40px #00000020;
}

.room-icon,
.power-icon {
  color: var(--home-accent);
  font-size: 24px;
}

.status-pill {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--home-success);
}

.status-pill.stale {
  color: var(--home-warning);
}

.home-card h3 {
  font-size: 20px;
  font-weight: 500;
  margin: 24px 0 5px;
}

.device-name {
  margin: 0;
  color: var(--home-muted);
  font-size: 12px;
}

.temperature,
.power-value {
  margin: 25px 0;
  font-size: clamp(46px, 5vw, 66px);
  font-weight: 300;
  letter-spacing: -0.05em;
  font-variant-numeric: tabular-nums;
}

.temperature span,
.power-value span {
  font-size: 21px;
  color: var(--home-muted);
}

.humidity {
  padding-top: 18px;
  border-top: 1px solid var(--home-border);
  color: var(--home-muted);
  font-size: 13px;
}

.humidity strong {
  color: var(--home-text);
  font-size: 18px;
}

.card-footer {
  margin: 22px 0 0;
  font-size: 11px;
  color: var(--home-muted);
}

.empty-card {
  min-height: 170px;
}

.empty-card p {
  color: var(--home-muted);
}

.empty-icon {
  font-size: 32px;
  color: var(--home-accent);
}

.home-footer {
  padding-top: 25px;
  border-top: 1px solid var(--home-border);
  color: var(--home-muted);
  font-size: 10px;
  letter-spacing: 0.1em;
}

.footer-error {
  color: var(--home-danger);
}

@media (max-width: 650px) {
  .energrid-home {
    padding: 20px;
  }

  .site-name {
    display: none;
  }

  .home-hero {
    align-items: flex-start;
    flex-direction: column;
    padding: 45px 0;
  }

  .hero-status {
    text-align: left;
  }

  .hero-status-value {
    font-size: 48px;
  }

  .home-clock {
    font-size: clamp(76px, 18vw, 120px);
  }
}

/* Compact electricity monitoring */
.electricity-panel {
  overflow: hidden;
  border: 1px solid rgba(153, 211, 213, 0.13);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.025);
}

.electricity-list,
.electricity-unavailable {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.electricity-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(153, 211, 213, 0.10);
}

.electricity-device {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.electricity-device > div {
  min-width: 0;
}

.electricity-device strong,
.electricity-device small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.electricity-device strong {
  font-size: 14px;
  font-weight: 600;
}

.electricity-device small {
  margin-top: 4px;
  font-size: 11px;
  color: var(--home-muted);
}

.electricity-indicator {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: var(--home-accent);
  box-shadow: 0 0 12px rgba(113, 230, 186, 0.25);
}

.electricity-reading {
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
}

.electricity-reading strong {
  font-size: clamp(22px, 2.5vw, 32px);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.electricity-reading span {
  font-size: 12px;
  color: var(--home-muted);
}

.electricity-toggle {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 14px 20px;
  border: 0;
  background: rgba(255, 255, 255, 0.025);
  color: var(--home-muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.electricity-toggle:hover {
  color: var(--home-accent);
}

.electricity-row-stale {
  opacity: 0.55;
}

.electricity-row-stale .electricity-indicator {
  background: var(--home-muted);
  box-shadow: none;
}

.electricity-empty {
  padding: 24px 20px;
  color: var(--home-muted);
}

.electricity-note {
  margin: 12px 2px 0;
  font-size: 11px;
  color: var(--home-muted);
}

@media (max-width: 700px) {
  .electricity-list,
  .electricity-unavailable {
    grid-template-columns: 1fr;
  }
}

</style>

<style scoped>
.home-brand-logo {
  width: 48px;
  height: 48px;
  object-fit: contain;
}
</style>

<style>
body:has(.energrid-home) {
  margin: 0;
  background: #020617;
}

body:has(.energrid-home) #app {
  width: 100%;
  max-width: none;
  margin: 0;
  padding: 0;
}
</style>

<style scoped>
/* Energrid tablet control layout */

.energrid-home {
  padding: 16px 28px;
}

.home-header {
  padding-bottom: 12px;
}

.home-hero {
  padding: 18px 0 22px;
  align-items: center;
}

.home-clock {
  font-size: clamp(42px, 5vw, 68px);
  letter-spacing: -0.05em;
}

.home-date {
  font-size: 13px;
  margin-top: 2px;
}

.hero-status {
  padding-bottom: 0;
}

.hero-status-value {
  font-size: 36px;
}

.hero-status p,
.hero-status span {
  font-size: 11px;
}

.home-section {
  margin-bottom: 22px;
}

.section-heading {
  margin-bottom: 12px;
}

.section-heading h2 {
  font-size: 19px;
}

.climate-grid,
.power-grid {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.home-card {
  padding: 16px;
  border-radius: 14px;
}

.home-card h3 {
  margin-top: 12px;
  font-size: 16px;
}

.temperature,
.power-value {
  margin: 14px 0;
  font-size: 38px;
}

.temperature span,
.power-value span {
  font-size: 16px;
}

.humidity {
  padding-top: 10px;
}

.card-footer {
  margin-top: 12px;
}

.home-footer {
  padding-top: 12px;
}

@media (max-width: 650px) {
  .energrid-home {
    padding: 14px;
  }

  .home-clock {
    font-size: 48px;
  }
}
</style>

<style scoped>
.tablet-top-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 12px;
  align-items: stretch;
  margin-bottom: 14px;
}

.tablet-climate {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--home-border);
  border-radius: 14px;
  background: linear-gradient(145deg, var(--home-surface), var(--home-surface));
}

.tablet-climate .home-section {
  margin: 0;
}

.climate-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.climate-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--home-border);
}

.climate-row:last-child {
  border-bottom: 0;
}

.climate-room,
.climate-readings {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.climate-room strong {
  font-size: 14px;
  font-weight: 500;
}

.climate-room small,
.climate-readings small {
  color: var(--home-muted);
  font-size: 10px;
}

.climate-readings {
  align-items: flex-end;
  flex-shrink: 0;
}

.climate-readings strong {
  color: var(--home-accent);
  font-size: 23px;
  font-weight: 400;
}

.climate-readings strong.unavailable {
  color: var(--home-muted);
}

.climate-empty {
  color: var(--home-muted);
  font-size: 12px;
}

.relay-section { margin-top: 18px; }
.relay-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.relay-card { min-width: 0; display: flex; flex-direction: column; gap: 14px; padding: 16px; border: 1px solid var(--home-border); border-radius: 14px; background: linear-gradient(145deg, var(--home-surface-raised), var(--home-surface-soft)); }
.relay-card > div:first-child { display: grid; gap: 5px; }
.relay-card > div:first-child strong { color: var(--home-text); font-size: 15px; font-weight: 650; }
.relay-card > div:first-child span { color: var(--home-muted); font-size: 12px; overflow-wrap: anywhere; }
.relay-card > div:first-child small { color: var(--home-muted); font-size: 11px; }
.relay-actions { display: flex; gap: 8px; }
.relay-actions button { flex: 1; min-height: 44px; border: 1px solid var(--home-blue-border); border-radius: 11px; background: var(--home-blue-soft); color: var(--home-text); font-weight: 700; }
.relay-actions button:first-child { border-color: var(--home-primary); background: var(--home-primary); color: #fff; }
.relay-actions button:disabled { opacity: .55; }
.relay-feedback { margin: 0; color: var(--home-muted); font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }

@media (max-width: 950px) {
  .tablet-top-row {
    grid-template-columns: 1fr;
  }
}
</style>
