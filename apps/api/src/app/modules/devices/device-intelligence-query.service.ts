import {
  resolveDeviceTarget,
  type DeviceTargetRequest,
} from './device-intelligence-target-resolver';
import { randomUUID } from 'node:crypto';
import { Inject, Optional } from '@nestjs/common';
import { DEVICE_ENROLLMENT_SERVICE } from './enrollment/device-enrollment.module';
import { Injectable } from '@nestjs/common';
import { AuthorizedDeviceObservationReader } from './device-intelligence-observation-reader';
import { resolveInstallationObservationAuthority } from './device-observation-installation-authority';
import {
  projectAuthorizedObservations,
  observationFreshnessLimitSeconds,
  type IntelligenceObservationResult,
} from './device-intelligence-observation';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceInstallationStore } from './device-installation.store';
import { DeviceEnrollmentService } from './enrollment/device-enrollment.service';
import { canonicalUtcInstant, CORE_MEASUREMENT_DEFINITIONS } from '@energrid/domain-telemetry';
import { PostgresGenericMeasurementRepository } from '../telemetry/generic-measurements/postgres-generic-measurement.repository';
import { TELEMETRY_CONFIG, type TelemetryConfig } from '../telemetry/telemetry.config';
import {
  DEFAULT_MAX_POWER_INTEGRATION_INTERVAL_MS,
  estimatePowerEnergy,
} from './power-energy-estimate';

export interface IntelligenceScope {
  tenantId: string;
  siteId: string;
}

export interface IntelligenceDeviceDescription {
  deviceId: string;
  displayName: string;
  capabilities: unknown[];
  assistantEnabled: boolean;
}

export interface MeasurementSourceBinding {
  sourceId: string;
  fields: readonly string[];
}

