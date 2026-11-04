import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard';
import { PortalNetworkInvestigationController } from './portal-network-investigation.controller';

const admin = { headers: {}, user: { userId: 'admin', role: 'admin', email: 'admin@example.test' } } as never;
const anonymous = { headers: {} } as never;
const observedAt = new Date().toISOString();
const target = {
  id: 'shellyplus1-001122334455', networkZoneId: 'lab', gatewayId: 'gateway-lab', ipAddress: '172.30.250.11',
  status: 'online', discoveredAt: observedAt, protocol: 'http', observations: [],
};

function fixture(options: { live?: unknown[]; history?: unknown[]; siteId?: string } = {}) {
  const ownership = { tenantId: 'tenant-a', siteId: options.siteId || 'site-lab' };
  const registry = { getSnapshot: jest.fn(() => ({ tenant: { id: ownership.tenantId }, site: { id: ownership.siteId } })) };
  const lan = {
    getLastScan: jest.fn(() => options.live ?? [target]),
    getZones: jest.fn(() => [{ id: 'lab', collectionSource: 'virtual-lab' }]),
  };
  const memory = { list: jest.fn().mockResolvedValue(options.history ?? []) };
  const ai = {
    investigate: jest.fn().mockResolvedValue({ outcome: 'proposed' }),
    investigateStoredMqttProfile: jest.fn().mockResolvedValue({ status: 'proposed' }),
    listMqttProfileInvestigations: jest.fn().mockResolvedValue({ investigations: [] }),
    getMqttProfileInvestigation: jest.fn().mockResolvedValue({ id: 'profile-1' }),
    getProviderAvailability: jest.fn().mockReturnValue({ available: true }),
    listHistory: jest.fn().mockResolvedValue({ records: [] }),
    getHistoryRecord: jest.fn().mockResolvedValue({ id: 'investigation-1' }),
  };
  const workflow = { executeProposedAction: jest.fn().mockResolvedValue({ outcome: 'rejected', reasonCode: 'operator_approval_required' }) };
  const controller = new PortalNetworkInvestigationController(
    registry as never, lan as never, memory as never, ai as never, workflow as never,
  );
  return { controller, registry, lan, memory, ai, workflow, ownership };
}

