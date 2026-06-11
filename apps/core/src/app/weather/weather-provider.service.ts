import { Injectable, Logger } from '@nestjs/common';

type OpenMeteoResponse = any;

@Injectable()
export class WeatherProviderService {
  private readonly logger = new Logger(WeatherProviderService.name);

  async getSnapshot() {
    try {
      return await this.getOpenMeteoSnapshot();
    } catch (error) {
      this.logger.warn(`Open-Meteo failed, using fallback data: ${String(error)}`);
      return this.getFallbackSnapshot();
    }
  }

  private async getOpenMeteoSnapshot() {
    const latitude = 43.9916;
    const longitude = 22.8728;

    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone: 'Europe/Sofia',
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

    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);

    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);

    const data = (await response.json()) as OpenMeteoResponse;

    return {
      location: 'Vidin',
      coordinates: { latitude, longitude },
      provider: 'open-meteo',
      fetchedAt: new Date().toISOString(),
      current: {
        time: data.current?.time,
        temperature: data.current?.temperature_2m ?? null,
        feelsLike: data.current?.apparent_temperature ?? null,
        humidity: data.current?.relative_humidity_2m ?? null,
        pressure: data.current?.surface_pressure ?? null,
        windKmh: data.current?.wind_speed_10m ?? null,
        gustKmh: data.current?.wind_gusts_10m ?? null,
        weatherCode: data.current?.weather_code ?? null,
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

    return h.time.map((time: string, index: number) => ({
      time,
      temperature: h.temperature_2m?.[index] ?? null,
      feelsLike: h.apparent_temperature?.[index] ?? null,
      humidity: h.relative_humidity_2m?.[index] ?? null,
      pressure: h.surface_pressure?.[index] ?? null,
      rainChance: h.precipitation_probability?.[index] ?? null,
      precipitationMm: h.precipitation?.[index] ?? null,
      rainMm: h.rain?.[index] ?? null,
      showersMm: h.showers?.[index] ?? null,
      weatherCode: h.weather_code?.[index] ?? null,
      condition: this.describeWeatherCode(h.weather_code?.[index]),
      windKmh: h.wind_speed_10m?.[index] ?? null,
      gustKmh: h.wind_gusts_10m?.[index] ?? null,
    }));
  }

  private mapDaily(data: OpenMeteoResponse) {
    const d = data.daily;
    if (!d?.time?.length) return [];

    return d.time.map((date: string, index: number) => ({
      date,
      tempMax: d.temperature_2m_max?.[index] ?? null,
      tempMin: d.temperature_2m_min?.[index] ?? null,
      rainTotalMm: d.precipitation_sum?.[index] ?? null,
      rainChanceMax: d.precipitation_probability_max?.[index] ?? null,
      weatherCode: d.weather_code?.[index] ?? null,
      condition: this.describeWeatherCode(d.weather_code?.[index]),
      windMaxKmh: d.wind_speed_10m_max?.[index] ?? null,
      gustMaxKmh: d.wind_gusts_10m_max?.[index] ?? null,
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

  private getFallbackSnapshot() {
    return {
      location: 'Vidin',
      provider: 'fallback',
      fetchedAt: new Date().toISOString(),
      current: {
        temperature: 22,
        feelsLike: 22,
        humidity: 55,
        pressure: 1014,
        windKmh: 48,
        gustKmh: 72,
        condition: 'Thunderstorms',
        weatherCode: 95,
      },
      hourly: [],
      daily: [],
      alerts: [],
    };
  }
}
