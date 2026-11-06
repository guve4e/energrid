import { Injectable } from '@nestjs/common';
import { HOUR_MS } from './weather-data-quality';
import {
  meteostatObservations,
  MeteostatHour,
  meteostatPrecipitationObservations,
  stationDistanceKm,
  validWeatherCoordinates,
  weatherCoordinateKey,
  WeatherCoordinates,
  weatherObservationSource,
  weatherObservationMode,
} from './weather-observations';
import {
  dailyPeriodConfiguration,
  meteostatDailyObservations,
} from './weather-station-daily';
import {
  NIMH_RAIN_SOURCE,
  nimhRainSourceUrl,
  parseNimhRainCsv,
} from './nimh-rain';
import {
  DAILY_REVISION_MESSAGE,
  WeatherStationDailyService,
} from './weather-station-daily.service';
import { weatherDate } from './weather-calendar';
import {
  VIDIN_LOCATION,
  WeatherVerificationService,
} from './weather-verification.service';

const NIMH_UNIT_UNVERIFIED_NOTE =
  'NIMH preliminary daily rain reports are stored with raw values and provenance. Their numeric unit and reporting period are unverified; no verified metric is exposed or scored.';

interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
  reportedDistanceKm?: number;
  country?: string;
  region?: string;
  timezone?: string;
  identifiers?: unknown;
  inventory?: unknown;
}
export interface CollectionStatus {
  status:
    | 'configuration-required'
    | 'ready'
    | 'available'
    | 'no-observations'
    | 'unavailable'
    | 'manual'
    | 'disabled'
    | 'reporting-period-unverified'
    | 'partial-coverage';
  source: string | null;
  note: string;
  station?: Station;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastObservedAt?: string | null;
  availableMetrics?: string[];
  records?: number;
  granularity?: 'hourly' | 'daily';
  nextCollectionAt?: string;
  lastReportDate?: string | null;
  valueUnitStatus?: 'verified' | 'unverified';
  coverage?: {
    expectedHours: number;
    observedHours: number;
    missingHours: number;
    complete: boolean;
  };
  attribution?: string;
  targetCoordinates?: string;
}

export interface HourlyPrecipitationRequest {
  latitude: number;
  longitude: number;
  metric: 'precipitation_mm';
  startAt: string;
  endAt: string;
}

export interface MeteostatStationDiagnostic {
  stationId: string;
  station?: Station;
  reportedDistanceKm: number;
  status:
    | 'inspected'
    | 'no-hourly-inventory'
    | 'metadata-or-hourly-request-failed';
  returnedRows?: number;
  validTimestampRows?: number;
  invalidTimestampRows?: number;
  uniqueTimestampLabels?: number;
  duplicateTimestampRows?: number;
  timestampRowsInRequestedInterval?: number;
  precipitationValues?: number;
  missingPrecipitationValues?: number;
  explicitZeroValues?: number;
  invalidPrecipitationValues?: number;
  intervalPrecipitationValues?: number;
  intervalMissingPrecipitationValues?: number;
  intervalExplicitZeroValues?: number;
  intervalInvalidPrecipitationValues?: number;
  firstTimestampLabel?: string;
  lastTimestampLabel?: string;
  timestampLabelSamples?: string[];
  note?: string;
}

export interface MeteostatStationDiagnosticResult {
  status: 'configuration-required' | 'available' | 'unavailable';
  targetCoordinates?: string;
  interval?: { startAt: string; endAt: string; requestedHours: number };
  stations: MeteostatStationDiagnostic[];
  note: string;
}

const DEFAULT_NEARBY_STATION_LIMIT = 3;
const MAX_NEARBY_STATION_LIMIT = 10;
const DEFAULT_NEARBY_RADIUS_KM = 25;
const MAX_NEARBY_RADIUS_KM = 200;
const MAX_DIAGNOSTIC_STATIONS = 3;
const MAX_DIAGNOSTIC_HOURS = 7 * 24;
const MAX_DIAGNOSTIC_ROWS = 8 * 24 + 1;

function utcTimestampFromLabel(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    return undefined;
  const timestamp = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) === value
    ? timestamp
    : undefined;
}

@Injectable()
export class WeatherObservationCollector {
  private last?: CollectionStatus;
  constructor(
    private readonly verification: WeatherVerificationService,
    private readonly stationDaily: WeatherStationDailyService,
  ) {}

