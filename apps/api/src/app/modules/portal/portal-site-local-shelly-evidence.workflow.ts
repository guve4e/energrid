import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, Inject, ServiceUnavailableException } from '@nestjs/common'
import { DeviceDiscoveryMemoryStore } from '../devices/device-discovery-memory.store'
import type { DiscoveryOwnership } from '../devices/device-discovery-memory.store'
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service'
import { DeviceRegistryService } from '../devices/device-registry.service'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from '../devices/enrollment/device-enrollment.module'
import type { PhysicalDeviceInventoryService } from '../devices/enrollment/physical-device-inventory.service'
import { configuredSiteLocalObservers, validateSiteLocalShellyEvidence } from '../devices/site-local-shelly-evidence-intake'
import type { SiteLocalShellyEvidenceInput } from '../devices/site-local-shelly-evidence-intake'
import type { NetworkDiscoverySnapshot } from '../devices/network-discovery-snapshot'
import { shellyLanCandidates } from '../devices/adapters/inbound/shelly/shelly-lan-candidates'
import { findExactShellyInventoryAssignment } from './site-local-shelly-inventory-match'
import { registerOwnedDiscoveryCandidate, sameDiscoveryOwner } from './portal-discovery-candidate'

/**
 * Site-owned, operator-attested RPC evidence workflow. The domain registry remains
 * authoritative for matching and reconciliation; this service does not enroll,
 * authorize observations, or authorize control.
 */
