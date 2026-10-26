import { Injectable } from '@nestjs/common';
import type { DeviceHealthHistoryQuery } from './device-health-history';
import { DeviceFirmwareDiagnosticsService, type FirmwareDiagnosticScope } from './device-firmware-diagnostics';
import { DeviceIntelligenceQueryService } from './device-intelligence-query.service';
import { DeviceRegistryService } from './device-registry.service';
import type { RegisteredDevice } from './device-registry.types';

export type AssistantDeviceHealthRange = '1h' | '24h' | '7d' | '30d';
export type AssistantDeviceHealthGranularity = Extract<DeviceHealthHistoryQuery['granularity'], 'raw' | 'hourly' | 'daily'>;

const RANGE_OPTIONS: Record<AssistantDeviceHealthRange, { durationMs: number; granularity: AssistantDeviceHealthGranularity }> = {
  '1h': { durationMs: 60 * 60_000, granularity: 'raw' },
  '24h': { durationMs: 24 * 60 * 60_000, granularity: 'hourly' },
  '7d': { durationMs: 7 * 24 * 60 * 60_000, granularity: 'hourly' },
  '30d': { durationMs: 30 * 24 * 60 * 60_000, granularity: 'daily' },
};

type AuthorizedTarget = {
  deviceId: string;
  physicalDeviceId: string;
  displayName: string;
  zoneName: string;
  registered: RegisteredDevice;
};

/**
 * Assistant-facing read boundary. It resolves only enrolled devices in the
 * server-provided scope, then delegates statistics and history to the existing
 * deterministic Device Health query path.
 */
@Injectable()
export class DeviceHealthAssistantQueryService {
  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly intelligence: DeviceIntelligenceQueryService,
    private readonly diagnostics: DeviceFirmwareDiagnosticsService,
  ) {}

  async read(scope: FirmwareDiagnosticScope, request: { device: string; range?: AssistantDeviceHealthRange }) {
    const query = typeof request?.device === 'string' ? request.device.trim() : '';
    const range = request?.range || '24h';
    if (!scope?.tenantId?.trim() || !scope?.siteId?.trim() || !query || query.length > 160 || !RANGE_OPTIONS[range]) {
      return { status: 'invalid_request' as const, message: 'A device name and supported time range are required.' };
    }

    const devices = await this.intelligence.listDevices(scope);
    const enrolledIds = new Set(devices.map(device => device.deviceId));
    const eligible = this.registry.getDevices().flatMap(registered => {
      if (!enrolledIds.has(registered.id) || !isAuthorizedDiagnosticDevice(registered, scope)) return [];
      const physicalDeviceId = String(registered.metadata?.physicalId || '').toLowerCase();
      return [{
        deviceId: registered.id,
        physicalDeviceId,
        displayName: registered.displayName,
        zoneName: registered.zoneName,
        registered,
      } satisfies AuthorizedTarget];
    });
    const matches = resolveTarget(eligible, query);
    if (matches.length === 0) {
      return { status: 'not_found' as const, message: 'No enrolled, approved Energrid ESP8266 matched that name in the current site.' };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous' as const,
        message: 'More than one enrolled diagnostic device matched. Ask for its room or exact device name.',
        candidates: matches.map(({ deviceId, displayName, zoneName }) => ({ deviceId, displayName, zoneName })),
      };
    }

    const target = matches[0];
    const configuredRange = RANGE_OPTIONS[range];
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const now = Date.now();
    const toMs = configuredRange.granularity === 'hourly'
      ? Math.floor(now / 3_600_000) * 3_600_000
      : configuredRange.granularity === 'daily'
        ? Math.floor(now / 86_400_000) * 86_400_000
        : now;
    const fromMs = toMs - configuredRange.durationMs;
    const historyQuery: DeviceHealthHistoryQuery = {
      deviceId: target.deviceId,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      granularity: configuredRange.granularity,
      timezone,
      limit: 200,
    };
    const [diagnostics, history, observation] = await Promise.all([
      this.diagnostics.get(scope, target.deviceId),
      this.diagnostics.queryHistory(scope, historyQuery, [{
        deviceId: target.deviceId,
        physicalDeviceId: target.physicalDeviceId,
      }]),
      this.intelligence.readObservations(scope, target.deviceId),
    ]);

    if (diagnostics && (diagnostics.tenantId !== scope.tenantId || diagnostics.siteId !== scope.siteId || diagnostics.deviceId !== target.deviceId)) {
      throw new Error('Device Health query returned an invalid diagnostic scope or device result');
    }

    const analysis = history.analysis?.devices.find(device => device.deviceId === target.deviceId);
    if (!history.analysis || history.tenantId !== scope.tenantId || history.siteId !== scope.siteId ||
        history.analysis.tenantId !== scope.tenantId || history.analysis.siteId !== scope.siteId ||
        history.analysis.devices.some(device => device.deviceId !== target.deviceId)) {
      throw new Error('Device Health query returned an invalid scope or device result');
    }
    const lastSnapshot = diagnostics?.snapshots.at(-1);
    const latestFailure = diagnostics?.collectionFailures.at(-1);

    return {
      status: analysis?.observedSampleCount || analysis?.failureCount ? 'available' as const : 'no_history' as const,
      device: {
        deviceId: target.deviceId,
        physicalDeviceId: target.physicalDeviceId,
        name: target.displayName,
        room: target.zoneName,
        tenantId: scope.tenantId,
        siteId: scope.siteId,
      },
      timeRange: {
        selected: range,
        from: history.from,
        to: history.to,
        timezone: history.analysis.timezone,
        granularity: history.granularity,
      },
      latestDiagnostic: diagnostics ? {
        lastSuccessfulContactAt: diagnostics.lastSuccessfulContactAt,
        lastSuccessfulContactAtBasis: 'server-collection-time' as const,
        lastAttemptAt: diagnostics.lastAttemptAt,
        observerCollectionStatus: diagnostics.collectionStatus,
        firmwareVersion: diagnostics.current?.firmwareVersion ?? null,
        bootSessionId: diagnostics.current?.bootSessionId ?? null,
        uptimeMs: diagnostics.current?.uptimeMs ?? null,
        reset: diagnostics.current ? {
          reason: diagnostics.current.reset.reason,
          reasonCode: diagnostics.current.reset.reasonCode,
          exceptionCause: diagnostics.current.reset.exception?.cause ?? null,
        } : null,
        wifi: diagnostics.current ? {
          connected: diagnostics.current.wifi.connected,
          rssiDbm: diagnostics.current.wifi.rssiDbm,
          disconnectCount: diagnostics.current.wifi.disconnectCount,
          reconnectCount: diagnostics.current.wifi.reconnectCount,
        } : null,
        memory: diagnostics.current?.memory ?? null,
        sensor: diagnostics.current?.sensor ?? null,
        provenance: lastSnapshot ? {
          protocol: lastSnapshot.protocol,
          method: lastSnapshot.method,
          path: lastSnapshot.path,
          collectedAt: lastSnapshot.collectedAt,
          identityVerifiedAt: lastSnapshot.identityVerifiedAt,
          deviceWallClockTimestamp: lastSnapshot.deviceObservedAt,
        } : null,
      } : null,
      measurementFreshness: {
        temperature: projectFreshness(observation?.fields.temperature),
        humidity: projectFreshness(observation?.fields.humidity),
      },
      observerReachability: {
        lastAttemptAt: diagnostics?.lastAttemptAt ?? null,
        latestRequestSucceeded: diagnostics?.collectionStatus === 'success',
        latestFailure: latestFailure ? {
          attemptedAt: latestFailure.attemptedAt,
          reason: latestFailure.reason,
          observer: latestFailure.context?.observer ?? null,
          target: latestFailure.context?.target ?? null,
        } : null,
        interpretation: 'A failed observer request does not prove the device lost power or Wi-Fi.',
      },
      history: analysis ? {
        coverage: {
          firstObservedAt: analysis.firstObservedAt,
          latestObservedAt: analysis.latestObservedAt,
          observedSampleCount: analysis.observedSampleCount,
          expectedSampleCount: analysis.expectedSampleCount,
          missingSampleCount: analysis.missingSampleCount,
          coverageRatio: analysis.coverageRatio,
          coverageBasis: analysis.coverageBasis,
        },
        metrics: analysis.metrics,
        failureCount: analysis.failureCount,
        failures: analysis.failures.slice(-20),
        bootSessionTransitions: analysis.bootSessionTransitions.slice(-20),
        resetEvidence: analysis.resetEvidence.slice(-20),
        resetEvents: analysis.resetEvents.slice(-20),
        events: analysis.events.slice(-20),
        series: history.analysis.series,
        page: history.analysis.page,
      } : null,
      evidenceLimitations: [
        'Device diagnostics are server-collected HTTP snapshots; this firmware does not timestamp its own response.',
        'An inferred boot time is an estimate from collection time minus reported uptime, not an exact reboot time.',
        'Observer timeouts are collection failures, not proof of physical device failure.',
        ...(analysis?.coverageRatio === null || analysis?.coverageRatio === undefined ? ['No diagnostic samples are available in this period.'] : []),
      ],
    };
  }
}

