import type { AuthorizedSiteLocalObserver } from './site-local-shelly-evidence-intake'

/** A command route is separately authorized from the read-only observer assignment. */
export interface AuthorizedSiteLocalShellyControlRoute {
  observerId: string
  tenantId: string
  siteId: string
  scopeId: string
  physicalId: string
  component: string
}

export function configuredSiteLocalShellyControlRoutes(
  raw = process.env.HOME_SITE_LOCAL_SHELLY_CONTROL_ROUTES_JSON,
): AuthorizedSiteLocalShellyControlRoute[] {
  if (!raw?.trim()) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('HOME_SITE_LOCAL_SHELLY_CONTROL_ROUTES_JSON is malformed.') }
  if (!Array.isArray(value) || value.length > 32) throw new Error('Site-local Shelly control routes must be a bounded array.')
  const routes = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Site-local Shelly control route is malformed.')
    const route = item as Record<string, unknown>
    for (const key of ['observerId', 'tenantId', 'siteId', 'scopeId', 'physicalId', 'component']) {
      if (typeof route[key] !== 'string' || !(route[key] as string).trim()) throw new Error(`Site-local Shelly control route requires ${key}.`)
    }
    if (!/^shelly[a-z0-9._-]{1,114}$/i.test(route.physicalId as string) ||
        !/^switch:(?:0|[1-9]|[12][0-9]|3[01])$/.test(route.component as string)) {
      throw new Error('Site-local Shelly control routes must name an exact physical Shelly switch component.')
    }
    return route as unknown as AuthorizedSiteLocalShellyControlRoute
  })
  const keys = routes.map(route => `${route.tenantId}\u0000${route.siteId}\u0000${route.scopeId}\u0000${route.physicalId.toLowerCase()}\u0000${route.component}`)
  if (new Set(keys).size !== keys.length) throw new Error('Site-local Shelly control routes must not contain duplicate assignments.')
  return routes
}

export function selectSiteLocalShellyControlRoute(input: {
  routes: AuthorizedSiteLocalShellyControlRoute[]
  observer: AuthorizedSiteLocalObserver
  tenantId: string
  siteId: string
  scopeId: string
  physicalId: string
  component: string
}): AuthorizedSiteLocalShellyControlRoute | null {
  const matches = input.routes.filter(route => route.observerId === input.observer.id &&
    route.tenantId === input.tenantId && route.siteId === input.siteId && route.scopeId === input.scopeId &&
    route.physicalId.toLowerCase() === input.physicalId.toLowerCase() && route.component === input.component)
  return matches.length === 1 ? matches[0] : null
}
