import { httpPollTimeoutMs } from '../../collection/http-collection-timeout'
import { Injectable, Logger, Optional } from '@nestjs/common'
import { performance } from 'node:perf_hooks'
import { hostname, networkInterfaces } from 'node:os'
import { DeviceRegistryService } from '../../device-registry.service'
import type { NetworkDiscoveryZone, NetworkDiscoveredDevice, RegisteredDevice } from '../../device-registry.types'
import type { KnownNetworkDevice } from '../../device-discovery-memory.store'
import { DeviceDiscoveryMemoryStore } from '../../device-discovery-memory.store'
import { DeviceLanDiscoveryService } from '../../device-lan-discovery.service'
import { ApprovedMqttObservationRuntime } from '../../mqtt/approved-mqtt-observation.runtime'
import {
  ENERGRID_HTTP_OBSERVATION_SOURCE,
  ENERGRID_HTTP_STATUS_SELECTOR,
  ENERGRID_SAMPLE_CURSOR_SOURCE,
  energridFirmwareSampleEvidenceId,
  parseEnergridHttpSample,
  resolveEnrolledEnergridHttpEndpoint,
  resolveEnergridHttpEndpoint,
} from '../../adapters/inbound/energrid/energrid-http-observation.adapter'
import { parseEnergridIdentity } from '../../adapters/outbound/network/energrid-http-identity.adapter'
import { DeviceFirmwareDiagnosticsService, type FirmwareDiagnosticCollectionContext, type FirmwareDiagnosticFailureReason } from '../../device-firmware-diagnostics'
import { EnergridFirmwareDiagnosticsHttpAdapter, FirmwareDiagnosticsCollectionError } from '../../adapters/outbound/network/energrid-firmware-diagnostics-http.adapter'
import { readJsonResponse } from '../../adapters/outbound/network/read-bounded-json-response'
import { ipv4NetmaskPrefix } from '../../network/ipv4-netmask-prefix'

/** Firmware-specific identity, sampling and diagnostic reads for Energrid ESP8266.
 * Observation admission is delegated to the existing approved ingress.
 */
@Injectable()
export class EnergridEspHttpCollectionService {
  private readonly logger = new Logger(EnergridEspHttpCollectionService.name)
  private readonly firmwareDiagnosticsAdapter = new EnergridFirmwareDiagnosticsHttpAdapter()
  private readonly diagnosticsPollAt = new Map<string, number>()

  constructor(
    private readonly registry: DeviceRegistryService,
    @Optional() private readonly observations?: ApprovedMqttObservationRuntime,
    @Optional() private readonly discovery?: DeviceDiscoveryMemoryStore,
    @Optional() private readonly lanDiscovery?: DeviceLanDiscoveryService,
    @Optional() private readonly firmwareDiagnostics?: DeviceFirmwareDiagnosticsService,
  ) {}

