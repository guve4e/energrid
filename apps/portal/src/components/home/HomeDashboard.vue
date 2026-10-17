<script setup lang="ts">
import HomeTemperatureHistory from './HomeTemperatureHistory.vue';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import HomeIntelligence from './HomeIntelligence.vue';

type Device = {
  id: string;
  displayName: string;
  zoneName: string;
  capabilities: Array<{ kind: string; unit?: string }>;
  state: {
    values: Record<string, number | boolean | string | null>;
    observedAt: string | null;
    status: 'online' | 'offline' | 'unknown';
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
    .filter((device) =>
      device.capabilities?.some(
        (capability) =>
          capability.kind === 'temperature' ||
          capability.kind === 'humidity',
      ) &&
      !/motion|occupancy|presence/i.test(device.displayName),
    )
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

const showUnavailablePower = ref(false);

const activePowerDevices = computed(() =>
  powerDevices.value.filter((device) =>
    fresh(device) &&
    typeof device.state.values?.power === 'number' &&
    Number.isFinite(device.state.values.power),
  ),
);

const unavailablePowerDevices = computed(() =>
  powerDevices.value.filter(
    (device) => !activePowerDevices.value.includes(device),
  ),
);

const powerDevices = computed(() =>
  devices.value.filter((device) =>
    device.capabilities?.some(
      (capability) => capability.kind === 'power',
    ),
  ),
);

const onlineCount = computed(() =>
  devices.value.filter((device) => device.state.status === 'online').length,
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
  if (!device.state.observedAt) return 'No observations';

  const timestamp = Date.parse(device.state.observedAt);
  if (!Number.isFinite(timestamp)) return 'Unknown observation time';

  const minutes = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60000),
  );

  if (!fresh(device)) return `Unavailable · ${minutes}m ago`;
  if (minutes < 1) return 'Updated just now';

  return `Updated ${minutes}m ago`;
}

