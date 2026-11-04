import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PortalController } from './portal.controller';

describe('Portal commissioning events authorization', () => {
  const scope = { tenantId: 'tenant-a', siteId: 'shared-site' };
  const request = { user: { role: 'admin', userId: 'operator-1' } };

  function harness(devices = [
    { id: 'relay-1', tenantId: 'tenant-a', siteId: 'shared-site', trustStatus: 'approved' },
    { id: 'relay-1', tenantId: 'tenant-b', siteId: 'shared-site', trustStatus: 'approved' },
  ]) {
    const forPrincipal = jest.fn().mockResolvedValue(scope);
    const getInstallationEvents = jest.fn().mockResolvedValue([{ deviceId: 'relay-1', actor: 'operator-1' }]);
    const controller = Object.create(PortalController.prototype) as PortalController;
    Object.assign(controller, {
      portalSites: { forPrincipal },
      deviceRegistry: {
        ensureInstallationsLoaded: jest.fn().mockResolvedValue(undefined),
        getDevices: jest.fn().mockReturnValue(devices),
        getInstallationEvents,
      },
    });
    return { controller, getInstallationEvents, forPrincipal };
  }

  it('reads only events for the authenticated principal selected tenant/site', async () => {
    const h = harness();
    await expect(h.controller.getCommissioningEvents('relay-1', request as never))
      .resolves.toEqual({ deviceId: 'relay-1', events: [expect.objectContaining({ actor: 'operator-1' })] });
    expect(h.forPrincipal).toHaveBeenCalledWith(request.user);
    expect(h.getInstallationEvents).toHaveBeenCalledWith(scope, 'relay-1');
  });

  it('does not authorize a matching device in a different tenant', async () => {
    const h = harness([{ id: 'relay-1', tenantId: 'tenant-b', siteId: 'shared-site', trustStatus: 'approved' }]);
    await expect(h.controller.getCommissioningEvents('relay-1', request as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.getInstallationEvents).not.toHaveBeenCalled();
  });

  it('refuses requests when site authorization is unavailable', async () => {
    const h = harness();
    Object.assign(h.controller, { portalSites: undefined });
    await expect(h.controller.getCommissioningEvents('relay-1', request as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.getInstallationEvents).not.toHaveBeenCalled();
  });
});