@Injectable()
export class PortalSiteLocalShellyEvidenceWorkflow {
  constructor(
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    @Optional() @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  async importSiteLocalShellyEvidence(
    body: unknown,
  ) {
    const { ownership, siteName } = this.discoveryOwner()
    let observers
    try { observers = configuredSiteLocalObservers() }
    catch (error) { throw new ServiceUnavailableException(error instanceof Error ? error.message : 'Site-local observer authorization is invalid.') }
    if (!observers.length) throw new ServiceUnavailableException('No site-local discovery observers are authorized for Portal evidence intake.')
    let validated
    try {
      validated = validateSiteLocalShellyEvidence(body, {
        ownership, zones: this.lanDiscovery.getZones(), observers,
      })
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Site-local Shelly evidence was rejected.')
    }
    if (await this.discoveryMemory.getSnapshot(validated.scanId, ownership)) {
      throw new ConflictException('This immutable site-local evidence report has already been submitted.')
    }
    const device = validated.device
    const completedAt = device.discoveredAt
    const report = body as SiteLocalShellyEvidenceInput
    const startedAt = report.startedAt
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    const rawEvidence = [{
      observedAt: completedAt,
      source: 'operator_attested_site_local_shelly_rpc_report',
      scopeId: device.networkZoneId,
      evidence: {
        observerId: validated.observer.id,
        endpointIp: device.ipAddress,
        deviceId: device.id,
        identity: {
          method: report.identity.method, observedAt: report.identity.observedAt,
          id: report.identity.response.id, mac: report.identity.response.mac,
          model: report.identity.response.model || '', app: report.identity.response.app || '',
          generation: report.identity.response.gen, firmware: report.identity.response.ver || report.identity.response.fw_id || '',
        },
        components: report.components.map(item => ({ key: item.key, method: item.method, observedAt: item.observedAt,
          status: projectShellyStatusEvidence(item.response) })),
      },
    }]
    const snapshot: NetworkDiscoverySnapshot = {
      schemaVersion: 2, scanId: validated.scanId, ownership,
      startedAt, completedAt,
      collector: { id: `${validated.observer.id}/${report.observer.interfaceName}`, host: validated.observer.host,
        interfaces: [report.observer.interfaceName] },
      scopes: [{ id: device.networkZoneId, name: device.networkZoneName, cidr: validated.observer.cidr,
        complete: false, gatewayIpsObserved: [],
        collectionStages: {
          hostDiscovery: { durationMs: 0, complete: false,
            targetCount: 0, hostsReported: 0 },
          serviceEnrichment: { durationMs, complete: report.scan.serviceEnrichmentComplete === true,
            targetCount: 1, hostsReported: 1 },
        } }],
      methods: ['site_local_single_target_read_only_rpc'],
      successes: 1, failures: [], limitations: ['This report was submitted by an authenticated Portal administrator; observer content is operator-attested and was not cryptographically signed by the observer.'],
      rawEvidence, rawEvidenceOmitted: 0, endpoints: [device], topology: { relationships: [] },
    }
    await this.discoveryMemory.recordScan(completedAt, [device], ownership)
    await this.discoveryMemory.recordSnapshot(snapshot)
    if (this.physicalInventory) {
      await this.physicalInventory.discover({
        scope: ownership,
        identity: { namespace: 'mqtt:shelly-protocol-id', value: device.id },
        vendor: 'Shelly', hardwareModel: device.model,
        firmwareVersion: device.firmwareVersion,
        evidenceSource: 'operator_attested_site_local_shelly_rpc_report', observedAt: completedAt,
        components: shellyLanCandidates(device).flatMap(candidate => {
          const key = candidate.metadata?.component
          return typeof key === 'string' ? [{ key, capabilities: candidate.capabilities || [] }] : []
        }),
        endpoint: { protocol: 'http', kind: 'rpc', address: `http://${device.ipAddress}` },
      })
    }
    await this.deviceRegistry.ensureInstallationsLoaded()
    return this.buildSiteLocalShellyReview(snapshot, ownership, validated.observer.id, device, siteName, true)
  }

  async reviewSavedSiteLocalShellyEvidence(
    scanId: string,
  ) {
    const { ownership, siteName } = this.discoveryOwner()
    const snapshot = await this.discoveryMemory.getSnapshot(scanId, ownership)
    if (!snapshot || snapshot.schemaVersion < 2 || !snapshot.ownership || !sameDiscoveryOwner(snapshot.ownership, ownership)) {
      throw new NotFoundException('Site-owned RPC evidence was not found.')
    }
    const raw = snapshot.rawEvidence.find(item => item.source === 'operator_attested_site_local_shelly_rpc_report')
    const evidence = raw?.evidence as Record<string, any> | undefined
    const observerId = typeof evidence?.observerId === 'string' ? evidence.observerId : ''
    const observer = configuredSiteLocalObservers().find(item => item.id === observerId &&
      item.tenantId === ownership.tenantId && item.siteId === ownership.siteId)
    const endpointId = typeof evidence?.deviceId === 'string' ? evidence.deviceId : ''
    const endpoint = snapshot.endpoints.find(item => item.id === endpointId)
    if (!observer || !endpoint || observer.scopeId !== endpoint.networkZoneId ||
        observer.host !== snapshot.collector.host || observer.cidr !== snapshot.scopes.find(item => item.id === observer.scopeId)?.cidr ||
        !observer.expectedDeviceIds.some(id => id.toLowerCase() === endpoint.id.toLowerCase())) {
      throw new ConflictException('Saved evidence no longer matches the authorized site-local observer and network scope.')
    }
    await this.deviceRegistry.ensureInstallationsLoaded()
    return this.buildSiteLocalShellyReview(snapshot, ownership, observer.id, endpoint, siteName, false)
  }

  private async buildSiteLocalShellyReview(
    snapshot: NetworkDiscoverySnapshot,
    ownership: DiscoveryOwnership,
    observerId: string,
    device: NetworkDiscoverySnapshot['endpoints'][number],
    siteName: string,
    registerUnmatched: boolean,
  ) {
    const historicalComponents = [...new Set(this.deviceRegistry.getDevices(true).flatMap(existing =>
      existing.tenantId === ownership.tenantId && existing.siteId === ownership.siteId &&
      existing.metadata?.physicalId === device.id && typeof existing.metadata?.component === 'string' &&
      /^(?:switch|em1|cover):\d+$/.test(existing.metadata.component) &&
      !device.components?.some(current => current.component === existing.metadata?.component)
        ? [existing.metadata.component] : [],
    ))].sort()
    const reconciliationProposals: Array<Record<string, unknown>> = []
    const reconciliationConflicts: Array<Record<string, unknown>> = []
    const siteInventories = await this.physicalInventory?.list(ownership) || []
    for (const candidate of shellyLanCandidates(device)) {
      const component = String(candidate.metadata?.component || '')
      const inventory = findExactShellyInventoryAssignment(siteInventories, ownership, String(candidate.id), device.id, component)
      if (!inventory) {
        reconciliationConflicts.push({ deviceId: candidate.id, component,
          reasonCode: 'physical_inventory_assignment_unmatched',
          reason: 'No unique same-site physical inventory assignment matches this exact Shelly identity and component; no existing record was changed.' })
        continue
      }
      const match = await this.deviceRegistry.getShellyReconciliationTargetDecision(
        ownership.tenantId, ownership.siteId, String(candidate.id), device.id, component, inventory.physicalDeviceId,
      )
      if (match.matched) {
        const current = match.device
        const identityVerifiedAt = String(device.observations?.find(item => item.source === 'http_identity' &&
          item.attribute === 'identity.device_id' && item.value === device.id)?.observedAt || '')
        const componentVerifiedAt = String(device.observations?.find(item => item.source === 'site_local_http_rpc' &&
          item.attribute === 'shelly.component_status' && item.value === component)?.observedAt || '')
        reconciliationProposals.push({
          deviceId: current.id, displayName: current.displayName, room: current.zoneName,
          physicalId: device.id, component, evidenceScanId: snapshot.scanId, observerId,
          observedAt: device.discoveredAt, endpoint: device.ipAddress, model: device.model,
          firmwareVersion: device.firmwareVersion || '', physicalInventoryId: inventory.physicalDeviceId,
          identityVerifiedAt,
          componentVerifiedAt,
          evidenceFresh: isFreshSiteEvidence(identityVerifiedAt) && isFreshSiteEvidence(componentVerifiedAt),
          verifiedMeasurementFields: String(candidate.metadata?.verifiedMeasurementFields || '').split(',').filter(Boolean),
          currentIdentitySource: String(current.metadata?.identityEvidenceSource || 'unverified'),
          currentDriver: current.adapter.driver, mqttTopicRequiresOperatorBinding: true,
          reconciled: current.metadata?.siteLocalEvidenceScanId === snapshot.scanId,
        })
        continue
      }
      const sameId = this.deviceRegistry.getDevices(true).find(existing => existing.id === candidate.id)
      if (sameId) {
        const rejectionMessages: Record<string, string> = {
          logical_record_outside_site: 'A logical device with this identity exists outside the authorized site; cross-site reconciliation and duplicate candidate creation were suppressed.',
          installation_missing: 'The scoped logical device record has no durable installation record; no metadata was changed.',
          installation_scope_mismatch: 'The durable installation record does not belong to the authorized tenant and site; no metadata was changed.',
          device_not_physical: 'The existing logical record is not classified as a physical device; no metadata was changed.',
          device_not_approved: 'The existing physical device is not in an approved state; no metadata was changed.',
          physical_identity_mismatch: 'The existing record has a different protocol identity; no metadata was changed.',
          component_mismatch: 'The existing record has a different component key; no metadata was changed.',
          logical_device_id_mismatch: 'The existing logical ID does not match this physical identity and component; no metadata was changed.',
          physical_inventory_conflict: 'The logical record has a physical inventory link that conflicts with the server-validated assignment; no metadata was changed.',
          not_enrolled: 'The existing logical record is not currently enrolled; no metadata was changed.',
          logical_record_missing: 'The exact logical record was not found; no duplicate candidate was created.',
        }
        reconciliationConflicts.push({ deviceId: candidate.id, component,
          reasonCode: match.reasonCode,
          reason: rejectionMessages[match.reasonCode] || 'The existing record did not pass a reconciliation check; no metadata was changed.' })
        continue
      }
      if (registerUnmatched) {
        const projected = historicalComponents.length ? { ...candidate,
          reason: `${candidate.reason} Historical component evidence ${historicalComponents.join(', ')} conflicts with the accepted RPC profile and remains preserved for operator reconciliation.`,
          metadata: { ...candidate.metadata, historicalComponentConflicts: historicalComponents.join(','), requiresProfileReconciliation: true },
        } : candidate
        registerOwnedDiscoveryCandidate(this.deviceRegistry, projected, ownership, siteName)
      }
    }
    return { status: reconciliationProposals.length ? 'reconciliation_review_required' : 'pending_review',
      scanId: snapshot.scanId, ownership, observerId, physicalId: device.id, components: device.components,
      historicalComponentConflicts: historicalComponents, reconciliationProposals, reconciliationConflicts, snapshot }
  }

  async reconcileSiteLocalShellyComponent(
    scanId: string,
    body: { deviceId?: unknown; component?: unknown },
  ) {
    const { ownership } = this.discoveryOwner()
    if (typeof body?.deviceId !== 'string' || typeof body?.component !== 'string') {
      throw new BadRequestException('Choose an exact enrolled component from the verified evidence report.')
    }
    const snapshot = await this.discoveryMemory.getSnapshot(scanId, ownership)
    if (!snapshot || snapshot.schemaVersion < 2 || !snapshot.ownership || !sameDiscoveryOwner(snapshot.ownership, ownership)) {
      throw new NotFoundException('Site-owned RPC evidence was not found.')
    }
    const observers = configuredSiteLocalObservers()
    const raw = snapshot.rawEvidence.find(item => item.source === 'operator_attested_site_local_shelly_rpc_report')
    const evidence = raw?.evidence as Record<string, any> | undefined
    const observerId = typeof evidence?.observerId === 'string' ? evidence.observerId : ''
    const observer = observers.find(item => item.id === observerId && item.tenantId === ownership.tenantId && item.siteId === ownership.siteId);
    // The Portal submits the enrolled logical component ID (physical ID + component),
    // while Discovery Memory stores the physical endpoint under its Shelly ID.
    // Resolve only that exact supported suffix; the checks below still validate the
    // server-authorized physical identity, site, observer, scope, inventory and RPC evidence.
    const componentSuffix = `:${body.component}`
    const physicalId = /^(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/.test(body.component) &&
      body.deviceId.endsWith(componentSuffix)
      ? body.deviceId.slice(0, -componentSuffix.length)
      : ''
    if (!/^shelly[a-z0-9._-]{1,114}$/i.test(physicalId)) {
      throw new BadRequestException('The selected logical component does not map to the verified physical identity.')
    }
    const selectedEndpoint = snapshot.endpoints.find(item => item.id === physicalId)
    if (!observer || !selectedEndpoint || observer.scopeId !== selectedEndpoint.networkZoneId ||
        observer.host !== snapshot.collector.host || observer.cidr !== snapshot.scopes.find(item => item.id === observer.scopeId)?.cidr) {
      throw new BadRequestException('Evidence observer, site, and authorized network scope no longer match.')
    }
    const completedAt = Date.parse(snapshot.completedAt)
    const now = Date.now()
    if (!Number.isFinite(completedAt) || completedAt > now + 30_000) {
      throw new BadRequestException('The accepted report has an invalid completion timestamp.')
    }
    const endpoint = snapshot.endpoints.find(item => item.id === physicalId && item.networkZoneId === observer.scopeId)
    if (!endpoint || endpoint.vendor !== 'Shelly' || !observer.expectedDeviceIds.some(id => id.toLowerCase() === endpoint.id.toLowerCase())) {
      throw new BadRequestException('Evidence does not match the observer allowlist and selected physical identity.')
    }
    const candidate = shellyLanCandidates(endpoint).find(item => item.id === body.deviceId && item.metadata?.component === body.component)
    if (!candidate || candidate.metadata?.identityEvidenceSource !== 'verified_site_local_shelly_rpc' ||
        candidate.metadata?.componentEvidenceSource !== 'verified_site_local_shelly_rpc') {
      throw new BadRequestException('The selected component lacks exact read-only RPC identity and status evidence.')
    }
    const identityObserved = endpoint.observations?.find(item => item.source === 'http_identity' && item.attribute === 'identity.device_id' && item.value === endpoint.id)
    const componentObserved = endpoint.observations?.find(item => item.source === 'site_local_http_rpc' && item.attribute === 'shelly.component_status' && item.value === body.component)
    if (!identityObserved || !componentObserved ||
        !validEvidenceTimestamp(identityObserved.observedAt, completedAt) ||
        !validEvidenceTimestamp(componentObserved.observedAt, completedAt)) {
      throw new BadRequestException('Accepted report timestamps do not support this exact identity and component.')
    }
    const inventories = await this.physicalInventory?.list(ownership) || []
    const inventory = findExactShellyInventoryAssignment(inventories, ownership, String(body.deviceId), endpoint.id, String(body.component))
    if (!inventory) {
      throw new ConflictException('The exact logical component is not assigned to a matching physical inventory record in this site.')
    }
    const fields = String(candidate.metadata?.verifiedMeasurementFields || '').split(',').filter(Boolean)
    try {
      const reconciled = await this.deviceRegistry.reconcileShellyIdentityEvidence({
        tenantId: ownership.tenantId, siteId: ownership.siteId, deviceId: String(body.deviceId), physicalId: endpoint.id,
        component: String(body.component), physicalInventoryId: inventory.physicalDeviceId,
        evidenceScanId: snapshot.scanId, evidenceCompletedAt: snapshot.completedAt, observerId,
        ipAddress: endpoint.ipAddress, networkScope: `${observer.scopeId}:${observer.cidr}`,
        identityVerifiedAt: identityObserved.observedAt, componentVerifiedAt: componentObserved.observedAt,
        verifiedMeasurementFields: fields,
      })
      if (!reconciled) throw new ConflictException('No exact enrolled component exists in the authorized site; it was not enrolled or changed.')
      return { status: 'identity_evidence_reconciled', deviceId: reconciled.id,
        evidenceFreshForMeasurementApproval: isFreshSiteEvidence(identityObserved.observedAt) && isFreshSiteEvidence(componentObserved.observedAt), enrollmentChanged: false,
        measurementAuthorityChanged: false, controlAuthorityChanged: false, device: reconciled }
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error
      throw new BadRequestException(error instanceof Error ? error.message : 'Identity evidence reconciliation failed.')
    }
  }

  private discoveryOwner(): { ownership: DiscoveryOwnership; siteName: string } {
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return { ownership: { tenantId: tenant.id, siteId: site.id }, siteName: site.name }
  }
}

function validEvidenceTimestamp(value: unknown, completedAt: number): boolean {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp <= completedAt + 30_000
}

function isFreshSiteEvidence(value: string, now = Date.now()): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp <= now + 30_000 && now - timestamp <= 15 * 60_000
}

function projectShellyStatusEvidence(status: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ['id', 'output', 'state', 'apower', 'act_power', 'voltage', 'current', 'total_act_energy', 'total_act_ret_energy']) {
    const value = status[key]
    if (typeof value === 'string' && value.length <= 64 || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  for (const key of ['aenergy', 'ret_aenergy']) {
    const value = status[key]
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).total === 'number' && Number.isFinite((value as Record<string, unknown>).total)) {
      result[key] = { total: (value as Record<string, unknown>).total }
    }
  }
  const temperature = status.temperature
  if (temperature && typeof temperature === 'object' && !Array.isArray(temperature) &&
      typeof (temperature as Record<string, unknown>).tC === 'number' && Number.isFinite((temperature as Record<string, unknown>).tC)) {
    result.temperature = { tC: (temperature as Record<string, unknown>).tC }
  }
  return result
}
