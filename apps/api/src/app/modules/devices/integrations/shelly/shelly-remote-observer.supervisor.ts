import { ConflictException, Logger } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DeviceRegistryService } from '../../device-registry.service'
import type { RegisteredDevice } from '../../device-registry.types'
import type { DeviceDiscoveryMemoryStore } from '../../device-discovery-memory.store'
import type { DeviceLanDiscoveryService } from '../../device-lan-discovery.service'
import type { PhysicalDeviceInventoryService } from '../../enrollment/physical-device-inventory.service'
import type { RemoteShellyObserverRuntime, RemoteShellyStatusAssignment, RemoteShellyStatusObserverHandle } from '../../adapters/outbound/network/virtual-lab-network-evidence.adapter'
import { configuredSiteLocalObservers, selectAuthorizedSiteLocalObserver, type AuthorizedSiteLocalObserver } from '../../site-local-shelly-evidence-intake'
import { normalizedObserverHost, type ShellyRouteResolver } from '../../shelly-route.resolver'
import { parseShellySwitchStatus } from '../../adapters/inbound/shelly/shelly-switch-status'

interface AuthorizedRemoteShellyStatusTarget {
  assignmentKey: string
  device: RegisteredDevice
  tenantId: string
  siteId: string
  physicalId: string
  physicalInventoryId: string
  component: string
  ipAddress: string
  scopeId: string
  expectedComponentKeys: string[]
  targetKey: string
}

interface RemoteShellyObserverState {
  key: string
  sessionId: string
  scopeId: string
  owner: { tenantId: string; siteId: string }
  observer?: RemoteShellyObserverRuntime
  handle?: RemoteShellyStatusObserverHandle
  assignmentMap: Map<string, AuthorizedRemoteShellyStatusTarget>
  lastObservedAtByAssignmentKey: Map<string, number>
  configHash: string
  lastSequence: number
  failedStarts: number
  retryAt: number
}

/** Maintains authorized site-local/virtual Shelly read-only worker sessions.
 * No device onboarding, relay commands or automatic approval is performed here.
 */
