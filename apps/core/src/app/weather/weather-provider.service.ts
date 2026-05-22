import { Injectable, Logger } from '@nestjs/common';

type OpenMeteoResponse = {
  latitude: number;
  longitude: number;
  timezone: string;
  current?: {
    time: string;
    temperature_2m?: number;
    wind_speed_10m?: number;
    wind_gusts_10m?: number;
    weather_code?: number;
  };
  hourly?: {
    time: string[];
    temperature_2m?: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
    rain?: number[];
    showers?: number[];
    weather_code?: number[];
    wind_speed_10m?: number[];
    wind_gusts_10m?: number[];
  };
};

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
      forecast_days: '3',
      current: [
        'temperature_2m',
        'weather_code',
        'wind_speed_10m',
        'wind_gusts_10m',
      ].join(','),
      hourly: [
        'temperature_2m',
        'precipitation_probability',
        'precipitation',
        'rain',
        'showers',
        'weather_code',
        'wind_speed_10m',
        'wind_gusts_10m',
      ].join(','),
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}`);
    }

    const data = (await response.json()) as OpenMeteoResponse;

    return {
      location: 'Vidin',
      coordinates: {
        latitude,
        longitude,
      },
      provider: 'open-meteo',
      fetchedAt: new Date().toISOString(),
      current: {
        time: data.current?.time,
        temperature: data.current?.temperature_2m ?? null,
        windKmh: data.current?.wind_speed_10m ?? null,
        gustKmh: data.current?.wind_gusts_10m ?? null,
        weatherCode: data.current?.weather_code ?? null,
        condition: this.describeWeatherCode(data.current?.weather_code),
      },
      hourly: this.mapHourly(data),
      alerts: [],
    };
  }

  private mapHourly(data: OpenMeteoResponse) {
    const hourly = data.hourly;

    if (!hourly?.time?.length) {
      return [];
    }

    return hourly.time.slice(0, 24).map((time, index) => ({
      time,
      temperature: hourly.temperature_2m?.[index] ?? null,
      rainChance: hourly.precipitation_probability?.[index] ?? null,
      precipitationMm: hourly.precipitation?.[index] ?? null,
      rainMm: hourly.rain?.[index] ?? null,
      showersMm: hourly.showers?.[index] ?? null,
      weatherCode: hourly.weather_code?.[index] ?? null,
      condition: this.describeWeatherCode(hourly.weather_code?.[index]),
      windKmh: hourly.wind_speed_10m?.[index] ?? null,
      gustKmh: hourly.wind_gusts_10m?.[index] ?? null,
    }));
  }

  private describeWeatherCode(code?: number | null): string {
    if (code == null) return 'Unknown';

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

    return map[code] ?? `Weather code ${code}`;
  }

  private getFallbackSnapshot() {
    return {
      location: 'Vidin',
      provider: 'fallback',
      fetchedAt: new Date().toISOString(),
      current: {
        temperature: 22,
        windKmh: 48,
        gustKmh: 72,
        condition: 'Thunderstorms',
        weatherCode: 95,
      },
      hourly: [
        { time: '14:00', rainChance: 60, gustKmh: 70, condition: 'Thunderstorm' },
        { time: '15:00', rainChance: 75, gustKmh: 82, condition: 'Thunderstorm' },
      ],
      alerts: [],
    };
  }
}
