<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { DeviceConnectionReport } from '@energrid/domain-devices';
import type { ControlSetupDevice } from './device-control';

const props = defineProps<{
  device: ControlSetupDevice & { kind?: string };
  apiBase: string;
  accessToken: string;
}>();
const emit = defineEmits<{
  'identity-verification': [result: { tenantId?: string; siteId?: string; deviceId: string; route: string; verified: boolean }];
  'status-observed': [];
}>();
const report = ref<DeviceConnectionReport | null>(null);
const busy = ref(false);
const error = ref('');
const expired = ref(false);
const shellyStatus = ref<{ output: boolean; observedAt: string; observer: { id: string; host: string } } | null>(null);
const statusBusy = ref(false);
const statusError = ref('');
const shellyComponent = computed(() => {
  const component = props.device.metadata?.component;
  return typeof component === 'string' && /^switch:\d+$/.test(component) ? component : null;
});
const shellySwitchLabel = computed(() => {
  const channel = shellyComponent.value?.split(':')[1];
  return channel === undefined ? 'Switch' : `Switch ${Number(channel) + 1}`;
});
let request: AbortController | null = null;
let statusRequest: AbortController | null = null;
let expires: ReturnType<typeof setTimeout> | undefined;
const available = computed(
  () =>
    props.device.trustStatus === 'approved' &&
    props.device.kind !== 'logical' &&
    props.device.adapter.protocol !== 'simulated',
);
const routingWarning = computed(
  () =>
    report.value?.checks.find((check) => check.id === 'shared-topic')?.detail,
);
const canReadShellyStatus = computed(() =>
  props.device.trustStatus === 'approved' && props.device.kind !== 'logical' &&
  ['shelly-lan', 'shelly-discovered'].includes(props.device.adapter.driver) &&
  !!shellyComponent.value,
);

function reset() {
  reportIdentity(false);
  request?.abort();
  request = null;
  statusRequest?.abort();
  statusRequest = null;
  statusBusy.value = false;
  statusError.value = '';
  shellyStatus.value = null;
  clearTimeout(expires);
  report.value = null;
  busy.value = false;
  error.value = '';
  expired.value = false;
}
function reportIdentity(verified: boolean) {
  const binding = props.device.control?.binding;
  if (binding?.kind === 'shelly-http')
    emit('identity-verification', {
      deviceId: props.device.id,
      ...(props.device.tenantId ? { tenantId: props.device.tenantId } : {}),
      ...(props.device.siteId ? { siteId: props.device.siteId } : {}),
      route: binding.baseUrl,
      verified,
    });
}
watch(
  [
    () => props.device.id,
    () => props.device.trustStatus,
    () => JSON.stringify(props.device.control?.binding),
  ],
  reset,
);
onBeforeUnmount(reset);

