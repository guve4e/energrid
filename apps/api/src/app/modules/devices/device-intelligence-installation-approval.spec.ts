import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';
import type { DeviceInstallationChangeProposal } from './device-installation.store';

const scope = {
  tenantId: 'home',
  siteId: 'house',
};

const deviceId = 'shellyplus1-test:switch:0';
const proposalId = '11111111-2222-4333-8444-555555555555';
const installationUpdatedAt = '2026-10-22T12:00:00.000Z';

function harness() {
  const device = {
    id: deviceId,
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    kind: 'physical',
    trustStatus: 'approved',
    displayName: 'Shelly Switch',
    zoneName: 'kitchen',
    metadata: {},
    capabilities: [{ kind: 'switch' }],
  };

  const proposal: DeviceInstallationChangeProposal = {
    schemaVersion: 1,
    id: proposalId,
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    deviceId,
    status: 'pending',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    installationUpdatedAt,
    current: {
      displayName: 'Shelly Switch',
      zoneName: 'kitchen',
      loadType: null,
    },
    proposed: {
      displayName: 'Kitchen Ceiling Lights',
      zoneName: 'Kitchen',
      loadType: 'lighting',
    },
  };

  const registry = {
    ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
    getDevices: jest.fn().mockReturnValue([device]),
    updateInstallationDetails: jest.fn().mockResolvedValue({
      ...device,
      displayName: proposal.proposed.displayName,
      zoneName: proposal.proposed.zoneName,
    }),
    persistInstallationEvent: jest.fn().mockResolvedValue(undefined),
  };

  const installations = {
    getProposal: jest.fn().mockResolvedValue(proposal),
    saveProposal: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      device,
      updatedAt: installationUpdatedAt,
    }),
  };

  const enrollment = {
    find: jest.fn().mockResolvedValue({
      deviceId,
      status: 'enrolled',
    }),
  };

  const service = new DeviceIntelligenceQueryService(
    registry as unknown as ConstructorParameters<
      typeof DeviceIntelligenceQueryService
    >[0],
    installations as unknown as ConstructorParameters<
      typeof DeviceIntelligenceQueryService
    >[1],
    enrollment as unknown as ConstructorParameters<
      typeof DeviceIntelligenceQueryService
    >[2],
    {} as ConstructorParameters<
      typeof DeviceIntelligenceQueryService
    >[3],
  );

  return {
    service,
    device,
    proposal,
    registry,
    installations,
    enrollment,
  };
}

describe('Conversational installation proposal approval', () => {
  it('applies an approved proposal and writes an audit event', async () => {
    const h = harness();

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'approve', true,
    );

    expect(result).toMatchObject({
      status: 'approved',
      proposalId,
      deviceId,
    });

    expect(h.registry.updateInstallationDetails).toHaveBeenCalledWith(
      deviceId,
      'Kitchen Ceiling Lights',
      'Kitchen',
      undefined,
      undefined,
      'lighting',
    );

    expect(h.installations.saveProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: proposalId,
        status: 'approved',
      }),
    );

    expect(h.registry.persistInstallationEvent).toHaveBeenCalledWith(
      deviceId,
      'installation_details_saved',
      expect.objectContaining({
        proposalId,
        physicalLoadConfirmed: true,
      }),
    );
  });

  it('rejects a proposal without changing the installation', async () => {
    const h = harness();

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'reject',
    );

    expect(result.status).toBe('rejected');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
    expect(h.installations.saveProposal).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
  });

  it('requires physical confirmation for a new lighting assignment', async () => {
    const h = harness();

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'approve', false,
    );

    expect(result.status).toBe('physical_confirmation_required');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
    expect(h.installations.saveProposal).not.toHaveBeenCalled();
  });

  it('refuses expired proposals', async () => {
    const h = harness();
    h.proposal.expiresAt =
      new Date(Date.now() - 1000).toISOString();

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'approve', true,
    );

    expect(result.status).toBe('expired');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
  });

  it('refuses proposals after the installation has changed', async () => {
    const h = harness();
    h.installations.get.mockResolvedValue({
      schemaVersion: 1,
      device: h.device,
      updatedAt: '2026-10-22T15:00:00.000Z',
    });

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'approve', true,
    );

    expect(result.status).toBe('stale_proposal');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
  });

  it('refuses a device that is no longer enrolled', async () => {
    const h = harness();
    h.enrollment.find.mockResolvedValue(null);

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'approve', true,
    );

    expect(result.status).toBe('not_enrolled');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
  });

  it('isolates proposals by tenant', async () => {
    const h = harness();

    const result = await h.service.decideInstallationProposal(
      { ...scope, tenantId: 'another-tenant' },
      proposalId,
      deviceId,
      'approve',
      true,
    );

    expect(result.status).toBe('not_found');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
  });

  it('refuses a mismatched device ID', async () => {
    const h = harness();

    const result = await h.service.decideInstallationProposal(
      scope,
      proposalId,
      'different-device',
      'approve',
      true,
    );

    expect(result.status).toBe('not_found');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
  });

  it('prevents a second decision on an approved proposal', async () => {
    const h = harness();

    h.installations.getProposal
      .mockResolvedValueOnce(h.proposal)
      .mockResolvedValueOnce({
        ...h.proposal,
        status: 'approved',
      });

    const result = await h.service.decideInstallationProposal(
      scope, proposalId, deviceId, 'approve', true,
    );

    expect(result.status).toBe('already_decided');
    expect(h.registry.updateInstallationDetails).not.toHaveBeenCalled();
  });
});
