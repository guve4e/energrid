import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { DeviceInstallationStore, type PortalSiteRecord } from '../devices/device-installation.store';
import type { AccountRole } from '../auth/auth.types';
import type { AuthorizedPortalSite } from './portal-site-context';

export interface PortalPrincipal {
  userId: string;
  role: AccountRole;
}

@Injectable()
export class PortalSiteService implements OnModuleInit {
  constructor(private readonly store: DeviceInstallationStore) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensurePortalSite({ tenantId: 'tenant-demo', siteId: 'site-home', name: 'Home', mode: 'home' });
    await this.store.ensurePortalSite({ tenantId: 'tenant-demo', siteId: 'site-device-lab', name: 'Virtual Device Lab', mode: 'home' });
  }

  async list(principal: PortalPrincipal): Promise<PortalSiteRecord[]> {
    this.requireAdmin(principal);
    return this.store.listPortalSites();
  }

  async select(principal: PortalPrincipal, siteId: string): Promise<PortalSiteRecord> {
    this.requireAdmin(principal);
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(siteId)) throw new ForbiddenException('Site is not authorized.');
    const site = (await this.store.listPortalSites()).find(item => item.siteId === siteId);
    if (!site) throw new ForbiddenException('Site is not authorized.');
    await this.store.setPortalSiteSelection(principal.userId, site.tenantId, site.siteId);
    return site;
  }

  async forPrincipal(principal: PortalPrincipal): Promise<AuthorizedPortalSite> {
    this.requireAdmin(principal);
    const sites = await this.store.listPortalSites();
    const saved = await this.store.getPortalSiteSelection(principal.userId);
    const selected = saved && sites.find(site => site.tenantId === saved.tenantId && site.siteId === saved.siteId);
    const fallback = sites.find(site => site.siteId === 'site-home') || sites[0];
    const site = selected || fallback;
    if (!site) throw new ForbiddenException('No authorized Portal site is configured.');
    return { tenantId: site.tenantId, siteId: site.siteId, siteName: site.name, mode: site.mode };
  }

  private requireAdmin(principal: PortalPrincipal): void {
    if (!principal?.userId || principal.role !== 'admin') throw new ForbiddenException('Administrator access is required.');
  }
}

function siteProjection(site: PortalSiteRecord) {
  return { id: site.siteId, name: site.name, mode: site.mode, gatewayIds: [], deviceCount: 0, systemCount: 0 };
}

export function portalSiteProjection(site: PortalSiteRecord) { return siteProjection(site); }