async function refresh() {
  controller?.abort();
  const current = new AbortController();
  controller = current;

  try {
    const response = await fetch(`${props.apiBase}/portal/state`, {
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
        <p>Devices reporting online</p>
        <span>{{ devices.length }} registered devices</span>
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

        <p v-if="!climate.length" class="climate-empty">
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

    <HomeTemperatureHistory
      :api-base="apiBase"
      :access-token="accessToken"
    />




    <section class="home-section electricity-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">ENERGY INTELLIGENCE</p>
          <h2>Electricity</h2>
        </div>
        <span>
          {{ activePowerDevices.length }} live measurements
        </span>
      </div>

      <div class="electricity-panel">
        <div v-if="activePowerDevices.length" class="electricity-list">
          <article
            v-for="device in activePowerDevices"
            :key="device.id"
            class="electricity-row"
          >
            <div class="electricity-device">
              <span class="electricity-indicator"></span>
              <div>
                <strong>
                  {{ device.zoneName || device.displayName }}
                </strong>
                <small>
                  {{ device.displayName }}
                </small>
              </div>
            </div>

            <div class="electricity-reading">
              <strong>{{ reading(device, 'power', 0) }}</strong>
              <span>W</span>
            </div>
          </article>
        </div>

        <div v-else class="electricity-empty">
          No current power measurements available.
        </div>

        <button
          v-if="unavailablePowerDevices.length"
          class="electricity-toggle"
          type="button"
          :aria-expanded="showUnavailablePower"
          @click="showUnavailablePower = !showUnavailablePower"
        >
          <span>
            {{ unavailablePowerDevices.length }} unavailable devices
          </span>
          <span>{{ showUnavailablePower ? 'Hide −' : 'Show +' }}</span>
        </button>

        <div
          v-if="showUnavailablePower"
          class="electricity-unavailable"
        >
          <article
            v-for="device in unavailablePowerDevices"
            :key="device.id"
            class="electricity-row electricity-row-stale"
          >
            <div class="electricity-device">
              <span class="electricity-indicator"></span>
              <div>
                <strong>
                  {{ device.zoneName || device.displayName }}
                </strong>
                <small>{{ freshnessLabel(device) }}</small>
              </div>
            </div>
            <div class="electricity-reading">
              <strong>—</strong>
              <span>W</span>
            </div>
          </article>
        </div>
      </div>

      <p class="electricity-note">
        Individual circuit measurements. Values are not summed because
        monitored circuits may overlap.
      </p>
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
    radial-gradient(ellipse at 80% 0%, #183a38 0%, transparent 45%),
    radial-gradient(ellipse at 0% 90%, #142c36 0%, transparent 40%),
    #09141b;
  color: #f2f7f5;
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
  border-bottom: 1px solid #ffffff18;
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
  border: 1px solid #6b9b92;
  border-radius: 6px;
  padding: 0 14px;
  background: #d8f1e8;
  color: #102c28;
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
  background: #c4e8dc;
}

.assistant-navigation:focus-visible {
  outline: 3px solid #74c9ad;
  outline-offset: 2px;
}

.wake-word-control {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  border: 1px solid #456866;
  border-radius: 6px;
  padding: 0 12px;
  background: #102522;
  color: #d9f4e9;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.wake-word-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8b9b98;
}

.wake-word-dot.active {
  background: #65eab0;
  box-shadow: 0 0 10px #65eab077;
}

.wake-word-status {
  color: #9bb7b4;
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
  border: 1px solid #65f4bb66;
  border-radius: 13px;
  color: #75f3c3;
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
  color: #7f9c9f;
  font-size: 9px;
  letter-spacing: 0.2em;
  margin-top: 4px;
}

.site-name {
  color: #c2d3d2;
  font-size: 14px;
}

.connection {
  justify-content: flex-end;
  gap: 9px;
  font-size: 12px;
  color: #a6c9b8;
}

.connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #65eab0;
  box-shadow: 0 0 12px #65eab077;
}

.disconnected .connection-dot {
  background: #f5a18f;
  box-shadow: none;
}

.home-hero {
  align-items: flex-end;
  gap: 24px;
  padding: 55px 0 50px;
}

.eyebrow {
  color: #69c9ae;
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
  color: #a5b9b8;
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
  color: #8ceac3;
}

.hero-status p {
  margin: 0;
  color: #d7e6e1;
}

.hero-status span {
  display: block;
  margin-top: 8px;
  color: #78918f;
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
  color: #7e9b9a;
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
  border: 1px solid #ffffff16;
  border-radius: 20px;
  background: linear-gradient(145deg, #1a3037dd, #12232bdd);
  box-shadow: 0 15px 40px #00000020;
}

.room-icon,
.power-icon {
  color: #81e4c4;
  font-size: 24px;
}

.status-pill {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: #82e8bd;
}

.status-pill.stale {
  color: #e8b68b;
}

.home-card h3 {
  font-size: 20px;
  font-weight: 500;
  margin: 24px 0 5px;
}

.device-name {
  margin: 0;
  color: #77969a;
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
  color: #88aca9;
}

.humidity {
  padding-top: 18px;
  border-top: 1px solid #ffffff12;
  color: #9cb8b7;
  font-size: 13px;
}

.humidity strong {
  color: #e1f4ed;
  font-size: 18px;
}

.card-footer {
  margin: 22px 0 0;
  font-size: 11px;
  color: #718f90;
}

.empty-card {
  min-height: 170px;
}

.empty-card p {
  color: #8ca5a5;
}

.empty-icon {
  font-size: 32px;
  color: #74d6b4;
}

.home-footer {
  padding-top: 25px;
  border-top: 1px solid #ffffff14;
  color: #6d8d8d;
  font-size: 10px;
  letter-spacing: 0.1em;
}

.footer-error {
  color: #f5a18f;
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
  color: #91aeb0;
}

.electricity-indicator {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: #71e6ba;
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
  color: #91aeb0;
}

.electricity-toggle {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 14px 20px;
  border: 0;
  background: rgba(255, 255, 255, 0.025);
  color: #9eb8b9;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.electricity-toggle:hover {
  color: #71e6ba;
}

.electricity-row-stale {
  opacity: 0.55;
}

.electricity-row-stale .electricity-indicator {
  background: #819498;
  box-shadow: none;
}

.electricity-empty {
  padding: 24px 20px;
  color: #91aeb0;
}

.electricity-note {
  margin: 12px 2px 0;
  font-size: 11px;
  color: #819b9d;
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
  background: #09141b;
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
  border: 1px solid #ffffff16;
  border-radius: 14px;
  background: linear-gradient(145deg, #1a3037, #12232b);
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
  border-bottom: 1px solid #ffffff12;
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
  color: #8da8a4;
  font-size: 10px;
}

.climate-readings {
  align-items: flex-end;
  flex-shrink: 0;
}

.climate-readings strong {
  color: #9cf0cf;
  font-size: 23px;
  font-weight: 400;
}

.climate-readings strong.unavailable {
  color: #8ca5a4;
}

.climate-empty {
  color: #8ca5a4;
  font-size: 12px;
}

@media (max-width: 950px) {
  .tablet-top-row {
    grid-template-columns: 1fr;
  }
}
</style>
