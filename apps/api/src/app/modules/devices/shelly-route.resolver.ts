import { BadGatewayException, ConflictException, Injectable, Logger, NotFoundException, Optional, Inject } from '@nestjs/common'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { DeviceRegistryService } from './device-registry.service'
import type { NetworkDiscoveryZone, RegisteredDevice } from './device-registry.types'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceLanDiscoveryService, ipInCidr } from './device-lan-discovery.service'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from './enrollment/physical-device-inventory.token'
import type { PhysicalDeviceInventoryService } from './enrollment/physical-device-inventory.service'
import { hasPhysicalDeviceIdentityClaim } from './enrollment/physical-device-inventory.repository'
import { configuredSiteLocalObservers, selectAuthorizedSiteLocalObserver, type AuthorizedSiteLocalObserver } from './site-local-shelly-evidence-intake'
import { configuredSiteLocalShellyControlRoutes, selectSiteLocalShellyControlRoute } from './site-local-shelly-control-route'

export interface AuthorizedLocalShellyStatusTarget {
  device: RegisteredDevice
  observer: AuthorizedSiteLocalObserver
  physicalId: string
  component: string
  channel: number
  ipAddress: string
  zone: NetworkDiscoveryZone
  interfaceAddress: string
}

/** Shared site-owned installation, identity, and observer route validation.
 * No polling, command dispatch, or state mutation belongs here.
 */
@Injectable()
export class ShellyRouteResolver {
  private readonly logger = new Logger(ShellyRouteResolver.name)
  private readonly localShellyResolutionWarnings = new Set<string>()

