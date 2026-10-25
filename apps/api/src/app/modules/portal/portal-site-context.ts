import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthorizedPortalSite {
  tenantId: string;
  siteId: string;
  siteName: string;
  mode: 'home' | 'away' | 'night';
}

const context = new AsyncLocalStorage<AuthorizedPortalSite>();

export function currentAuthorizedPortalSite(): AuthorizedPortalSite | undefined {
  return context.getStore();
}

export function runWithAuthorizedPortalSite<T>(site: AuthorizedPortalSite, run: () => T): T {
  return context.run(site, run);
}

export function configuredPortalSite(): AuthorizedPortalSite {
  return currentAuthorizedPortalSite() || {
    tenantId: process.env.PORTAL_TENANT_ID || 'tenant-demo',
    siteId: process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home',
    siteName: process.env.PORTAL_SITE_NAME || 'Home',
    mode: (process.env.PORTAL_SITE_MODE as AuthorizedPortalSite['mode']) || 'home',
  };
}
