import { Injectable, Logger } from '@nestjs/common';

import { WeatherSnapshot } from './weather-data-quality';

type OpenMeteoResponse = any;
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const instant = (value: unknown): string | null => {
  const date = typeof value === 'number' ? new Date(value * 1000) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

@Injectable()
export class WeatherProviderService {
  private readonly logger = new Logger(WeatherProviderService.name);

  private readonly cache = new Map<string, { expires: number; snapshot: WeatherSnapshot }>();
  private readonly pending = new Map<string, Promise<WeatherSnapshot>>();

  async getSnapshot(model: 'best_match' | 'icon_seamless' | 'ncep_gfs_seamless' = 'best_match'): Promise<WeatherSnapshot> {
    const cached = this.cache.get(model);
    if (cached && cached.expires > Date.now()) return cached.snapshot;
    const pending = this.pending.get(model);
    if (pending) return pending;
    const request = this.fetchSnapshot(model).then(snapshot => {
      const ttl = snapshot.availability === 'available' ? 10 * 60000 : 60000;
      this.cache.set(model, { expires: Date.now() + ttl, snapshot });
      return snapshot;
    }).finally(() => this.pending.delete(model));
    this.pending.set(model, request);
    return request;
  }

  private async fetchSnapshot(model: string): Promise<WeatherSnapshot> {
    try {
      return await this.getOpenMeteoSnapshot(model);
    } catch (error) {
      this.logger.warn(`Open-Meteo failed, weather unavailable: ${String(error)}`);
      return { ...this.getFallbackSnapshot(), model };
    }
  }

  private async getOpenMeteoSnapshot(model: string): Promise<WeatherSnapshot> {
    const latitude = 43.9916;
    const longitude = 22.8728;

    const params = new URLSearchParams({
      models: model,
      latitude: String(latitude),
      longitude: String(longitude),
      timezone: 'Europe/Sofia',
      timeformat: 'unixtime',
      temperature_unit: 'celsius',
      wind_speed_unit: 'kmh',
      precipitation_unit: 'mm',
      forecast_days: '12',
      current: [
        'temperature_2m',
        'apparent_temperature',
        'relative_humidity_2m',
        'surface_pressure',
        'weather_code',
        'wind_speed_10m',
        'wind_gusts_10m',
      ].join(','),
      hourly: [
        'temperature_2m',
        'apparent_temperature',
        'relative_humidity_2m',
        'surface_pressure',
        'precipitation_probability',
        'precipitation',
        'rain',
        'showers',
        'weather_code',
        'wind_speed_10m',
        'wind_gusts_10m',
      ].join(','),
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_sum',
        'precipitation_probability_max',
        'weather_code',
        'wind_speed_10m_max',
        'wind_gusts_10m_max',
      ].join(','),
    });

    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, { signal: AbortSignal.timeout(8000) });

    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);

    const data = (await response.json()) as OpenMeteoResponse;

    return {
      location: 'Vidin',
      coordinates: { latitude, longitude },
      provider: 'open-meteo',
      model,
      availability: 'available',
      units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
      fetchedAt: new Date().toISOString(),
      current: {
        time: instant(data.current?.time),
        temperature: numberOrNull(data.current?.temperature_2m),
        feelsLike: numberOrNull(data.current?.apparent_temperature),
        humidity: numberOrNull(data.current?.relative_humidity_2m),
        pressure: numberOrNull(data.current?.surface_pressure),
        windKmh: numberOrNull(data.current?.wind_speed_10m),
        gustKmh: numberOrNull(data.current?.wind_gusts_10m),
        weatherCode: numberOrNull(data.current?.weather_code),
        condition: this.describeWeatherCode(data.current?.weather_code),
      },
      hourly: this.mapHourly(data),
      daily: this.mapDaily(data),
      alerts: [],
    };
  }

  private mapHourly(data: OpenMeteoResponse) {
    const h = data.hourly;
    if (!h?.time?.length) return [];

    return h.time.map((time: number, index: number) => ({
      time: instant(time),
      temperature: numberOrNull(h.temperature_2m?.[index]),
      feelsLike: numberOrNull(h.apparent_temperature?.[index]),
      humidity: numberOrNull(h.relative_humidity_2m?.[index]),
      pressure: numberOrNull(h.surface_pressure?.[index]),
      rainChance: numberOrNull(h.precipitation_probability?.[index]),
      precipitationMm: numberOrNull(h.precipitation?.[index]),
      rainMm: numberOrNull(h.rain?.[index]),
      showersMm: numberOrNull(h.showers?.[index]),
      weatherCode: numberOrNull(h.weather_code?.[index]),
      condition: this.describeWeatherCode(h.weather_code?.[index]),
      windKmh: numberOrNull(h.wind_speed_10m?.[index]),
      gustKmh: numberOrNull(h.wind_gusts_10m?.[index]),
    }));
  }

  private mapDaily(data: OpenMeteoResponse) {
    const d = data.daily;
    if (!d?.time?.length) return [];

    return d.time.map((date: number, index: number) => ({
      date: instant(date) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date * 1000)) : '',
      tempMax: numberOrNull(d.temperature_2m_max?.[index]),
      tempMin: numberOrNull(d.temperature_2m_min?.[index]),
      rainTotalMm: numberOrNull(d.precipitation_sum?.[index]),
      rainChanceMax: numberOrNull(d.precipitation_probability_max?.[index]),
      weatherCode: numberOrNull(d.weather_code?.[index]),
      condition: this.describeWeatherCode(d.weather_code?.[index]),
      windMaxKmh: numberOrNull(d.wind_speed_10m_max?.[index]),
      gustMaxKmh: numberOrNull(d.wind_gusts_10m_max?.[index]),
    }));
  }

  private describeWeatherCode(code?: number | null): string {
    const map: Record<number, string> = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      71: 'Slight snow',
      73: 'Moderate snow',
      75: 'Heavy snow',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail',
    };

    return code == null ? 'Unknown' : map[code] ?? `Weather code ${code}`;
  }

  private getFallbackSnapshot(): WeatherSnapshot {
    return {
      location: 'Vidin', coordinates: { latitude: 43.9916, longitude: 22.8728 },
      provider: 'open-meteo', availability: 'unavailable',
      units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
      fetchedAt: new Date().toISOString(),
      current: { time: null, temperature: null, feelsLike: null, humidity: null,
        pressure: null, windKmh: null, gustKmh: null, condition: 'Unavailable', weatherCode: null },
      hourly: [], daily: [], alerts: [],
    };
  }
}