  status(): CollectionStatus {
    const source = weatherObservationSource();
    if (process.env.WEATHER_OBSERVATION_PROVIDER === 'nimh') {
      if (process.env.WEATHER_OBSERVATION_COLLECTION_ENABLED !== 'true')
        return {
          status: 'disabled',
          source,
          granularity: 'daily',
          note: 'NIMH daily rain collection is disabled. No station requests are made.',
        };
      const current: CollectionStatus =
        this.last?.source === source
          ? this.last
          : {
              status: 'ready',
              source,
              granularity: 'daily',
              note: NIMH_UNIT_UNVERIFIED_NOTE,
            };
      return {
        ...current,
        availableMetrics: [],
        valueUnitStatus: 'unverified',
        note:
          current.status === 'unavailable'
            ? current.note
            : NIMH_UNIT_UNVERIFIED_NOTE,
      };
    }
    if (process.env.WEATHER_OBSERVATION_PROVIDER !== 'meteostat') {
      return {
        status: source ? 'manual' : 'configuration-required',
        source: source || null,
        note: source
          ? 'A private station adapter is configured. Waiting measurements must be sent to the private observation endpoint.'
          : 'No measured weather source is connected. Configure a station before accuracy can be measured.',
      };
    }
    const granularity = weatherObservationMode();
    if (process.env.WEATHER_OBSERVATION_COLLECTION_ENABLED !== 'true') {
      return {
        status: 'disabled',
        source: source || null,
        granularity,
        note: 'External measurement collection is disabled. Forecast recording continues; no station API calls are made.',
      };
    }
    if (!source || !process.env.METEOSTAT_API_KEY) {
      const nearbyReady =
        !process.env.METEOSTAT_STATION_ID &&
        !!process.env.METEOSTAT_API_KEY &&
        (process.env.METEOSTAT_INTERVAL_LABEL === 'start' ||
          process.env.METEOSTAT_INTERVAL_LABEL === 'end');
      if (nearbyReady)
        return this.last?.granularity === 'hourly'
          ? this.last
          : {
              status: 'ready',
              source: null,
              granularity: 'hourly',
              note: 'A forecast location will be used to discover nearby stations. Collection requires a verified interval label.',
            };
      return {
        status: 'configuration-required',
        source: source || null,
        granularity,
        note:
          granularity === 'daily'
            ? 'Meteostat daily collection needs a server API key and a station ID. Model-filled data is disabled.'
            : 'Meteostat needs a server API key, a station ID or forecast coordinates for nearby discovery, and a verified hourly interval label. Model-filled data is disabled.',
      };
    }
    return this.last?.source === source
      ? this.last
      : {
          status: 'ready',
          source,
          granularity,
          note: 'Station collection runs at most once per 24 hours, including failed attempts. Model-filled data is disabled.',
        };
  }

