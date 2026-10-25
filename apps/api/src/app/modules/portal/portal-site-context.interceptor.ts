import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithAuthorizedPortalSite } from './portal-site-context';
import { PortalSiteService } from './portal-site.service';

@Injectable()
export class PortalSiteContextInterceptor implements NestInterceptor {
  constructor(private readonly sites: PortalSiteService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = context.switchToHttp().getRequest()?.user;
    if (!principal?.userId || principal.role !== 'admin') return next.handle();
    return new Observable(subscriber => {
      void this.sites.forPrincipal(principal).then(site => {
        runWithAuthorizedPortalSite(site, () => next.handle().subscribe(subscriber));
      }).catch(error => subscriber.error(error));
    });
  }
}
