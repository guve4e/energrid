import { Injectable, Optional } from '@nestjs/common'
import { configuredNetworkZones, ipInCidr } from './device-lan-discovery.service'
import { configuredSiteLocalObservers, selectAuthorizedSiteLocalObserver } from './site-local-shelly-evidence-intake'
import { configuredSiteLocalShellyControlRoutes, selectSiteLocalShellyControlRoute } from './site-local-shelly-control-route'
import { SiteLocalShellyControlAdapter } from './adapters/outbound/network/site-local-shelly-control.adapter'

/** Authorized site-local switch execution. This boundary does not discover devices or read registry state. */
@Injectable()
export class SiteLocalShellyCommandExecutor {
  constructor(@Optional() private readonly adapter = new SiteLocalShellyControlAdapter()) {}

  async execute(input: {
    scopeId: string; observerId: string; tenantId: string; siteId: string; physicalId: string
    ipAddress: string; component: string; expectedComponentKeys: string[]; on: boolean
  }) {
    // Revalidate against effective runtime configuration at command time,
    // even when the installation resolver has already approved the target.
    const zone = configuredNetworkZones().find(candidate => candidate.id === input.scopeId)
    if (!zone || zone.collectionSource === 'virtual-lab' || !zone.cidr) {
      throw new Error('No configured site-local scope matches the authorized observer.')
    }
    const selection = selectAuthorizedSiteLocalObserver({
      observers: configuredSiteLocalObservers(), tenantId: input.tenantId, siteId: input.siteId,
      scopeId: input.scopeId, physicalId: input.physicalId, component: input.component,
    })
    const observer = selection.observer
    if (!observer || observer.id !== input.observerId || !observer.sshTarget || !observer.interfaceName ||
        observer.cidr !== zone.cidr || !input.expectedComponentKeys.includes(input.component) ||
        !ipInCidr(input.ipAddress, observer.cidr)) {
      throw new Error('The site-local observer route does not match the enrolled device, component, endpoint, and scope.')
    }
    const route = selectSiteLocalShellyControlRoute({
      routes: configuredSiteLocalShellyControlRoutes(), observer, tenantId: input.tenantId,
      siteId: input.siteId, scopeId: input.scopeId, physicalId: input.physicalId, component: input.component,
    })
    if (!route) throw new Error('No separately authorized site-local Shelly command route matches this device component.')
    return this.adapter.setSwitch({ ...input, zone, observer, route })
  }
}
