<script setup lang="ts">
import { computed, ref, watch } from 'vue';

type CommissioningEvent = {
  id: string;
  kind: string;
  occurredAt: string;
  evidence: Record<string, string | number | boolean | null>;
};

type InstallationProposal = {
  id: string;
  deviceId: string;
  status: 'pending' | 'approved' | 'rejected';
  expiresAt: string;
  current: {
    displayName: string;
    zoneName: string;
    loadType: string | null;
  };
  proposed: {
    displayName: string;
    zoneName: string;
    loadType: string | null;
  };
};

type CommissioningDevice = {
  id: string;
  displayName: string;
  zoneName: string;
  trustStatus: string;
  assistantEnabled?: boolean;
  settingsUrl?: string;
  metadata?: Record<string, string | number | boolean>;
  adapter?: { protocol?: string };
  commissioning?: {
    physicalOutcome: 'not_confirmed' | 'confirmed';
    confirmedAt: string | null;
  };
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
const loadType = ref<'lighting' | ''>('');
const initialLoadType = ref<'lighting' | ''>('');
const loadConfirmed = ref(false);

const busy = ref(false);
const error = ref('');
const message = ref('');

const events = ref<CommissioningEvent[]>([]);
const eventsError = ref('');

const proposals = ref<InstallationProposal[]>([]);
const proposalsError = ref('');
const loadingProposals = ref(false);
const proposalConfirmations = ref<Record<string, boolean>>({});

const approved = computed(
  () => props.device.trustStatus === 'approved',
);

const confirmed = computed(
  () => props.device.commissioning?.physicalOutcome === 'confirmed',
);

const canConfirmPhysical = computed(
  () => approved.value &&
    props.device.state.command?.status === 'acked' &&
    !confirmed.value,
);

const showWebSettings = computed(
  () => props.device.adapter?.protocol?.startsWith('http') === true ||
    !!props.device.settingsUrl ||
    !!props.settingsUrlSuggestion,
);

function requiresPhysicalConfirmation(proposal: InstallationProposal) {
  return proposal.proposed.loadType === 'lighting' &&
    proposal.current.loadType !== 'lighting';
}

function expired(proposal: InstallationProposal) {
  const timestamp = Date.parse(proposal.expiresAt);
  return !Number.isFinite(timestamp) || Date.now() >= timestamp;
}

watch(
  () => [
    props.device.id,
    props.device.displayName,
    props.device.zoneName,
    props.device.settingsUrl,
    props.device.assistantEnabled,
    props.device.metadata?.loadType,
    props.settingsUrlSuggestion,
  ],
  () => {
    name.value = props.device.displayName;
    room.value = props.device.zoneName;
    settingsUrl.value =
      props.device.settingsUrl || props.settingsUrlSuggestion || '';
    assistantEnabled.value = props.device.assistantEnabled === true;

    const currentLoad =
      props.device.metadata?.loadType === 'lighting' ? 'lighting' : '';

    loadType.value = currentLoad;
    initialLoadType.value = currentLoad;
    loadConfirmed.value = false;

    error.value = '';
    message.value = '';
    proposalConfirmations.value = {};

    void loadEvents();
    void loadProposals();
  },
  { immediate: true },
);

async function request(
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${props.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${props.accessToken}`,
      ...(body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(body !== undefined
      ? { body: JSON.stringify(body) }
      : {}),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    const details = result as { message?: string | string[] } | null;
    throw new Error(
      Array.isArray(details?.message)
        ? details.message.join(', ')
        : details?.message || 'Request failed.',
    );
  }

  return result;
}

async function loadEvents() {
  const deviceId = props.device.id;
  eventsError.value = '';

  try {
    const result = await request(
      `/portal/devices/${encodeURIComponent(deviceId)}/commissioning/events`,
      'GET',
    ) as { events?: CommissioningEvent[] } | null;

    if (props.device.id === deviceId)
      events.value = Array.isArray(result?.events) ? result.events : [];
  } catch (cause) {
    if (props.device.id === deviceId)
      eventsError.value = cause instanceof Error
        ? cause.message
        : 'History could not be loaded.';
  }
}

async function loadProposals() {
  const deviceId = props.device.id;
  loadingProposals.value = true;
  proposalsError.value = '';

  try {
    const result = await request(
      `/portal/devices/${encodeURIComponent(deviceId)}/installation-proposals`,
      'GET',
    ) as { proposals?: InstallationProposal[] } | null;

    if (props.device.id === deviceId)
      proposals.value = Array.isArray(result?.proposals)
        ? result.proposals.filter(item => item.status === 'pending')
        : [];
  } catch (cause) {
    if (props.device.id === deviceId)
      proposalsError.value = cause instanceof Error
        ? cause.message
        : 'Pending proposals could not be loaded.';
  } finally {
    if (props.device.id === deviceId)
      loadingProposals.value = false;
  }
}

async function decideProposal(
  proposal: InstallationProposal,
  decision: 'approve' | 'reject',
) {
  if (busy.value) return;

  if (decision === 'approve') {
    if (expired(proposal)) {
      error.value = 'This proposal has expired. Create a new one in chat.';
      return;
    }

    if (
      requiresPhysicalConfirmation(proposal) &&
      !proposalConfirmations.value[proposal.id]
    ) {
      error.value = 'Confirm the physical lighting load first.';
      return;
    }
  }

  busy.value = true;
  error.value = '';
  message.value = '';

  try {
    const result = await request(
      `/portal/devices/${encodeURIComponent(props.device.id)}` +
      `/installation-proposals/${encodeURIComponent(proposal.id)}/decision`,
      'POST',
      {
        decision,
        physicalLoadConfirmed:
          decision === 'approve' &&
          proposalConfirmations.value[proposal.id] === true,
      },
    ) as { status?: string } | null;

    if (result?.status !== 'approved' && result?.status !== 'rejected') {
      error.value = `Core did not apply the decision: ${
        result?.status || 'unknown result'
      }.`;
      await loadProposals();
      return;
    }

    message.value = result.status === 'approved'
      ? 'Installation proposal approved and saved.'
      : 'Installation proposal rejected. No configuration changed.';

    await Promise.all([loadProposals(), loadEvents()]);

    if (result.status === 'approved')
      emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : 'Proposal decision failed.';
  } finally {
    busy.value = false;
  }
}

async function saveDetails() {
  if (busy.value || !approved.value) return;

  const normalizedSettingsUrl = settingsUrl.value.trim();

  if (normalizedSettingsUrl) {
    try {
      const parsed = new URL(normalizedSettingsUrl);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      ) throw new Error();
    } catch {
      error.value = 'Enter a valid HTTP or HTTPS settings address.';
      return;
    }
  }

  const changingLoad = loadType.value !== initialLoadType.value;

  if (changingLoad && loadType.value === 'lighting' && !loadConfirmed.value) {
    error.value = 'Confirm the physical lighting load first.';
    return;
  }

  busy.value = true;
  error.value = '';
  message.value = '';

  try {
    await request(
      `/portal/devices/${encodeURIComponent(props.device.id)}/commissioning`,
      'PATCH',
      {
        displayName: name.value.trim(),
        zoneName: room.value.trim(),
        settingsUrl: normalizedSettingsUrl || null,
        assistantEnabled: assistantEnabled.value,
        ...(changingLoad
          ? {
              loadType: loadType.value || null,
              loadPurposeConfirmed: loadType.value === 'lighting'
                ? loadConfirmed.value
                : false,
            }
          : {}),
      },
    );

    message.value = 'Installation details saved.';
    await loadEvents();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : 'Commissioning update failed.';
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
      `/portal/devices/${encodeURIComponent(props.device.id)}` +
      '/commissioning/confirm-physical-outcome',
      'POST',
    );

    message.value = 'Physical result recorded.';
    await loadEvents();
    emit('saved');
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : 'Physical result could not be recorded.';
  } finally {
    busy.value = false;
  }
}

function eventTitle(kind: string, evidence: Record<string, unknown>) {
  if (
    kind === 'installation_details_saved' &&
    evidence.update === 'conversational_installation_approval'
  ) return 'Conversational installation approved';

  if (kind === 'approved') return 'Device approved';
  if (kind === 'control_configured') return 'Control route saved';
  if (kind === 'installation_details_saved') return 'Installation updated';
  if (kind === 'physical_outcome_confirmed') return 'Physical result confirmed';
  if (kind === 'command' && evidence.stage === 'requested')
    return 'Command requested';
  if (kind === 'command')
    return `Command ${String(evidence.status || 'result')}`;

  return 'Installation event';
}

function eventDetail(evidence: Record<string, unknown>) {
  return [
    evidence.action,
    evidence.displayName,
    evidence.zoneName,
    evidence.loadType,
    evidence.adapter,
    evidence.message,
  ]
    .filter((value): value is string =>
      typeof value === 'string' && !!value.trim(),
    )
    .join(' · ');
}
</script>

<template>
  <section class="commissioning" aria-label="Device commissioning">

    <div class="section-heading">
      <h4>Installation</h4>
      <span class="subtle">Approved device configuration</span>
    </div>

    <section class="proposal-section" aria-label="Installation proposals">
      <div class="section-heading">
        <h5>Pending proposals</h5>
        <button
          type="button"
          class="text-button"
          :disabled="busy || loadingProposals"
          @click="loadProposals"
        >
          {{ loadingProposals ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>

      <p v-if="proposalsError" class="error" role="alert">
        {{ proposalsError }}
      </p>

      <p v-else-if="!proposals.length" class="subtle">
        No pending installation proposals. Ask Energrid in chat to
        configure this device, then refresh here.
      </p>

      <article
        v-for="proposal in proposals"
        :key="proposal.id"
        class="proposal-card"
      >
        <div class="section-heading">
          <strong>Proposed installation</strong>
          <span class="subtle">
            {{ expired(proposal) ? 'Expired' : 'Awaiting approval' }}
          </span>
        </div>

        <div class="proposal-diff">
          <span class="subtle">Setting</span>
          <span class="subtle">Current</span>
          <span class="subtle">Proposed</span>

          <span>Name</span>
          <span>{{ proposal.current.displayName }}</span>
          <strong>{{ proposal.proposed.displayName }}</strong>

          <span>Room</span>
          <span>{{ proposal.current.zoneName }}</span>
          <strong>{{ proposal.proposed.zoneName }}</strong>

          <span>Controls</span>
          <span>{{ proposal.current.loadType || 'Not classified' }}</span>
          <strong>{{ proposal.proposed.loadType || 'Not classified' }}</strong>
        </div>

        <label
          v-if="requiresPhysicalConfirmation(proposal)"
          class="checkbox-row"
        >
          <input
            v-model="proposalConfirmations[proposal.id]"
            type="checkbox"
            :disabled="busy || expired(proposal)"
          />
          I verified what this device physically controls.
        </label>

        <div class="actions">
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            @click="decideProposal(proposal, 'reject')"
          >
            Reject
          </button>
          <button
            type="button"
            :disabled="
              busy ||
              expired(proposal) ||
              (requiresPhysicalConfirmation(proposal) &&
                !proposalConfirmations[proposal.id])
            "
            @click="decideProposal(proposal, 'approve')"
          >
            Approve changes
          </button>
        </div>
      </article>
    </section>

    <form @submit.prevent="saveDetails">
      <label>
        Device name
        <input
          v-model="name"
          maxlength="100"
          :disabled="busy || !approved"
          required
        />
      </label>

      <div class="form-grid">
        <label>
          Room
          <input
            v-model="room"
            maxlength="80"
            :disabled="busy || !approved"
            required
          />
        </label>

        <label>
          Controls
          <select v-model="loadType" :disabled="busy || !approved">
            <option value="">Not classified</option>
            <option value="lighting">Lighting</option>
          </select>
        </label>
      </div>

      <label
        v-if="loadType === 'lighting' &&
          loadType !== initialLoadType"
        class="checkbox-row"
      >
        <input
          v-model="loadConfirmed"
          type="checkbox"
          :disabled="busy"
        />
        I verified that this device controls lighting.
      </label>

      <label class="checkbox-row">
        <input
          v-model="assistantEnabled"
          type="checkbox"
          :disabled="busy || !approved"
        />
        Allow the assistant to use this device
      </label>

      <p class="subtle">
        Assistant permission is separate from installation approval.
        Physical actions remain subject to Core safety checks.
      </p>

      <div class="actions">
        <button
          type="submit"
          :disabled="busy || !approved || !name.trim() || !room.trim()"
        >
          {{ busy ? 'Saving...' : 'Save installation' }}
        </button>
      </div>

      <details class="advanced">
        <summary>Advanced settings</summary>

        <div class="advanced-content">
          <label v-if="showWebSettings">
            Web settings address (optional)
            <input
              v-model="settingsUrl"
              type="url"
              maxlength="500"
              :disabled="busy || !approved"
              placeholder="Verified HTTP(S) address"
            />
          </label>

          <div class="physical-panel">
            <span>
              Physical command result:
              {{ confirmed ? 'confirmed' : 'not confirmed' }}
            </span>

            <button
              v-if="canConfirmPhysical"
              type="button"
              class="secondary"
              :disabled="busy"
              @click="confirmPhysicalOutcome"
            >
              Confirm physical result
            </button>
          </div>

          <p class="subtle">
            Command-result confirmation is separate from verifying
            which electrical load the device controls.
          </p>
        </div>
      </details>
    </form>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="message" class="success" role="status">
      {{ message }}
    </p>

    <details class="advanced history-panel">
      <summary>Activity history ({{ events.length }})</summary>

      <div class="advanced-content">
        <p v-if="eventsError" class="error">{{ eventsError }}</p>
        <p v-else-if="!events.length" class="subtle">
          No recorded installation activity.
        </p>

        <ol v-else class="history-list">
          <li v-for="event in events" :key="event.id">
            <div class="history-heading">
              <strong>{{ eventTitle(event.kind, event.evidence) }}</strong>
              <time :datetime="event.occurredAt">
                {{ new Date(event.occurredAt).toLocaleString() }}
              </time>
            </div>
            <span v-if="eventDetail(event.evidence)" class="subtle">
              {{ eventDetail(event.evidence) }}
            </span>
          </li>
        </ol>
      </div>
    </details>
  </section>
</template>

<style scoped>
.commissioning {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding-top: 12px;
}

h4, h5, p {
  margin: 0;
}

h4 { font-size: 16px; }
h5 { font-size: 14px; }

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.subtle {
  color: var(--muted, #64748b);
  font-size: 12px;
  line-height: 1.5;
}

.proposal-section {
  display: grid;
  gap: 10px;
}

.proposal-card {
  display: grid;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--border, #d7dfeb);
  border-radius: 10px;
  background: var(--surface-muted, transparent);
}

.proposal-diff {
  display: grid;
  grid-template-columns: minmax(65px, .7fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  font-size: 12px;
  overflow-wrap: anywhere;
}

form {
  display: grid;
  gap: 12px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  min-width: 0;
}

input:not([type='checkbox']), select, button {
  box-sizing: border-box;
  max-width: 100%;
  min-height: 38px;
  border: 1px solid var(--border, #d7dfeb);
  border-radius: 7px;
  padding: 8px 10px;
  background: var(--surface, transparent);
  color: inherit;
  font: inherit;
}

input:not([type='checkbox']), select {
  width: 100%;
}

button {
  cursor: pointer;
  font-weight: 650;
}

button:disabled {
  cursor: not-allowed;
  opacity: .5;
}

.secondary {
  background: var(--surface-muted, #eef3fb);
}

.text-button {
  border: 0;
  background: transparent;
  padding: 4px;
  min-height: 0;
  color: inherit;
  text-decoration: underline;
  font-size: 12px;
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 9px;
}

.checkbox-row input {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  margin: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.advanced {
  border: 1px solid var(--border, #d7dfeb);
  border-radius: 8px;
  min-width: 0;
}

.advanced summary {
  cursor: pointer;
  padding: 11px 12px;
  font-size: 13px;
  font-weight: 650;
}

.advanced-content {
  display: grid;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid var(--border, #d7dfeb);
}

.physical-panel {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  font-size: 12px;
}

.history-list {
  display: grid;
  gap: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 230px;
  overflow-y: auto;
}

.history-list li {
  display: grid;
  gap: 4px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border, #d7dfeb);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.history-heading {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.history-heading time {
  color: var(--muted, #64748b);
  font-size: 11px;
}

.error {
  color: #c0392b;
  font-size: 12px;
}

.success {
  font-size: 12px;
}

@media (max-width: 520px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .proposal-diff {
    grid-template-columns: minmax(60px, .65fr) repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
}
</style>