describe('P6f site-scoped investigation HTTP boundary', () => {
  it('preserves JWT/admin guards and all eight existing routes', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PortalNetworkInvestigationController)).toEqual([AccessJwtGuard, RoleGuard]);
    expect(Reflect.getMetadata('energrid.auth.roles', PortalNetworkInvestigationController)).toEqual(['admin']);
    expect(Reflect.getMetadata(PATH_METADATA, PortalNetworkInvestigationController)).toBe('portal');
    const routes = [
      ['investigateNetworkDeviceWithAi', 'network/:deviceId/investigate'],
      ['executeInvestigationAction', 'network/:deviceId/investigations/:investigationId/actions/:proposalId/execute'],
      ['investigateNetworkMqttProfile', 'network/:deviceId/profile-investigations'],
      ['listNetworkMqttProfiles', 'network/:deviceId/profile-investigations'],
      ['getInvestigationAvailability', 'investigations/availability'],
      ['getNetworkMqttProfile', 'network/:deviceId/profile-investigations/:investigationId'],
      ['listNetworkDeviceInvestigations', 'network/:deviceId/investigations'],
      ['getNetworkDeviceInvestigation', 'network/:deviceId/investigations/:investigationId'],
    ];
    for (const [name, expectedPath] of routes) {
      const handler = (PortalNetworkInvestigationController.prototype as any)[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(expectedPath);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBeDefined();
    }
  });

  it('denies unauthenticated investigation, history, proposed-action and profile requests before delegation', async () => {
    const f = fixture();
    await expect(f.controller.investigateNetworkDeviceWithAi(target.id, {}, anonymous)).rejects.toThrow(UnauthorizedException);
    await expect(f.controller.listNetworkDeviceInvestigations(target.id, anonymous)).rejects.toThrow(UnauthorizedException);
    await expect(f.controller.executeInvestigationAction(target.id, 'i', 'p', { approved: true }, anonymous)).rejects.toThrow(UnauthorizedException);
    await expect(f.controller.investigateNetworkMqttProfile(target.id, { cloudDataConsent: true }, anonymous)).rejects.toThrow(UnauthorizedException);
    expect(f.ai.investigate).not.toHaveBeenCalled();
    expect(f.ai.listHistory).not.toHaveBeenCalled();
    expect(f.ai.investigateStoredMqttProfile).not.toHaveBeenCalled();
    expect(f.workflow.executeProposedAction).not.toHaveBeenCalled();
  });

  it('derives scope from the active registry site and the resolved gateway/network, never request values', async () => {
    const f = fixture();
    await expect(f.controller.investigateNetworkDeviceWithAi(target.id, { cloudDataConsent: 'true' }, admin))
      .resolves.toEqual({ outcome: 'proposed' });
    expect(f.ai.investigate).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', siteId: 'site-lab', networkId: 'gateway-lab:lab' }, target.id, [target], false,
    );
    await f.controller.listNetworkDeviceInvestigations(target.id, admin);
    expect(f.ai.listHistory).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', siteId: 'site-lab', networkId: 'gateway-lab:lab' }, target.id, 50,
    );
    await f.controller.getNetworkDeviceInvestigation(target.id, 'i-1', admin);
    expect(f.ai.getHistoryRecord).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', siteId: 'site-lab', networkId: 'gateway-lab:lab' }, target.id, 'i-1',
    );
  });

  it('rejects unknown or foreign-site targets, without calling AI or proposal executors', async () => {
    const f = fixture({ live: [], history: [] });
    await expect(f.controller.investigateNetworkDeviceWithAi('other-site-device', { cloudDataConsent: true }, admin))
      .rejects.toThrow(NotFoundException);
    await expect(f.controller.executeInvestigationAction('other-site-device', 'i', 'p', { approved: true }, admin))
      .rejects.toThrow(NotFoundException);
    expect(f.memory.list).toHaveBeenCalledWith({ tenantId: 'tenant-a', siteId: 'site-lab' });
    expect(f.ai.investigate).not.toHaveBeenCalled();
    expect(f.workflow.executeProposedAction).not.toHaveBeenCalled();
  });

  it('uses saved site-owned discovery memory when live scan has expired', async () => {
    const f = fixture({ live: [], history: [{ device: target }] });
    await f.controller.listNetworkDeviceInvestigations(target.id, admin);
    expect(f.memory.list).toHaveBeenCalledWith(f.ownership);
    expect(f.ai.listHistory).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-lab', networkId: 'gateway-lab:lab' }), target.id, 50,
    );
  });

  it('forwards only strict approval/consent booleans to the existing deterministic executor', async () => {
    const f = fixture();
    await f.controller.executeInvestigationAction(target.id, 'investigation-1', 'proposal-1',
      { approved: 'true', cloudDataConsent: 'true' }, admin);
    expect(f.workflow.executeProposedAction).toHaveBeenCalledWith({
      scope: { tenantId: 'tenant-a', siteId: 'site-lab', networkId: 'gateway-lab:lab' },
      deviceId: target.id, investigationId: 'investigation-1', proposalId: 'proposal-1', target,
      zones: [{ id: 'lab', collectionSource: 'virtual-lab' }], approved: false, cloudDataConsent: false,
    });
    await f.controller.executeInvestigationAction(target.id, 'investigation-1', 'proposal-1',
      { approved: true, cloudDataConsent: true }, admin);
    expect(f.workflow.executeProposedAction.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      approved: true, cloudDataConsent: true,
    }));
  });

  it('keeps MQTT-profile operations scoped to the selected site and preserves cloud consent', async () => {
    const f = fixture({ live: [] });
    await f.controller.investigateNetworkMqttProfile('mqtt-device', { cloudDataConsent: false }, admin);
    await f.controller.listNetworkMqttProfiles('mqtt-device', admin);
    await f.controller.getNetworkMqttProfile('mqtt-device', 'profile-1', admin);
    expect(f.ai.investigateStoredMqttProfile).toHaveBeenCalledWith(f.ownership, 'mqtt-device', false);
    expect(f.ai.listMqttProfileInvestigations).toHaveBeenCalledWith(f.ownership, 'mqtt-device', 50);
    expect(f.ai.getMqttProfileInvestigation).toHaveBeenCalledWith(f.ownership, 'mqtt-device', 'profile-1');
    expect(f.controller.getInvestigationAvailability(admin)).toEqual({ available: true });
  });

  it('continues to exclude recognized first-party Energrid devices from LLM investigation and actions', async () => {
    const f = fixture({ live: [{
      id: 'esp8266:324864', ipAddress: '192.168.1.198', networkZoneId: 'upstream-lan',
      networkZoneName: 'Upstream LAN', protocol: 'http', confidence: 1,
      status: 'online', discoveredAt: observedAt, reason: 'Verified firmware identity',
      observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt },
        { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt },
        { source: 'http_identity', attribute: 'device.model', value: 'Energrid ESP8266 DHT22', observedAt },
        { source: 'http_identity', attribute: 'firmware.version', value: '0.2.0', observedAt },
        { source: 'http_identity', attribute: 'device.capability', value: 'temperature', observedAt },
        { source: 'http_identity', attribute: 'device.capability', value: 'humidity', observedAt },
      ],
    }] });
    await expect(f.controller.investigateNetworkDeviceWithAi('esp8266:324864', {}, admin)).rejects.toThrow(ConflictException);
    await expect(f.controller.executeInvestigationAction('esp8266:324864', 'i', 'p', { approved: true }, admin))
      .rejects.toThrow(ConflictException);
    expect(f.ai.investigate).not.toHaveBeenCalled();
    expect(f.workflow.executeProposedAction).not.toHaveBeenCalled();
  });
});
