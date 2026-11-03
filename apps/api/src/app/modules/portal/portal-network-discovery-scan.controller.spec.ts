import { BadRequestException, ForbiddenException, GatewayTimeoutException, RequestMethod, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard';
import { PortalController } from './portal.controller';
import { PortalNetworkDiscoveryScanController } from './portal-network-discovery-scan.controller';

const admin = { user: { role: 'admin', userId: 'operator' }, headers: {} } as never;
const viewer = { user: { role: 'viewer', userId: 'viewer' }, headers: {} } as never;
const anonymous = { headers: {} } as never;
const owner = { tenantId: 'tenant-one', siteId: 'site-home' };

function fixture() {
  const lan = {
    getZones: jest.fn().mockReturnValue([{ id: 'home-lan', cidr: '192.168.7.0/24', collectionSource: 'site-local' }]),
    scanNow: jest.fn().mockResolvedValue({ devices: [], snapshot: { ownership: owner } }),
    verifyShellyCandidate: jest.fn().mockResolvedValue({ status: 'verified' }),
  };
  const registry = {
    getSnapshot: jest.fn().mockReturnValue({ tenant: { id: owner.tenantId }, site: { id: owner.siteId, name: 'Home' } }),
    getDevices: jest.fn().mockReturnValue([]),
    registerDiscoveredDevice: jest.fn().mockReturnValue(true),
  };
  return { controller: new PortalNetworkDiscoveryScanController(lan as never, registry as never), lan, registry };
}

const consent = { scopeIds: ['home-lan'], fullSubnetConfirmed: true };

describe('Portal network discovery scan boundary (P6c)', () => {
  it('preserves exactly the two POST routes, class guards and Nest registration', () => {
    const target = PortalNetworkDiscoveryScanController;
    expect(Reflect.getMetadata(PATH_METADATA, target)).toBe('portal');
    expect(Reflect.getMetadata(GUARDS_METADATA, target)).toEqual([AccessJwtGuard, RoleGuard]);
    expect(Reflect.getMetadata('energrid.auth.roles', target)).toEqual(['admin']);
    for (const [name, path] of [
      ['scanNetwork', 'network/scan'],
      ['verifyShellyDiscoveryCandidate', 'discovery/:deviceId/verify-shelly'],
    ] as const) {
      const method = target.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
      expect(Object.prototype.hasOwnProperty.call(PortalController.prototype, name)).toBe(false);
    }
    // Avoid importing PortalModule: it pulls in the unrelated ESM-only Letta SDK in Jest.
    // This is a source contract, not a substitute for Nest bootstrap/HTTP smoke tests.
    expect(readFileSync(join(__dirname, 'portal.module.ts'), 'utf8'))
      .toMatch(/controllers\s*:\s*\[[^\]]*\bPortalNetworkDiscoveryScanController\b/);
  });

  it('denies missing JWT and viewer roles via the actual guard classes', async () => {
    const reflector = new Reflector();
    const access = { authenticateAccessToken: jest.fn().mockResolvedValue({ userId: 'viewer', role: 'viewer' }) };
    const jwtGuard = new AccessJwtGuard(access as never, reflector);
    const roleGuard = new RoleGuard(reflector);
    const request: { headers: { authorization?: string }; user?: { userId: string; role: string } } = { headers: {} };
    const context = {
      getHandler: () => PortalNetworkDiscoveryScanController.prototype.scanNetwork,
      getClass: () => PortalNetworkDiscoveryScanController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    await expect(jwtGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(access.authenticateAccessToken).not.toHaveBeenCalled();
    request.headers.authorization = 'Bearer test-token';
    await expect(jwtGuard.canActivate(context)).resolves.toBe(true);
    expect(() => roleGuard.canActivate(context)).toThrow(ForbiddenException);
    request.user = { userId: 'admin', role: 'admin' };
    expect(roleGuard.canActivate(context)).toBe(true);
  });

  it.each([anonymous, viewer])('rejects non-admin before scanning or verifying', async (request) => {
    const { controller, lan, registry } = fixture();
    await expect(controller.scanNetwork(consent, request)).rejects.toThrow(UnauthorizedException);
    await expect(controller.verifyShellyDiscoveryCandidate('shelly:0', request)).rejects.toThrow(UnauthorizedException);
    expect(lan.getZones).not.toHaveBeenCalled();
    expect(lan.scanNow).not.toHaveBeenCalled();
    expect(lan.verifyShellyCandidate).not.toHaveBeenCalled();
    expect(registry.getSnapshot).not.toHaveBeenCalled();
  });

  it('validates explicit scope, uniqueness and full-subnet consent before scanning', async () => {
    const { controller, lan } = fixture();
    for (const body of [
      { scopeIds: [], fullSubnetConfirmed: true },
      { scopeIds: ['unknown'], fullSubnetConfirmed: true },
      { scopeIds: ['home-lan', 'home-lan'], fullSubnetConfirmed: true },
      { scopeIds: ['home-lan'], fullSubnetConfirmed: false },
    ]) {
      await expect(controller.scanNetwork(body, admin)).rejects.toThrow(BadRequestException);
    }
    expect(lan.scanNow).not.toHaveBeenCalled();
    await expect(controller.scanNetwork(consent, admin)).resolves.toMatchObject({ devices: [] });
    expect(lan.scanNow).toHaveBeenCalledWith(expect.objectContaining({
      scopeIds: ['home-lan'], fullSubnetConfirmed: true, signal: expect.any(AbortSignal),
    }));
  });

  it('uses the active registry site for Shelly candidate verification', async () => {
    const { controller, lan, registry } = fixture();
    await expect(controller.verifyShellyDiscoveryCandidate('shelly:0', admin))
      .resolves.toEqual({ status: 'verified' });
    expect(lan.verifyShellyCandidate).toHaveBeenCalledWith('shelly:0', owner);
    registry.getSnapshot.mockReturnValue({ tenant: { id: owner.tenantId }, site: { id: 'lab', name: 'Lab' } });
    await controller.verifyShellyDiscoveryCandidate('shelly:1', admin);
    expect(lan.verifyShellyCandidate).toHaveBeenLastCalledWith('shelly:1', { tenantId: owner.tenantId, siteId: 'lab' });
  });

  it('does not persist candidates from foreign-site scans', async () => {
    const { controller, lan, registry } = fixture();
    lan.scanNow.mockResolvedValue({
      snapshot: { ownership: { tenantId: 'tenant-one', siteId: 'foreign' } },
      devices: [{ id: 'shellyplus1-test', vendor: 'Shelly', components: [{ component: 'switch:0', channel: 0 }] }],
    });
    await expect(controller.scanNetwork(consent, admin)).rejects.toThrow(ForbiddenException);
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled();
    expect(registry.getDevices).not.toHaveBeenCalled();
  });

  it('registers only authorized, site-stamped candidates for human review', async () => {
    const { controller, lan, registry } = fixture();
    lan.scanNow.mockResolvedValue({
      snapshot: { ownership: owner },
      devices: [{
        id: 'shellyplus1-8813bfcdc8bc', vendor: 'Shelly', generation: 2, status: 'online', ipAddress: '192.168.7.10',
        components: [{ component: 'switch:0', channel: 0 }],
        observations: [
          { source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-8813bfcdc8bc', observedAt: '2026-11-03T08:00:00Z' },
          { source: 'http_rpc', attribute: 'shelly.component_status', value: 'switch:0', method: 'Switch.GetStatus?id=0', observedAt: '2026-11-03T08:00:00Z' },
        ],
      }],
    });
    await controller.scanNetwork(consent, admin);
    expect(registry.registerDiscoveredDevice).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: owner.tenantId, siteId: owner.siteId, siteName: 'Home',
      metadata: expect.objectContaining({ discoveryTenantId: owner.tenantId, discoverySiteId: owner.siteId }),
    }));
  });

  it('suppresses late candidate registration after a client disconnect', async () => {
    const { controller, lan, registry } = fixture();
    const response = { writableEnded: false, once: jest.fn(), off: jest.fn() };
    let finishScan!: (result: unknown) => void;
    lan.scanNow.mockImplementationOnce(() => new Promise(resolve => { finishScan = resolve; }));
    const pending = controller.scanNetwork(consent, admin, response);
    expect(response.once).toHaveBeenCalledWith('close', expect.any(Function));
    const onClose = response.once.mock.calls[0][1] as () => void;
    onClose();
    expect(lan.scanNow.mock.calls[0][0].signal.aborted).toBe(true);
    const rejected = expect(pending).rejects.toThrow(ServiceUnavailableException);
    finishScan({ snapshot: { ownership: owner }, devices: [{ id: 'shellyplus1-test' }] });
    await rejected;
    expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled();
    expect(response.off).toHaveBeenCalledWith('close', onClose);
  });

  it('aborts on deadline and releases response close listener', async () => {
    jest.useFakeTimers();
    try {
      const { controller, lan } = fixture();
      lan.scanNow.mockImplementationOnce(() => new Promise(() => undefined));
      const response = { writableEnded: false, once: jest.fn(), off: jest.fn() };
      const pending = controller.scanNetwork(consent, admin, response);
      const rejection = expect(pending).rejects.toThrow(GatewayTimeoutException);
      await jest.advanceTimersByTimeAsync(180_000);
      await rejection;
      expect(lan.scanNow.mock.calls[0][0].signal.aborted).toBe(true);
      expect(response.once).toHaveBeenCalledWith('close', expect.any(Function));
      expect(response.off).toHaveBeenCalledWith('close', response.once.mock.calls[0][1]);
    } finally {
      jest.useRealTimers();
    }
  });
});