async function check() {
  if (!available.value || busy.value) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const deviceId = props.device.id;
  busy.value = true;
  error.value = '';
  report.value = null;
  reportIdentity(false);
  clearTimeout(expires);
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(deviceId)}/diagnostics`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${props.accessToken}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const known: Record<number, string> = {
        401: 'Your Portal session expired. Sign in again and retry.',
        403: 'This device is not eligible for a connection check in the selected site.',
        404: 'The enrolled device record was not found.',
        429: 'Connection checks are busy. Wait briefly before trying again.',
        503: 'The connection diagnostic service is unavailable.',
      };
      error.value = known[response.status] || `Connection check failed (HTTP ${response.status}). No device command was sent.`;
      return;
    }
    const result = await response.json().catch(() => null) as DeviceConnectionReport | null;
    if (
      !result || result.deviceId !== deviceId ||
      result.readOnly !== true || !Array.isArray(result.checks)
    ) {
      error.value = 'Connection check returned an invalid response. Device reachability remains unknown; no command was sent.';
      return;
    }
    if (request !== controller) return;
    report.value = result;
    reportIdentity(result.checks.some(check => check.id === 'identity' && check.status === 'passed'));
    expired.value = false;
    expires = setTimeout(() => {
      expired.value = true;
      reportIdentity(false);
    }, 60000);
  } catch {
    if (request === controller)
      error.value = controller.signal.aborted
          ? 'Connection check timed out after 25 seconds. Device reachability remains unknown; no command was sent.'
          : 'Energrid could not be reached for the connection check. Device reachability remains unknown; no command was sent.';
  } finally {
    clearTimeout(timeout);
    if (request === controller) {
      busy.value = false;
      request = null;
    }
  }
}

async function readShellyStatusOnce() {
  if (!canReadShellyStatus.value || statusBusy.value) return;
  statusRequest?.abort();
  const controller = new AbortController();
  statusRequest = controller;
  statusBusy.value = true;
  statusError.value = '';
  shellyStatus.value = null;
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.device.id)}/observe-shelly-status`,
      { method: 'POST', headers: { Authorization: `Bearer ${props.accessToken}` }, signal: controller.signal },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { message?: unknown } | null;
      const reason = typeof failure?.message === 'string' ? failure.message : 'The authorized observer rejected the request.';
      statusError.value = `Read-only status observation failed (HTTP ${response.status}): ${reason} No device command was sent.`;
      return;
    }
    const result = await response.json().catch(() => null) as {
      deviceId?: unknown; component?: unknown; output?: unknown; observedAt?: unknown;
      observer?: { id?: unknown; host?: unknown };
    } | null;
    if (!result || result.deviceId !== props.device.id || result.component !== shellyComponent.value ||
        typeof result.output !== 'boolean' || typeof result.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(result.observedAt)) || !result.observer ||
        typeof result.observer.id !== 'string' || typeof result.observer.host !== 'string') {
      statusError.value = 'The status response could not be verified. Device state was not updated in this view.';
      return;
    }
    if (statusRequest !== controller) return;
    shellyStatus.value = { output: result.output, observedAt: result.observedAt, observer: { id: result.observer.id, host: result.observer.host } };
    emit('status-observed');
  } catch {
    if (statusRequest === controller) statusError.value = controller.signal.aborted
      ? 'Read-only status observation timed out. Device state remains unchanged.'
      : 'The authorized observer could not return device status. Device state remains unchanged.';
  } finally {
    clearTimeout(timeout);
    if (statusRequest === controller) {
      statusBusy.value = false;
      statusRequest = null;
    }
  }
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function outcomeLabel(value: string) {
  return (
    (
      {
        settled: 'Confirmed',
        timed_out: 'Not confirmed',
        no_ack: 'Not confirmed',
        failed: 'Failed',
        running: 'Waiting for confirmation',
        superseded: 'Replaced by a newer request',
        drifted: 'State changed afterwards',
      } as Record<string, string>
    )[value] || value
  );
}
</script>

