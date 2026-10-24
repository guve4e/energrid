import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { DeviceRegistryService } from './device-registry.service'
import type { RegisteredDevice } from './device-registry.types'
import type { NetworkDiscoveredDevice } from './device-registry.types'
import type { KnownNetworkDevice } from './device-discovery-memory.store'
import { DeviceDiscoveryMemoryStore } from './device-discovery-memory.store'
import { DeviceLanDiscoveryService } from './device-lan-discovery.service'
import { ApprovedMqttObservationRuntime } from './mqtt/approved-mqtt-observation.runtime'
import {
  ENERGRID_HTTP_OBSERVATION_SOURCE,
  ENERGRID_HTTP_STATUS_SELECTOR,
  parseEnergridHttpSample,
  resolveEnergridHttpEndpoint,
} from './adapters/inbound/energrid/energrid-http-observation.adapter'
import { parseEnergridIdentity } from './adapters/outbound/network/energrid-http-identity.adapter'
import { DeviceFirmwareDiagnosticsService, parseFirmwareDiagnosticSample } from './device-firmware-diagnostics'
import { performance } from 'node:perf_hooks'

@Injectable()
export class DeviceHttpPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceHttpPollService.name)
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private readonly diagnosticsPollAt = new Map<string, number>()

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly observations?: ApprovedMqttObservationRuntime,
    private readonly discovery?: DeviceDiscoveryMemoryStore,
    private readonly lanDiscovery?: DeviceLanDiscoveryService,
    private readonly firmwareDiagnostics?: DeviceFirmwareDiagnosticsService,
  ) {}

  onModuleInit(): void {
    if (!httpPollingEnabled()) return

    const intervalMs = httpPollIntervalMs()
    this.logger.log(`[DEVICE HTTP POLL] enabled interval=${intervalMs}ms`)
    void this.pollOnce()
    this.timer = setInterval(() => void this.pollOnce(), intervalMs)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true

    try {
      const devices = this.registry
        .getDevices()
        .filter((device) => device.trustStatus === 'approved')
        // Energrid's adapter stays unconfigured until observation approval.
        // Its persisted installation binding is checked by trusted ingress.
        .filter((device) => device.adapter.configured || device.adapter.driver === 'energrid-esp8266')
        .filter((device) => device.adapter.protocol === 'http')
        .filter((device) => isHttpTarget(device.adapter.target))

      await Promise.all(devices.map((device) => this.pollDevice(device)))
    } finally {
      this.polling = false
    }
  }

  private async pollDevice(device: RegisteredDevice): Promise<void> {
    if (device.adapter.driver === 'energrid-esp8266') {
      await this.pollEnergridDevice(device)
      return
    }

    const target = device.adapter.target
    if (!isHttpTarget(target)) return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs())

    try {
      const startedAt = Date.now()
      const response = await fetch(target, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        this.registry.ingestDeviceStatus({
          deviceId: device.id,
          status: 'offline',
          observedAt: new Date().toISOString(),
        })
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} status=${response.status}`)
        return
      }

      const json = await response.json()
      const values = normalizeHttpValues(json)
      this.registry.ingestDeviceTelemetry({
        deviceId: device.id,
        name: device.displayName,
        protocol: 'http',
        transport: 'http',
        driver: device.adapter.driver,
        target,
        location: device.zoneName,
        capabilities: device.capabilities.map((capability) => capability.kind),
        values,
        state: {
          values,
          source: 'http-poll',
          status: 'online',
        },
        observedAt: new Date().toISOString(),
      })
      this.logger.log(`[DEVICE HTTP POLL] ${device.id} ${Date.now() - startedAt}ms`)
    } catch (error) {
      this.registry.ingestDeviceStatus({
        deviceId: device.id,
        status: 'offline',
        observedAt: new Date().toISOString(),
      })
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} ${error instanceof Error ? error.message : 'failed'}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async pollEnergridDevice(device: RegisteredDevice): Promise<void> {
    const scope = { tenantId: device.tenantId, siteId: device.siteId }
    const physicalId = String(device.metadata?.physicalId || '').toLowerCase()
    if (!scope.tenantId || !scope.siteId || !physicalId || !this.discovery || !this.observations) {
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=trusted_http_ingress_unavailable`)
      return
    }

    let records: KnownNetworkDevice[]
    try {
      records = await this.discovery.listIdentityEvidence()
    } catch {
      this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=trusted_identity_evidence_unavailable`)
      return
    }
    const endpoint = resolveEnergridHttpEndpoint(device, records, this.lanDiscovery?.getZones() || [])
    if (!endpoint) {
      this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'unknown', observedAt: new Date().toISOString() })
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=verified_endpoint_missing_or_out_of_scope`)
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs())
    let phase: 'identity' | 'status' | 'observation' = 'identity'
    try {
      const identityResponse = await fetch(endpoint.identityUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      })
      if (identityResponse.status >= 300 && identityResponse.status < 400) throw new Error('identity_redirect_rejected')
      if (!identityResponse.ok) throw new Error(`identity_http_${identityResponse.status}`)
      const identityPayload: unknown = await readJsonResponse(identityResponse, 4 * 1024)
      const identity = parseEnergridIdentity(identityPayload)
      if (!identity) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'offline', observedAt: new Date().toISOString() })
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=invalid_firmware_identity_response`)
        return
      }
      if (identity.id !== physicalId) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'offline', observedAt: new Date().toISOString() })
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
          await this.discovery!.recordIdentityObservation(observedAt, refreshed)
          this.logger.log(`[DEVICE HTTP POLL] ${device.id} identity_refreshed scope=${device.metadata?.networkScope} observedAt=${observedAt}`)
        } catch {
          throw new Error('identity_evidence_persistence_failed')
        }
      }
      this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'online', observedAt: new Date().toISOString() })

      phase = 'status'
      const statusResponse = await fetch(endpoint.statusUrl, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      })
      if (!statusResponse.ok) throw new Error(`status_http_${statusResponse.status}`)
      const payload: unknown = await readJsonResponse(statusResponse)
      const parsed = parseEnergridHttpSample(payload, physicalId)
      if (!parsed.accepted) {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'online', observedAt: new Date().toISOString() })
        this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${parsed.reason}`)
        await this.pollFirmwareDiagnostics(device, endpoint.identityUrl, physicalId, scope)
        return
      }

      phase = 'observation'
      const evidenceId = await this.observations.sourceSampleEvidenceId(
        scope, device.id, ENERGRID_HTTP_OBSERVATION_SOURCE, parsed.sample.counters,
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
      await this.pollFirmwareDiagnostics(device, endpoint.identityUrl, physicalId, scope)
    } catch (error) {
      if (phase !== 'observation') {
        this.registry.ingestDeviceStatus({ deviceId: device.id, status: 'offline', observedAt: new Date().toISOString() })
      }
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'request_timeout'
        : error instanceof Error && /^((identity|status)_http_\d+|response_too_large|invalid_response_json|source_sample_session_ambiguous|identity_evidence_persistence_failed|identity_redirect_rejected)$/.test(error.message)
          ? error.message
          : phase === 'observation' ? 'observation_ingress_failed'
            : phase === 'identity' ? 'identity_request_failed'
              : 'request_failed'
      this.logger.warn(`[DEVICE HTTP POLL] ${device.id} rejected reason=${reason}`)
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
    const now = performance.now();
    const lastPoll = this.diagnosticsPollAt.get(device.id) ?? Number.NEGATIVE_INFINITY;
    if (now - lastPoll < firmwareDiagnosticsIntervalMs()) return;
    this.diagnosticsPollAt.set(device.id, now);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpPollTimeoutMs());
    try {
      const url = new URL('/api/v1/diagnostics', verifiedIdentityUrl).toString();
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      });
      if (response.status >= 300 && response.status < 400) throw new Error('diagnostics_redirect_rejected');
      if (!response.ok) throw new Error(`diagnostics_http_${response.status}`);
      const sample = parseFirmwareDiagnosticSample(await readJsonResponse(response, 4 * 1024), physicalId);
      if (!sample) throw new Error('invalid_or_mismatched_diagnostics_identity');
      const view = await this.firmwareDiagnostics.record(scope, device.id, physicalId, sample);
      this.logger.log(`[DEVICE FIRMWARE DIAGNOSTICS] ${device.id} recorded boot=${sample.bootSessionId} uptimeMs=${sample.uptimeMs} restartCount10m=${view.restartCount10m}`);
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'request_timeout'
        : error instanceof Error && /^(diagnostics_http_\d+|diagnostics_redirect_rejected|response_too_large|invalid_response_json|invalid_or_mismatched_diagnostics_identity)$/.test(error.message)
          ? error.message
          : 'diagnostics_unavailable';
      this.logger.warn(`[DEVICE FIRMWARE DIAGNOSTICS] ${device.id} skipped reason=${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readJsonResponse(response: Response, maxBytes = 16 * 1024): Promise<unknown> {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('response_too_large')
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('response_too_large')
      }
      chunks.push(value)
    }
    return parseJson(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'))
  }
  if (typeof response.text === 'function') return parseJson(await response.text())
  return response.json()
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body) as unknown } catch { throw new Error('invalid_response_json') }
}

function normalizeHttpValues(payload: unknown): Record<string, number | boolean | string | null> {
  if (!payload || typeof payload !== 'object') return {}

  const raw = payload as Record<string, unknown>
  const source =
    raw.values && typeof raw.values === 'object'
      ? (raw.values as Record<string, unknown>)
      : raw
  const values: Record<string, number | boolean | string | null> = {}

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' || value === null) {
      values[key] = value
    } else if (value && typeof value === 'object' && 'value' in value) {
      const nested = (value as { value?: unknown }).value
      if (typeof nested === 'number' || typeof nested === 'boolean' || typeof nested === 'string' || nested === null) {
        values[key] = nested
      }
    }
  }

  return values
}

function isHttpTarget(value: string | undefined): value is string {
  return !!value && /^https?:\/\//.test(value)
}

function httpPollingEnabled(): boolean {
  return ['1', 'true', 'yes'].includes(String(process.env.HOME_HTTP_POLL_ENABLED).toLowerCase())
}

function httpPollIntervalMs(): number {
  const configured = Number(process.env.HOME_HTTP_POLL_INTERVAL_MS)
  return Number.isFinite(configured) && configured >= 500 ? configured : 5000
}

function httpPollTimeoutMs(): number {
  const configured = Number(process.env.HOME_HTTP_POLL_TIMEOUT_MS)
  return Number.isFinite(configured) && configured >= 250 ? configured : 2000
}

function firmwareDiagnosticsIntervalMs(): number {
  const configured = Number(process.env.HOME_FIRMWARE_DIAGNOSTICS_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 15_000 && configured <= 15 * 60_000 ? configured : 60_000;
}
