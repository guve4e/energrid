import { ForbiddenException, NotFoundException, RequestMethod, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard';
import { PortalController } from './portal.controller';
import { PortalNetworkDiscoveryReadController } from './portal-network-discovery-read.controller';

const owner = { tenantId: 'tenant-one', siteId: 'home' };
const admin = { user: { role: 'admin', userId: 'operator-1' }, headers: {} } as never;
const viewer = { user: { role: 'viewer', userId: 'guest' }, headers: {} } as never;
const anonymous = { headers: {} } as never;

function snapshot(scanId: string, ownership = owner) {
  return {
    schemaVersion: 2 as const,
    scanId,
    ownership,
    startedAt: '2026-11-03T08:00:00.000Z',
    completedAt: '2026-11-03T08:01:00.000Z',
    collector: { id: 'observer-1', host: 'lab', interfaces: [] },
    scopes: [], methods: [], successes: 0, failures: [], limitations: [],
    rawEvidenceOmitted: 0, rawEvidence: [], endpoints: [],
    topology: { relationships: [] },
  };
}

function subject() {
  const registry = {
    getSnapshot: jest.fn(() => ({ tenant: { id: owner.tenantId }, site: { id: owner.siteId } })),
    getDevices: jest.fn(() => []),
  };
  const memory = {
    listHistoricalSnapshots: jest.fn().mockResolvedValue([]),
    getSnapshot: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    summary: jest.fn().mockResolvedValue({ known: 0, lastScanId: null }),
  };
  const discovery = {
    getRuntimeCapabilities: jest.fn().mockReturnValue({ scanSupported: true }),
  };
  const inventory = { list: jest.fn().mockResolvedValue([]) };
  return {
    controller: new PortalNetworkDiscoveryReadController(
      registry as never, memory as never, discovery as never, inventory as never,
    ),
    registry, memory, discovery, inventory,
  };
}

const movedRoutes = [
  ['listNetworkSnapshots', 'network/snapshots'],
  ['networkCapabilities', 'network/capabilities'],
  ['compareNetworkSnapshotRoute', 'network/snapshots/:fromScanId/compare/:toScanId'],
  ['getNetworkDiscoveryMemory', 'network/memory'],
  ['getNetworkDiscoveryMemorySummary', 'network/memory/summary'],
] as const;

describe('Portal network discovery read boundary (P6b)', () => {
  it('registers exactly the moved GET endpoints under the original JWT/admin policy', () => {
    const controller = PortalNetworkDiscoveryReadController;
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('portal');
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([AccessJwtGuard, RoleGuard]);
    expect(Reflect.getMetadata('energrid.auth.roles', controller)).toEqual(['admin']);
    // Check registration without importing unrelated LLM SDKs into this unit suite.
    // Runtime dependency injection still requires a separate integration smoke test.
    const moduleSource = readFileSync(join(__dirname, 'portal.module.ts'), 'utf8');
    expect(moduleSource).toMatch(/controllers\s*:\s*\[[^\]]*\bPortalNetworkDiscoveryReadController\b/);
    for (const [name, path] of movedRoutes) {
      const method = controller.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.GET);
      expect(Object.prototype.hasOwnProperty.call(PortalController.prototype, name)).toBe(false);
    }
  });

  it('rejects missing JWT and a viewer role through the actual Nest guards', async () => {
    const reflector = new Reflector();
    const authenticateAccessToken = jest.fn().mockResolvedValue({ userId: 'viewer-1', role: 'viewer' });
    const jwtGuard = new AccessJwtGuard({ authenticateAccessToken } as never, reflector);
    const roleGuard = new RoleGuard(reflector);
    const request: { headers: { authorization?: string }; user?: { userId: string; role: string } } = {
      headers: {},
    };
    const context = {
      getHandler: () => PortalNetworkDiscoveryReadController.prototype.listNetworkSnapshots,
      getClass: () => PortalNetworkDiscoveryReadController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    await expect(jwtGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(authenticateAccessToken).not.toHaveBeenCalled();

    request.headers.authorization = 'Bearer test-token';
    await expect(jwtGuard.canActivate(context)).resolves.toBe(true);
    expect(authenticateAccessToken).toHaveBeenCalledWith('test-token');
    expect(() => roleGuard.canActivate(context)).toThrow(ForbiddenException);
    request.user = { userId: 'admin-1', role: 'admin' };
    expect(roleGuard.canActivate(context)).toBe(true);
  });

  it.each([anonymous, viewer])('rejects a non-admin before invoking any read collaborator', async (request) => {
    const { controller, registry, memory, discovery, inventory } = subject();
    for (const invoke of [
      () => controller.listNetworkSnapshots(request),
      () => controller.networkCapabilities(request),
      () => controller.compareNetworkSnapshotRoute('scan-a', 'scan-b', request),
      () => controller.getNetworkDiscoveryMemory(request),
      () => controller.getNetworkDiscoveryMemorySummary(request),
    ]) {
      await expect(invoke()).rejects.toThrow(UnauthorizedException);
    }
    expect(registry.getSnapshot).not.toHaveBeenCalled();
    expect(registry.getDevices).not.toHaveBeenCalled();
    expect(memory.listHistoricalSnapshots).not.toHaveBeenCalled();
    expect(memory.getSnapshot).not.toHaveBeenCalled();
    expect(memory.list).not.toHaveBeenCalled();
    expect(memory.summary).not.toHaveBeenCalled();
    expect(discovery.getRuntimeCapabilities).not.toHaveBeenCalled();
    expect(inventory.list).not.toHaveBeenCalled();
  });

  it('lists only active-site snapshots with their read-only projections', async () => {
    const { controller, registry, memory, inventory } = subject();
    memory.listHistoricalSnapshots.mockResolvedValue([snapshot('scan-a')] as never);
    const result = await controller.listNetworkSnapshots(admin);
    expect(memory.listHistoricalSnapshots).toHaveBeenCalledWith(owner, 50);
    expect(registry.getDevices).toHaveBeenCalledWith(true);
    expect(inventory.list).toHaveBeenCalledWith(owner);
    expect(result).toEqual({ snapshots: [expect.objectContaining({
      scanId: 'scan-a', ownership: owner, endpoints: [],
      endpointRecoveryProposals: [], networkRoles: [],
    })] });
  });

  it('keeps the snapshot read available when optional physical inventory fails', async () => {
    const { controller, memory, inventory } = subject();
    memory.listHistoricalSnapshots.mockResolvedValue([snapshot('scan-a')] as never);
    inventory.list.mockRejectedValue(new Error('physical inventory unavailable') as never);
    await expect(controller.listNetworkSnapshots(admin)).resolves.toMatchObject({
      snapshots: [{ scanId: 'scan-a', endpointRecoveryProposals: [] }],
    });
  });

  it('scopes both snapshot comparison reads and rejects a missing or foreign-site snapshot', async () => {
    const { controller, memory } = subject();
    memory.getSnapshot.mockImplementation(async (id: string) => snapshot(id));
    const result = await controller.compareNetworkSnapshotRoute('scan-a', 'scan-b', admin);
    expect(result).toMatchObject({ fromScanId: 'scan-a', toScanId: 'scan-b', addedEndpoints: [] });
    expect(memory.getSnapshot).toHaveBeenNthCalledWith(1, 'scan-a', owner);
    expect(memory.getSnapshot).toHaveBeenNthCalledWith(2, 'scan-b', owner);

    memory.getSnapshot.mockImplementation(async (id: string) => id === 'foreign-site-scan' ? null : snapshot(id));
    await expect(controller.compareNetworkSnapshotRoute('scan-a', 'foreign-site-scan', admin))
      .rejects.toThrow(NotFoundException);
    expect(memory.getSnapshot).toHaveBeenLastCalledWith('foreign-site-scan', owner);
  });

  it('reads discovery memory and summary from the selected site, never from request parameters', async () => {
    const { controller, registry, memory } = subject();
    memory.list.mockResolvedValue([{ identity: 'host-1' }] as never);
    memory.summary.mockResolvedValue({ known: 1, lastScanId: 'scan-a' } as never);
    await expect(controller.getNetworkDiscoveryMemory(admin)).resolves.toEqual({
      devices: [{ identity: 'host-1' }], summary: { known: 1, lastScanId: 'scan-a' },
    });
    expect(memory.list).toHaveBeenCalledWith(owner);
    expect(memory.summary).toHaveBeenCalledWith(owner);

    registry.getSnapshot.mockReturnValue({ tenant: { id: owner.tenantId }, site: { id: 'lab' } });
    await controller.getNetworkDiscoveryMemorySummary(admin);
    expect(memory.summary).toHaveBeenLastCalledWith({ tenantId: owner.tenantId, siteId: 'lab' });
  });

  it('preserves the admin-only capability response', async () => {
    const { controller, discovery } = subject();
    await expect(controller.networkCapabilities(admin)).resolves.toEqual({ scanSupported: true });
    expect(discovery.getRuntimeCapabilities).toHaveBeenCalledTimes(1);
  });
});