  constructor(
    private readonly registry: DeviceRegistryService,
    @Optional() private readonly discovery?: DeviceDiscoveryMemoryStore,
    @Optional() private readonly lanDiscovery?: DeviceLanDiscoveryService,
    @Optional() @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  async resolveAuthorizedLocalShellyStatusTarget(
    device: RegisteredDevice,
    expectedIpAddress?: string,
  ): Promise<AuthorizedLocalShellyStatusTarget | null> {
    const reject = (reason: string, context: Record<string, string | number | boolean> = {}): null => {
      const key = `${device.id}:${reason}`
      if (!this.localShellyResolutionWarnings.has(key)) {
        this.localShellyResolutionWarnings.add(key)
        this.logger.warn(JSON.stringify({
          event: 'shelly_operational_status_poll', outcome: 'skipped', deviceId: device.id,
          failureCategory: reason, ...context,
        }))
      }
      return null
    }
    if (!this.discovery || !this.lanDiscovery || !this.physicalInventory ||
        device.kind !== 'physical' || device.trustStatus !== 'approved' ||
        !device.tenantId || !device.siteId) return reject('observation_dependencies_or_enrollment_missing')
    const physicalId = String(device.metadata?.physicalId || '')
    const component = String(device.metadata?.component || '')
    const match = /^(switch):(0|[1-9]|[12][0-9]|3[01])$/.exec(component)
    if (!/^shelly[a-z0-9._-]{1,114}$/i.test(physicalId) || !match ||
        device.id !== `${physicalId}:${component}`) return reject('identity_or_component_binding_invalid')
    const installationScope = String(device.metadata?.networkScope || '').trim()
    const installationScopeId = installationScope.includes(':')
      ? installationScope.slice(installationScope.lastIndexOf(':') + 1)
      : installationScope
    let observers: AuthorizedSiteLocalObserver[]
    try { observers = configuredSiteLocalObservers() } catch { return reject('observer_configuration_invalid') }
    const matchingScopeIds = [...new Set(observers.filter(item => item.tenantId === device.tenantId && item.siteId === device.siteId &&
      (item.scopeId === installationScopeId || item.cidr === installationScope || installationScope.endsWith(`:${item.cidr}`)))
      .map(item => item.scopeId))]
    if (matchingScopeIds.length !== 1) return reject(matchingScopeIds.length ? 'site_scope_authorization_ambiguous' : 'site_scope_authorization_missing', {
      tenantSiteScopeMatchCount: matchingScopeIds.length,
    })
    const scopeId = matchingScopeIds[0]
    const selection = selectAuthorizedSiteLocalObserver({ observers, tenantId: device.tenantId,
      siteId: device.siteId, scopeId, physicalId, component })
    if (!selection.observer) return reject(selection.reason, {
      tenantSiteObserverCount: observers.filter(item => item.tenantId === device.tenantId && item.siteId === device.siteId &&
        (item.scopeId === scopeId || item.cidr === installationScope || installationScope.endsWith(`:${item.cidr}`))).length,
      installationTenantId: device.tenantId,
      installationSiteId: device.siteId,
      installationScopeId: scopeId === installationScope ? 'cidr' : scopeId,
    })
    const observer = selection.observer
    const selectedScopeId = observer.scopeId
    if (!observer.interfaceName) return reject('component_or_interface_not_explicitly_authorized')
    const zone = this.lanDiscovery.getConfiguredZone(selectedScopeId)
    if (!zone || zone.collectionSource === 'virtual-lab' || zone.cidr !== observer.cidr || !zone.cidr ||
        (installationScopeId !== observer.scopeId && installationScope !== observer.cidr &&
          !installationScope.endsWith(`:${observer.cidr}`))) {
      return reject('scope_not_authorized_for_local_observation')
    }
    const runtimeHost = normalizedObserverHost(hostname())
    if (runtimeHost !== normalizedObserverHost(observer.host)) return reject('observer_host_mismatch')
    const addresses = networkInterfaces()[observer.interfaceName!] || []
    const matchingAddresses = addresses.filter(address => !address.internal && address.family === 'IPv4' &&
      networkInterfaceMatchesCidr(address.address, address.netmask, observer.cidr))
    if (matchingAddresses.length !== 1) return reject('observer_interface_scope_mismatch')
    const inventory = await this.physicalInventory.forLogicalDevice(
      { tenantId: device.tenantId, siteId: device.siteId }, device.id,
    )
    const inventoryId = String(device.metadata?.physicalInventoryId || '')
    const inventoryChecks = {
      inventoryFound: !!inventory,
      // The site-owned inventory lookup and its logical assignment are
      // authoritative. Some imported installation rows omit this optional
      // metadata mirror; if present, it must still match exactly.
      inventoryIdMatches: !!inventory && (!inventoryId || inventory.physicalDeviceId === inventoryId),
      siteOwnerMatches: !!inventory && inventory.scope.tenantId === device.tenantId && inventory.scope.siteId === device.siteId,
      physicalIdentityClaimMatches: !!inventory && hasPhysicalDeviceIdentityClaim(inventory, 'mqtt:shelly-protocol-id', physicalId),
      componentExists: !!inventory && inventory.components.some(item => item.key === component),
      logicalAssignmentMatches: !!inventory && inventory.assignments.some(item => item.deviceId === device.id &&
        item.physicalDeviceId === inventory.physicalDeviceId && item.componentKey === component),
    }
    if (Object.values(inventoryChecks).some(check => !check)) {
      return reject('physical_inventory_assignment_mismatch', {
        ...inventoryChecks,
        expectedPhysicalInventoryId: inventoryId || 'missing',
        resolvedPhysicalInventoryId: inventory?.physicalDeviceId || 'missing',
      })
    }
    const records = await this.discovery.listIdentityEvidence({ tenantId: device.tenantId, siteId: device.siteId })
    const endpoints = [...new Map(records.filter(record => {
      const observations = record.device.observations || []
      const identityAt = new Set(observations.filter(item => item.source === 'http_identity' &&
        item.attribute === 'identity.device_id' && typeof item.value === 'string' &&
        item.value.toLowerCase() === physicalId.toLowerCase() &&
        item.scopeId === scopeId && item.method === 'GET /rpc/Shelly.GetDeviceInfo').map(item => item.observedAt))
      return record.ownership?.tenantId === device.tenantId && record.ownership.siteId === device.siteId &&
        record.device.vendor === 'Shelly' && record.device.id.toLowerCase() === physicalId.toLowerCase() &&
        record.device.networkZoneId === scopeId && record.device.protocol === 'http' &&
        (!expectedIpAddress || record.device.ipAddress === expectedIpAddress) &&
        ipInCidr(record.device.ipAddress, observer.cidr) &&
        observations.some(item => item.source === 'http_identity' && item.attribute === 'identity.verified' &&
          item.value === true && identityAt.has(item.observedAt)) &&
        observations.some(item => item.source === 'site_local_http_rpc' && item.attribute === 'observer.identity' &&
          item.value === observer.id && item.scopeId === scopeId && item.interfaceName === observer.interfaceName) &&
        observations.some(item => item.source === 'site_local_http_rpc' && item.attribute === 'shelly.component_status' &&
          item.value === component && item.scopeId === scopeId && item.interfaceName === observer.interfaceName &&
          item.method === `Switch.GetStatus?id=${match[2]}`)
    }).map(record => [`${record.device.networkZoneId}:${record.device.ipAddress}`, record])).values()]
    if (endpoints.length !== 1) return reject(endpoints.length === 0
      ? 'saved_identity_or_component_evidence_missing'
      : 'saved_endpoint_ambiguous')
    return {
      device, observer, physicalId, component, channel: Number(match[2]),
      ipAddress: endpoints[0].device.ipAddress, zone, interfaceAddress: matchingAddresses[0].address,
    }
  }

  /** Resolve a command target only from the enrolled installation and saved site-owned RPC evidence. */
  async resolveShellyControlTarget(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    onStage?: (stage: 'enrollment_and_inventory_validation' | 'enrollment_inventory_validated' | 'saved_endpoint_observer_scope_validation' | 'saved_endpoint_observer_scope_validated') => void,
    requireControlRoute = false,
  ) {
    const target = await this.resolveShellyInstallationTarget(deviceId, ownership, onStage)
    if (target.zone.collectionSource === 'local') {
      const localTarget = await this.resolveAuthorizedLocalShellyStatusTarget(target.device, target.ipAddress)
      if (localTarget && localTarget.ipAddress === target.ipAddress && localTarget.zone.id === target.zone.id &&
          target.device.metadata?.siteLocalObserverId === localTarget.observer.id) return { ...target, siteLocalObserver: undefined }

      // The API may be outside this authorized LAN. In that case execute only
      // through the exact Pi observer already recorded on the reconciled device.
      const observerId = String(target.device.metadata?.siteLocalObserverId || '')
      const selection = selectAuthorizedSiteLocalObserver({ observers: configuredSiteLocalObservers(),
        tenantId: ownership.tenantId, siteId: ownership.siteId, scopeId: target.zone.id,
        physicalId: target.physicalId, component: target.component })
      const observer = selection.observer
      if (!observer || observer.id !== observerId || !observer.sshTarget || !observer.interfaceName ||
          observer.cidr !== target.zone.cidr || !target.zone.cidr || !ipInCidr(target.ipAddress, observer.cidr)) {
        throw new ConflictException('The saved endpoint has no matching authorized site-local execution observer.')
      }
      if (requireControlRoute && !selectSiteLocalShellyControlRoute({
        routes: configuredSiteLocalShellyControlRoutes(), observer, tenantId: ownership.tenantId,
        siteId: ownership.siteId, scopeId: target.zone.id, physicalId: target.physicalId, component: target.component,
      })) throw new ConflictException('No separately authorized site-local Shelly command route matches this device component.')
      return { ...target, siteLocalObserver: observer }
    }
    return target
  }

  /** Resolve the enrolled site-owned endpoint/evidence independently from an executable command transport. */
  async resolveShellyInstallationTarget(
    deviceId: string,
    ownership: { tenantId: string; siteId: string },
    onStage?: (stage: 'enrollment_and_inventory_validation' | 'enrollment_inventory_validated' | 'saved_endpoint_observer_scope_validation' | 'saved_endpoint_observer_scope_validated') => void,
  ) {
    onStage?.('enrollment_and_inventory_validation')
    await this.registry.ensureInstallationsLoaded()
    const matches = this.registry.getDevices(true).filter(device => device.id === deviceId)
    const device = matches.find(item => item.tenantId === ownership.tenantId && item.siteId === ownership.siteId)
    if (!device) throw new NotFoundException('No Shelly installation exists in the selected site.')
    if (matches.some(item => item.tenantId !== ownership.tenantId || item.siteId !== ownership.siteId)) {
      throw new ConflictException('The Shelly identity is also registered outside the selected site.')
    }
    const physicalId = String(device.metadata?.physicalId || '')
    const component = String(device.metadata?.component || '')
    const channel = device.metadata?.channel
    if (device.kind !== 'physical' || device.trustStatus !== 'approved' ||
        !['shelly-lan', 'shelly-discovered'].includes(device.adapter.driver) ||
        !['http', 'mqtt'].includes(device.adapter.protocol) ||
        !device.adapter.configured || !/^shelly[a-z0-9._-]{1,114}$/i.test(physicalId) ||
        !/^switch:\d+$/.test(component) || !Number.isInteger(channel) ||
        component !== `switch:${channel}` || device.id !== `${physicalId}:${component}`) {
      throw new ConflictException('Only an approved, configured Shelly switch installation is supported.')
    }
    if (!this.physicalInventory || !this.discovery || !this.lanDiscovery) {
      throw new BadGatewayException('Site-owned Shelly identity and endpoint evidence is unavailable.')
    }
    const inventory = await this.physicalInventory.forLogicalDevice(ownership, deviceId)
    if (!inventory || inventory.scope.tenantId !== ownership.tenantId || inventory.scope.siteId !== ownership.siteId ||
        !hasPhysicalDeviceIdentityClaim(inventory, 'mqtt:shelly-protocol-id', physicalId) ||
        !inventory.components.some(item => item.key === component) ||
        !inventory.assignments.some(item => item.deviceId === deviceId &&
          item.physicalDeviceId === inventory.physicalDeviceId && item.componentKey === component) ||
        (device.metadata?.physicalInventoryId !== undefined &&
          device.metadata.physicalInventoryId !== inventory.physicalDeviceId)) {
      throw new ConflictException('The switch has no exact same-site physical inventory assignment.')
    }
    const decision = await this.registry.getShellyReconciliationTargetDecision(
      ownership.tenantId, ownership.siteId, deviceId, physicalId, component, inventory.physicalDeviceId,
    )
    if (!decision.matched) throw new ConflictException(`Shelly route rejected (${decision.reasonCode}).`)
    onStage?.('enrollment_inventory_validated')

    onStage?.('saved_endpoint_observer_scope_validation')
    const savedScope = String(device.metadata?.networkScope || '').trim()
    const scopeParts = savedScope.split(':').reverse()
    const zone = scopeParts
      .map(part => this.lanDiscovery?.getConfiguredZone(part))
      .find((candidate): candidate is NetworkDiscoveryZone => Boolean(candidate))
    if (!zone || !scopeMatchesConfiguredZone(savedScope, zone)) {
      throw new ConflictException('The saved endpoint does not belong to a configured installation network scope.')
    }

    // Discovery Memory is an audit history. Select only the endpoint already
    // reconciled onto this enrolled installation and still marked current in
    // its site-owned Physical Inventory record. A scan at a new address must
    // not silently move the command route.
    const ipAddress = String(device.metadata?.ipAddress || '')
    if (isIP(ipAddress) !== 4) {
      throw new ConflictException('No reconciled active Shelly endpoint is saved for this installation; review its network identity before enabling switching.')
    }
    const activeObservations = inventory.networkObservations.filter(item =>
      item.isCurrent && scopeMatchesConfiguredZone(item.networkScope, zone),
    )
    const activeEndpoints = [...new Set(activeObservations.map(item => item.ipAddress))]
    if (activeEndpoints.length !== 1 || activeEndpoints[0] !== ipAddress) {
      throw new ConflictException(activeEndpoints.length > 1
        ? `Physical Inventory has conflicting active endpoints in ${zone.id}; review network identity reconciliation before enabling switching.`
        : `The saved ${zone.id} endpoint differs from the active Physical Inventory association; explicitly reconcile the endpoint before enabling switching.`)
    }
    const collectionSource = zone.collectionSource ?? 'local'
    if (collectionSource !== 'virtual-lab') {
      if (device.metadata?.identityEvidenceSource !== 'verified_site_local_shelly_rpc' ||
          device.metadata?.componentEvidenceSource !== 'verified_site_local_shelly_rpc' ||
          !String(device.metadata?.siteLocalEvidenceScanId || '').startsWith('site-observer-') ||
          !String(device.metadata?.siteLocalObserverId || '')) {
        throw new ConflictException('The active endpoint lacks operator-reconciled site-local Shelly identity and component evidence.')
      }

      const history = (await this.discovery.listIdentityEvidence(ownership)).filter(record => {
        if (!record?.device) return false
        const observations = record.device.observations || []
        const independentlyVerifiedAt = new Set(observations.filter(item => item.source === 'http_identity' &&
          item.attribute === 'identity.verified' && item.value === true).map(item => item.observedAt))
        const identityMatches = observations.some(item =>
          ['http_identity', 'http_rpc', 'site_local_http_rpc'].includes(item.source) &&
          ['shelly.device_id', 'identity.device_id'].includes(item.attribute) &&
          typeof item.value === 'string' && item.value.toLowerCase() === physicalId.toLowerCase() &&
          (item.source !== 'http_identity' || independentlyVerifiedAt.has(item.observedAt)))
        return record.ownership?.tenantId === ownership.tenantId && record.ownership.siteId === ownership.siteId &&
          record.device.vendor === 'Shelly' && record.device.id.toLowerCase() === physicalId.toLowerCase() &&
          record.device.networkZoneId === zone.id && record.device.ipAddress === ipAddress &&
          record.device.components?.some(item => item.component === component) && identityMatches &&
          observations.some(item => ['http_rpc', 'site_local_http_rpc'].includes(item.source) &&
            item.attribute === 'shelly.component_status' && item.value === component &&
            item.method === `Switch.GetStatus?id=${channel}`)
      })
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      if (!history.length) {
        throw new ConflictException(`No saved site-owned identity and ${component} component-status evidence supports the reconciled ${zone.id} endpoint.`)
      }
    }
    if (isIP(ipAddress) !== 4) {
      throw new ConflictException('The saved Shelly endpoint is not in a configured authorized execution scope.')
    }
    const endpointInScope = zone.cidr
      ? ipInCidr(ipAddress, zone.cidr)
      : zone.seedIps.includes(ipAddress)
    if (!endpointInScope) {
      throw new ConflictException('The saved Shelly endpoint is outside the configured network scope.')
    }
    onStage?.('saved_endpoint_observer_scope_validated')
    return { device, inventory, physicalId, component, channel: channel as number, ipAddress,
      zone: { ...zone, collectionSource }, siteLocalObserver: undefined as AuthorizedSiteLocalObserver | undefined }
  }

}

export function normalizedObserverHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.local$/, '')
}

