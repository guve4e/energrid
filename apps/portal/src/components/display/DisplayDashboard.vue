<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

type Device = { id: string; displayName: string; zoneName: string; capabilities: Array<{ kind: string }>; state: { status: string; observedAt: string | null; values: Record<string, number | boolean | string | null> } };
type Sensor = { id: string; name: string; capability: string; value: number | boolean | null; unit?: string; observedAt: string };
type Weather = { current?: { temperature: number | null; windKmh?: number | null }; summary?: string; intelligence?: { headline: string }; daily?: Array<{ date: string; tempMin: number | null; tempMax: number | null; weatherCode?: number | null; rainTotalMm?: number | null }> };

const props = defineProps<{
  siteName: string;
  tenantName: string;
  devices: Device[];
  sensors: Sensor[];
  unreadCount: number;
  apiBase: string;
  accessToken: string;
}>();
const clock = ref(new Date());
const weather = ref<Weather | null>(null);
const weatherError = ref('');
let clockTimer: ReturnType<typeof setInterval> | undefined;
let weatherTimer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;
const online = computed(() => props.devices.filter((device) => device.state.status === 'online').length);
const temperatures = computed(() => props.sensors.filter((sensor) => sensor.capability === 'temperature' && typeof sensor.value === 'number').slice(0, 4));
const powers = computed(() => props.devices.filter((device) => device.capabilities.some((capability) => capability.kind === 'power') && typeof device.state.values.power === 'number'));
const currentTime = computed(() => new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hour12: false }).format(clock.value));
const currentDate = computed(() => new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', weekday: 'long', day: 'numeric', month: 'long' }).format(clock.value));
const weatherIcon = (code?: number | null) => code == null ? '—' : [95, 96, 99].includes(code) ? '⛈' : [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code) ? '☂' : [71, 73, 75, 77, 85, 86].includes(code) ? '❄' : [2, 3, 45, 48].includes(code) ? '☁' : '☀';

async function refreshWeather() {
  controller?.abort();
  controller = new AbortController();
  weatherError.value = '';
  try {
    const response = await fetch(`${props.apiBase}/portal/weather/dashboard`, { headers: { Authorization: `Bearer ${props.accessToken}` }, signal: controller.signal });
    if (!response.ok) throw new Error('Forecast unavailable');
    weather.value = await response.json() as Weather;
  } catch (error) {
    if (!controller.signal.aborted) {
      weather.value = null;
      weatherError.value = error instanceof Error ? error.message : 'Forecast unavailable';
    }
  }
}

onMounted(() => {
  clockTimer = setInterval(() => { clock.value = new Date(); }, 10_000);
  void refreshWeather();
  weatherTimer = setInterval(() => void refreshWeather(), 5 * 60_000);
});
onBeforeUnmount(() => { if (clockTimer) clearInterval(clockTimer); if (weatherTimer) clearInterval(weatherTimer); controller?.abort(); });
</script>

<template>
  <main class="display-experience">
    <header class="display-header"><div><span>ENERGRID · {{ tenantName }}</span><h1>{{ siteName }}</h1><p>{{ currentDate }}</p></div><time>{{ currentTime }}</time></header>
    <section class="display-weather" aria-label="Current weather">
      <div class="display-weather-current"><span class="display-kicker">VIDIN · WEATHER</span><div class="display-weather-line"><strong>{{ weather?.current?.temperature == null ? '—' : `${weather.current.temperature.toFixed(1)}°` }}</strong><span>{{ weather ? weatherIcon(weather.daily?.[0]?.weatherCode) : '◌' }}</span></div><p>{{ weather?.intelligence?.headline || (weatherError ? 'Forecast unavailable' : 'Loading current conditions') }}</p><small>{{ weather?.summary || 'Unavailable weather values are shown as dashes.' }}</small></div>
      <div class="display-forecast"><article v-for="day in weather?.daily?.slice(0, 5) || []" :key="day.date"><span>{{ new Date(`${day.date}T12:00:00`).toLocaleDateString('bg-BG', { weekday: 'short', timeZone: 'Europe/Sofia' }) }}</span><strong>{{ weatherIcon(day.weatherCode) }}</strong><b>{{ day.tempMax == null ? '—' : `${Math.round(day.tempMax)}°` }}</b><small>{{ day.tempMin == null ? '—' : `${Math.round(day.tempMin)}°` }}</small></article><p v-if="!weather?.daily?.length">{{ weatherError || 'Forecast loading' }}</p></div>
    </section>
    <section class="display-grid">
      <article class="display-panel display-home"><header><span>HOME</span><strong>{{ online }}<small> / {{ devices.length }} online</small></strong></header><div v-if="temperatures.length" class="display-temp-list"><div v-for="sensor in temperatures" :key="sensor.id"><span>{{ sensor.name }}</span><strong>{{ Number(sensor.value).toFixed(1) }}{{ sensor.unit || '°C' }}</strong></div></div><p v-else class="display-unavailable">No indoor temperature sensors configured.</p></article>
      <article class="display-panel display-energy"><header><span>ENERGY</span><strong v-if="powers.length">{{ powers.reduce((sum, device) => sum + Number(device.state.values.power), 0).toFixed(0) }}<small> W measured</small></strong><strong v-else>—</strong></header><div v-if="powers.length" class="display-power-list"><div v-for="device in powers.slice(0, 3)" :key="device.id"><span>{{ device.displayName }}</span><strong>{{ Number(device.state.values.power).toFixed(0) }} W</strong></div></div><p v-else class="display-unavailable">No live power measurement configured. This is not a whole-home total.</p></article>
      <article class="display-panel display-alerts"><header><span>SYSTEM</span><strong>{{ unreadCount ? `${unreadCount} alert${unreadCount === 1 ? '' : 's'}` : 'All clear' }}</strong></header><div class="display-status"><span :class="online === devices.length && devices.length ? 'ok' : 'warn'"></span><p>{{ online }} of {{ devices.length }} devices currently online</p></div><div v-if="devices.some((device) => device.state.status === 'offline')" class="display-offline-list"><p v-for="device in devices.filter((item) => item.state.status === 'offline').slice(0, 3)" :key="device.id">{{ device.displayName }} · Offline</p></div><p class="display-unavailable">{{ unreadCount ? 'Review details in the Energrid dashboard.' : 'New system events appear here when available.' }}</p></article>
    </section>
    <footer><span>ENERGRID HOME</span><span>Live site state · refreshed {{ currentTime }}</span></footer>
  </main>
</template>

<style scoped>
.display-experience{min-height:100dvh;box-sizing:border-box;padding:4vh 5vw;background:#101719;color:#eef4f1;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;gap:3vh}.display-header{display:flex;justify-content:space-between;align-items:center}.display-header div>span,.display-kicker,.display-panel header>span{font-size:12px;font-weight:800;color:#7fd0b0}.display-header h1{font-size:48px;margin:6px 0 0}.display-header p{margin:5px 0;color:#9aa9a6;text-transform:capitalize}.display-header time{font-size:96px;font-variant-numeric:tabular-nums;font-weight:750;color:#f5bd55}.display-weather{display:grid;grid-template-columns:minmax(260px,.8fr) 1.5fr;gap:28px;padding:28px 32px;border-radius:16px;background:#1d2929;border:1px solid #344442;min-height:220px}.display-weather-line{display:flex;align-items:center;gap:20px}.display-weather-line strong{font-size:76px;line-height:1}.display-weather-line span{font-size:42px;color:#f5bd55}.display-weather-current p{margin:12px 0 5px;font-weight:700;font-size:18px}.display-weather-current small,.display-unavailable,.display-forecast small{color:#9aa9a6;line-height:1.5}.display-forecast{display:grid;grid-template-columns:repeat(5,minmax(70px,1fr));align-items:center;gap:12px}.display-forecast article{display:grid;justify-items:center;gap:8px}.display-forecast article span,.display-forecast article small{color:#aab8b5;text-transform:capitalize}.display-forecast article strong{font-size:28px;color:#f5bd55}.display-forecast article b{font-size:20px}.display-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;flex:1}.display-panel{padding:22px 24px;background:#1a2425;border:1px solid #354342;border-radius:14px}.display-panel header{display:flex;align-items:center;justify-content:space-between;gap:10px}.display-panel header strong{font-size:26px}.display-panel header small{font-size:13px;color:#aab8b5}.display-temp-list,.display-power-list{display:grid;gap:14px;margin-top:22px}.display-temp-list div,.display-power-list div{display:flex;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid #354342}.display-temp-list span,.display-power-list span{color:#c2cfcb}.display-status{display:flex;align-items:center;gap:10px;margin-top:24px}.display-status span{width:10px;height:10px;border-radius:50%;background:#48c78e}.display-status span.warn{background:#f5bd55}.display-status p{margin:0}.display-offline-list p{color:#ff978b}.display-alerts .display-unavailable,.display-energy .display-unavailable{margin-top:24px}.display-experience footer{display:flex;justify-content:space-between;color:#71817d;font-size:11px}@media(max-width:850px){.display-experience{padding:22px 16px;gap:16px}.display-weather{grid-template-columns:1fr;gap:20px;padding:20px}.display-grid{grid-template-columns:1fr}.display-header h1{font-size:32px}.display-header time{font-size:48px}.display-weather-line strong{font-size:54px}.display-forecast{gap:3px}.display-forecast article strong{font-size:20px}}
</style>