function isAuthorizedDiagnosticDevice(device: RegisteredDevice, scope: FirmwareDiagnosticScope): boolean {
  const physicalId = String(device.metadata?.physicalId || '').toLowerCase();
  const networkScope = String(device.metadata?.networkScope || '');
  return device.tenantId === scope.tenantId && device.siteId === scope.siteId &&
    device.kind === 'physical' && device.trustStatus === 'approved' &&
    device.adapter.driver === 'energrid-esp8266' && /^esp8266:[0-9a-f]{6}$/.test(physicalId) &&
    networkScope.length > 0 && device.id === `device:${networkScope}:${physicalId}`;
}

function resolveTarget(devices: AuthorizedTarget[], query: string): AuthorizedTarget[] {
  const normalized = normalize(query);
  const exact = devices.filter(device => normalize(device.deviceId) === normalized || normalize(device.displayName) === normalized);
  if (exact.length) return exact;
  const room = canonicalRoom(query);
  if (room) return devices.filter(device => canonicalRoom(device.zoneName) === room);
  const names = devices.filter(device => normalize(device.displayName).includes(normalized) || normalize(device.zoneName).includes(normalized));
  return names;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function canonicalRoom(value: string): string | null {
  const normalized = normalize(value);
  if (/kitchen|кухн|kuhnq|kuhnia|kuhnya/.test(normalized)) return 'kitchen';
  if (/garage|гараж/.test(normalized)) return 'garage';
  if (/boiler|котел/.test(normalized)) return 'boilerroom';
  return null;
}

function projectFreshness(field?: {
  value: number | boolean | string;
  sourceId: string;
  receivedAt: string;
  measuredAt?: string;
  ageSeconds: number | null;
  freshness: 'fresh' | 'stale' | 'invalid';
}) {
  return field ? {
    status: field.freshness,
    value: field.value,
    source: field.sourceId,
    receivedAt: field.receivedAt,
    measuredAt: field.measuredAt ?? null,
    ageSeconds: field.ageSeconds,
  } : { status: 'unavailable' as const, value: null, source: null, receivedAt: null, measuredAt: null, ageSeconds: null };
}