  private async request(path: string, params: Record<string, string>) {
    const response = await fetch(
      `https://meteostat.p.rapidapi.com/stations/${path}?${new URLSearchParams(params)}`,
      {
        headers: {
          'x-rapidapi-host': 'meteostat.p.rapidapi.com',
          'x-rapidapi-key': process.env.METEOSTAT_API_KEY!,
        },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new Error('Station request failed');
    return response.json();
  }

  private nearbySearchBounds() {
    const radiusKm = Number(
      process.env.METEOSTAT_NEARBY_RADIUS_KM ?? DEFAULT_NEARBY_RADIUS_KM,
    );
    const stationLimit = Number(
      process.env.METEOSTAT_NEARBY_STATION_LIMIT ??
        DEFAULT_NEARBY_STATION_LIMIT,
    );
    return Number.isFinite(radiusKm) &&
      radiusKm >= 1 &&
      radiusKm <= MAX_NEARBY_RADIUS_KM &&
      Number.isInteger(stationLimit) &&
      stationLimit >= 1 &&
      stationLimit <= MAX_NEARBY_STATION_LIMIT
      ? { radiusKm, stationLimit }
      : null;
  }

  async diagnoseAtCoordinates(
    request: HourlyPrecipitationRequest,
    now = new Date(),
  ): Promise<MeteostatStationDiagnosticResult> {
    const { latitude, longitude, startAt, endAt } = request;
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    const validUtcHour = (value: string, timestamp: number) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value) &&
      Number.isFinite(timestamp) &&
      timestamp % HOUR_MS === 0 &&
      new Date(timestamp).toISOString() === value;
    const unavailable = (
      status: MeteostatStationDiagnosticResult['status'],
      note: string,
    ): MeteostatStationDiagnosticResult => ({
      status,
      stations: [],
      note,
    });
    if (!process.env.METEOSTAT_API_KEY)
      return unavailable(
        'configuration-required',
        'Set METEOSTAT_API_KEY in the isolated development environment to inspect stations.',
      );
    if (
      request.metric !== 'precipitation_mm' ||
      !validWeatherCoordinates(request) ||
      !validUtcHour(startAt, start) ||
      !validUtcHour(endAt, end) ||
      end <= start ||
      end - start > MAX_DIAGNOSTIC_HOURS * HOUR_MS ||
      end > now.getTime()
    )
      return unavailable(
        'unavailable',
        'Provide valid coordinates and a past UTC-hour interval of at most seven days.',
      );
    const bounds = this.nearbySearchBounds();
    if (!bounds)
      return unavailable(
        'configuration-required',
        `Set METEOSTAT_NEARBY_RADIUS_KM from 1 to ${MAX_NEARBY_RADIUS_KM} and METEOSTAT_NEARBY_STATION_LIMIT from 1 to ${MAX_NEARBY_STATION_LIMIT}.`,
      );

    const result: MeteostatStationDiagnosticResult = {
      status: 'available',
      targetCoordinates: weatherCoordinateKey(request),
      interval: {
        startAt,
        endAt,
        requestedHours: (end - start) / HOUR_MS,
      },
      stations: [],
      note: 'Read-only station evidence. Raw timestamp labels are reported without assigning start/end interval semantics; nothing is stored or scored.',
    };
    try {
      const nearby = await this.request('nearby', {
        lat: String(latitude),
        lon: String(longitude),
        radius: String(bounds.radiusKm * 1000),
        limit: String(Math.min(bounds.stationLimit, MAX_DIAGNOSTIC_STATIONS)),
      });
      if (
        !Array.isArray(nearby?.data) ||
        nearby.data.length > MAX_DIAGNOSTIC_STATIONS
      )
        throw new Error('Invalid nearby station response');

      const startDate = startAt.slice(0, 10);
      const endDate = new Date(end - 1).toISOString().slice(0, 10);
      const inspectedIds = new Set<string>();
      for (const candidate of nearby.data) {
        if (
          typeof candidate?.id !== 'string' ||
          !/^[A-Za-z0-9]{1,12}$/.test(candidate.id) ||
          inspectedIds.has(candidate.id) ||
          typeof candidate.distance !== 'number' ||
          !Number.isFinite(candidate.distance) ||
          candidate.distance < 0 ||
          candidate.distance > bounds.radiusKm * 1000
        )
          continue;
        inspectedIds.add(candidate.id);
        let station: Station | undefined;
        try {
          const metadata = await this.request('meta', { id: candidate.id });
          const data = metadata?.data;
          const stationLatitude = data?.location?.latitude;
          const stationLongitude = data?.location?.longitude;
          if (
            data?.id !== candidate.id ||
            !validWeatherCoordinates({
              latitude: stationLatitude,
              longitude: stationLongitude,
            })
          )
            continue;
          const distanceKm = stationDistanceKm(
            stationLatitude,
            stationLongitude,
            latitude,
            longitude,
          );
          if (distanceKm > bounds.radiusKm) continue;
          station = {
            id: candidate.id,
            name: data.name?.en || candidate.id,
            latitude: stationLatitude,
            longitude: stationLongitude,
            distanceKm,
            reportedDistanceKm: candidate.distance / 1000,
            country: data.country,
            region: data.region,
            timezone: data.timezone,
            identifiers: data.identifiers ?? data.identifier,
            inventory: data.inventory,
          };
          const inventory = data.inventory?.hourly;
          if (
            typeof inventory?.start !== 'string' ||
            typeof inventory?.end !== 'string' ||
            inventory.start > endDate ||
            inventory.end < startDate
          ) {
            result.stations.push({
              stationId: candidate.id,
              station,
              reportedDistanceKm: candidate.distance / 1000,
              status: 'no-hourly-inventory',
            });
            continue;
          }
          const hourly = await this.request('hourly', {
            station: candidate.id,
            start: startDate,
            end: endDate,
            tz: 'UTC',
            model: 'false',
            units: 'metric',
          });
          if (
            !Array.isArray(hourly?.data) ||
            hourly.data.length > MAX_DIAGNOSTIC_ROWS
          )
            throw new Error('Invalid station data');

          const hourlyRows = hourly.data as MeteostatHour[];
          const timestamps = hourlyRows
            .map((row) => row?.time)
            .filter((time: unknown): time is string =>
              Number.isFinite(utcTimestampFromLabel(time)),
            );
          const uniqueTimestamps = [...new Set(timestamps)].sort();
          const timestampRowsInRequestedInterval = timestamps.filter((time) => {
            const timestamp = utcTimestampFromLabel(time)!;
            return timestamp >= start && timestamp < end;
          }).length;
          let precipitationValues = 0;
          let missingPrecipitationValues = 0;
          let explicitZeroValues = 0;
          let invalidPrecipitationValues = 0;
          let intervalPrecipitationValues = 0;
          let intervalMissingPrecipitationValues = 0;
          let intervalExplicitZeroValues = 0;
          let intervalInvalidPrecipitationValues = 0;
          for (const row of hourlyRows) {
            const timestamp = utcTimestampFromLabel(row.time) ?? Number.NaN;
            const inRequestedInterval = timestamp >= start && timestamp < end;
            if (row.prcp === null || row.prcp === undefined) {
              missingPrecipitationValues++;
              if (inRequestedInterval) intervalMissingPrecipitationValues++;
            } else if (
              typeof row.prcp === 'number' &&
              Number.isFinite(row.prcp) &&
              row.prcp >= 0
            ) {
              precipitationValues++;
              if (inRequestedInterval) intervalPrecipitationValues++;
              if (row.prcp === 0) explicitZeroValues++;
              if (inRequestedInterval && row.prcp === 0)
                intervalExplicitZeroValues++;
            } else {
              invalidPrecipitationValues++;
              if (inRequestedInterval) intervalInvalidPrecipitationValues++;
            }
          }
          result.stations.push({
            stationId: candidate.id,
            station,
            reportedDistanceKm: candidate.distance / 1000,
            status: 'inspected',
            returnedRows: hourlyRows.length,
            validTimestampRows: timestamps.length,
            invalidTimestampRows: hourlyRows.length - timestamps.length,
            uniqueTimestampLabels: uniqueTimestamps.length,
            duplicateTimestampRows: timestamps.length - uniqueTimestamps.length,
            timestampRowsInRequestedInterval,
            precipitationValues,
            missingPrecipitationValues,
            explicitZeroValues,
            invalidPrecipitationValues,
            intervalPrecipitationValues,
            intervalMissingPrecipitationValues,
            intervalExplicitZeroValues,
            intervalInvalidPrecipitationValues,
            firstTimestampLabel: uniqueTimestamps[0],
            lastTimestampLabel: uniqueTimestamps.at(-1),
            timestampLabelSamples: [
              ...new Set([
                ...uniqueTimestamps.slice(0, 6),
                ...uniqueTimestamps.slice(-6),
              ]),
            ],
            note: 'Raw Meteostat time labels; precipitation timestamps have no inferred interval boundary.',
          });
        } catch {
          result.stations.push({
            stationId: candidate.id,
            station,
            reportedDistanceKm: candidate.distance / 1000,
            status: 'metadata-or-hourly-request-failed',
            note: 'Station metadata or hourly request failed; no data was stored.',
          });
        }
      }
      if (!result.stations.some(({ status }) => status === 'inspected')) {
        result.status = 'unavailable';
        result.note =
          'No nearby station hourly observations could be inspected for this coordinate and interval.';
      }
      return result;
    } catch {
      return unavailable(
        'unavailable',
        'Meteostat station discovery failed. No data was stored or scored.',
      );
    }
  }

  async collect(
    now = new Date(),
    target?: WeatherCoordinates,
  ): Promise<CollectionStatus> {
    if (
      target &&
      process.env.WEATHER_OBSERVATION_PROVIDER === 'meteostat' &&
      !process.env.METEOSTAT_STATION_ID
    ) {
      const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
      return this.collectAtCoordinates(
        {
          ...target,
          metric: 'precipitation_mm',
          startAt: new Date(end - 14 * 24 * HOUR_MS).toISOString(),
          endAt: new Date(end).toISOString(),
        },
        now,
      );
    }
    const status = this.status();
    if (
      status.status === 'configuration-required' ||
      status.status === 'manual' ||
      status.status === 'disabled'
    )
      return status;
    const lastSuccessAt = this.last?.lastSuccessAt;
    const granularity = weatherObservationMode();
    try {
      const claim = await this.stationDaily.claimCollection(
        status.source!,
        now,
      );
      if (!claim.claimed) {
        const snapshot = claim.snapshot as
          | Partial<CollectionStatus>
          | null
          | undefined;
        this.last = snapshot
          ? { ...status, ...snapshot }
          : (this.last ?? {
              ...status,
              note: 'Collection already attempted in the last 24 hours. Waiting for the next daily cycle.',
            });
        if (status.source === NIMH_RAIN_SOURCE) {
          this.last = {
            ...this.last!,
            availableMetrics: [],
            valueUnitStatus: 'unverified',
            note: NIMH_UNIT_UNVERIFIED_NOTE,
          };
        }
        return this.last!;
      }
      if (status.source === NIMH_RAIN_SOURCE) {
        const [year, month] = weatherDate(now).split('-').map(Number);
        const months = [
          new Date(Date.UTC(year, month - 2, 1)),
          new Date(Date.UTC(year, month - 1, 1)),
        ];
        const observations = [];
        for (const date of months) {
          const sourceUrl = nimhRainSourceUrl(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
          );
          const response = await fetch(sourceUrl, {
            signal: AbortSignal.timeout(8000),
            redirect: 'error',
          });
          if (!response.ok) throw new Error('NIMH rain request failed');
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > 100_000)
            throw new Error('NIMH rain file is too large');
          const csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          observations.push(
            ...parseNimhRainCsv(
              csv,
              date.getUTCFullYear(),
              date.getUTCMonth() + 1,
              sourceUrl,
              new Date().toISOString(),
              now,
            ),
          );
        }
        if (observations.length)
          await this.stationDaily.ingest(
            status.source,
            VIDIN_LOCATION,
            observations,
            { id: '1020', name: 'Vidin', provider: 'NIMH' },
          );
        this.last = {
          status: observations.length
            ? 'reporting-period-unverified'
            : 'no-observations',
          source: status.source,
          granularity: 'daily',
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          nextCollectionAt: new Date(
            now.getTime() + 24 * HOUR_MS,
          ).toISOString(),
          lastObservedAt: null,
          availableMetrics: [],
          valueUnitStatus: 'unverified',
          records: observations.length,
          lastReportDate:
            observations
              .map((o) => o.date)
              .sort()
              .at(-1) ?? null,
          note: NIMH_UNIT_UNVERIFIED_NOTE,
        };
        await this.stationDaily.saveCollectionStatus(status.source, this.last);
        return this.last;
      }
      const stationId = process.env.METEOSTAT_STATION_ID!;
      const metadata = await this.request('meta', { id: stationId });
      const stationData = metadata?.data;
      const latitude = stationData?.location?.latitude;
      const longitude = stationData?.location?.longitude;
      if (
        stationData?.id !== stationId ||
        typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        throw new Error('Invalid station metadata');
      }
      const [targetLatitude, targetLongitude] =
        VIDIN_LOCATION.split(',').map(Number);
      const distanceKm = stationDistanceKm(
        latitude,
        longitude,
        targetLatitude,
        targetLongitude,
      );
      if (distanceKm > 25)
        throw new Error(
          'Station is outside the supported local comparison radius',
        );
      const station: Station = {
        id: stationId,
        name: stationData.name?.en || stationId,
        latitude,
        longitude,
        distanceKm,
      };
      if (granularity === 'daily') {
        if (typeof stationData.timezone !== 'string' || !stationData.timezone)
          throw new Error('Missing station timezone');
        new Intl.DateTimeFormat('en', {
          timeZone: stationData.timezone,
        }).format(now);
      }
      // Revisit 14 days to pick up delayed reports. Duplicates remain immutable in storage.
      const anchor =
        granularity === 'daily' ? Date.parse(weatherDate(now)) : now.getTime();
      const start = new Date(anchor - 14 * 24 * HOUR_MS)
        .toISOString()
        .slice(0, 10);
      const end =
        granularity === 'daily'
          ? new Date(anchor - 24 * HOUR_MS).toISOString().slice(0, 10)
          : now.toISOString().slice(0, 10);
      const payload = await this.request(granularity, {
        station: stationId,
        start,
        end,
        ...(granularity === 'hourly' ? { tz: 'UTC' } : {}),
        model: 'false',
        units: 'metric',
      });
      if (
        !Array.isArray(payload?.data) ||
        payload.data.length > (granularity === 'daily' ? 16 : 24 * 16)
      )
        throw new Error('Invalid station data');
      const nextCollectionAt = new Date(
        now.getTime() + 24 * HOUR_MS,
      ).toISOString();
      if (granularity === 'daily') {
        const observations = meteostatDailyObservations(
          payload.data,
          now,
          dailyPeriodConfiguration(),
          stationData.timezone,
        );
        if (observations.length)
          await this.stationDaily.ingest(
            status.source!,
            VIDIN_LOCATION,
            observations,
            station,
          );
        const verified = observations.every(
          (o) => o.periodBasis === 'local-calendar-day',
        );
        this.last = {
          status: !observations.length
            ? 'no-observations'
            : verified
              ? 'available'
              : 'reporting-period-unverified',
          source: status.source,
          station,
          granularity,
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          nextCollectionAt,
          lastObservedAt: null,
          availableMetrics: [...new Set(observations.map((o) => o.metric))],
          records: observations.length,
          lastReportDate:
            observations
              .map((o) => o.date)
              .sort()
              .at(-1) ?? null,
          note: verified
            ? 'Native daily station reports with verified matching calendar-day periods. Missing gusts remain unknown; average wind is not substituted.'
            : 'Native daily station reports can be stored, but the reporting period is not verified. These reports remain unscored; no hourly measurements are invented.',
        };
        await this.stationDaily.saveCollectionStatus(status.source!, this.last);
        return this.last;
      }
      const observations = meteostatObservations(
        payload.data as MeteostatHour[],
        process.env.METEOSTAT_INTERVAL_LABEL as 'start' | 'end',
        now,
      );
      for (let i = 0; i < observations.length; i += 100) {
        await this.verification.ingest(
          status.source!,
          VIDIN_LOCATION,
          observations.slice(i, i + 100),
        );
      }
      this.last = {
        status: observations.length ? 'available' : 'no-observations',
        source: status.source,
        granularity,
        nextCollectionAt,
        station,
        lastAttemptAt: now.toISOString(),
        lastSuccessAt: now.toISOString(),
        lastObservedAt: observations.length
          ? observations
              .map((o) => o.observedAt)
              .sort()
              .at(-1)!
          : null,
        availableMetrics: [...new Set(observations.map((o) => o.metric))],
        records: observations.length,
        note: 'Measured station data only; no interpolation or model-filled gaps. This station is not a measurement at your house. Daily scoring requires all hours for each metric.',
      };
      await this.stationDaily.saveCollectionStatus(status.source!, this.last);
    } catch (error) {
      // Do not leak API credentials or upstream bodies through errors or logs.
      this.last = {
        status: 'unavailable',
        source: status.source,
        lastAttemptAt: now.toISOString(),
        lastSuccessAt,
        granularity,
        nextCollectionAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
        ...(status.source === NIMH_RAIN_SOURCE
          ? { availableMetrics: [], valueUnitStatus: 'unverified' as const }
          : {}),
        note:
          error instanceof Error && error.message === DAILY_REVISION_MESSAGE
            ? DAILY_REVISION_MESSAGE
            : status.source === NIMH_RAIN_SOURCE
              ? 'NIMH collection failed. Check source availability, CSV structure, and station 1020 identity. Unit and period remain unverified; saved evidence is unscored.'
              : 'Station collection failed. Check the server API key, station identity, distance (maximum 25 km), and observation availability. No missing data was replaced with zero.',
      };
      try {
        await this.stationDaily.saveCollectionStatus(status.source!, this.last);
      } catch {
        /* Storage failures must not stop forecast evaluation. */
      }
    }
    return this.last;
  }