function networkInterfaceMatchesCidr(address: string, netmask: string, cidr: string): boolean {
  const prefix = ipv4NetmaskPrefix(netmask)
  const [network, prefixText] = cidr.split('/')
  const authorizedPrefix = Number(prefixText)
  if (prefix === null || prefix !== authorizedPrefix || isIP(address) !== 4 || isIP(network) !== 4) return false
  return ipv4Network(address, prefix) === ipv4Network(network, prefix)
}

function ipv4Network(address: string, prefix: number): number {
  const value = address.split('.').map(Number).reduce((current, octet) => current * 256 + octet, 0)
  const blockSize = 2 ** (32 - prefix)
  return Math.floor(value / blockSize) * blockSize
}

function scopeMatchesConfiguredZone(scopeValue: string, zone: NetworkDiscoveryZone): boolean {
  const scope = scopeValue.trim()
  return scope === zone.id || (!!zone.cidr && scope === zone.cidr) ||
    scope.endsWith(`:${zone.id}`) || (!!zone.cidr && scope.endsWith(`:${zone.cidr}`))
}

export function ipv4NetmaskPrefix(netmask: string): number | null {
  const octets = netmask.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null
  const bits = octets.map(value => value.toString(2).padStart(8, '0')).join('')
  if (!/^1*0*$/.test(bits)) return null
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')
}