export class ShellyRemoteObserverSupervisor {
  private readonly logger = new Logger(ShellyRemoteObserverSupervisor.name)
  private remoteAssignmentRefreshAt = 0
  private refreshingRemoteAssignments = false
  private readonly remoteShellyObservers = new Map<string, RemoteShellyObserverState>()

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly routes: ShellyRouteResolver,
    private readonly lanDiscovery?: DeviceLanDiscoveryService,
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
    private readonly discovery?: DeviceDiscoveryMemoryStore,
  ) {}

  stop(): void {
    for (const observer of this.remoteShellyObservers.values()) observer.handle?.close()
    this.remoteShellyObservers.clear()
  }

  async refreshRemoteShellyObservers(devices: RegisteredDevice[]): Promise<void> {
    const now = Date.now()
    if (this.refreshingRemoteAssignments || now - this.remoteAssignmentRefreshAt < 15_000) return
    if (!this.lanDiscovery || !this.physicalInventory || !this.discovery) return
    this.refreshingRemoteAssignments = true
    this.remoteAssignmentRefreshAt = now
    try {
      const groups = new Map<string, {
        owner: { tenantId: string; siteId: string }
        scopeId: string
        transport: 'virtual-lab' | 'site-local-ssh'
        siteLocalObserver?: AuthorizedSiteLocalObserver
        assignments: Map<string, AuthorizedRemoteShellyStatusTarget>
        remoteTargets: Map<string, RemoteShellyStatusAssignment>
      }>()
      const candidates = devices.filter(device => ['shelly-lan', 'shelly-discovered'].includes(device.adapter.driver))
      for (const device of candidates) {
        const owner = { tenantId: device.tenantId, siteId: device.siteId }
        try {
          const target = await this.routes.resolveShellyInstallationTarget(device.id, owner)
          let transport: 'virtual-lab' | 'site-local-ssh'
          let siteLocalObserver: AuthorizedSiteLocalObserver | undefined
          if (target.zone.collectionSource === 'virtual-lab') {
            transport = 'virtual-lab'
          } else {
            if ((target.device.metadata?.siteLocalObserverId || '') === '') continue
            const observers = configuredSiteLocalObservers()
            const selection = selectAuthorizedSiteLocalObserver({ observers,
              tenantId: owner.tenantId, siteId: owner.siteId, scopeId: target.zone.id,
              physicalId: target.physicalId, component: target.component })
            if (!selection.observer || selection.observer.id !== target.device.metadata?.siteLocalObserverId) {
              throw new ConflictException(selection.observer ? 'The reconciled endpoint belongs to a different authorized observer.' : selection.reason)
            }
            siteLocalObserver = selection.observer
            if (normalizedObserverHost(hostname()) === normalizedObserverHost(siteLocalObserver.host)) continue
            if (!siteLocalObserver.sshTarget || !siteLocalObserver.interfaceName ||
                siteLocalObserver.cidr !== target.zone.cidr || !target.zone.cidr) {
              throw new ConflictException('The authorized remote observer has no explicit secure SSH execution target, interface, or matching scope.')
            }
            transport = 'site-local-ssh'
          }
          const expectedComponentKeys = target.inventory.components
            .map(component => component.key)
            .filter(component => /^switch:\d+$/.test(component))
            .sort()
          if (!expectedComponentKeys.includes(target.component)) continue
          const groupKey = `${owner.tenantId}\u0000${owner.siteId}\u0000${target.zone.id}\u0000${transport}\u0000${siteLocalObserver?.id || 'virtual-lab'}`
          const group = groups.get(groupKey) || {
            owner, scopeId: target.zone.id, transport, ...(siteLocalObserver ? { siteLocalObserver } : {}),
            assignments: new Map<string, AuthorizedRemoteShellyStatusTarget>(),
            remoteTargets: new Map<string, RemoteShellyStatusAssignment>(),
          }
          const targetKey = createHash('sha256').update(JSON.stringify([
            owner.tenantId, owner.siteId, target.zone.id, target.inventory.physicalDeviceId,
            target.physicalId, target.ipAddress, expectedComponentKeys,
          ])).digest('hex').slice(0, 32)
          const assignmentKey = createHash('sha256').update(JSON.stringify([
            targetKey, device.id, target.component,
          ])).digest('hex').slice(0, 32)
          const authorized: AuthorizedRemoteShellyStatusTarget = {
            assignmentKey, device, tenantId: owner.tenantId, siteId: owner.siteId,
            physicalId: target.physicalId, physicalInventoryId: target.inventory.physicalDeviceId,
            component: target.component, ipAddress: target.ipAddress, scopeId: target.zone.id,
            expectedComponentKeys, targetKey,
          }
          group.assignments.set(assignmentKey, authorized)
          const remoteTarget = group.remoteTargets.get(targetKey) || {
            key: targetKey, physicalId: target.physicalId, ipAddress: target.ipAddress,
            expectedComponentKeys,
            components: [],
          }
          if (!remoteTarget.components.some(item => item.assignmentKey === assignmentKey))
            remoteTarget.components.push({ assignmentKey, componentKey: target.component })
          group.remoteTargets.set(targetKey, remoteTarget)
          groups.set(groupKey, group)
        } catch (error) {
          this.logger.warn(JSON.stringify({ event: 'remote_shelly_observer_assignment', outcome: 'rejected',
            deviceId: device.id, failureCategory: safeRemoteAssignmentFailure(error) }))
        }
      }

      for (const [key, current] of this.remoteShellyObservers) {
        if (groups.has(key)) continue
        current.handle?.close()
        this.remoteShellyObservers.delete(key)
      }

      for (const [key, group] of groups) {
        const assignments = [...group.remoteTargets.values()]
          .map(target => ({ ...target, components: [...target.components].sort((a, b) => a.componentKey.localeCompare(b.componentKey)) }))
          .sort((a, b) => a.key.localeCompare(b.key))
        const configHash = JSON.stringify(assignments)
        let session = this.remoteShellyObservers.get(key)
        if (session?.handle?.isAlive()) {
          if (session.configHash !== configHash) {
            const nextMap = new Map(group.assignments)
            if (session.handle.update(assignments)) {
              session.assignmentMap = nextMap
              session.configHash = configHash
            } else {
              session.handle.close()
            }
          }
          continue
        }
        if (session && session.retryAt > now) continue
        if (!session) {
          session = {
            key, sessionId: randomUUID(), scopeId: group.scopeId, owner: group.owner,
            assignmentMap: new Map(group.assignments), configHash: '', lastSequence: 0,
            lastObservedAtByAssignmentKey: new Map(),
            failedStarts: 0, retryAt: 0,
          }
          this.remoteShellyObservers.set(key, session)
        }
        session.assignmentMap = new Map(group.assignments)
        session.scopeId = group.scopeId
        session.owner = group.owner
        session.sessionId = randomUUID()
        session.lastSequence = 0
        session.lastObservedAtByAssignmentKey.clear()
        try {
          const onMessage = (message: unknown) => this.acceptRemoteShellyMessage(session!, message)
          const onExit = (reason: 'spawn_failed' | 'runner_exited') => this.handleRemoteShellyObserverExit(session!, reason)
          const started = group.transport === 'site-local-ssh' && group.siteLocalObserver
            ? await this.lanDiscovery.startSiteLocalShellyOperationalObserver(group.scopeId, group.siteLocalObserver,
              session.sessionId, assignments, onMessage, onExit)
            : await this.lanDiscovery.startRemoteShellyOperationalObserver(
              group.scopeId, session.sessionId, assignments, onMessage, onExit)
          session.handle = started.handle
          session.observer = started.observer
          if (group.transport === 'virtual-lab' && !started.handle.update(assignments)) {
            started.handle.close()
            throw new Error('Remote observer rejected authorized assignments.')
          }
          session.configHash = configHash
          session.failedStarts = 0
          session.retryAt = 0
          this.logger.log(`[REMOTE SHELLY OBSERVER] started scope=${group.scopeId} assignments=${group.assignments.size} observer=${started.observer.id}`)
        } catch (error) {
          session.handle = undefined
          session.failedStarts += 1
          session.retryAt = now + Math.min(30_000, 1_000 * (2 ** Math.min(session.failedStarts, 5)))
          this.logger.warn(`[REMOTE SHELLY OBSERVER] start failed scope=${group.scopeId} reason=${safeRemoteObserverError(error)} retryMs=${session.retryAt - now}`)
        }
      }
    } finally {
      this.refreshingRemoteAssignments = false
    }
  }

  private handleRemoteShellyObserverExit(
    session: RemoteShellyObserverState,
    reason: 'spawn_failed' | 'runner_exited',
  ): void {
    if (this.remoteShellyObservers.get(session.key) !== session) return
    session.failedStarts += 1
    session.retryAt = Date.now() + Math.min(30_000, 1_000 * (2 ** Math.min(session.failedStarts, 5)))
    this.logger.warn(`[REMOTE SHELLY OBSERVER] stopped scope=${session.scopeId} reason=${reason} retryMs=${session.retryAt - Date.now()}`)
  }

  private acceptRemoteShellyMessage(session: RemoteShellyObserverState, message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected malformed output scope=${session.scopeId}`)
      return
    }
    const event = message as Record<string, unknown>
    if (event.schemaVersion !== 1 || !['observation', 'failure'].includes(String(event.kind)) ||
        event.observerSessionId !== session.sessionId || event.scopeId !== session.scopeId ||
        !Number.isInteger(event.sequence) || (event.sequence as number) <= session.lastSequence ||
        event.observationId !== `${session.sessionId}:${event.sequence}`) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected stale or malformed event scope=${session.scopeId}`)
      return
    }
    const assignmentKey = String(event.assignmentKey || '')
    const assignment = session.assignmentMap.get(assignmentKey)
    if (!assignment || event.targetKey !== assignment.targetKey || event.ipAddress !== assignment.ipAddress ||
        event.physicalId !== assignment.physicalId || event.componentKey !== assignment.component) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected unassigned event scope=${session.scopeId}`)
      return
    }
    session.lastSequence = event.sequence as number
    const observer = session.observer
    if (!observer) return
    if (event.kind === 'failure') {
      const checkedAt = typeof event.checkedAt === 'string' && freshRemoteTimestamp(event.checkedAt, 30_000)
        ? event.checkedAt : new Date().toISOString()
      const reason = safeRemoteFailureCode(event.reasonCode)
      this.logger.warn(JSON.stringify({ event: 'remote_shelly_operational_observation', outcome: 'observer_failure',
        deviceId: assignment.device.id, observerId: observer.id, scopeId: assignment.scopeId,
        component: assignment.component, observationId: String(event.observationId), reason, checkedAt }))
      this.registry.recordObserverReachability(assignment.device.id, {
        status: 'unreachable', checkedAt,
        endpoint: `http://${assignment.ipAddress}/rpc/Switch.GetStatus?id=${assignment.component.split(':')[1]}`,
        targetIpAddress: assignment.ipAddress, networkScopeId: assignment.scopeId,
        observer: { id: observer.id, host: observer.host, platform: observer.platform, localScopes: observer.localScopes },
        reason,
      }, { tenantId: assignment.tenantId, siteId: assignment.siteId })
      return
    }
    const status = event.body
    const identity = event.identity
    const keys = event.componentKeys
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
        (identity as Record<string, unknown>).id !== assignment.physicalId ||
        typeof (identity as Record<string, unknown>).gen !== 'number' || ((identity as Record<string, unknown>).gen as number) < 2 ||
        !Array.isArray(keys) || keys.length !== assignment.expectedComponentKeys.length ||
        [...keys].sort().some((key, index) => key !== assignment.expectedComponentKeys[index]) ||
        !freshRemoteTimestamp(String(event.observedAt || ''), 30_000)) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected identity, component, or timestamp scope=${session.scopeId} device=${assignment.device.id}`)
      return
    }
    const values = parseShellySwitchStatus(status, assignment.component)
    if (!values) {
      this.logger.warn(`[REMOTE SHELLY OBSERVER] rejected status scope=${session.scopeId} device=${assignment.device.id}`)
      return
    }
    const observedAt = String(event.observedAt)
    const observedTime = Date.parse(observedAt)
    const previousRemoteTime = session.lastObservedAtByAssignmentKey.get(assignmentKey)
    if (previousRemoteTime !== undefined && observedTime <= previousRemoteTime) return
    const current = this.registry.getDevices(true).find(device => device.id === assignment.device.id &&
      device.tenantId === assignment.tenantId && device.siteId === assignment.siteId)?.state?.observedAt
    const currentTime = current ? Date.parse(current) : Number.NaN
    if (Number.isFinite(currentTime) && Date.parse(observedAt) <= currentTime) return
    const source = `site-local-http-rpc:${observer.id}`
    const endpoint = `http://${assignment.ipAddress}/rpc/Switch.GetStatus?id=${assignment.component.split(':')[1]}`
    this.registry.ingestDeviceTelemetry({
      id: assignment.device.id, deviceId: assignment.device.id,
      tenantId: assignment.tenantId, siteId: assignment.siteId,
      displayName: assignment.device.displayName, protocol: 'http', transport: 'http', driver: 'shelly-lan',
      target: endpoint, location: assignment.device.zoneName,
      capabilities: assignment.device.capabilities.map(item => item.kind),
      values, state: { values, source, status: 'online', observedAt }, observedAt,
      observationId: String(event.observationId),
    })
    this.logger.log(JSON.stringify({ event: 'remote_shelly_operational_observation', outcome: 'submitted_to_canonical_writer',
      deviceId: assignment.device.id, observerId: observer.id, scopeId: assignment.scopeId,
      component: assignment.component, observationId: String(event.observationId), observedAt }))
    session.lastObservedAtByAssignmentKey.set(assignmentKey, observedTime)
    this.registry.recordObserverReachability(assignment.device.id, {
      status: 'reachable', checkedAt: observedAt, endpoint,
      targetIpAddress: assignment.ipAddress, networkScopeId: assignment.scopeId,
      observer: { id: observer.id, host: observer.host, platform: observer.platform, localScopes: observer.localScopes },
    }, { tenantId: assignment.tenantId, siteId: assignment.siteId })
  }

}

