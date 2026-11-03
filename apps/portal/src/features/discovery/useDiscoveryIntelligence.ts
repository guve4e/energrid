import { computed, nextTick, ref, watch, onBeforeUnmount, type ComputedRef, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import { cloudEvidenceConsentMessage } from '../../components/discovery/network-endpoint-investigation';
import type { NetworkDevice } from './discovery-contracts';
import { useMqttProfileInvestigations } from './useMqttProfileInvestigations';

export type LlmProviderAvailability = {
  mode: 'disabled' | 'local-only' | 'cloud-enabled';
  provider: string | null;
  available: boolean;
  cloudDataConsentRequired: boolean;
  reasonCode?: string;
};

/** Investigation suggestions never authorize enrollment or device control. */
export function useDiscoveryIntelligence(deps: {
  apiBase: string;
  accessToken: Readonly<Ref<string>>;
  networkDevices: ComputedRef<NetworkDevice[]>;
  siteScope: () => string | null;
  request?: typeof authFetch;
  confirm?: (message: string) => boolean;
}) {
  const { apiBase, accessToken, networkDevices } = deps;
  const request = deps.request ?? authFetch;
  const confirm = deps.confirm ?? ((message: string) => window.confirm(message));
  let generation = 0;
  function session() {
    const token = accessToken.value;
    const scope = deps.siteScope();
    const version = generation;
    return { token, scope, current: () => !!token && !!scope && generation === version &&
      accessToken.value === token && deps.siteScope() === scope };
  }

type AiEvidenceRecord = {
  id: string;
  source: string;
  attribute: string;
  value: string | number | boolean;
  observedAt: string;
  confidence: string;
};

type AiHypothesis = {
  id: string;
  claim: string;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  missingEvidence: string[];
};

type AiInvestigationProposal = {
  id: string;
  action: string;
  reason: string;
  requiredEvidenceIds: string[];
  requiresApproval: true;
  status: 'proposed';
};

type AiInvestigationResult = {
  investigationId?: string;
  parentInvestigationId?: string;
  actionResult?: { action: string; outcome: string; reasonCode: string; statusCode?: number };
  deviceId: string;
  provider: string;
  model: string;
  assessment?: {
    schemaVersion: 1;
    deviceId: string;
    snapshotId: string;
    hypotheses: AiHypothesis[];
    proposals: AiInvestigationProposal[];
  };
  evidenceSnapshot?: {
    id: string;
    schemaVersion: 1;
    deviceId: string;
    createdAt: string;
    evidence: AiEvidenceRecord[];
  };
  report: {
    summary: string;
    findings: string[];
    unknowns: string[];
    nextSteps: string[];
  };
};

type AiHistoryRecord = {
  schemaVersion: 1;
  id: string;
  deviceId: string;
  createdAt: string;
  result: AiInvestigationResult;
};

const aiHistory = ref<Record<string, AiHistoryRecord[]>>({});

const aiHistoryLoading = ref<Record<string, boolean>>({});

const aiHistoryErrors = ref<Record<string, string>>({});

const selectedAiHistoryId = ref<string | null>(null);

async function loadAiHistory(deviceId: string): Promise<void> {
  if (aiHistoryLoading.value[deviceId]) return;
  const operation = session();
  if (!operation.current()) return;

  aiHistoryLoading.value[deviceId] = true;
  delete aiHistoryErrors.value[deviceId];

  try {
    const response = await request(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/investigations`,
      {
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`History request failed (${response.status})`);
    }

    const history = (await response.json()) as AiHistoryRecord[];
    if (!operation.current()) return;
    aiHistory.value[deviceId] = history;
  } catch (error) {
    if (!operation.current()) return;
    aiHistoryErrors.value[deviceId] =
      error instanceof Error ? error.message : 'History unavailable';
  } finally {
    if (operation.current()) aiHistoryLoading.value[deviceId] = false;
  }
}

function openAiHistoryRecord(record: AiHistoryRecord): void {
  selectedAiDeviceId.value = record.deviceId;
  selectedAiHistoryId.value = record.id;
  aiReports.value[record.deviceId] = record.result;
  void loadMqttProfileHistory(record.deviceId);
  void revealDeviceIntelligence();
}

const aiReports = ref<Record<string, AiInvestigationResult>>({});

const aiErrors = ref<Record<string, string>>({});

const aiInvestigating = ref<Record<string, boolean>>({});

const aiActionRunning = ref<Record<string, boolean>>({});

const aiActionErrors = ref<Record<string, string>>({});

const aiActionResults = ref<Record<string, { outcome: string; reasonCode: string; statusCode?: number }>>({});



const llmProviderAvailability = ref<LlmProviderAvailability | null>(null);

async function loadLlmProviderAvailability(): Promise<LlmProviderAvailability> {
  const operation = session();
  if (!operation.current()) throw new Error('No authenticated site selected');
  const response = await request(`${apiBase}/portal/investigations/availability`, {
    headers: { Authorization: `Bearer ${accessToken.value}` },
  });
  if (!operation.current()) throw new Error('Investigation context changed');
  if (!response.ok) throw new Error(`Provider status unavailable (${response.status})`);
  const status = await response.json() as LlmProviderAvailability;
  if (!operation.current()) throw new Error('Investigation context changed');
  llmProviderAvailability.value = status;
  return status;
}

async function confirmCloudEvidence(status: LlmProviderAvailability): Promise<boolean> {
  if (!status.cloudDataConsentRequired) return true;
  return confirm(cloudEvidenceConsentMessage(status.provider));
}

const deviceIntelligencePanel = ref<HTMLElement | null>(null);

async function revealDeviceIntelligence(): Promise<void> {
  await nextTick();
  deviceIntelligencePanel.value?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

function openDeviceIntelligenceOnly(deviceId: string): void {
  selectedAiDeviceId.value = deviceId;
  selectedAiHistoryId.value = null;

  void loadAiHistory(deviceId);
  void loadMqttProfileHistory(deviceId);
  const operation = session();
  void loadLlmProviderAvailability().catch(() => {
    if (!operation.current()) return;
    llmProviderAvailability.value = {
      mode: 'disabled', provider: null, available: false,
      cloudDataConsentRequired: false, reasonCode: 'provider-status-unavailable',
    };
  });
  void revealDeviceIntelligence();
}

async function investigateNetworkDeviceWithAi(device: NetworkDevice) {
  selectedAiDeviceId.value = device.id;
  selectedAiHistoryId.value = null;
  void loadAiHistory(device.id);
  void loadMqttProfileHistory(device.id);
  void revealDeviceIntelligence();

  if (aiInvestigating.value[device.id]) return;
  const operation = session();
  if (!operation.current()) return;

  aiInvestigating.value[device.id] = true;
  delete aiErrors.value[device.id];
  delete aiReports.value[device.id];

  try {
    const provider = await loadLlmProviderAvailability();
    if (!operation.current()) return;
    if (!provider.available) throw new Error(`Investigation provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider)) || !operation.current()) return;
    const response = await request(
      `${apiBase}/portal/network/${encodeURIComponent(device.id)}/investigate`,
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
            : `Investigation failed (${response.status})`,
      );
    }

    const report = (await response.json()) as AiInvestigationResult;
    if (!operation.current()) return;
    aiReports.value[device.id] = report;

    void loadAiHistory(device.id);

    if (selectedAiDeviceId.value === device.id) {
      void revealDeviceIntelligence();
    }
  } catch (error) {
    if (!operation.current()) return;
    aiErrors.value[device.id] =
      error instanceof Error ? error.message : 'Investigation failed';
  } finally {
    if (operation.current()) aiInvestigating.value[device.id] = false;
  }
}

