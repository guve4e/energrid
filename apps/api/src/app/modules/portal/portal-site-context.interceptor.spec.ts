import { firstValueFrom, of } from 'rxjs';
import { currentAuthorizedPortalSite } from './portal-site-context';
import { PortalSiteContextInterceptor } from './portal-site-context.interceptor';

describe('PortalSiteContextInterceptor', () => {
  it('runs an administrator request in the site resolved by the server', async () => {
    const site = { tenantId: 'tenant-demo', siteId: 'site-device-lab', siteName: 'Virtual Device Lab', mode: 'home' as const };
    const interceptor = new PortalSiteContextInterceptor({
      forPrincipal: jest.fn().mockResolvedValue(site),
    } as any);
    const request = { user: { userId: 'admin-1', role: 'admin' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as any;
    const result = await firstValueFrom(interceptor.intercept(context, {
      handle: () => of(currentAuthorizedPortalSite()),
    } as any));

    expect(result).toEqual(site);
  });

  it('does not select a client-supplied site for a non-administrator request', async () => {
    const forPrincipal = jest.fn();
    const interceptor = new PortalSiteContextInterceptor({ forPrincipal } as any);
    const context = { switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'viewer-1', role: 'viewer' } }) }) } as any;
    const result = await firstValueFrom(interceptor.intercept(context, { handle: () => of('passed-through') } as any));

    expect(result).toBe('passed-through');
    expect(forPrincipal).not.toHaveBeenCalled();
  });
});
