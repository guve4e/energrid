import {
  processObservationPipeline,
  type ApprovedObservationBinding,
  type DeviceObservationState,
  type ObservationAuthorityPolicy,
  type ObservationValue,
} from '@energrid/domain-devices';

import {
  validateObservationProfileProposal,
  type CapturedMqttSample,
  type ObservationProfileProposal,
} from './observation-profile-proposal';

import type {
  DeviceEvidenceSnapshot,
} from './device-evidence';

export interface DeviceProfileReplayStep {
  evidenceId: string;
  receivedAt: string;
  pipelineAccepted: boolean;
  passed: boolean;
  stage: string;
  reason: string;
  updatedKeys: string[];
  ignoredKeys: string[];
  rejectedFields: string[];
}

export interface DeviceProfileReplayReport {
  status: 'passed' | 'failed';
  profileStatus: 'proposed';
  installationAuthorized: false;
  testedSamples: number;
  acceptedSamples: number;
  rejectedSamples: number;
  mappedFields: string[];
  observedFields: Record<string, ObservationValue>;
  steps: DeviceProfileReplayStep[];
}

/**
 * Offline replay of an untrusted AI profile proposal.
 *
 * Validation authority is local to this function.
 * It is NOT installation authority.
 *
 * No MQTT, registry, persistence, or network access.
 */
export function replayObservationProfileProposal(
  candidate: unknown,
  snapshot: DeviceEvidenceSnapshot,
  samples: readonly CapturedMqttSample[],
): DeviceProfileReplayReport {
  // Revalidate at the replay boundary.
  const proposal: ObservationProfileProposal =
    validateObservationProfileProposal(
      candidate,
      snapshot,
      samples,
    );

  const evidenceById = new Map(
    snapshot.evidence.map((item) => [item.id, item]),
  );

  // Replay ALL captured samples for the proposed topic.
  // Do not let the AI cherry-pick only favorable evidence IDs.
  const selected = samples.filter(
    (sample) => sample.topic === proposal.selector,
  );

  if (
    selected.length === 0 ||
    selected.length > 8
  ) {
    throw new Error('Invalid replay sample count');
  }

  const seenEvidence = new Set<string>();

  const ordered = selected.map((sample) => {
    const evidence = evidenceById.get(sample.evidenceId);

    if (
      !evidence ||
      evidence.source !== 'mqtt' ||
      evidence.confidence !== 'observed' ||
      evidence.attribute !== 'captured-message' ||
      evidence.value !== sample.topic ||
      !Number.isFinite(Date.parse(evidence.observedAt))
    ) {
      throw new Error(
        'Replay sample is not backed by matching captured evidence',
      );
    }

    if (seenEvidence.has(sample.evidenceId)) {
      throw new Error('Duplicate replay evidence ID');
    }

    seenEvidence.add(sample.evidenceId);

    return {
      sample,
      receivedAt: evidence.observedAt,
    };
  });

  // The evidence store returns newest-first.
  // The observation engine must see chronological captures.
  ordered.sort(
    (a, b) =>
      Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
      a.sample.evidenceId.localeCompare(b.sample.evidenceId),
  );

  // This source identity exists ONLY inside the replay.
  const sourceId = 'energrid-offline-profile-replay';

  const binding: ApprovedObservationBinding = {
    deviceId: proposal.deviceId,
    sourceId,
    selector: proposal.selector,
    fields: proposal.fields,
  };

  // A hypothetical policy used to evaluate a candidate mapping.
  // This policy is never persisted or installed.
  const policy: ObservationAuthorityPolicy = {
    deviceId: proposal.deviceId,
    allowedSourcesByField: Object.fromEntries(
      Object.keys(proposal.fields).map((field) => [
        field,
        [sourceId],
      ]),
    ),
  };

  let state: DeviceObservationState | null = null;

  const steps: DeviceProfileReplayStep[] = [];

  for (const { sample, receivedAt } of ordered) {
    const result = processObservationPipeline({
      binding,
      policy,
      context: {
        selector: sample.topic,
        receivedAt,
        evidenceId: sample.evidenceId,
      },
      payload: sample.payload,
      currentState: state,
    });

    state = result.state;

    // Partial decoding is not a clean replay pass.
    const passed =
      result.accepted &&
      result.rejectedFields.length === 0;

    steps.push({
      evidenceId: sample.evidenceId,
      receivedAt,
      pipelineAccepted: result.accepted,
      passed,
      stage: result.stage,
      reason: result.reason,
      updatedKeys: result.updatedKeys,
      ignoredKeys: result.ignoredKeys,
      rejectedFields: result.rejectedFields,
    });
  }

  const observedFields: Record<string, ObservationValue> =
    Object.fromEntries(
      Object.entries(state?.fields ?? {}).map(
        ([field, observation]) => [
          field,
          observation.value,
        ],
      ),
    );

  const mappedFields = Object.keys(proposal.fields);

  const acceptedSamples = steps.filter(
    (step) => step.passed,
  ).length;

  const rejectedSamples =
    steps.length - acceptedSamples;

  // Every declared field must actually have been accepted.
  const coverageComplete = mappedFields.every(
    (field) =>
      Object.prototype.hasOwnProperty.call(
        observedFields,
        field,
      ),
  );

  return {
    status:
      rejectedSamples === 0 && coverageComplete
        ? 'passed'
        : 'failed',
    profileStatus: 'proposed',
    installationAuthorized: false,
    testedSamples: steps.length,
    acceptedSamples,
    rejectedSamples,
    mappedFields,
    observedFields,
    steps,
  };
}