@Injectable()
export class DeviceIntelligenceQueryService {
  private readonly installationDecisionsInProgress = new Set<string>();
  private readonly maximumIntegratedPowerIntervalMs: number;

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly installations: DeviceInstallationStore,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
    private readonly observationReader: AuthorizedDeviceObservationReader,
    @Optional() @Inject(PostgresGenericMeasurementRepository)
    private readonly measurementHistory: PostgresGenericMeasurementRepository | null = null,
    @Optional() @Inject(TELEMETRY_CONFIG)
    telemetryConfig: TelemetryConfig | null = null,
  ) {
    // Use the configured heartbeat when stricter, capped at the generic power
    // writer's current five-minute default. This is an integration limit, not
    // the chart's visual gap rule, and config cannot loosen it.
    this.maximumIntegratedPowerIntervalMs = Math.min(
      telemetryConfig?.historyPolicies?.power?.maxHeartbeatMs ??
        DEFAULT_MAX_POWER_INTEGRATION_INTERVAL_MS,
      DEFAULT_MAX_POWER_INTEGRATION_INTERVAL_MS,
    );
  }

  async listDevices(
    scope: IntelligenceScope,
  ): Promise<IntelligenceDeviceDescription[]> {
    if (!scope.tenantId?.trim() || !scope.siteId?.trim()) {
      throw new Error('Tenant and site are required');
    }

    await this.registry.ensureInstallationsLoaded();

    const result: IntelligenceDeviceDescription[] = [];

    for (const device of this.registry.getDevices()) {
      if (
        device.tenantId !== scope.tenantId ||
        device.siteId !== scope.siteId ||
        device.kind !== 'physical' ||
        device.trustStatus !== 'approved'
      ) continue;

      const installation = await this.installations.get(
        scope,
        device.id,
      );

      if (
        !installation ||
        installation.schemaVersion !== 1 ||
        installation.device.id !== device.id ||
        installation.device.tenantId !== scope.tenantId ||
        installation.device.siteId !== scope.siteId ||
        installation.device.trustStatus !== 'approved'
      ) continue;

      const enrolled = await this.enrollment.find({
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        deviceId: device.id,
      });

      if (!enrolled || enrolled.status !== 'enrolled') continue;

      result.push({
        deviceId: device.id,
        displayName: device.displayName,
        capabilities: Array.isArray(device.capabilities)
          ? device.capabilities
          : [],
        assistantEnabled: device.assistantEnabled === true,
      });
    }

    return result.sort((a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.deviceId.localeCompare(b.deviceId)
    );
  }

  /**
   * Resolve a device using approved installations and durable enrollment.
   *
   * A resolved identity is NOT permission to execute a command.
   * Core must revalidate permissions immediately before execution.
   */
  async resolveTarget(
    scope: { tenantId: string; siteId: string },
    request: DeviceTargetRequest,
  ) {
    if (!scope.tenantId?.trim() || !scope.siteId?.trim()) {
      return { status: 'not_found' as const };
    }

    const installations = await this.installations.list(scope);

    const scoped = installations.filter(record =>
      record.device.tenantId === scope.tenantId &&
      record.device.siteId === scope.siteId
    );

    const enrollmentResults = await Promise.all(
      scoped.map(async record => ({
        deviceId: record.device.id,
        enrollment: await this.enrollment.find({
          tenantId: scope.tenantId,
          siteId: scope.siteId,
          deviceId: record.device.id,
        }),
      }))
    );

    const enrolledIds = new Set(
      enrollmentResults
        .filter(result => result.enrollment?.status === 'enrolled')
        .map(result => result.deviceId)
    );

    return resolveDeviceTarget(
      scoped,
      enrolledIds,
      scope,
      request,
    );
  }

  /**
   * Read-only proposal for an existing enrolled installation.
   *
   * Configuration authority is separate from assistant control
   * permission. This method never writes device state.
   */
  async proposeInstallationChange(
    scope: { tenantId: string; siteId: string },
    request: {
      device: string;
      displayName: string;
      zoneName: string;
      loadType?: 'lighting';
    },
  ) {
    if (!scope.tenantId?.trim() || !scope.siteId?.trim())
      return { status: 'invalid_scope' as const };

    const identifier = request.device?.trim().toLowerCase();
    const displayName = request.displayName?.trim();
    const zoneName = request.zoneName?.trim();

    if (
      !identifier || identifier.length > 160 ||
      !displayName || displayName.length > 100 ||
      !zoneName || zoneName.length > 80 ||
      (request.loadType !== undefined &&
        request.loadType !== 'lighting')
    ) {
      return { status: 'invalid_request' as const };
    }

    const records = await this.installations.list(scope);

    const scoped = records.filter(record =>
      record.schemaVersion === 1 &&
      record.device.tenantId === scope.tenantId &&
      record.device.siteId === scope.siteId &&
      record.device.trustStatus === 'approved'
    );

    const matches = scoped.filter(record =>
      record.device.id.toLowerCase() === identifier ||
      record.device.displayName.toLowerCase() === identifier
    );

    if (matches.length === 0)
      return { status: 'not_found' as const };

    if (matches.length > 1)
      return { status: 'ambiguous' as const };

    const record = matches[0];
    const device = record.device;

    const enrollment = await this.enrollment.find({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId: device.id,
    });

    if (enrollment?.status !== 'enrolled')
      return { status: 'not_enrolled' as const };

    if (
      request.loadType === 'lighting' &&
      !device.capabilities.some(capability =>
        capability.kind === 'switch' ||
        capability.kind === 'light'
      )
    ) {
      return { status: 'capability_missing' as const };
    }

    return {
      status: 'proposal' as const,
      deviceId: device.id,
      current: {
        displayName: device.displayName,
        zoneName: device.zoneName,
        loadType: device.metadata?.loadType ?? null,
      },
      proposed: {
        displayName,
        zoneName,
        loadType: request.loadType ??
          device.metadata?.loadType ?? null,
      },
      requiresPhysicalLoadConfirmation:
        request.loadType === 'lighting',
      persisted: false,
      message:
        'Preview only. No changes saved. Physical load identification ' +
        'and authenticated approval are required before applying.',
    };
  }

  /**
   * Create a durable pending proposal.
   * This does not update the installed device.
   */
  async createInstallationProposal(
    scope: IntelligenceScope,
    request: {
      device: string;
      displayName: string;
      zoneName: string;
      loadType?: 'lighting';
    },
  ) {
    const preview = await this.proposeInstallationChange(scope, request);

    if (preview.status !== 'proposal')
      return preview;

    const installation = await this.installations.get(
      scope,
      preview.deviceId,
    );

    if (
      !installation ||
      installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId ||
      installation.device.id !== preview.deviceId ||
      installation.device.trustStatus !== 'approved'
    ) {
      return { status: 'installation_changed' as const };
    }

    const enrollment = await this.enrollment.find({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId: preview.deviceId,
    });

    if (enrollment?.status !== 'enrolled')
      return { status: 'not_enrolled' as const };

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 60 * 60 * 1000);

    const proposal = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId: preview.deviceId,
      status: 'pending' as const,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      installationUpdatedAt: installation.updatedAt,
      current: {
        ...preview.current,
        loadType:
          typeof preview.current.loadType === 'string'
            ? preview.current.loadType
            : null,
      },
      proposed: {
        ...preview.proposed,
        loadType:
          typeof preview.proposed.loadType === 'string'
            ? preview.proposed.loadType
            : null,
      },
    };

    await this.installations.saveProposal(proposal);

    return {
      ...preview,
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      expiresAt: proposal.expiresAt,
      persisted: false,
      message:
        'Pending proposal saved. Device configuration is unchanged. ' +
        'An authenticated approval and physical-load confirmation ' +
        'are required before applying.',
    };
  }

  /**
   * Apply or reject a durable installation proposal.
   * Never called directly by the LLM.
   *
   * The caller must establish authenticated installer authority.
   */
  async listInstallationProposals(
    scope: IntelligenceScope,
    deviceId: string,
  ) {
    if (
      !scope.tenantId?.trim() ||
      !scope.siteId?.trim() ||
      !deviceId?.trim()
    ) return [];

    await this.registry.ensureInstallationsLoaded();

    const matchingDevices = this.registry.getDevices().filter(device =>
      device.id === deviceId
    );

    if (
      matchingDevices.length !== 1 ||
      matchingDevices[0].tenantId !== scope.tenantId ||
      matchingDevices[0].siteId !== scope.siteId ||
      matchingDevices[0].trustStatus !== 'approved'
    ) return [];

    const enrollment = await this.enrollment.find({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId,
    });

    if (enrollment?.status !== 'enrolled') return [];

    const installation = await this.installations.get(
      scope,
      deviceId,
    );

    if (
      !installation ||
      installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId ||
      installation.device.trustStatus !== 'approved'
    ) return [];

    const proposals =
      await this.installations.listDeviceProposals(scope, deviceId);

    return proposals.filter(proposal =>
      proposal.tenantId === scope.tenantId &&
      proposal.siteId === scope.siteId &&
      proposal.deviceId === deviceId
    );
  }

  async decideInstallationProposal(
    scope: IntelligenceScope,
    proposalId: string,
    expectedDeviceId: string,
    decision: 'approve' | 'reject',
    physicalLoadConfirmed = false,
  ) {
    if (
      !scope.tenantId?.trim() ||
      !scope.siteId?.trim() ||
      !expectedDeviceId?.trim() ||
      !['approve', 'reject'].includes(decision)
    ) return { status: 'invalid_request' as const };

    const proposal = await this.installations.getProposal(
      scope,
      proposalId,
    );

    if (
      !proposal ||
      proposal.tenantId !== scope.tenantId ||
      proposal.siteId !== scope.siteId ||
      proposal.deviceId !== expectedDeviceId
    ) return { status: 'not_found' as const };

    const lockKey = `${scope.tenantId}:${scope.siteId}:${proposal.deviceId}`;

    if (this.installationDecisionsInProgress.has(lockKey))
      return { status: 'busy' as const };

    this.installationDecisionsInProgress.add(lockKey);

    try {
      const latest = await this.installations.getProposal(
        scope,
        proposalId,
      );

      if (!latest || latest.tenantId !== scope.tenantId ||
          latest.deviceId !== expectedDeviceId)
        return { status: 'not_found' as const };

      if (latest.status !== 'pending')
        return { status: 'already_decided' as const };

      if (decision === 'reject') {
        await this.installations.saveProposal({
          ...latest,
          status: 'rejected',
          decidedAt: new Date().toISOString(),
        });
        return { status: 'rejected' as const, proposalId };
      }

      const expiry = Date.parse(latest.expiresAt);
      if (!Number.isFinite(expiry) || Date.now() >= expiry)
        return { status: 'expired' as const };

      const next = latest.proposed;
      if (
        typeof next?.displayName !== 'string' ||
        !next.displayName.trim() ||
        next.displayName.length > 100 ||
        typeof next.zoneName !== 'string' ||
        !next.zoneName.trim() ||
        next.zoneName.length > 80 ||
        ![null, 'lighting'].includes(next.loadType)
      ) return { status: 'invalid_proposal' as const };

      if (
        next.loadType === 'lighting' &&
        latest.current.loadType !== 'lighting' &&
        !physicalLoadConfirmed
      ) return { status: 'physical_confirmation_required' as const };

      await this.registry.ensureInstallationsLoaded();

      // Registry updates currently address a device by ID.
      // Fail closed if an ID appears in more than one scope.
      const matches = this.registry.getDevices()
        .filter(device => device.id === expectedDeviceId);

      if (
        matches.length !== 1 ||
        matches[0].tenantId !== scope.tenantId ||
        matches[0].siteId !== scope.siteId ||
        matches[0].kind !== 'physical' ||
        matches[0].trustStatus !== 'approved'
      ) return { status: 'device_not_approved' as const };

      const enrollment = await this.enrollment.find({
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        deviceId: expectedDeviceId,
      });

      if (enrollment?.status !== 'enrolled')
        return { status: 'not_enrolled' as const };

      const installation = await this.installations.get(
        scope,
        expectedDeviceId,
      );

      if (
        !installation ||
        installation.device.tenantId !== scope.tenantId ||
        installation.device.siteId !== scope.siteId ||
        installation.device.trustStatus !== 'approved' ||
        installation.updatedAt !== latest.installationUpdatedAt ||
        installation.device.displayName !== latest.current.displayName ||
        installation.device.zoneName !== latest.current.zoneName ||
        (typeof installation.device.metadata?.loadType === 'string'
          ? installation.device.metadata.loadType
          : null) !== latest.current.loadType
      ) return { status: 'stale_proposal' as const };

      if (
        next.loadType === 'lighting' &&
        !matches[0].capabilities.some(capability =>
          capability.kind === 'switch' || capability.kind === 'light'
        )
      ) return { status: 'capability_missing' as const };

      const loadTypeChange: 'lighting' | null | undefined =
        next.loadType === latest.current.loadType
          ? undefined
          : next.loadType === 'lighting'
            ? 'lighting'
            : null;

      await this.registry.updateInstallationDetails(
        expectedDeviceId,
        next.displayName,
        next.zoneName,
        undefined,
        undefined,
        loadTypeChange,
      );

      await this.installations.saveProposal({
        ...latest,
        status: 'approved',
        decidedAt: new Date().toISOString(),
      });

      await this.registry.persistInstallationEvent(
        expectedDeviceId,
        'installation_details_saved',
        {
          proposalId,
          update: 'conversational_installation_approval',
          displayName: next.displayName,
          zoneName: next.zoneName,
          loadType: next.loadType,
          physicalLoadConfirmed,
        },
      );

      return {
        status: 'approved' as const,
        proposalId,
        deviceId: expectedDeviceId,
        applied: next,
      };
    } finally {
      this.installationDecisionsInProgress.delete(lockKey);
    }
  }

  async readObservations(
    scope: IntelligenceScope,
    deviceQuery: string,
  ): Promise<IntelligenceObservationResult | null> {
    const device = await this.describeDevice(scope, deviceQuery);
    if (!device) return null;

    // Reader is responsible for approved field/source authority.
    // Registry display state is deliberately NOT used.
    const state = await this.observationReader.read(
      scope,
      device.deviceId,
    );
    if (!state || state.deviceId !== device.deviceId) return null;

    return projectAuthorizedObservations(
      state, observationFreshnessLimitSeconds(),
    );
  }

  /** Shared, site-scoped history read used by the Portal and assistant. */
  async readAuthorizedMeasurementHistory(
    scope: IntelligenceScope,
    deviceId: string,
    metric: string,
    fromValue: string,
    toValue: string,
    limit = 1000,
  ) {
    if (!scope.tenantId?.trim() || !scope.siteId?.trim() || !deviceId?.trim() ||
        !CORE_MEASUREMENT_DEFINITIONS.some(item => item.metric === metric) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      return { status: 'invalid_request' as const };
    }
    let from: string;
    let to: string;
    try {
      from = canonicalUtcInstant(fromValue, 'from');
      to = canonicalUtcInstant(toValue, 'to');
    } catch {
      return { status: 'invalid_request' as const };
    }
    const duration = Date.parse(to) - Date.parse(from);
    if (duration <= 0 || duration > 7 * 24 * 60 * 60_000 || Date.parse(to) > Date.now() + 30_000) {
      return { status: 'invalid_request' as const };
    }

    const model = await this.readDeviceModel(scope, deviceId);
    if (!model || model.identity.id.toLowerCase() !== deviceId.toLowerCase() ||
        model.installation.status !== 'enrolled' ||
        model.installation.tenantId !== scope.tenantId ||
        model.installation.siteId !== scope.siteId) {
      return { status: 'not_found' as const };
    }
    const authorizedMetrics: readonly string[] = model.history.authorizedMetrics;
    if (!authorizedMetrics.includes(metric)) {
      return { status: 'unauthorized' as const, deviceId: model.identity.id, metric };
    }
    const authorizedSources = this.authorizedSourcesForMetric(
      model,
      metric,
    );
    if (!authorizedSources.length) {
      return { status: 'unauthorized' as const, deviceId: model.identity.id, metric };
    }
    if (!this.measurementHistory) {
      return { status: 'unavailable' as const, deviceId: model.identity.id, metric };
    }

    try {
      const measurements = await this.measurementHistory.read({
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        deviceId: model.identity.id,
        componentId: 'device',
        channel: metric,
        metric,
        from,
        to,
        limit,
        sources: authorizedSources,
      });
      return {
        status: 'available' as const,
        deviceId: model.identity.id,
        metric,
        unit: measurements[0]?.unit ?? CORE_MEASUREMENT_DEFINITIONS.find(item => item.metric === metric)!.unit,
        authorizedSources,
        measurements,
      };
    } catch {
      return { status: 'unavailable' as const, deviceId: model.identity.id, metric };
    }
  }

  /** The persisted source/field bindings are the single authority for history reads. */
  authorizedSourcesForMetric(
    model: { observationAuthorization: { bindings: readonly MeasurementSourceBinding[] } },
    metric: string,
  ): string[] {
    return [...new Set(model.observationAuthorization.bindings
      .filter(binding => binding.fields.includes(metric))
      .map(binding => binding.sourceId)
      .filter(sourceId => typeof sourceId === 'string' && sourceId.trim().length > 0))];
  }

  /**
   * Read a bounded summary from canonical accepted measurement history.
   * Installation source/field authority and enrollment are resolved from the
   * same device read model used by Portal history before PostgreSQL is queried.
   */
  async readMeasurementSummary(
    scope: IntelligenceScope,
    deviceQuery: string,
    metricQuery: string,
    rangeQuery: '1h' | '24h' | '7d' = '24h',
  ) {
    const metric = metricQuery.trim().toLowerCase();
    const definition = CORE_MEASUREMENT_DEFINITIONS.find(item => item.metric === metric);
    if (!scope.tenantId?.trim() || !scope.siteId?.trim() ||
        !deviceQuery?.trim() || deviceQuery.length > 160 || !definition ||
        !['1h', '24h', '7d'].includes(rangeQuery)) {
      return { status: 'invalid_request' as const };
    }

    const query = deviceQuery.trim().toLocaleLowerCase();
    const devices = await this.listDevices(scope);
    const exactId = devices.filter(device => device.deviceId.toLocaleLowerCase() === query);
    const exactName = exactId.length ? [] : devices.filter(device =>
      device.displayName.trim().toLocaleLowerCase() === query,
    );
    const matches = exactId.length ? exactId : exactName;
    if (!matches.length) return { status: 'not_found' as const };
    if (matches.length !== 1) return { status: 'ambiguous' as const };

    const device = matches[0];
    if (!this.measurementHistory) {
      return { status: 'unavailable' as const, deviceId: device.deviceId, metric };
    }

    const now = Date.now();
    const to = new Date(now).toISOString();
    const rangeMs = rangeQuery === '1h' ? 60 * 60_000
      : rangeQuery === '7d' ? 7 * 24 * 60 * 60_000
        : 24 * 60 * 60_000;
    const from = new Date(now - rangeMs).toISOString();
    try {
      const historyResult = await this.readAuthorizedMeasurementHistory(
        scope, device.deviceId, metric, from, to, 5000,
      );
      if (historyResult.status !== 'available') return historyResult;
      const rows = historyResult.measurements;
      const latest = await this.measurementHistory.latest({
        tenantId: scope.tenantId,
        siteId: scope.siteId,
        deviceId: device.deviceId,
        componentId: 'device',
        channel: metric,
        metric,
        sources: historyResult.authorizedSources,
      });
      const measured = rows.filter(row => row.quality === 'measured' &&
        typeof row.value === 'number' && Number.isFinite(row.value));
      const values = measured.map(row => row.value as number).sort((a, b) => a - b);
      const freshnessLimitSeconds = observationFreshnessLimitSeconds();
      const latestAgeSeconds = latest && Number.isFinite(Date.parse(latest.observedAt)) &&
        Date.parse(latest.observedAt) <= now && Date.parse(latest.receivedAt) <= now
        ? Math.floor((now - Date.parse(latest.observedAt)) / 1000)
        : null;
      const current = !latest
        ? { status: 'unavailable' as const }
        : latest.quality !== 'measured' || typeof latest.value !== 'number'
          ? { status: 'invalid' as const, value: null, unit: latest.unit,
              observedAt: latest.observedAt, receivedAt: latest.receivedAt,
              source: latest.source, provenance: latest.provenance,
              authority: 'approved' as const }
          : {
              status: latestAgeSeconds !== null && latestAgeSeconds <= freshnessLimitSeconds
                ? 'fresh' as const : latestAgeSeconds === null ? 'invalid' as const : 'stale' as const,
              value: latest.value,
              unit: latest.unit,
              observedAt: latest.observedAt,
              receivedAt: latest.receivedAt,
              source: latest.source,
              provenance: latest.provenance,
              authority: 'approved' as const,
              ageSeconds: latestAgeSeconds,
              freshnessLimitSeconds,
            };

      return {
        status: 'available' as const,
        deviceId: device.deviceId,
        displayName: device.displayName,
        metric,
        authority: 'approved' as const,
        authorizedSources: historyResult.authorizedSources,
        unit: latest?.unit ?? definition.unit,
        range: { from, to, duration: rangeQuery },
        current,
        history: {
          status: rows.length === 0 ? 'empty' as const
            : rows.length === 5000 ? 'possibly_incomplete' as const : 'available' as const,
          sampleCount: measured.length,
          invalidSampleCount: rows.length - measured.length,
          sources: [...new Set(rows.map(row => row.source))],
          coverage: {
            windowStart: from,
            windowEnd: to,
            firstObservedAt: rows[0]?.observedAt ?? null,
            lastObservedAt: rows.at(-1)?.observedAt ?? null,
            possiblyTruncated: rows.length === 5000,
          },
          ...(values.length ? {
            minimum: values[0],
            median: median(values),
            maximum: values[values.length - 1],
          } : {}),
          ...(metric === 'power' ? {
            energyEstimate: estimatePowerEnergy(
              rows, from, to, this.maximumIntegratedPowerIntervalMs,
            ),
          } : {}),
          unit: rows[0]?.unit ?? definition.unit,
        },
      };
    } catch {
      return { status: 'unavailable' as const, deviceId: device.deviceId, metric };
    }
  }

  /**
   * Canonical, read-only projection of an enrolled installation. Support,
   * observation authority, current state and command routing deliberately
   * remain separate. An empty capability declaration is reported as unknown
   * and never masks persisted observation bindings.
   */
  async readDeviceModel(scope: IntelligenceScope, deviceQuery: string) {
    const described = await this.describeDevice(scope, deviceQuery);
    if (!described) {
      const query = deviceQuery.trim().toLowerCase();
      const candidate = this.registry.getDevices().find(item =>
        item.id.toLowerCase() === query && item.tenantId === scope.tenantId &&
        item.siteId === scope.siteId && item.trustStatus === 'discovered'
      );
      if (!candidate) return null;
      const supported = candidate.supportedCapabilities ?? [];
      return {
        identity: {
          id: candidate.id,
          physicalId: typeof candidate.metadata?.physicalId === 'string'
            ? candidate.metadata.physicalId : null,
          kind: candidate.kind,
          protocol: candidate.adapter.protocol,
          adapterId: candidate.adapter.id,
          memberDeviceIds: candidate.memberDeviceIds ?? [],
        },
        installation: { tenantId: scope.tenantId, siteId: scope.siteId, displayName: candidate.displayName, zoneId: candidate.zoneId, zoneName: candidate.zoneName, status: 'not_enrolled' as const },
        capabilities: {
          supportStatus: supported.length ? 'verified' as const : 'unknown' as const,
          supported: supported.map(item => item.kind),
          evidence: candidate.discovery ? { source: candidate.discovery.source, confidence: candidate.discovery.confidence, reason: candidate.discovery.reason } : [],
        },
        observationAuthorization: { status: 'none' as const, bindings: [] },
        current: { registry: candidate.state, freshnessLimitSeconds: observationFreshnessLimitSeconds(), observations: {} },
        history: { endpoint: null, authorizedMetrics: [], availability: 'not_available' as const, streams: [] },
        commands: { executionMustBeRevalidated: true as const, available: [] },
      };
    }

    const installation = await this.installations.get(scope, described.deviceId);
    const enrollment = await this.enrollment.find({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId: described.deviceId,
    });
    const device = this.registry.getDevices().find(item =>
      item.id.toLowerCase() === described.deviceId.toLowerCase() &&
      item.tenantId === scope.tenantId && item.siteId === scope.siteId &&
      item.trustStatus === 'approved'
    );
    if (!installation || !enrollment || enrollment.status !== 'enrolled' || !device) return null;

    const observations = await this.readObservations(scope, described.deviceId);
    const bindings = (installation.observationAuthority?.bindings ?? [])
      .filter(binding => binding?.deviceId === described.deviceId)
      .map(binding => {
        const resolved = resolveInstallationObservationAuthority(
          installation, binding.sourceId, binding.selector,
        );
        const fields = resolved?.binding.deviceId === described.deviceId
          ? Object.keys(resolved.binding.fields) : [];
        return fields.length ? {
          sourceId: binding.sourceId,
          selector: binding.selector,
          fields,
        } : null;
      })
      .filter((binding): binding is NonNullable<typeof binding> => binding !== null);

    const supported = device.supportedCapabilities;
    const hasVerifiedSupport = Array.isArray(supported) && supported.length > 0;
    const commands = device.capabilities.flatMap(capability =>
      capability.actions.filter(action => action !== 'read').map(action => ({
        capability: capability.kind,
        action,
        available: device.control?.status === 'ready' &&
          device.adapter.configured && device.trustStatus === 'approved',
        requiresConfirmation: device.policy.confirmationRequiredFor.includes(action),
        requiresApproval: device.policy.requiresApproval,
      })),
    );

    return {
      identity: {
        id: device.id,
        physicalId: typeof device.metadata?.physicalId === 'string'
          ? device.metadata.physicalId : null,
        kind: device.kind,
        protocol: device.adapter.protocol,
        adapterId: device.adapter.id,
        memberDeviceIds: device.memberDeviceIds ?? [],
      },
      installation: {
        tenantId: enrollment.tenantId,
        siteId: enrollment.siteId,
        displayName: device.displayName,
        zoneId: device.zoneId,
        zoneName: device.zoneName,
        status: enrollment.status,
        enrolledAt: enrollment.enrolledAt,
        version: enrollment.version,
        physicalOutcome: installation.physicalOutcome.status,
      },
      capabilities: {
        supportStatus: hasVerifiedSupport ? 'verified' as const : 'unknown' as const,
        supported: (supported ?? []).map(item => item.kind),
        evidence: device.discovery ? {
          source: device.discovery.source,
          confidence: device.discovery.confidence,
          reason: device.discovery.reason,
        } : [],
      },
      observationAuthorization: {
        status: bindings.length ? 'approved' as const : 'none' as const,
        bindings,
      },
      current: {
        registry: device.state,
        freshnessLimitSeconds: observations?.freshnessLimitSeconds ?? observationFreshnessLimitSeconds(),
        observations: observations?.fields ?? {},
      },
      history: {
        endpoint: `/portal/devices/${encodeURIComponent(device.id)}/measurements`,
        authorizedMetrics: [...new Set(bindings.flatMap(binding => binding.fields))],
        availability: 'queryable' as const,
      },
      commands: {
        executionMustBeRevalidated: true as const,
        available: commands,
      },
    };
  }

  /** Resolve a room inside the authenticated site and return one approved metric. */
  async readRoomMeasurement(
    scope: IntelligenceScope,
    roomQuery: string,
    metricQuery: string,
  ) {
    const room = normalizeRoom(roomQuery);
    const metric = metricQuery.trim().toLowerCase();
    const definition = CORE_MEASUREMENT_DEFINITIONS.find(item => item.metric === metric);
    if (!room || !['temperature', 'humidity'].includes(metric) || !definition) {
      return { status: 'not_found' as const };
    }

    // listDevices is the existing approved-installation + durable-enrollment
    // boundary. Use installation metadata only to resolve its room name.
    const devices = await this.listDevices(scope);
    if (!devices.length) return { status: 'not_found' as const };
    const approvedIds = new Set(devices.map(device => device.deviceId));
    const installations = await this.installations.list(scope);
    const matches = installations.filter(record =>
      record.schemaVersion === 1 &&
      record.device.tenantId === scope.tenantId &&
      record.device.siteId === scope.siteId &&
      record.device.trustStatus === 'approved' &&
      approvedIds.has(record.device.id) &&
      normalizeRoom(record.device.zoneName) === room
    );

    if (!matches.length) return { status: 'not_found' as const };
    if (matches.length > 1) return {
      status: 'ambiguous' as const,
      deviceIds: matches.map(record => record.device.id).sort(),
    };

    const device = matches[0].device;
    const observation = await this.readObservations(scope, device.id);
    const field = observation?.fields[metric];
    if (!field || typeof field.value !== 'number' || !Number.isFinite(field.value)) {
      return {
        status: 'unavailable' as const,
        deviceId: device.id,
        displayName: device.displayName,
        room: device.zoneName,
        metric,
      };
    }

    return {
      status: 'measurement' as const,
      deviceId: device.id,
      displayName: device.displayName,
      room: device.zoneName,
      metric,
      value: field.value,
      unit: definition.unit,
      sourceId: field.sourceId,
      observedAt: field.measuredAt ?? field.receivedAt,
      freshness: field.freshness,
      ageSeconds: field.ageSeconds,
      freshnessLimitSeconds: observation!.freshnessLimitSeconds,
    };
  }

  async describeDevice(
    scope: IntelligenceScope,
    query: string,
  ): Promise<IntelligenceDeviceDescription | null> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;

    const devices = await this.listDevices(scope);

    const exact = devices.find(
      device => device.deviceId.toLowerCase() === normalized,
    );
    if (exact) return exact;

    const matches = devices.filter(device =>
      device.displayName.toLowerCase().includes(normalized)
    );

    return matches.length === 1 ? matches[0] : null;
  }
}

function normalizeRoom(value: string): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  // Bulgarian room names and their common Latin transliteration resolve to
  // the canonical room name already stored on the installation.
  if (
    ['кухня', 'кухнята', 'kuhnq', 'kuhnqta', 'kuhnia', 'kuhnya']
      .includes(normalized)
  ) {
    return 'kitchen';
  }
  return normalized;
}

function median(sortedValues: readonly number[]): number {
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}