  async collectAtCoordinates(
    request: HourlyPrecipitationRequest,
    now = new Date(),
  ): Promise<CollectionStatus> {
    const { latitude, longitude, startAt, endAt } = request;
    const label = process.env.METEOSTAT_INTERVAL_LABEL;
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    const expectedHours = (end - start) / HOUR_MS;
    const validUtcHour = (value: string, timestamp: number) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value) &&
      Number.isFinite(timestamp) &&
      timestamp % HOUR_MS === 0 &&
      new Date(timestamp).toISOString() === value;
    if (
      process.env.WEATHER_OBSERVATION_PROVIDER !== 'meteostat' ||
      process.env.WEATHER_OBSERVATION_COLLECTION_ENABLED !== 'true'
    ) {
      return {
        status: 'disabled',
        source: null,
        granularity: 'hourly',
        note: 'Coordinate-based Meteostat collection is disabled or not selected.',
      };
    }
    if (
      !process.env.METEOSTAT_API_KEY ||
      (label !== 'start' && label !== 'end')
    ) {
      return {
        status: 'configuration-required',
        source: null,
        granularity: 'hourly',
        note: 'Meteostat needs an API key and an explicitly verified hourly interval label.',
      };
    }
    if (
      request.metric !== 'precipitation_mm' ||
      !validWeatherCoordinates(request) ||
      !validUtcHour(startAt, start) ||
      !validUtcHour(endAt, end) ||
      expectedHours < 1 ||
      expectedHours > 30 * 24 ||
      end > now.getTime() ||
      start < now.getTime() - 30 * 24 * HOUR_MS
    ) {
      return {
        status: 'unavailable',
        source: null,
        granularity: 'hourly',
        note: 'Provide valid coordinates and a past, hour-aligned UTC interval of at most 30 days.',
      };
    }
    const bounds = this.nearbySearchBounds();
    if (!bounds) {
      return {
        status: 'configuration-required',
        source: null,
        granularity: 'hourly',
        note: `Set METEOSTAT_NEARBY_RADIUS_KM from 1 to ${MAX_NEARBY_RADIUS_KM} and METEOSTAT_NEARBY_STATION_LIMIT from 1 to ${MAX_NEARBY_STATION_LIMIT}.`,
      };
    }
    const { radiusKm, stationLimit } = bounds;

