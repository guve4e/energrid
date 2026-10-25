import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import { WeatherProviderService } from './weather-provider.service';
import { assessWeather } from './weather-data-quality';
import {
  buildWeatherEvidence,
  FixtureWeatherInvestigatorProvider,
  validateWeatherFindings,
  WeatherInvestigatorProvider,
} from './weather-investigator';

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
      const location = this.siteLocation(siteId, tenantId);
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
      await client.query(
        `DELETE FROM weather_investigation_snapshots WHERE tenant_id=$1 AND site_id=$2
        AND id NOT IN (SELECT id FROM weather_investigation_snapshots WHERE tenant_id=$1 AND site_id=$2 ORDER BY created_at DESC LIMIT 48)`,
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
      let savedFindings = 0;
      for (const finding of analysis.findings) {
        if (
          Date.parse(finding.startsAt) < Date.now() - 60 * 60000 ||
          Date.parse(finding.endsAt) <= Date.now()
        )
          continue;
        const stableKey = `${finding.eventType}:${finding.startsAt.slice(0, 10)}`;
        const findingProvider = analysis.inferenceProvider ?? activeProvider.id;
        const result = await client.query(
          `INSERT INTO weather_investigation_findings
          (tenant_id,site_id,event_type,stable_key,starts_at,ends_at,location,severity,confidence,uncertainty,
           evidence_refs,consequences,preparation,explanation_bg,reasoning_summary,evidence_snapshot_id,provider,model,first_notified_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,now())
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
            first_notified_at=CASE WHEN weather_investigation_findings.notification_state='acknowledged' AND
              (CASE EXCLUDED.severity WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 WHEN 'high' THEN 3 ELSE 4 END) >
              (CASE weather_investigation_findings.severity WHEN 'low' THEN 1 WHEN 'moderate' THEN 2 WHEN 'high' THEN 3 ELSE 4 END)
              THEN now() ELSE weather_investigation_findings.first_notified_at END,
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
      `SELECT id::text,event_type AS "eventType",starts_at AS "startsAt",ends_at AS "endsAt",
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
        `SELECT captured_at AS "capturedAt",provider,model,location,latitude,longitude,evidence
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

  private siteLocation(siteId: string, tenantId: string): WeatherSiteLocation {
    const defaultLocation = this.weather.getDefaultLocation();
    try {
      const configured = JSON.parse(
        process.env.WEATHER_SITE_LOCATIONS_JSON || '{}',
      ) as Record<string, Partial<WeatherSiteLocation>>;
      const entry = configured[siteId];
      if (
        entry &&
        entry.tenantId === tenantId &&
        entry.siteId === siteId &&
        typeof entry.location === 'string' &&
        Number.isFinite(entry.latitude) &&
        Number.isFinite(entry.longitude) &&
        Math.abs(entry.latitude!) <= 90 &&
        Math.abs(entry.longitude!) <= 180
      ) {
        return entry as WeatherSiteLocation;
      }
    } catch {
      /* A bad optional location map falls back to the configured LAB location. */
    }
    return {
      tenantId,
      siteId,
      location: defaultLocation.location,
      latitude: defaultLocation.latitude,
      longitude: defaultLocation.longitude,
    };
  }
}
