import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import { WeatherProviderService } from './weather-provider.service';
import type { WeatherConfigurationIssue } from './weather-investigator-readiness';
import type { WeatherFinding } from './weather-investigator.types';
import { buildWeatherReadModel, StoredWeatherFinding, StoredWeatherSnapshot } from './weather-read-model';
import { assessWeather } from './weather-data-quality';
import {
  buildWeatherEvidence,
  FixtureWeatherInvestigatorProvider,
  validateWeatherFindings,
  WeatherInvestigatorProvider,
} from './weather-investigator';

/** Persisted rows are the identity anchors for the same forecast episode across runs. */
interface PersistedWeatherEvent {
  stableKey: string;
  eventType: string;
  location: string;
  startsAt: Date | string;
  endsAt: Date | string;
}

/**
 * A forecast's start hour is unique within an event type; a calendar date is not.
 * Once persisted, the key is retained when later forecasts shift an overlapping
 * event's boundaries. Never reinterpret separate non-overlapping episodes as one.
 */
function findingStableKey(
  finding: WeatherFinding,
  previous: readonly PersistedWeatherEvent[],
  claimed: ReadonlySet<string>,
): string {
  const start = Date.parse(finding.startsAt);
  const end = Date.parse(finding.endsAt);
  let best: PersistedWeatherEvent | undefined;
  let bestOverlap = 0;
  let bestStartDifference = Number.POSITIVE_INFINITY;
  for (const candidate of previous) {
    if (
      candidate.eventType !== finding.eventType ||
      candidate.location !== finding.location ||
      claimed.has(candidate.stableKey)
    ) {
      continue;
    }
    const oldStart = new Date(candidate.startsAt).getTime();
    const oldEnd = new Date(candidate.endsAt).getTime();
    const overlap = Math.min(end, oldEnd) - Math.max(start, oldStart);
    if (overlap <= 0) continue;
    const distance = Math.abs(start - oldStart);
    if (
      overlap > bestOverlap ||
      (overlap === bestOverlap && distance < bestStartDifference)
    ) {
      best = candidate;
      bestOverlap = overlap;
      bestStartDifference = distance;
    }
  }
  return best?.stableKey ?? `${finding.eventType}:${new Date(start).toISOString()}`;
}

export const WEATHER_INVESTIGATOR_PROVIDER = 'WEATHER_INVESTIGATOR_PROVIDER';
export interface WeatherSiteLocation {
  tenantId: string;
  siteId: string;
  location: string;
  latitude: number;
  longitude: number;
}

