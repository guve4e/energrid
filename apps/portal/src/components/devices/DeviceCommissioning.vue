<script setup lang="ts">
import { computed, ref, watch } from 'vue';

type CommissioningEvent = {
  id: string;
  kind: string;
  occurredAt: string;
  evidence: Record<string, string | number | boolean | null>;
};

type CommissioningDevice = {
  id: string;
  displayName: string;
  zoneName: string;
  trustStatus: string;
  assistantEnabled?: boolean;
  settingsUrl?: string;
  commissioning?: { physicalOutcome: 'not_confirmed' | 'confirmed'; confirmedAt: string | null };
  state: { command?: { status: string } };
};

const props = defineProps<{
  device: CommissioningDevice;
  apiBase: string;
  accessToken: string;
  settingsUrlSuggestion?: string;
}>();
const emit = defineEmits<{ saved: [] }>();
const name = ref('');
const room = ref('');
const settingsUrl = ref('');
const assistantEnabled = ref(false);
const busy = ref(false);
const error = ref('');
const message = ref('');
const events = ref<CommissioningEvent[]>([]);
const eventsError = ref('');
const confirmed = computed(
  () => props.device.commissioning?.physicalOutcome === 'confirmed',
);
const canConfirmPhysical = computed(
  () => props.device.trustStatus === 'approved' &&
    props.device.state.command?.status === 'acked' && !confirmed.value,
);

watch(
  () => [props.device.id, props.device.displayName, props.device.zoneName, props.device.settingsUrl, props.device.assistantEnabled, props.settingsUrlSuggestion],
  () => {
    name.value = props.device.displayName;
    room.value = props.device.zoneName;
    settingsUrl.value = props.device.settingsUrl || props.settingsUrlSuggestion || '';
    assistantEnabled.value = props.device.assistantEnabled === true;
    error.value = '';
    message.value = '';
    void loadEvents();
  },
  { immediate: true },
);

