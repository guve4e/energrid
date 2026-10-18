import {
  processDeviceObservation,
  type DeviceObservationState,
  type ObservationAuthorityPolicy,
  type ObservationDecision,
} from './device-observation-engine';

import {
  decodeObservationProfile,
  type ApprovedObservationBinding,
  type ObservationIngressContext,
  type DecodeResult,
} from './device-observation-profile';

export interface ObservationPipelineInput {
  binding: ApprovedObservationBinding | null;
  policy: ObservationAuthorityPolicy | null;
  context: ObservationIngressContext;
  payload: unknown;
  currentState: DeviceObservationState | null;
}

export interface ObservationPipelineResult {
  accepted: boolean;

  stage: 'binding' | 'decoding' | 'observation';

  reason: string;

  deviceId: string | null;

  updatedKeys: string[];
  ignoredKeys: string[];
  rejectedFields: string[];

  state: DeviceObservationState | null;
}

/**
 * Pure deterministic observation pipeline.
 *
 * IMPORTANT:
 * The caller MUST resolve binding and policy from
 * trusted, approved installation configuration.
 *
 * Never construct binding or policy from MQTT payload data.
 */
export function processObservationPipeline(
  input: ObservationPipelineInput,
): ObservationPipelineResult {

  if (!input.binding || !input.policy) {
    return {
      accepted: false,
      stage: 'binding',
      reason: 'approved_binding_required',
      deviceId: null,
      updatedKeys: [],
      ignoredKeys: [],
      rejectedFields: [],
      state: input.currentState,
    };
  }

  const decoded: DecodeResult = decodeObservationProfile(
    input.binding,
    input.context,
    input.payload,
  );

  if (!decoded.accepted || !decoded.observation) {
    return {
      accepted: false,
      stage: 'decoding',
      reason: decoded.reason,
      deviceId: input.binding.deviceId,
      updatedKeys: [],
      ignoredKeys: [],
      rejectedFields: decoded.rejectedFields,
      state: input.currentState,
    };
  }

  const decision: ObservationDecision =
    processDeviceObservation(
      input.currentState,
      decoded.observation,
      input.policy,
    );

  return {
    accepted: decision.accepted,
    stage: 'observation',
    reason: decision.reason,
    deviceId: decoded.observation.deviceId,
    updatedKeys: decision.updatedKeys,
    ignoredKeys: decision.ignoredKeys,
    rejectedFields: decoded.rejectedFields,
    state: decision.state,
  };
}