<template>
  <section
    v-if="available"
    class="device-diagnostics"
    aria-label="Connection diagnosis"
    :aria-busy="busy"
  >
    <header>
      <h4>Connection diagnosis</h4>
      <button type="button" class="ghost" :disabled="busy" @click="check">
        {{ busy ? 'Checking...' : 'Check connection' }}
      </button>
    </header>
    <section v-if="canReadShellyStatus" class="shelly-read-status" aria-label="Read Shelly status">
      <button type="button" class="ghost" :disabled="statusBusy" @click="readShellyStatusOnce">
        {{ statusBusy ? 'Reading status…' : 'Read status once' }}
      </button>
      <p class="muted">One read-only {{ shellySwitchLabel }} status request through the authorized site observer. No relay command is sent.</p>
      <p v-if="statusError" role="alert">{{ statusError }}</p>
      <p v-if="shellyStatus" role="status" aria-live="polite">
        {{ shellySwitchLabel }} was {{ shellyStatus.output ? 'On' : 'Off' }} at {{ time(shellyStatus.observedAt) }} · Observer {{ shellyStatus.observer.id }} ({{ shellyStatus.observer.host }}).
      </p>
    </section>
    <p v-if="!report && !error" class="muted" role="status">
      {{
        busy
          ? 'Reading device identity, connection settings and current relay state.'
          : 'Not checked. No switch test has been performed.'
      }}
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div
      v-if="report"
      class="device-diagnostic-result"
      :data-result="report.code"
      aria-live="polite"
    >
      <p class="device-diagnostic-time">
        {{ expired ? 'Earlier snapshot' : 'Checked' }}
        {{ time(report.checkedAt) }} · Read-only
      </p>
      <h4>{{ report.title }}</h4>
      <p>{{ report.summary }}</p>
      <p class="device-diagnostic-next">
        <strong>Next step</strong> {{ report.nextAction }}
      </p>
      <p v-if="routingWarning" class="device-diagnostic-routing-warning">
        <strong>Before switching:</strong> {{ routingWarning }}
      </p>
      <p v-if="report.currentRelay">
        <strong>Relay at check time:</strong>
        {{ report.currentRelay.on ? 'On' : 'Off' }} ·
        {{ time(report.currentRelay.checkedAt) }}
      </p>
      <p v-if="expired" role="status">
        This snapshot is over a minute old. Check again for the current
        connection.
      </p>
      <details>
        <summary>Evidence · {{ report.checks.length }} checks</summary>
        <ul class="device-diagnostic-checks">
          <li
            v-for="item in report.checks"
            :key="item.id"
            :data-status="item.status"
          >
            <div>
              <strong>{{ item.label }}</strong
              ><span>{{
                item.status === 'passed'
                  ? 'Verified'
                  : item.status === 'failed'
                    ? 'Problem'
                    : item.status === 'warning'
                      ? 'Review'
                      : 'Not verified'
              }}</span>
            </div>
            <p>{{ item.detail }}</p>
            <time :datetime="item.checkedAt">{{ time(item.checkedAt) }}</time>
          </li>
        </ul>
      </details>
      <details v-if="report.lastCommand">
        <summary>
          Last command · {{ outcomeLabel(report.lastCommand.outcome) }}
        </summary>
        <ol class="device-diagnostic-history">
          <li>
            Requested
            {{
              report.lastCommand.action === 'turn_on'
                ? 'On'
                : report.lastCommand.action === 'turn_off'
                  ? 'Off'
                  : report.lastCommand.action
            }}
            ·
            {{ time(report.lastCommand.requestedAt) }}
          </li>
          <li>
            {{
              report.lastCommand.publishedAt
                ? `Publication completed · ${time(report.lastCommand.publishedAt)}`
                : 'No completed publication recorded'
            }}
          </li>
          <li>
            Outcome: {{ outcomeLabel(report.lastCommand.outcome)
            }}{{
              report.lastCommand.completedAt
                ? ` · ${time(report.lastCommand.completedAt)}`
                : ''
            }}
          </li>
        </ol>
      </details>
    </div>
  </section>
</template>

<style scoped>
.device-diagnostics {
  border-top: 1px solid var(--line, #d8e1ed);
  padding: 20px 0;
  margin: 16px 0;
  min-width: 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
h4 {
  margin: 0;
  font-size: 16px;
}
button {
  min-height: 44px;
}
p {
  font-size: 14px;
  line-height: 1.55;
  margin: 10px 0;
  overflow-wrap: anywhere;
}
.device-diagnostic-result {
  margin-top: 12px;
  border-left: 3px solid #d9902f;
  padding: 4px 0 4px 14px;
  min-width: 0;
}
.device-diagnostic-result[data-result='checks-passed'] {
  border-color: #11945d;
}
.device-diagnostic-time,
time {
  font-size: 12px;
  color: var(--muted, #64748b);
}
.device-diagnostic-next strong {
  display: block;
}
.device-diagnostic-routing-warning {
  color: #916010;
}
summary {
  padding: 12px 0;
  min-height: 44px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.device-diagnostic-checks {
  list-style: none;
  padding: 0;
  margin: 0;
}
.device-diagnostic-checks li {
  border-top: 1px solid var(--line, #d8e1ed);
  padding: 10px 0;
}
.device-diagnostic-checks li > div {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
.device-diagnostic-checks span {
  color: #916010;
}
.device-diagnostic-checks [data-status='failed'] span {
  color: #b42318;
}
.device-diagnostic-checks [data-status='passed'] span {
  color: #16804b;
}
.device-diagnostic-checks p {
  margin: 6px 0;
}
.device-diagnostic-history {
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
</style>