async function request(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${props.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${props.accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(result?.message || 'Commissioning update could not be saved.');
  }
  return response.json().catch(() => null);
}

async function loadEvents() {
  eventsError.value = '';
  try {
    const result = await request(
      `/portal/devices/${encodeURIComponent(props.device.id)}/commissioning/events`,
      'GET',
    ) as { events?: CommissioningEvent[] } | null;
    events.value = Array.isArray(result?.events) ? result.events : [];
  } catch (cause) {
    eventsError.value = cause instanceof Error ? cause.message : 'History could not be loaded.';
  }
}

async function saveDetails() {
  if (busy.value || props.device.trustStatus !== 'approved') return;
  busy.value = true;
  error.value = '';
  message.value = '';
  const normalizedSettingsUrl = settingsUrl.value.trim();
  if (normalizedSettingsUrl) {
    try {
      const parsed = new URL(normalizedSettingsUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error();
    } catch {
      error.value = 'Enter a full HTTP or HTTPS device settings address.';
      busy.value = false;
      return;
    }
  }
  try {
    await request(
      `/portal/devices/${encodeURIComponent(props.device.id)}/commissioning`,
      'PATCH',
      {
        displayName: name.value.trim(),
        zoneName: room.value.trim(),
        settingsUrl: normalizedSettingsUrl || null,
        assistantEnabled: assistantEnabled.value,
      },
    );
    message.value = 'Installation details saved on this site.';
    await loadEvents();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Commissioning update failed.';
  } finally {
    busy.value = false;
  }
}

async function confirmPhysicalOutcome() {
  if (busy.value || !canConfirmPhysical.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await request(
      `/portal/devices/${encodeURIComponent(props.device.id)}/commissioning/confirm-physical-outcome`,
      'POST',
    );
    message.value = 'Physical result recorded.';
    await loadEvents();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Physical result could not be recorded.';
  } finally {
    busy.value = false;
  }
}

function eventTitle(kind: string, evidence: Record<string, unknown>) {
  if (kind === 'approved') return 'Device approved';
  if (kind === 'control_configured') return 'Control route saved';
  if (kind === 'installation_details_saved') return 'Name and room updated';
  if (kind === 'physical_outcome_confirmed') return 'Physical result confirmed';
  if (kind === 'command' && evidence.stage === 'requested') return 'Command requested';
  if (kind === 'command') return `Command ${String(evidence.status || 'result')}`;
  return 'Installation event';
}

function eventDetail(evidence: Record<string, unknown>) {
  return [evidence.action, evidence.adapter, evidence.message]
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .join(' · ');
}
</script>

<template>
  <section class="commissioning" aria-label="Device commissioning">
    <h4>Installation</h4>
    <form @submit.prevent="saveDetails">
      <label>
        Device name
        <input v-model="name" maxlength="100" :disabled="busy || device.trustStatus !== 'approved'" required />
      </label>
      <label>
        Room
        <input v-model="room" maxlength="80" :disabled="busy || device.trustStatus !== 'approved'" required />
      </label>
      <label>
        Device settings address
        <input v-model="settingsUrl" type="url" maxlength="500" :disabled="busy || device.trustStatus !== 'approved'" placeholder="http://192.168.1.20" />
      </label>
      <label class="permission">
        <input v-model="assistantEnabled" type="checkbox" :disabled="busy || device.trustStatus !== 'approved'" />
        Allow the assistant to use this device
      </label>
      <p class="permission-note">The device needs a ready control route. Every voice command still needs your on-screen confirmation.</p>
      <button type="submit" :disabled="busy || device.trustStatus !== 'approved' || !name.trim() || !room.trim()">
        {{ busy ? 'Saving...' : 'Save installation' }}
      </button>
    </form>
    <p v-if="device.trustStatus === 'approved'" class="physical-status" role="status">
      Physical result: {{ confirmed ? 'confirmed by installer' : 'not confirmed' }}
    </p>
    <button
      v-if="canConfirmPhysical"
      type="button"
      class="secondary"
      :disabled="busy"
      @click="confirmPhysicalOutcome"
    >
      Confirm physical result
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="message" role="status">{{ message }}</p>
    <div class="history" aria-label="Installation history">
      <h5>Recent history</h5>
      <p v-if="eventsError" class="history-error">{{ eventsError }}</p>
      <p v-else-if="!events.length" class="empty-history">No recorded installation activity yet.</p>
      <ol v-else>
        <li v-for="event in events" :key="event.id">
          <strong>{{ eventTitle(event.kind, event.evidence) }}</strong>
          <time :datetime="event.occurredAt">{{ new Date(event.occurredAt).toLocaleString() }}</time>
          <span v-if="eventDetail(event.evidence)">{{ eventDetail(event.evidence) }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.commissioning {
  border-top: 1px solid var(--border, #d7dfeb);
  margin-top: 16px;
  padding-top: 16px;
  display: grid;
  gap: 12px;
}
h4, p { margin: 0; }
form { display: grid; gap: 10px; }
label { display: grid; gap: 6px; font-size: 13px; }
input, button {
  box-sizing: border-box;
  max-width: 100%;
  min-height: 40px;
  border: 1px solid var(--border, #d7dfeb);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--surface, transparent);
  color: inherit;
  font: inherit;
}
button { justify-self: start; cursor: pointer; font-weight: 700; }
button:disabled { opacity: .5; cursor: not-allowed; }
.secondary { background: var(--surface-muted, #eef3fb); }
.physical-status { color: var(--muted, #64748b); font-size: 13px; }
[role='alert'] { color: #c0392b; font-size: 13px; }
.history { display: grid; gap: 8px; }
.history h5, .empty-history { margin: 0; }
.history ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.history li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; font-size: 12px; }
.history li span { grid-column: 1 / -1; color: var(--muted, #64748b); overflow-wrap: anywhere; }
.history time, .empty-history, .history-error { color: var(--muted, #64748b); font-size: 12px; }
.history-error { color: #c0392b; }
.permission { display: flex; align-items: center; gap: 9px; }
.permission input { width: 16px; min-height: 16px; height: 16px; margin: 0; }
.permission-note { color: var(--muted, #64748b); font-size: 12px; }
@media (max-width: 520px) { .history li { grid-template-columns: 1fr; } .history li span { grid-column: auto; } }
</style>