@Injectable()
export class WeatherInvestigatorService {
  private readonly fallback = new FixtureWeatherInvestigatorProvider();
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly weather: WeatherProviderService,
    @Inject(WEATHER_INVESTIGATOR_PROVIDER)
    private readonly investigator: WeatherInvestigatorProvider,
  ) {}

  async run(
    siteId = process.env.WEATHER_INVESTIGATOR_SITE_ID || 'lab-default',
    tenantId = process.env.WEATHER_INVESTIGATOR_TENANT_ID || 'lab',
  ) {
    if (process.env.WEATHER_INVESTIGATOR_ENABLED === 'false')
      throw new Error('Weather investigation is disabled');
    if (!/^[\w.-]{1,120}$/.test(siteId) || !/^[\w.-]{1,120}$/.test(tenantId))
      throw new Error('Invalid tenant or site scope');
    // Resolve the explicit site mapping before any DB lock, provider request or write.
    // An unknown site must never inherit another site's coordinates.
    const location = this.siteLocation(siteId, tenantId);
    const client = await this.pool.connect();
    const lockKey = `weather-investigator:${tenantId}:${siteId}`;
    let locked = false;
    try {
      const lock = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockKey],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) return { status: 'already-running', findings: [] };
      const snapshot = await this.weather.getSnapshotForLocation(
        location,
        'icon_seamless',
      );
      const evidence = buildWeatherEvidence(snapshot, siteId);
      const ageMs = Date.now() - Date.parse(evidence.capturedAt);
      if (
        snapshot.availability !== 'available' ||
        !assessWeather(snapshot).forecastUsable ||
        !Number.isFinite(ageMs) ||
        ageMs < -300000 ||
        ageMs > 30 * 60000 ||
        evidence.hours.length < 24
      ) {
        return {
          status:
            snapshot.availability === 'available'
              ? 'stale-or-incomplete'
              : 'weather-unavailable',
          findings: [],
        };
      }
      const prior = await client.query(
        `SELECT evidence FROM weather_investigation_snapshots
        WHERE tenant_id=$1 AND site_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [tenantId, siteId],
      );
      const previous = prior.rows[0]?.evidence ?? null;
      const saved = await client.query(
        `INSERT INTO weather_investigation_snapshots
        (tenant_id,site_id,captured_at,provider,model,location,latitude,longitude,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
        [
          tenantId,
          siteId,
          evidence.capturedAt,
          evidence.provider,
          evidence.model,
          evidence.location,
          evidence.coordinates.latitude,
          evidence.coordinates.longitude,
          JSON.stringify(evidence),
        ],
      );
      const snapshotId = saved.rows[0].id as string;
      // Retain evidence still referenced by an existing finding. The foreign key
      // must never turn routine snapshot pruning into an investigation outage.
      await client.query(
        `DELETE FROM weather_investigation_snapshots s
        WHERE s.tenant_id=$1 AND s.site_id=$2
          AND s.id NOT IN (
            SELECT id FROM weather_investigation_snapshots
            WHERE tenant_id=$1 AND site_id=$2 ORDER BY created_at DESC, id DESC LIMIT 48
          )
          AND NOT EXISTS (
            SELECT 1 FROM weather_investigation_findings f
            WHERE f.evidence_snapshot_id=s.id
          )`,
        [tenantId, siteId],
      );
      let analysis: Awaited<
        ReturnType<WeatherInvestigatorProvider['investigate']>
      >;
      let activeProvider: WeatherInvestigatorProvider = this.investigator;
      try {
        analysis = await this.investigator.investigate(evidence, previous);
        analysis = {
          ...analysis,
          findings: validateWeatherFindings(analysis.findings, evidence),
        };
      } catch {
        // Provider failure or malformed output never blocks the deterministic, evidence-bound LAB fallback.
        activeProvider = this.fallback;
        analysis = await this.fallback.investigate(evidence, previous);
        analysis.summary = `Използвана е детерминистична резервна оценка (${this.investigator.id} е недостъпен или върна невалиден резултат).`;
      }
      const existing = await client.query(
        `SELECT stable_key AS "stableKey", event_type AS "eventType", location,
          starts_at AS "startsAt", ends_at AS "endsAt"
        FROM weather_investigation_findings
        WHERE tenant_id=$1 AND site_id=$2
          AND ends_at > $3::timestamptz AND starts_at < $4::timestamptz
        ORDER BY starts_at, id`,
        [
          tenantId,
          siteId,
          evidence.hours[0].time,
          new Date(
            Date.parse(evidence.hours[evidence.hours.length - 1].time) + 3_600_000,
          ).toISOString(),
        ],
      );
      const priorEvents = existing.rows as PersistedWeatherEvent[];
      const claimedKeys = new Set<string>();
      let savedFindings = 0;
      for (const finding of analysis.findings) {
        if (
          Date.parse(finding.startsAt) < Date.now() - 60 * 60000 ||
          Date.parse(finding.endsAt) <= Date.now()
        )
          continue;
        const stableKey = findingStableKey(finding, priorEvents, claimedKeys);
        // A single investigation must not overwrite the same episode twice.
        if (claimedKeys.has(stableKey)) continue;
        claimedKeys.add(stableKey);
        const findingProvider = analysis.inferenceProvider ?? activeProvider.id;
        const result = await client.query(
          `INSERT INTO weather_investigation_findings
          (tenant_id,site_id,event_type,stable_key,starts_at,ends_at,location,severity,confidence,uncertainty,
           evidence_refs,consequences,preparation,explanation_bg,reasoning_summary,evidence_snapshot_id,provider,model)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)
          ON CONFLICT (tenant_id,site_id,stable_key) DO UPDATE SET
            starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,severity=EXCLUDED.severity,
            confidence=EXCLUDED.confidence,uncertainty=EXCLUDED.uncertainty,evidence_refs=EXCLUDED.evidence_refs,
            consequences=EXCLUDED.consequences,preparation=EXCLUDED.preparation,explanation_bg=EXCLUDED.explanation_bg,
            reasoning_summary=EXCLUDED.reasoning_summary,evidence_snapshot_id=EXCLUDED.evidence_snapshot_id,
            provider=EXCLUDED.provider,model=EXCLUDED.model,
            notification_state=CASE WHEN weather_investigation_findings.notification_state='acknowledged' AND
              (CASE EXCLUDED.severity WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 WHEN 'high' THEN 3 ELSE 4 END) >
              (CASE weather_investigation_findings.severity WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 WHEN 'high' THEN 3 ELSE 4 END)
              THEN 'prepared' ELSE weather_investigation_findings.notification_state END,
            last_updated_at=now()
          WHERE weather_investigation_findings.notification_state='prepared' OR
            (weather_investigation_findings.notification_state='acknowledged' AND
              (CASE EXCLUDED.severity WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 WHEN 'high' THEN 3 ELSE 4 END) >
              (CASE weather_investigation_findings.severity WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 WHEN 'high' THEN 3 ELSE 4 END))
          RETURNING id`,
          [
            tenantId,
            siteId,
            finding.eventType,
            stableKey,
            finding.startsAt,
            finding.endsAt,
            finding.location,
            finding.severity,
            finding.confidence,
            finding.uncertainty,
            JSON.stringify(finding.evidenceRefs),
            JSON.stringify(finding.consequences),
            JSON.stringify(finding.preparation),
            finding.bulgarianExplanation,
            analysis.summary,
            snapshotId,
            findingProvider,
            analysis.model,
          ],
        );
        if (result.rowCount) savedFindings++;
        // Newly created events can also be matched within this same run;
        // claimedKeys prevents two findings from updating the same row.
        if (!priorEvents.some((row) => row.stableKey === stableKey)) {
          priorEvents.push({
            stableKey,
            eventType: finding.eventType,
            location: finding.location,
            startsAt: finding.startsAt,
            endsAt: finding.endsAt,
          });
        }
      }
      return {
        status: 'completed',
        siteId,
        tenantId,
        capturedAt: evidence.capturedAt,
        location: evidence.location,
        provider: analysis.inferenceProvider ?? activeProvider.id,
        model: analysis.model,
        summary: analysis.summary,
        createdOrUpdated: savedFindings,
        findings: await this.list(siteId, tenantId),
      };
    } finally {
      if (locked)
        await client
          .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
          .catch(() => undefined);
      client.release();
    }
  }

  async list(
    siteId = process.env.WEATHER_INVESTIGATOR_SITE_ID || 'lab-default',
    tenantId = process.env.WEATHER_INVESTIGATOR_TENANT_ID || 'lab',
  ) {
    const result = await this.pool.query(
      `SELECT id::text,evidence_snapshot_id::text AS "evidenceSnapshotId",event_type AS "eventType",starts_at AS "startsAt",ends_at AS "endsAt",
      location,severity,confidence,uncertainty,evidence_refs AS "evidenceRefs",consequences,preparation,
      explanation_bg AS "explanationBg",reasoning_summary AS "reasoningSummary",provider,model,
      notification_state AS "notificationState",first_notified_at AS "firstNotifiedAt",last_updated_at AS "lastUpdatedAt",
      acknowledged_at AS "acknowledgedAt",dismissed_at AS "dismissedAt"
      FROM weather_investigation_findings WHERE tenant_id=$1 AND site_id=$2 AND ends_at>now()-interval '24 hours'
      ORDER BY starts_at LIMIT 100`,
      [tenantId, siteId],
    );
    return result.rows;
  }

  async context(
    siteId = process.env.WEATHER_INVESTIGATOR_SITE_ID || 'lab-default',
    tenantId = process.env.WEATHER_INVESTIGATOR_TENANT_ID || 'lab',
  ) {
    const [findings, latest] = await Promise.all([
      this.list(siteId, tenantId),
      this.pool.query(
        `SELECT id::text,captured_at AS "capturedAt",provider,model,location,latitude,longitude,evidence
        FROM weather_investigation_snapshots WHERE tenant_id=$1 AND site_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [tenantId, siteId],
      ),
    ]);
    return {
      siteId,
      findings,
      latestForecast: latest.rows[0] ?? null,
      officialAlerts: {
        available: false,
        explanation:
          'Официалните предупреждения не се поддържат от текущия метеорологичен източник.',
      },
    };
  }

  async readModel(siteId: string, tenantId: string) {
    const context = await this.context(siteId, tenantId);
    return buildWeatherReadModel(
      { siteId, tenantId },
      {
        findings: context.findings as StoredWeatherFinding[],
        latestForecast: context.latestForecast as StoredWeatherSnapshot | null,
      },
    );
  }

  async acknowledge(
    id: string,
    action: 'acknowledged' | 'dismissed',
    siteId = process.env.WEATHER_INVESTIGATOR_SITE_ID || 'lab-default',
    tenantId = process.env.WEATHER_INVESTIGATOR_TENANT_ID || 'lab',
  ) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid finding ID');
    const result = await this.pool.query(
      `UPDATE weather_investigation_findings SET notification_state=$4,
      acknowledged_at=CASE WHEN $4='acknowledged' THEN now() ELSE acknowledged_at END,
      dismissed_at=CASE WHEN $4='dismissed' THEN now() ELSE dismissed_at END,last_updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND site_id=$3 RETURNING id::text`,
      [id, tenantId, siteId, action],
    );
    if (!result.rowCount) return { status: 'not-found' };
    return { status: action, id };
  }

  /** Configuration readiness without leaking coordinates, credentials or raw JSON. */
  configurationIssue(siteId: string, tenantId: string): WeatherConfigurationIssue {
    if (process.env.ENERGRID_LAB_MODE !== 'true') return 'lab_disabled';
    if (process.env.WEATHER_INVESTIGATOR_ENABLED !== 'true') return 'scheduler_disabled';
    if (process.env.WEATHER_INVESTIGATOR_SITE_ID !== siteId ||
        process.env.WEATHER_INVESTIGATOR_TENANT_ID !== tenantId)
      return 'site_configuration_missing';
    try {
      this.siteLocation(siteId, tenantId);
      return null;
    } catch {
      return 'site_configuration_missing';
    }
  }

  private siteLocation(siteId: string, tenantId: string): WeatherSiteLocation {
    let configured: unknown;
    try {
      configured = JSON.parse(process.env.WEATHER_SITE_LOCATIONS_JSON || '{}');
    } catch {
      throw new Error('Invalid WEATHER_SITE_LOCATIONS_JSON configuration');
    }
    if (!configured || typeof configured !== 'object' || Array.isArray(configured))
      throw new Error('Invalid WEATHER_SITE_LOCATIONS_JSON configuration');

    const entry = Object.prototype.hasOwnProperty.call(configured, siteId)
      ? (configured as Record<string, unknown>)[siteId]
      : undefined;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Weather site location is not configured for this scope');
    const site = entry as Partial<WeatherSiteLocation>;
    if (
      site.tenantId !== tenantId ||
      site.siteId !== siteId ||
      typeof site.location !== 'string' ||
      !site.location.trim() ||
      typeof site.latitude !== 'number' ||
      typeof site.longitude !== 'number' ||
      !Number.isFinite(site.latitude) ||
      !Number.isFinite(site.longitude) ||
      Math.abs(site.latitude) > 90 ||
      Math.abs(site.longitude) > 180
    )
      throw new Error('Weather site location is not configured for this scope');
    return {
      tenantId,
      siteId,
      location: site.location.trim(),
      latitude: site.latitude,
      longitude: site.longitude,
    };
  }
}