function freshRemoteTimestamp(value: string, maximumAgeMs: number): boolean {
  const timestamp = Date.parse(value)
  const now = Date.now()
  return Number.isFinite(timestamp) && timestamp <= now + 15_000 && now - timestamp <= maximumAgeMs
}

function safeRemoteFailureCode(value: unknown): string {
  return typeof value === 'string' && ['identity_mismatch', 'component_mismatch', 'invalid_status', 'rpc_unavailable'].includes(value)
    ? value
    : 'rpc_unavailable'
}

export function safeRemoteObserverError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'observer_error'
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)) return code
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(name) ? name : 'observer_error'
}

function safeRemoteAssignmentFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'observer_error'
  const message = error.message
  if (message.startsWith('Shelly route rejected (')) {
    const reason = /^Shelly route rejected \(([a-z0-9_]{1,80})\)\.$/.exec(message)?.[1]
    return reason ? `route_rejected_${reason}` : 'route_rejected'
  }
  if (message.includes('exact same-site physical inventory assignment')) return 'physical_inventory_assignment_mismatch'
  if (message.includes('configured installation network scope')) return 'installation_scope_not_configured'
  if (message.includes('conflicting active endpoints')) return 'active_endpoint_conflict'
  if (message.includes('active Physical Inventory association')) return 'active_endpoint_mismatch'
  if (message.includes('No reconciled active Shelly endpoint')) return 'active_endpoint_missing'
  if (message.includes('operator-reconciled site-local Shelly identity')) return 'reconciled_identity_metadata_missing'
  if (message.startsWith('No saved site-owned identity and ')) return 'saved_identity_or_component_evidence_missing'
  if (message.includes('outside the configured network scope')) return 'endpoint_out_of_scope'
  if (message.includes('belongs to a different authorized observer')) return 'observer_assignment_mismatch'
  if (message.includes('explicit secure SSH execution target')) return 'observer_transport_configuration_missing'
  if (message.includes('scope, physical ID and component allowlist')) return 'observer_assignment_unauthorized'
  if (['observer_identity_not_authorized', 'observer_component_not_authorized', 'observer_assignment_ambiguous'].includes(message)) {
    return message
  }
  return safeRemoteObserverError(error)
}