async function executeInvestigationProposal(proposal: AiInvestigationProposal): Promise<void> {
  const deviceId = selectedAiDeviceId.value;
  const report = selectedAiReport.value;
  if (!deviceId || !report?.investigationId || aiActionRunning.value[proposal.id]) return;
  const target = selectedAiDevice.value;
  if (!target) return;
  if (proposal.action !== 'inspect_http_headers') {
    aiActionErrors.value[proposal.id] = 'This action has no supported deterministic executor yet.';
    return;
  }
  if (!confirm(`Energrid will send one HTTP HEAD request to ${target.ipAddress}:80 using this current LAN observation. Continue?`)) return;
  const operation = session();
  if (!operation.current()) return;
  aiActionRunning.value[proposal.id] = true;
  delete aiActionErrors.value[proposal.id];
  try {
    const provider = await loadLlmProviderAvailability();
    if (!operation.current()) return;
    if (!provider.available) throw new Error(`Reassessment provider unavailable (${provider.reasonCode || 'unavailable'}).`);
    if (!(await confirmCloudEvidence(provider)) || !operation.current()) return;
    const response = await request(
      `${apiBase}/portal/network/${encodeURIComponent(deviceId)}/investigations/${encodeURIComponent(report.investigationId)}/actions/${encodeURIComponent(proposal.id)}/execute`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ approved: true, cloudDataConsent: provider.cloudDataConsentRequired }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!operation.current()) return;
    if (!response.ok) throw new Error(body.message || `Diagnostic action failed (${response.status})`);
    aiActionResults.value[proposal.id] = {
      outcome: body.outcome,
      reasonCode: body.reasonCode || body.action?.reasonCode || 'completed',
      statusCode: body.action?.result?.statusCode,
    };
    if (body.reassessment) {
      aiReports.value[deviceId] = body.reassessment as AiInvestigationResult;
      selectedAiHistoryId.value = body.reassessment.investigationId || null;
      void loadAiHistory(deviceId);
    }
  } catch (error) {
    if (!operation.current()) return;
    aiActionErrors.value[proposal.id] = error instanceof Error ? error.message : 'Diagnostic action failed';
  } finally {
    if (operation.current()) aiActionRunning.value[proposal.id] = false;
  }
}