  async pollDevice(device: RegisteredDevice): Promise<void> {
    const scope = { tenantId: device.tenantId, siteId: device.siteId }
    const physicalId = String(device.metadata?.physicalId || '').toLowerCase()
    let collectionContext: FirmwareDiagnosticCollectionContext | undefined
    if (!scope.tenantId || !scope.siteId || !physicalId || !this.discovery || !this.observations) {
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=trusted_http_ingress_unavailable`)
      return
    }
    const diagnosticsDue = this.claimDiagnosticsCollection(scope, device.id)
    const recordFailure = (reason: FirmwareDiagnosticFailureReason) => diagnosticsDue
      ? this.recordFirmwareDiagnosticsFailure(scope, device.id, physicalId, reason, collectionContext)
      : Promise.resolve()

    let records: KnownNetworkDevice[]
    try {
      records = await this.discovery.listIdentityEvidence(scope)
    } catch {
      this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'unknown', observedAt: new Date().toISOString() })
      await recordFailure('endpoint_unverified')
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=trusted_identity_evidence_unavailable`)
      return
    }
    const networkScope = String(device.metadata?.networkScope || '')
    // The last selected/scanned scope is transient UI state. Resolve every
    // installation against its configured scope so a Lab scan cannot hide a
    // Home endpoint (or vice versa) from the scheduled poller.
    const scannedZones = this.lanDiscovery?.getZones() || []
    const configuredZone = this.lanDiscovery?.getConfiguredZone?.(networkScope) ||
      scannedZones.find(zone => zone.id === networkScope)
    const endpointZones = configuredZone ? [configuredZone] : scannedZones
    // Discovery Memory may be absent (for example, a legacy installation
    // whose scan history is intentionally unscoped). Revalidate only the
    // enrolled installation's saved target within its configured zone; this
    // candidate is not trusted until its exact firmware identity is checked.
    const endpoint = resolveEnergridHttpEndpoint(device, records, endpointZones) ||
      resolveEnrolledEnergridHttpEndpoint(device, endpointZones)
    if (!endpoint) {
      this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'unknown', observedAt: new Date().toISOString() })
      await recordFailure('endpoint_unverified')
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=verified_endpoint_missing_or_out_of_scope`)
      return
    }
    collectionContext = buildFirmwareDiagnosticCollectionContext(
      endpoint.identityUrl,
      endpoint.record.device.ipAddress,
      configuredZone || scannedZones.find(zone => zone.id === networkScope),
    )
    const recordObserverReachability = (status: 'reachable' | 'unreachable', reason?: string) => {
      if (!collectionContext || typeof this.registry.recordObserverReachability !== 'function') return
      this.registry.recordObserverReachability(device.id, {
        status,
        checkedAt: new Date().toISOString(),
        endpoint: collectionContext.target.endpoint,
        targetIpAddress: collectionContext.target.ipAddress,
        networkScopeId: collectionContext.target.networkScopeId,
        observer: collectionContext.observer,
        ...(reason ? { reason } : {}),
      }, { tenantId: device.tenantId, siteId: device.siteId })
    }

    const virtualLabPoll = configuredZone?.collectionSource === 'virtual-lab'
    if (virtualLabPoll) {
      try {
        const configuredTarget = new URL(device.adapter.target!)
        if (configuredTarget.protocol !== 'http:' || (configuredTarget.port && configuredTarget.port !== '80')) {
          throw new Error('virtual_lab_target_not_configured')
        }
      } catch {
        this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'unknown', observedAt: new Date().toISOString() })
        await recordFailure('scope_rejected')
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=virtual_lab_target_not_configured`)
        return
      }
    }

    const controller = new AbortController()
    // The fixed remote reader includes Docker/SSH startup as well as two
    // bounded GETs, while local Home sensors keep their existing HTTP timeout.
    const timeout = setTimeout(() => controller.abort(), virtualLabPoll ? 12_000 : httpPollTimeoutMs())
    let phase: 'identity' | 'status' | 'observation' = 'identity'
    let targetResponded = false
    try {
      const virtualEvidence = virtualLabPoll
        ? await this.lanDiscovery!.readVirtualLabEnergridHttpEvidence(
          networkScope, endpoint.record.device.ipAddress, physicalId, controller.signal,
        )
        : null
      let identityPayload: unknown
      if (virtualEvidence) {
        targetResponded = true
        recordObserverReachability('reachable', 'http_response')
        if (virtualEvidence.identity.status >= 300 && virtualEvidence.identity.status < 400) throw new Error('identity_redirect_rejected')
        if (virtualEvidence.identity.status !== 200) throw new Error(`identity_http_${virtualEvidence.identity.status}`)
        identityPayload = virtualEvidence.identity.body
      } else {
        const identityResponse = await fetch(endpoint.identityUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        })
        targetResponded = true
        recordObserverReachability('reachable', 'http_response')
        if (identityResponse.status >= 300 && identityResponse.status < 400) throw new Error('identity_redirect_rejected')
        if (!identityResponse.ok) throw new Error(`identity_http_${identityResponse.status}`)
        identityPayload = await readJsonResponse(identityResponse, 4 * 1024)
      }
      const identity = parseEnergridIdentity(identityPayload)
      if (!identity) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'unknown', observedAt: new Date().toISOString() })
        await recordFailure('identity_request_failed')
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=invalid_firmware_identity_response`)
        return
      }
      if (identity.id !== physicalId) {
        // The endpoint answered, but it is not the enrolled physical device.
        // Keep device reachability unknown instead of labeling it offline or
        // allowing the reused address to supply measurements.
        this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'unknown', observedAt: new Date().toISOString() })
        await recordFailure('identity_mismatch')
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=firmware_identity_mismatch`)
        return
      }
      if (endpoint.renewalDue) {
        const observedAt = new Date().toISOString()
        const refreshed: NetworkDiscoveredDevice = {
          ...endpoint.record.device,
          id: identity.id,
          vendor: 'Energrid',
          model: identity.model,
          firmwareVersion: identity.firmwareVersion,
          protocol: 'http',
          confidence: 0.95,
          status: 'online',
          discoveredAt: observedAt,
          reason: 'Energrid firmware identity was re-verified by the bounded HTTP poller.',
          observations: [
            ...(endpoint.record.device.observations || []),
            { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'identity.device_id', value: identity.id, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'device.model', value: identity.model, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            { source: 'http_identity', attribute: 'firmware.version', value: identity.firmwareVersion, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' },
            ...identity.capabilities.map(capability => ({ source: 'http_identity' as const, attribute: 'device.capability', value: capability, observedAt, scopeId: device.metadata?.networkScope as string, method: 'GET /api/v1/identity' })),
          ],
        }
        try {
          await this.discovery!.recordIdentityObservation(observedAt, refreshed, scope)
          this.logger.log(`[DEVICE HTTP POLL] ${device.id} identity_refreshed scope=${device.metadata?.networkScope} observedAt=${observedAt}`)
        } catch {
          throw new Error('identity_evidence_persistence_failed')
        }
      }
      this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'online', observedAt: new Date().toISOString() })
      if (diagnosticsDue) await this.pollFirmwareDiagnostics(device, endpoint.identityUrl, physicalId, scope)

      phase = 'status'
      let payload: unknown
      if (virtualEvidence) {
        if (!virtualEvidence.status) throw new Error('status_not_requested_identity_mismatch')
        if (virtualEvidence.status.status >= 300 && virtualEvidence.status.status < 400) throw new Error('status_http_redirect_rejected')
        if (virtualEvidence.status.status !== 200) throw new Error(`status_http_${virtualEvidence.status.status}`)
        payload = virtualEvidence.status.body
      } else {
        const statusResponse = await fetch(endpoint.statusUrl, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        })
        if (!statusResponse.ok) throw new Error(`status_http_${statusResponse.status}`)
        payload = await readJsonResponse(statusResponse)
      }
      const parsed = parseEnergridHttpSample(payload, physicalId)
      if (!parsed.accepted) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, tenantId: device.tenantId, siteId: device.siteId, status: 'online', observedAt: new Date().toISOString() })
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${parsed.reason}`)
        return
      }

      phase = 'observation'
      const evidenceId = parsed.sample.sampleId
        ? energridFirmwareSampleEvidenceId(physicalId, parsed.sample.sampleId)
        : await this.observations.sourceSampleEvidenceId(
          scope, device.id, ENERGRID_SAMPLE_CURSOR_SOURCE, parsed.sample.counters,
        )
      if (!evidenceId) {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=observation_store_unavailable`)
        return
      }
      const result = await this.observations.ingestHttpObservation({
        scope,
        deviceId: device.id,
        sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
        selector: ENERGRID_HTTP_STATUS_SELECTOR,
        payload: parsed.sample.values,
        evidenceId,
      })
      if (result.outcome === 'processed') {
        this.logger.log(`[DEVICE HTTP POLL] ${device.id} ${result.accepted ? 'accepted' : 'rejected'} stage=${result.stage} reason=${result.reason} fields=${result.updatedKeys.join(',') || '-'} rejectedFields=${result.rejectedFields.join(',') || '-'}`)
      } else {
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${result.reasonCode}`)
      }
    } catch (error) {
      const transportFailure = error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError)
      if (transportFailure && !targetResponded) {
        recordObserverReachability('unreachable', error instanceof Error && error.name === 'AbortError' ? 'request_timeout' : 'request_failed')
      }
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'request_timeout'
        : error instanceof Error && /^((identity|status)_http_\d+|response_too_large|invalid_response_json|source_sample_session_ambiguous|identity_evidence_persistence_failed|identity_redirect_rejected)$/.test(error.message)
          ? error.message
          : phase === 'observation' ? 'observation_ingress_failed'
            : phase === 'identity' ? 'identity_request_failed'
              : 'request_failed'
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${reason}`)
      if (phase === 'identity') {
        await recordFailure(reason === 'request_timeout' ? 'request_timeout' : 'identity_request_failed')
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async pollFirmwareDiagnostics(
    device: RegisteredDevice,
    verifiedIdentityUrl: string,
    physicalId: string,
    scope: { tenantId: string; siteId: string },
  ): Promise<void> {
    if (!this.firmwareDiagnostics) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs());
    try {
      const sample = await this.firmwareDiagnosticsAdapter.collect(verifiedIdentityUrl, physicalId, controller.signal);
      const view = await this.firmwareDiagnostics.record(scope, device.id, physicalId, sample);
      this.logger.log(`[DEVICE FIRMWARE DIAGNOSTICS] ${device.id} recorded boot=${sample.bootSessionId} uptimeMs=${sample.uptimeMs} restartCount10m=${view.restartCount10m}`);
    } catch (error) {
      const reason = error instanceof FirmwareDiagnosticsCollectionError ? error.reason : 'collector_error';
      const networkScope = String(device.metadata?.networkScope || '');
      const zone = this.lanDiscovery?.getConfiguredZone?.(networkScope) ||
        this.lanDiscovery?.getZones().find(item => item.id === networkScope);
      const diagnosticsEndpoint = `${new URL(verifiedIdentityUrl).origin}/api/v1/diagnostics`;
      const context = buildFirmwareDiagnosticCollectionContext(
        diagnosticsEndpoint,
        new URL(verifiedIdentityUrl).hostname,
        zone,
      );
      await this.recordFirmwareDiagnosticsFailure(scope, device.id, physicalId, reason, context);
      this.logger.warn(`[DEVICE FIRMWARE DIAGNOSTICS] ${device.id} skipped reason=${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private claimDiagnosticsCollection(scope: { tenantId: string; siteId: string }, deviceId: string): boolean {
    const key = `${scope.tenantId}\0${scope.siteId}\0${deviceId}`;
    const now = performance.now();
    const lastPoll = this.diagnosticsPollAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - lastPoll < firmwareDiagnosticsIntervalMs()) return false;
    if (!this.diagnosticsPollAt.has(key) && this.diagnosticsPollAt.size >= 512) {
      const oldest = this.diagnosticsPollAt.keys().next().value;
      if (oldest) this.diagnosticsPollAt.delete(oldest);
    }
    this.diagnosticsPollAt.set(key, now);
    return true;
  }

  private async recordFirmwareDiagnosticsFailure(
    scope: { tenantId: string; siteId: string },
    deviceId: string,
    physicalId: string,
    reason: FirmwareDiagnosticFailureReason,
    context?: FirmwareDiagnosticCollectionContext,
  ): Promise<void> {
    if (!this.firmwareDiagnostics) return;
    try {
      await this.firmwareDiagnostics.recordFailure(scope, deviceId, physicalId, reason, new Date().toISOString(), context);
    } catch {
      this.logger.warn(`[DEVICE FIRMWARE DIAGNOSTICS] ${deviceId} failure_record_unavailable`);
    }
  }
}

export function buildFirmwareDiagnosticCollectionContext(
  endpointUrl: string,
  ipAddress: string,
  zone: NetworkDiscoveryZone | undefined,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  observerHost = hostname(),
  observerPlatform = process.platform,
): FirmwareDiagnosticCollectionContext {
  const localScopes = Object.entries(interfaces).flatMap(([interfaceName, addresses]) =>
    (addresses || []).flatMap(address => {
      if (address.internal || address.family !== 'IPv4') return []
      const prefix = ipv4NetmaskPrefix(address.netmask)
      if (prefix === null) return []
      return [{ interfaceName: interfaceName.slice(0, 64), cidr: `${address.address}/${prefix}`, address: address.address }]
    }),
  ).slice(0, 32)
  let endpoint = ipAddress
  try {
    const url = new URL(endpointUrl);
    endpoint = `${url.origin}${url.pathname}`;
  } catch { /* Keep the verified endpoint IP only. */ }
  return {
    observer: {
      id: `${observerHost}/${observerPlatform}`,
      host: observerHost.slice(0, 128),
      platform: observerPlatform.slice(0, 32),
      localScopes,
    },
    target: {
      endpoint,
      ipAddress,
      networkScopeId: zone?.id || '',
      networkScopeName: zone?.name || '',
    },
  }
}



function firmwareDiagnosticsIntervalMs(): number {
  const configured = Number(process.env.HOME_FIRMWARE_DIAGNOSTICS_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 15_000 && configured <= 15 * 60_000 ? configured : 60_000;
}
