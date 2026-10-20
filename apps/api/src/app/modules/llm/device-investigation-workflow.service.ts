import { Injectable } from '@nestjs/common';
import { DeviceInvestigationHistoryStore, type DeviceInvestigationScope } from './device-investigation-history.store';
import { DeviceAiInvestigationService } from './device-ai-investigation.service';
import { ReadOnlyHttpIdentityProbe } from './read-only-http-identity-probe';
import { OperationalLogService } from '../devices/operational-log.service';
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../devices/device-registry.types';
import { evidenceId, type DeviceEvidence } from './device-evidence';

@Injectable()
export class DeviceInvestigationWorkflowService {
  constructor(
    private readonly investigator: DeviceAiInvestigationService,
    private readonly history: DeviceInvestigationHistoryStore,
    private readonly httpProbe: ReadOnlyHttpIdentityProbe,
    private readonly operationalLog: OperationalLogService,
  ) {}

  async executeProposedAction(input: {
    scope: DeviceInvestigationScope;
    deviceId: string;
    investigationId: string;
    proposalId: string;
    target: NetworkDiscoveredDevice;
    zones: readonly NetworkDiscoveryZone[];
    approved: boolean;
    cloudDataConsent: boolean;
  }) {
    const { scope, deviceId, investigationId, proposalId } = input;
    const record = await this.history.getScoped(scope, investigationId);
    if (!record || record.deviceId !== deviceId) {
      return { outcome: 'rejected' as const, reasonCode: 'investigation_not_found_in_scope' };
    }

    const proposal = record.result.assessment.proposals.find(item => item.id === proposalId);
    if (!proposal) {
      this.recordOutcome(investigationId, deviceId, proposalId, 'rejected', 'proposal_not_found');
      return { outcome: 'rejected' as const, reasonCode: 'proposal_not_found' };
    }
    if (!(await this.history.beginAction(scope, investigationId, proposalId))) {
      const previous = await this.history.getAction(scope, investigationId, proposalId);
      return {
        outcome: previous?.status === 'completed' ? 'already_completed' as const : 'rejected' as const,
        reasonCode: previous?.reasonCode || 'action_already_started',
        ...(previous?.result ? { action: previous.result } : {}),
      };
    }

    if (!input.approved) return this.finishRejected(input, 'operator_approval_required');
    if (proposal.requiresApproval !== true || proposal.status !== 'proposed') {
      return this.finishRejected(input, 'proposal_not_approval_gated');
    }
    if (proposal.action !== 'inspect_http_headers') {
      return this.finishRejected(input, 'action_not_supported_by_this_executor');
    }
    if (record.result.parentInvestigationId) {
      return this.finishRejected(input, 'one_action_limit_reached');
    }
    const observedIp = record.result.evidenceSnapshot.evidence.find(item => item.attribute === 'ipAddress')?.value;
    if (input.target.id !== deviceId || input.target.ipAddress !== observedIp ||
      input.target.networkZoneId !== scope.networkId.slice(scope.networkId.indexOf(':') + 1)) {
      return this.finishRejected(input, 'target_changed_since_investigation');
    }
    if (!input.cloudDataConsent && this.investigator.getProviderAvailability().cloudDataConsentRequired) {
      return this.finishRejected(input, 'cloud_evidence_consent_required');
    }

    this.recordOutcome(investigationId, deviceId, proposalId, 'running', 'operator_approved');
    const action = await this.httpProbe.run(input.target, input.zones, true);
    const savedAction = await this.history.finishAction(scope, investigationId, proposalId, action);
    this.recordOutcome(investigationId, deviceId, proposalId, action.outcome, action.reasonCode);
    if (action.outcome !== 'completed') {
      return { outcome: action.outcome, reasonCode: action.reasonCode, action: savedAction };
    }

    const evidence = httpEvidence(deviceId, scope, action);
    try {
      const reassessment = await this.investigator.investigate(
        scope,
        deviceId,
        [input.target],
        input.cloudDataConsent,
        evidence,
        investigationId,
        {
          action: proposal.action,
          outcome: action.outcome,
          reasonCode: action.reasonCode,
          statusCode: action.statusCode,
        },
      );
      this.recordOutcome(investigationId, deviceId, proposalId, 'reassessed', 'follow_up_assessment_saved');
      return { outcome: 'completed' as const, action: savedAction, reassessment };
    } catch {
      this.recordOutcome(investigationId, deviceId, proposalId, 'failed', 'follow_up_assessment_failed');
      return {
        outcome: 'completed' as const,
        reasonCode: 'follow_up_assessment_failed',
        action: savedAction,
        reassessment: { outcome: 'failed' as const, reasonCode: 'follow_up_assessment_failed' },
      };
    }
  }

  private async finishRejected(
    input: { scope: DeviceInvestigationScope; deviceId: string; investigationId: string; proposalId: string },
    reasonCode: string,
  ) {
    const action = await this.history.finishAction(
      input.scope,
      input.investigationId,
      input.proposalId,
      { outcome: 'rejected', reasonCode },
    );
    this.recordOutcome(input.investigationId, input.deviceId, input.proposalId, 'rejected', reasonCode);
    return { outcome: 'rejected' as const, reasonCode, action };
  }

  private recordOutcome(
    correlationId: string,
    deviceId: string,
    proposalId: string,
    outcome: string,
    reasonCode: string,
  ): void {
    this.operationalLog.record({
      level: outcome === 'rejected' || outcome === 'failed' ? 'warn' : 'info',
      source: 'portal',
      event: 'device.investigation.action',
      message: `Investigation action ${outcome} (${reasonCode}).`,
      deviceId,
      correlationId,
      details: { proposalId, outcome, reasonCode },
    });
  }
}

function httpEvidence(
  deviceId: string,
  scope: DeviceInvestigationScope,
  result: Extract<Awaited<ReturnType<ReadOnlyHttpIdentityProbe['run']>>, { outcome: 'completed' }>,
): DeviceEvidence[] {
  const observedAt = result.observedAt;
  const evidence = (attribute: string, value: string | number, confidence: 'observed' | 'reported'): DeviceEvidence => ({
    id: evidenceId(deviceId, 'http', attribute, value, scope),
    source: 'http',
    attribute,
    value,
    observedAt,
    confidence,
    scope,
    verification: confidence === 'observed' ? 'scan_observed' : 'device_reported',
  });
  return [
    evidence('http.status_code', result.statusCode, 'observed'),
    ...(result.server ? [evidence('http.server_header', result.server, 'reported')] : []),
    ...(result.contentType ? [evidence('http.content_type', result.contentType, 'reported')] : []),
  ];
}