const selectedAiDeviceId = ref<string | null>(null);

const selectedAiDevice = computed(() =>
  networkDevices.value.find(
    (device) => device.id === selectedAiDeviceId.value,
  ) || null,
);

const selectedAiReport = computed(() =>
  selectedAiDeviceId.value
    ? aiReports.value[selectedAiDeviceId.value]
    : null,
);

function aiEvidenceLabel(
  result: AiInvestigationResult,
  evidenceId: string,
): string {
  const evidence = result.evidenceSnapshot?.evidence.find(
    (item) => item.id === evidenceId,
  );

  if (!evidence) return `Unresolved evidence: ${evidenceId}`;

  return `${evidence.attribute} = ${String(evidence.value)} (${evidence.source})`;
}

function aiConfidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% model estimate`;
}

const selectedAiError = computed(() =>
  selectedAiDeviceId.value
    ? aiErrors.value[selectedAiDeviceId.value]
    : null,
);
  const mqtt = useMqttProfileInvestigations({
    apiBase, accessToken, selectedAiDeviceId, request, session,
    loadLlmProviderAvailability, confirmCloudEvidence,
  });
  function loadMqttProfileHistory(deviceId: string): Promise<void> {
    return mqtt.loadMqttProfileHistory(deviceId);
  }
  // Previous site/session evidence must never be shown under a new identity.
  function invalidate() {
    generation += 1;
    selectedAiDeviceId.value = null;
    selectedAiHistoryId.value = null;
    aiReports.value = {};
    aiErrors.value = {};
    aiHistory.value = {};
    aiHistoryLoading.value = {};
    aiHistoryErrors.value = {};
    aiInvestigating.value = {};
    aiActionRunning.value = {};
    aiActionErrors.value = {};
    aiActionResults.value = {};
    mqtt.invalidate();
    llmProviderAvailability.value = null;
  }
  watch([accessToken, deps.siteScope], invalidate, { flush: 'sync' });
  onBeforeUnmount(invalidate);

  return {
    aiHistory, aiHistoryLoading, aiHistoryErrors, selectedAiHistoryId, loadAiHistory, openAiHistoryRecord,
    aiReports, aiErrors, aiInvestigating, aiActionRunning, aiActionErrors, aiActionResults,
    llmProviderAvailability, loadLlmProviderAvailability, confirmCloudEvidence,
    deviceIntelligencePanel, openDeviceIntelligenceOnly, investigateNetworkDeviceWithAi,
    executeInvestigationProposal,
    selectedAiDeviceId, selectedAiDevice, selectedAiReport, aiEvidenceLabel,
    aiConfidenceLabel, selectedAiError, ...mqtt,
  };
}