    const coordinateKey = weatherCoordinateKey(request);
    const claimSource = `meteostat:nearby:${coordinateKey}:hourly-${label}`;
    const base: CollectionStatus = {
      status: 'ready',
      source: claimSource,
      granularity: 'hourly',
      targetCoordinates: coordinateKey,
      note: 'Searching nearby stations for actual precipitation observations; model substitution is disabled.',
    };
    try {
      const claim = await this.stationDaily.claimCollection(claimSource, now);
      if (!claim.claimed) {
        const snapshot = claim.snapshot as Partial<CollectionStatus> | null;
        return snapshot
          ? { ...base, ...snapshot }
          : {
              ...base,
              note: 'Collection was already attempted in the last 24 hours.',
            };
      }
      const nearby = await this.request('nearby', {
        lat: String(latitude),
        lon: String(longitude),
        radius: String(radiusKm * 1000),
        limit: String(stationLimit),
      });
      if (!Array.isArray(nearby?.data) || nearby.data.length > stationLimit)
        throw new Error('Invalid nearby station response');

      const startDate = startAt.slice(0, 10);
      const endDate = new Date(end - 1).toISOString().slice(0, 10);
      const expected = expectedHours;
      const candidates: Array<{
        station: Station;
        source: string;
        observations: ReturnType<typeof meteostatPrecipitationObservations>;
      }> = [];
      let apiFailures = 0;
      let unverifiedIntervalStations = 0;
      let unverifiedStation: Station | undefined;
      const verifiedStationIds = new Set(
        (process.env.METEOSTAT_INTERVAL_VERIFIED_STATION_IDS ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      );
      const seenStationIds = new Set<string>();
      for (const nearbyStation of nearby.data) {
        if (
          typeof nearbyStation?.id !== 'string' ||
          !/^[A-Za-z0-9]{1,12}$/.test(nearbyStation.id) ||
          typeof nearbyStation.distance !== 'number' ||
          !Number.isFinite(nearbyStation.distance) ||
          nearbyStation.distance < 0 ||
          nearbyStation.distance > radiusKm * 1000
        )
          continue;
        if (seenStationIds.has(nearbyStation.id)) continue;
        seenStationIds.add(nearbyStation.id);
        try {
          const metadata = await this.request('meta', { id: nearbyStation.id });
          const data = metadata?.data;
          const stationLatitude = data?.location?.latitude;
          const stationLongitude = data?.location?.longitude;
          if (
            data?.id !== nearbyStation.id ||
            !validWeatherCoordinates({
              latitude: stationLatitude,
              longitude: stationLongitude,
            })
          )
            continue;
          const distanceKm = stationDistanceKm(
            stationLatitude,
            stationLongitude,
            latitude,
            longitude,
          );
          if (distanceKm > radiusKm) continue;
          const inventory = data.inventory?.hourly;
          if (
            typeof inventory?.start !== 'string' ||
            typeof inventory?.end !== 'string' ||
            inventory.start > endDate ||
            inventory.end < startDate
          )
            continue;
          const station: Station = {
            id: nearbyStation.id,
            name: data.name?.en || nearbyStation.id,
            latitude: stationLatitude,
            longitude: stationLongitude,
            distanceKm,
            reportedDistanceKm: nearbyStation.distance / 1000,
            country: data.country,
            region: data.region,
            timezone: data.timezone,
            identifiers: data.identifiers ?? data.identifier,
            inventory: data.inventory,
          };
          if (!verifiedStationIds.has(nearbyStation.id)) {
            unverifiedIntervalStations++;
            if (
              !unverifiedStation ||
              station.distanceKm < unverifiedStation.distanceKm
            )
              unverifiedStation = station;
            continue;
          }
          const hourly = await this.request('hourly', {
            station: nearbyStation.id,
            start: startDate,
            end: endDate,
            tz: 'UTC',
            model: 'false',
            units: 'metric',
          });
          if (!Array.isArray(hourly?.data) || hourly.data.length > 31 * 24)
            throw new Error('Invalid station data');
          const observations = meteostatPrecipitationObservations(
            hourly.data as MeteostatHour[],
            label,
            startAt,
            endAt,
          );
          if (!observations.length) continue;
          const source = `meteostat:${nearbyStation.id}@${stationLatitude.toFixed(5)},${stationLongitude.toFixed(5)}:hourly-${label}`;
          candidates.push({
            station,
            source,
            observations,
          });
        } catch {
          apiFailures++;
        }
      }
      candidates.sort(
        (a, b) =>
          b.observations.length - a.observations.length ||
          a.station.distanceKm - b.station.distanceKm ||
          a.station.id.localeCompare(b.station.id),
      );
      const selected = candidates[0];
      if (!selected) {
        const previous =
          this.last?.targetCoordinates === coordinateKey
            ? this.last
            : undefined;
        this.last = {
          ...base,
          status: unverifiedIntervalStations
            ? 'reporting-period-unverified'
            : 'unavailable',
          source: previous?.source ?? claimSource,
          lastSuccessAt: previous?.lastSuccessAt,
          station: previous?.station ?? unverifiedStation,
          lastAttemptAt: now.toISOString(),
          note: unverifiedIntervalStations
            ? `Station ${unverifiedStation?.id} at ${unverifiedStation?.distanceKm.toFixed(1)} km was found, but its hourly interval label is unverified. Add only individually verified station IDs to METEOSTAT_INTERVAL_VERIFIED_STATION_IDS.`
            : apiFailures
              ? 'Nearby station requests failed or returned no usable precipitation observations.'
              : 'No nearby station has precipitation observations in the requested interval.',
          attribution:
            'Meteostat API; station source metadata was not available.',
        };
      } else {
        const observations = selected.observations;
        for (let index = 0; index < observations.length; index += 100) {
          await this.verification.ingest(
            selected.source,
            coordinateKey,
            observations.slice(index, index + 100),
          );
        }
        const observedHours = observations.length;
        this.last = {
          status: observedHours === expected ? 'available' : 'partial-coverage',
          source: selected.source,
          targetCoordinates: coordinateKey,
          station: selected.station,
          granularity: 'hourly',
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          lastObservedAt:
            observations
              .map((observation) => observation.observedAt)
              .sort()
              .at(-1) ?? null,
          availableMetrics: ['precipitation_mm'],
          records: observedHours,
          coverage: {
            expectedHours: expected,
            observedHours,
            missingHours: expected - observedHours,
            complete: observedHours === expected,
          },
          attribution:
            'Meteostat API aggregation; original data provider is not identified in this response.',
          note:
            observedHours === expected
              ? 'Actual station precipitation only; model substitution is disabled.'
              : 'Only reported station values were stored. Missing hours remain missing; no station series were combined.',
        };
      }
      await this.stationDaily.saveCollectionStatus(claimSource, this.last);
      return this.last;
    } catch {
      const previous =
        this.last?.targetCoordinates === coordinateKey ? this.last : undefined;
      this.last = {
        ...base,
        status: 'unavailable',
        source: previous?.source ?? claimSource,
        station: previous?.station,
        lastSuccessAt: previous?.lastSuccessAt,
        lastAttemptAt: now.toISOString(),
        note: 'Nearby station discovery or observation collection failed. Check Meteostat availability and station coverage.',
        attribution:
          'Meteostat API; station source metadata was not available.',
      };
      try {
        await this.stationDaily.saveCollectionStatus(claimSource, this.last);
      } catch {
        /* Keep API failure status even if status persistence is unavailable. */
      }
      return this.last;
    }
  }
}
