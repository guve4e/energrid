import type { NetworkDiscoveredDevice } from '../devices/device-registry.types';
import { DeviceInvestigationWorkflowService } from './device-investigation-workflow.service';

describe('DeviceInvestigationWorkflowService', () => {
  const scope = { tenantId: 'tenant-a', siteId: 'site-a', networkId: 'gateway-a:upstream' };
  const target: NetworkDiscoveredDevice = {
    id: 'host-1', ipAddress: '192.168.1.133', networkZoneId: 'upstream', networkZoneName: 'Upstream',
    protocol: 'unknown', confidence: 0.6, status: 'online', discoveredAt: new Date().toISOString(), reason: 'fixture',
  };
  const proposal = { id: 'probe-1', action: 'inspect_http_headers', reason: 'Read the identity headers', requiredEvidenceIds: [], requiresApproval: true as const, status: 'proposed' as const };
  const record = {
    id: 'investigation-1', deviceId: 'host-1', result: {
      assessment: { proposals: [proposal] }, parentInvestigationId: undefined,
      evidenceSnapshot: { evidence: [{ attribute: 'ipAddress', value: target.ipAddress }] },
    },
  };

  function setup(overrides: Record<string, unknown> = {}) {
    const history = {
      getScoped: jest.fn().mockResolvedValue(record),
      beginAction: jest.fn().mockResolvedValue(true),
      finishAction: jest.fn().mockImplementation(async (_scope, _investigationId, _proposalId, result) => result),
      getAction: jest.fn().mockResolvedValue(null),
      ...overrides,
    };
    const investigator = {
      getProviderAvailability: jest.fn().mockReturnValue({ cloudDataConsentRequired: false }),
      investigate: jest.fn().mockResolvedValue({ investigationId: 'follow-up-1' }),
    };
    const probe = {
      run: jest.fn().mockResolvedValue({ outcome: 'completed', reasonCode: 'http_response_received', ipAddress: target.ipAddress, statusCode: 404, server: 'fixture-device', observedAt: new Date().toISOString() }),
    };
    const operationalLog = { record: jest.fn() };
    return {
      service: new DeviceInvestigationWorkflowService(investigator as any, history as any, probe as any, operationalLog as any),
      history, investigator, probe, operationalLog,
    };
  }

  it('executes one approved action, captures scoped evidence, and reassesses once', async () => {
    const { service, investigator, probe, history } = setup();
    const result = await service.executeProposedAction({
      scope, deviceId: target.id, investigationId: record.id, proposalId: proposal.id,
      target, zones: [], approved: true, cloudDataConsent: false,
    });

    expect(result).toMatchObject({ outcome: 'completed', reassessment: { investigationId: 'follow-up-1' } });
    expect(probe.run).toHaveBeenCalledWith(target, [], true);
    expect(investigator.investigate).toHaveBeenCalledWith(
      scope, target.id, [target], false,
      expect.arrayContaining([expect.objectContaining({ source: 'http', attribute: 'http.status_code', value: 404, scope })]),
      record.id,
      expect.objectContaining({ action: 'inspect_http_headers', outcome: 'completed' }),
    );
    expect(history.finishAction).toHaveBeenCalled();
  });

  it('records rejection and never probes when operator approval is absent', async () => {
    const { service, probe, history } = setup();
    const result = await service.executeProposedAction({
      scope, deviceId: target.id, investigationId: record.id, proposalId: proposal.id,
      target, zones: [], approved: false, cloudDataConsent: false,
    });

    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'operator_approval_required' });
    expect(probe.run).not.toHaveBeenCalled();
    expect(history.finishAction).toHaveBeenCalledWith(scope, record.id, proposal.id, {
      outcome: 'rejected', reasonCode: 'operator_approval_required',
    });
  });

  it('does not repeat an action already claimed by a previous request', async () => {
    const { service, probe } = setup({
      beginAction: jest.fn().mockResolvedValue(false),
      getAction: jest.fn().mockResolvedValue({ status: 'completed', reasonCode: 'http_response_received' }),
    });
    const result = await service.executeProposedAction({
      scope, deviceId: target.id, investigationId: record.id, proposalId: proposal.id,
      target, zones: [], approved: true, cloudDataConsent: false,
    });

    expect(result).toMatchObject({ outcome: 'already_completed' });
    expect(probe.run).not.toHaveBeenCalled();
  });
});
