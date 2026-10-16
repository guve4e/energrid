import { Injectable } from '@nestjs/common';
import { HOUR_MS } from './weather-data-quality';
import {
  meteostatObservations,
  MeteostatHour,
  stationDistanceKm,
  weatherObservationSource,
  weatherObservationMode,
} from './weather-observations';
import {
  dailyPeriodConfiguration,
  meteostatDailyObservations,
} from './weather-station-daily';
import {
  DAILY_REVISION_MESSAGE,
  WeatherStationDailyService,
} from './weather-station-daily.service';
import { weatherDate } from './weather-calendar';
import {
  VIDIN_LOCATION,
  WeatherVerificationService,
} from './weather-verification.service';

interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}
interface CollectionStatus {
  status:
    | 'configuration-required'
    | 'ready'
    | 'available'
    | 'no-observations'
    | 'unavailable'
    | 'manual'
    | 'disabled'
    | 'reporting-period-unverified';
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
      return {
        status: 'configuration-required',
        source: source || null,
        granularity,
        note:
          granularity === 'daily'
            ? 'Meteostat daily collection needs a server API key and a station ID. Model-filled data is disabled.'
            : 'Meteostat needs a server API key, a station ID, and a verified hourly interval label. Model-filled data is disabled.',
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

  async collect(now = new Date()): Promise<CollectionStatus> {
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
        this.last = claim.snapshot ??
          this.last ?? {
            ...status,
            note: 'Collection already attempted in the last 24 hours. Waiting for the next daily cycle.',
          };
        return this.last!;
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
      const distanceKm = stationDistanceKm(latitude, longitude);
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
        note:
          error instanceof Error && error.message === DAILY_REVISION_MESSAGE
            ? DAILY_REVISION_MESSAGE
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
}
