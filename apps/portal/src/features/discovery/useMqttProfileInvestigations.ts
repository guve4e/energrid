import { computed, ref, type Ref } from 'vue';
import type { authFetch } from '../../auth/auth-client';
import type { LlmProviderAvailability } from './useDiscoveryIntelligence';

type MqttProfileHistoryRecord = {
  schemaVersion: 1;
  kind: 'mqtt-observation-profile';
  id: string;
  deviceId: string;
  createdAt: string;
  result: {
    provider: string;
    model: string;
    proposal: {
      status: 'proposed';
      requiresApproval: true;
      selector: string;
      fields: Record<
        string,
        { rawKey: string; type: 'number' | 'boolean' | 'string' }
      >;
      supportingEvidenceIds: string[];
    };
    replay: {
      status: 'passed' | 'failed';
      profileStatus: 'proposed';
      installationAuthorized: false;
      testedSamples: number;
      acceptedSamples: number;
      rejectedSamples: number;
      observedFields: Record<string, number | boolean | string>;
      steps: Array<{
        evidenceId: string;
        passed: boolean;
        reason: string;
        updatedKeys: string[];
        ignoredKeys: string[];
        rejectedFields: string[];
      }>;
    };
  };
};

/** MQTT evidence is a separate identity source: suggestions are never installed automatically. */
export function useMqttProfileInvestigations(deps: {
  apiBase: string;
  accessToken: Readonly<Ref<string>>;
  selectedAiDeviceId: Ref<string | null>;
  request: typeof authFetch;
  session: () => { token: string; scope: string | null; current: () => boolean };
  loadLlmProviderAvailability: () => Promise<LlmProviderAvailability>;
  confirmCloudEvidence: (status: LlmProviderAvailability) => Promise<boolean>;
}) {
  const { apiBase, accessToken, selectedAiDeviceId, request, session,
    loadLlmProviderAvailability, confirmCloudEvidence } = deps;
const mqttProfileHistory =
  ref<Record<string, MqttProfileHistoryRecord[]>>({});

const mqttProfileSelected =
  ref<Record<string, MqttProfileHistoryRecord>>({});

const mqttProfileLoading = ref<Record<string, boolean>>({});

const mqttProfileRunning = ref<Record<string, boolean>>({});

const mqttProfileErrors = ref<Record<string, string>>({});

const selectedMqttProfile = computed(() =>
  selectedAiDeviceId.value
    ? mqttProfileSelected.value[selectedAiDeviceId.value] ?? null
    : null,
);

type MqttCaptureStatus = {
  enabled: boolean;
  deviceId: string;
  topics: string[];
  samplesInWindow: number;
  latestCapturedAt: string | null;
};

const kitchenCaptureStatus = ref<MqttCaptureStatus | null>(null);

const kitchenCaptureError = ref<string | null>(null);

const kitchenCaptureLoading = ref(false);

async function loadKitchenCaptureStatus(): Promise<void> {
  if (kitchenCaptureLoading.value) return;
  const operation = session();
  if (!operation.current()) return;

  kitchenCaptureLoading.value = true;
  kitchenCaptureError.value = null;

  try {
    const response = await request(
      `${apiBase}/portal/mqtt/evidence/temp-kitchen/status`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Evidence status failed (${response.status})`);
    }

    const status = (await response.json()) as MqttCaptureStatus;
    if (!operation.current()) return;
    kitchenCaptureStatus.value = status;
  } catch (error) {
    if (!operation.current()) return;
    kitchenCaptureError.value =
      error instanceof Error ? error.message : 'Status unavailable';
  } finally {
    if (operation.current()) kitchenCaptureLoading.value = false;
  }
}

async function loadMqttProfileHistory(deviceId: string): Promise<void> {
  if (mqttProfileLoading.value[deviceId]) return;
  const operation = session();
  if (!operation.current()) return;

  mqttProfileLoading.value[deviceId] = true;
  delete mqttProfileErrors.value[deviceId];

  try {
    const response = await request(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/profile-investigations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `MQTT profile history unavailable (${response.status})`,
      );
    }

    const records: unknown = await response.json();

    if (!Array.isArray(records)) {
      throw new Error('Invalid MQTT profile history response');
    }

    if (!operation.current()) return;
    mqttProfileHistory.value[deviceId] = records as MqttProfileHistoryRecord[];
  } catch (error) {
    if (!operation.current()) return;
    mqttProfileErrors.value[deviceId] =
      error instanceof Error ? error.message : 'History unavailable';
  } finally {
    if (operation.current()) mqttProfileLoading.value[deviceId] = false;
  }
}

function previewMqttProfile(deviceId: string): void {
  // Synthetic frontend-only fixture.
  // No MQTT, AI, database writes or installation privileges.
  mqttProfileSelected.value[deviceId] = {
    schemaVersion: 1,
    kind: 'mqtt-observation-profile',
    id: `synthetic-preview-${deviceId}`,
    deviceId,
    createdAt: new Date().toISOString(),
    result: {
      provider: 'offline-preview',
      model: 'synthetic-fixture-no-llm',
      proposal: {
        status: 'proposed',
        requiresApproval: true,
        selector: 'demo/esp8266/temperature',
        fields: {
          temperature: {
            rawKey: 'temperature',
            type: 'number',
          },
          humidity: {
            rawKey: 'humidity',
            type: 'number',
          },
        },
        supportingEvidenceIds: ['demo-sample-1'],
      },
      replay: {
        status: 'passed',
        profileStatus: 'proposed',
        installationAuthorized: false,
        testedSamples: 2,
        acceptedSamples: 2,
        rejectedSamples: 0,
        observedFields: {
          temperature: 25.3,
          humidity: 40.3,
        },
        steps: [
          {
            evidenceId: 'demo-sample-1',
            passed: true,
            reason: 'accepted',
            updatedKeys: ['temperature', 'humidity'],
            ignoredKeys: [],
            rejectedFields: [],
          },
          {
            evidenceId: 'demo-sample-2',
            passed: true,
            reason: 'accepted',
            updatedKeys: ['temperature'],
            ignoredKeys: [],
            rejectedFields: [],
          },
        ],
      },
    },
  };
}

async function investigateMqttProfile(deviceId: string): Promise<void> {
  if (mqttProfileRunning.value[deviceId]) return;
  const operation = session();
  if (!operation.current()) return;

  mqttProfileRunning.value[deviceId] = true;
  delete mqttProfileErrors.value[deviceId];

  try {
    const provider = await loadLlmProviderAvailability();
    if (!operation.current()) return;
    if (!provider.available) throw new Error(`Investigation provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider)) || !operation.current()) return;
    const response = await request(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/profile-investigations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cloudDataConsent: provider.cloudDataConsentRequired }),
      },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = body.message;

      throw new Error(
        typeof message === 'string'
          ? message
          : Array.isArray(message)
            ? message.join(', ')
            : `Profile investigation failed (${response.status})`,
      );
    }

    const record = (await response.json()) as MqttProfileHistoryRecord;
    if (!operation.current()) return;
    mqttProfileSelected.value[deviceId] = record;
    await loadMqttProfileHistory(deviceId);
  } catch (error) {
    if (!operation.current()) return;
    mqttProfileErrors.value[deviceId] =
      error instanceof Error
        ? error.message
        : 'MQTT profile investigation failed';
  } finally {
    if (operation.current()) mqttProfileRunning.value[deviceId] = false;
  }
}


  function invalidate() {
    mqttProfileSelected.value = {};
    mqttProfileHistory.value = {};
    mqttProfileLoading.value = {};
    mqttProfileRunning.value = {};
    mqttProfileErrors.value = {};
    kitchenCaptureStatus.value = null;
    kitchenCaptureError.value = null;
    kitchenCaptureLoading.value = false;
  }
  return { mqttProfileHistory, mqttProfileSelected, mqttProfileLoading, mqttProfileRunning,
    mqttProfileErrors, selectedMqttProfile, kitchenCaptureStatus, kitchenCaptureError,
    kitchenCaptureLoading, loadKitchenCaptureStatus, loadMqttProfileHistory,
    previewMqttProfile, investigateMqttProfile, invalidate };
}
