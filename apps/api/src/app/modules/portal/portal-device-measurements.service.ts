import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CORE_MEASUREMENT_DEFINITIONS } from '@energrid/domain-telemetry';
import { observationFreshnessLimitSeconds } from '../devices/device-intelligence-observation';
import { DeviceIntelligenceQueryService } from '../devices/device-intelligence-query.service';
import { PostgresGenericMeasurementRepository } from '../telemetry/generic-measurements/postgres-generic-measurement.repository';
import { canonicalUtcInstant } from '@energrid/domain-telemetry';

const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export interface DeviceMeasurementScope {
  tenantId: string;
  siteId: string;
}

@Injectable()
export class PortalDeviceMeasurementsService {
  constructor(
    private readonly intelligence: DeviceIntelligenceQueryService,
    @Optional() @Inject(PostgresGenericMeasurementRepository)
    private readonly repository: PostgresGenericMeasurementRepository | null,
  ) {}

  async current(scope: DeviceMeasurementScope, deviceId: string) {
    const device = await this.intelligence.describeDevice(scope, deviceId);
    if (!device || device.deviceId !== deviceId) throw new NotFoundException('Enrolled device was not found');
    let observations;
    try {
      observations = await this.intelligence.readObservations(scope, deviceId);
    } catch {
      throw new ServiceUnavailableException('Current observations are unavailable');
    }
    return {
      deviceId,
      freshnessLimitSeconds: observations?.freshnessLimitSeconds ?? observationFreshnessLimitSeconds(),
      fields: observations?.fields ?? {},
    };
  }

  async history(
    scope: DeviceMeasurementScope,
    deviceId: string,
    metricValue: unknown,
    fromValue: unknown,
    toValue: unknown,
    limitValue?: unknown,
  ) {
    const device = await this.intelligence.describeDevice(scope, deviceId);
    if (!device || device.deviceId !== deviceId) throw new NotFoundException('Enrolled device was not found');
    const metric = parseMetric(metricValue);
    const { from, to, limit } = parseRange(fromValue, toValue, limitValue);

    // Current Core state is also the active installation-authority check. Stale
    // values remain authorized historical context; they are not current values.
    let observations;
    try {
      observations = await this.intelligence.readObservations(scope, deviceId);
    } catch {
      throw new ServiceUnavailableException('Current observation authority is unavailable');
    }
    const authorized = observations?.fields[metric];
    if (!authorized || typeof authorized.value !== 'number' || !Number.isFinite(authorized.value)) {
      throw new ForbiddenException('Measurement history is not authorized for this device field');
    }
    if (!this.repository) throw new ServiceUnavailableException('Measurement history is unavailable');

    let rows: Awaited<ReturnType<PostgresGenericMeasurementRepository['read']>>;
    try {
      rows = await this.repository.read({
        ...scope,
        deviceId,
        componentId: 'device',
        channel: metric,
        metric,
        from,
        to,
        limit,
      });
    } catch {
      throw new ServiceUnavailableException('Measurement history is unavailable');
    }
    const definition = CORE_MEASUREMENT_DEFINITIONS.find(item => item.metric === metric);
    return {
      deviceId,
      metric,
      unit: rows[0]?.unit ?? definition?.unit ?? null,
      from,
      to,
      measurements: rows.map(({ observedAt, value, unit, quality }) => ({
        observedAt, value, unit, quality,
      })),
    };
  }
}

function parseMetric(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value) ||
      !CORE_MEASUREMENT_DEFINITIONS.some(item => item.metric === value)) {
    throw new BadRequestException('A supported measurement metric is required');
  }
  return value;
}

function parseRange(fromValue: unknown, toValue: unknown, limitValue?: unknown) {
  let from: string;
  let to: string;
  try {
    from = canonicalUtcInstant(fromValue, 'from');
    to = canonicalUtcInstant(toValue, 'to');
  } catch {
    throw new BadRequestException('from and to must be UTC ISO timestamps');
  }
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > MAX_RANGE_MS || Date.parse(to) > Date.now() + 30_000) {
    throw new BadRequestException('Choose a past range of up to 7 days');
  }
  const limit = limitValue === undefined
    ? DEFAULT_LIMIT
    : typeof limitValue === 'number' && Number.isSafeInteger(limitValue)
      ? limitValue
      : typeof limitValue === 'string' && /^\d+$/.test(limitValue)
        ? Number(limitValue)
        : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return { from, to, limit };
}
