import { ConflictException, ForbiddenException, NotFoundException, RequestMethod, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard';
import { PortalController } from './portal.controller';
import { PortalSnapshotEndpointInvestigationController } from './portal-snapshot-endpoint-investigation.controller';

const owner = { tenantId: 'tenant-one', siteId: 'site-home' };
const admin = { user: { role: 'admin', userId: 'operator' }, headers: {} } as never;
const viewer = { user: { role: 'viewer', userId: 'guest' }, headers: {} } as never;
const anonymous = { headers: {} } as never;
const scan = 'scan-home';
const scope = 'home-lan';
const ip = '192.168.7.100';
const endpointId = 'endpoint-one';
const target = {
  id: endpointId, networkZoneId: scope, ipAddress: ip, status: 'online', protocol: 'http',
  discoveredAt: '2026-11-04T08:00:00.000Z', observations: [],
};
const snapshot = (ownership = owner) => ({
  scanId: scan, ownership, endpoints: [target],
});
const zones = [{ id: scope, cidr: '192.168.7.0/24', seedIps: [] }];

function fixture(options: { noInvestigator?: boolean; noProbe?: boolean; noRefresh?: boolean } = {}) {
  const registry = { getSnapshot: jest.fn().mockReturnValue({
    tenant: { id: owner.tenantId }, site: { id: owner.siteId, name: 'Home' },
  }) };
  const memory = {
    getSnapshot: jest.fn().mockResolvedValue(snapshot()),
    listSnapshots: jest.fn().mockResolvedValue([snapshot(), { scanId: 'scan-old', ownership: owner, endpoints: [] }]),
  };
  const lan = { getZones: jest.fn().mockReturnValue(zones) };
  const investigate = jest.fn().mockResolvedValue({ status: 'proposed', source: 'model' });
  const run = jest.fn().mockResolvedValue({ outcome: 'rejected', reasonCode: 'operator_approval_required' });
  const refresh = jest.fn().mockResolvedValue({ outcome: 'rejected', reasonCode: 'operator_approval_required' });
  const consumeVerifiedRefresh = jest.fn().mockReturnValue(null);
  const controller = new PortalSnapshotEndpointInvestigationController(
    registry as never, memory as never, lan as never,
    options.noInvestigator ? undefined : { investigate } as never,
    options.noProbe ? undefined : { run } as never,
    options.noRefresh ? undefined : { refresh, consumeVerifiedRefresh } as never,
  );
  return { controller, registry, memory, lan, investigate, run, refresh, consumeVerifiedRefresh };
}

const movedRoutes = [
  ['investigateSnapshotEndpoint', `network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/investigate`],
  ['probeSnapshotEndpointHttp', `network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/probe-http`],
  ['refreshSnapshotEndpointIdentity', `network/snapshots/:scanId/scopes/:scopeId/endpoints/:ipAddress/:endpointId/refresh-identity`],
] as const;

const args = [scan, scope, ip, endpointId] as const;

describe('Portal snapshot-bound endpoint investigation (P6e)', () => {
  it('preserves three POST routes, JWT/admin guards and explicit Nest controller registration', () => {
    const C = PortalSnapshotEndpointInvestigationController;
    expect(Reflect.getMetadata(PATH_METADATA, C)).toBe('portal');
    expect(Reflect.getMetadata(GUARDS_METADATA, C)).toEqual([AccessJwtGuard, RoleGuard]);
    expect(Reflect.getMetadata('energrid.auth.roles', C)).toEqual(['admin']);
    for (const [name, path] of movedRoutes) {
      expect(Reflect.getMetadata(PATH_METADATA, C.prototype[name])).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, C.prototype[name])).toBe(RequestMethod.POST);
      expect(Object.prototype.hasOwnProperty.call(PortalController.prototype, name)).toBe(false);
    }
    // Avoid importing the entire PortalModule/Letta ESM graph into a controller unit test.
    expect(readFileSync(join(__dirname, 'portal.module.ts'), 'utf8'))
      .toMatch(/controllers\s*:\s*\[[^\]]*\bPortalSnapshotEndpointInvestigationController\b/);
  });

  it('enforces JWT and administrator roles through the real Nest guards', async () => {
    const reflector = new Reflector();
    const access = { authenticateAccessToken: jest.fn().mockResolvedValue({ userId: 'guest', role: 'viewer' }) };
    const jwtGuard = new AccessJwtGuard(access as never, reflector);
    const roleGuard = new RoleGuard(reflector);
    const request: { headers: { authorization?: string }; user?: { userId: string; role: string } } = { headers: {} };
    const context = {
      getHandler: () => PortalSnapshotEndpointInvestigationController.prototype.probeSnapshotEndpointHttp,
      getClass: () => PortalSnapshotEndpointInvestigationController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    await expect(jwtGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(access.authenticateAccessToken).not.toHaveBeenCalled();
    request.headers.authorization = 'Bearer test-token';
    await expect(jwtGuard.canActivate(context)).resolves.toBe(true);
    expect(() => roleGuard.canActivate(context)).toThrow(ForbiddenException);
    request.user = { userId: 'operator', role: 'admin' };
    expect(roleGuard.canActivate(context)).toBe(true);
  });

  it.each([anonymous, viewer])('rejects unauthenticated or non-admin calls before any collaborator', async (request) => {
    const f = fixture();
    await expect(f.controller.investigateSnapshotEndpoint(...args, {}, request)).rejects.toThrow(UnauthorizedException);
    await expect(f.controller.probeSnapshotEndpointHttp(...args, { approved: true }, request)).rejects.toThrow(UnauthorizedException);
    await expect(f.controller.refreshSnapshotEndpointIdentity(...args, { approved: true }, request)).rejects.toThrow(UnauthorizedException);
    expect(f.registry.getSnapshot).not.toHaveBeenCalled();
    expect(f.memory.getSnapshot).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.investigate).not.toHaveBeenCalled();
  });

  it('fails closed on missing or wrong-site snapshots, without LLM or network calls', async () => {
    const f = fixture();
    for (const returned of [null, snapshot({ tenantId: owner.tenantId, siteId: 'another-site' })]) {
      f.memory.getSnapshot.mockResolvedValue(returned as never);
      await expect(f.controller.investigateSnapshotEndpoint(...args, { cloudDataConsent: true }, admin))
        .rejects.toThrow(NotFoundException);
      await expect(f.controller.probeSnapshotEndpointHttp(...args, { approved: true, refreshId: 'token' }, admin))
        .rejects.toThrow(NotFoundException);
      await expect(f.controller.refreshSnapshotEndpointIdentity(...args, { approved: true }, admin))
        .rejects.toThrow(NotFoundException);
    }
    expect(f.memory.getSnapshot).toHaveBeenCalledWith(scan, owner);
    expect(f.investigate).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it('requires an exact matching snapshot endpoint identity, not just a matching IP', async () => {
    const f = fixture();
    await expect(f.controller.probeSnapshotEndpointHttp(scan, scope, ip, 'another-id', { approved: true, refreshId: 'token' }, admin))
      .rejects.toThrow(NotFoundException);
    await expect(f.controller.refreshSnapshotEndpointIdentity(scan, 'another-scope', ip, endpointId, { approved: true }, admin))
      .rejects.toThrow(NotFoundException);
    await expect(f.controller.investigateSnapshotEndpoint(scan, scope, '192.168.7.101', endpointId, {}, admin))
      .rejects.toThrow(NotFoundException);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.investigate).not.toHaveBeenCalled();
  });

  it('uses site-owned snapshot history and forwards only explicit cloud consent to model analysis', async () => {
    const f = fixture();
    await expect(f.controller.investigateSnapshotEndpoint(...args, { cloudDataConsent: 'true' }, admin))
      .resolves.toMatchObject({ status: 'proposed' });
    expect(f.memory.listSnapshots).toHaveBeenCalledWith(owner, 50);
    expect(f.investigate).toHaveBeenCalledWith(snapshot(), { scopeId: scope, ipAddress: ip, endpointId }, false, [
      { scanId: 'scan-old', ownership: owner, endpoints: [] },
    ]);
    await f.controller.investigateSnapshotEndpoint(...args, { cloudDataConsent: true }, admin);
    expect(f.investigate.mock.calls.at(-1)?.[2]).toBe(true);
  });

  it('prevents recognized first-party Energrid devices from entering LLM investigation', async () => {
    const f = fixture();
    const firmwareId = 'esp8266:324864';
    f.memory.getSnapshot.mockResolvedValue({
      ...snapshot(), endpoints: [{ ...target, id: firmwareId, observations: [
        { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: target.discoveredAt },
        { source: 'http_identity', attribute: 'identity.device_id', value: firmwareId, observedAt: target.discoveredAt },
      ] }],
    } as never);
    await expect(f.controller.investigateSnapshotEndpoint(scan, scope, ip, firmwareId, {}, admin))
      .rejects.toThrow(ConflictException);
    expect(f.investigate).not.toHaveBeenCalled();
  });

  it('keeps an unapproved HTTP probe unapproved at the deterministic probe adapter', async () => {
    const f = fixture();
    await f.controller.probeSnapshotEndpointHttp(...args, { approved: false, refreshId: 'anything' }, admin);
    expect(f.run).toHaveBeenCalledWith(target, zones, false);
    expect(f.consumeVerifiedRefresh).not.toHaveBeenCalled();
  });

  it('rejects approved HTTP probes without a consumed fresh identity verification', async () => {
    const f = fixture();
    await expect(f.controller.probeSnapshotEndpointHttp(...args, { approved: true }, admin))
      .resolves.toEqual({ outcome: 'rejected', reasonCode: 'fresh_identity_verification_required' });
    await expect(f.controller.probeSnapshotEndpointHttp(...args, { approved: true, refreshId: 'expired' }, admin))
      .resolves.toEqual({ outcome: 'rejected', reasonCode: 'fresh_identity_verification_required' });
    expect(f.consumeVerifiedRefresh).toHaveBeenCalledWith('expired', target, zones);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('allows an approved HTTP HEAD probe only after fresh identity verification supplies a refreshed target', async () => {
    const f = fixture();
    const refreshed = { ...target, discoveredAt: '2026-11-04T08:01:00.000Z' };
    f.consumeVerifiedRefresh.mockReturnValue(refreshed as never);
    await f.controller.probeSnapshotEndpointHttp(...args, { approved: true, refreshId: 'fresh-token' }, admin);
    expect(f.consumeVerifiedRefresh).toHaveBeenCalledWith('fresh-token', target, zones);
    expect(f.run).toHaveBeenCalledWith(refreshed, zones, true);
  });

  it('delegates explicit approval to the bounded identity-refresh adapter', async () => {
    const f = fixture();
    await f.controller.refreshSnapshotEndpointIdentity(...args, { approved: 'true' }, admin);
    expect(f.refresh).toHaveBeenCalledWith(target, zones, false);
    await f.controller.refreshSnapshotEndpointIdentity(...args, { approved: true }, admin);
    expect(f.refresh).toHaveBeenCalledWith(target, zones, true);
  });

  it('does not fall back to unsafe alternatives when optional investigation adapters are unavailable', async () => {
    const f = fixture({ noInvestigator: true, noProbe: true, noRefresh: true });
    await expect(f.controller.investigateSnapshotEndpoint(...args, {}, admin)).rejects.toThrow(ServiceUnavailableException);
    await expect(f.controller.probeSnapshotEndpointHttp(...args, {}, admin)).rejects.toThrow(ServiceUnavailableException);
    await expect(f.controller.refreshSnapshotEndpointIdentity(...args, {}, admin)).rejects.toThrow(ServiceUnavailableException);
    expect(f.memory.getSnapshot).not.toHaveBeenCalled();
  });
});
