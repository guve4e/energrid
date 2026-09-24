import { Injectable } from '@nestjs/common';

import { assessWeather, forecastWindow, HIGH_WIND_KMH, WeatherSnapshot } from './weather-data-quality';

const radarUnavailable = { status: 'unavailable', stormDirection: null, nearestCell: null, eta: null, trend: null };

type RiskLevel = 'normal' | 'watch' | 'danger';

@Injectable()
export class WeatherIntelligenceService {
  analyze(snapshot: WeatherSnapshot, river: any, riskReport: any) {
    const dataQuality = assessWeather(snapshot);
    if (!dataQuality.forecastUsable) return {
      headline: 'Weather assessment unavailable', severity: 'unknown', confidence: 'unavailable',
      subtitle: 'Weather data is missing, incomplete or stale. Do not infer safe conditions.',
      recommendations: ['Check weather sources before making weather-dependent decisions.'],
      today: { tempMax: null, tempMin: null, windMaxKmh: null, gustMaxKmh: null, rainTotalMm: null, rainChanceMax: null },
      daily: [], timeline: [], dataQuality,
      risks: { vehicleHail: 'unknown', stormEta: 'unknown', windDanger: 'unknown', floodConcern: 'unknown' },
      radarSummary: radarUnavailable,
    };
    const hourly = forecastWindow(snapshot);
    const startIndex = 0;

    const next12h = hourly
      .slice(startIndex, startIndex + 12)
      .map((hour: any, index: number) => ({
        offset: index,
        time: hour.time,
        temperature: hour.temperature,
        weatherCode: hour.weatherCode,
        condition: hour.condition,
        rainChance: hour.rainChance,
        precipitationMm: hour.precipitationMm,
        windKmh: hour.windKmh,
        gustKmh: hour.gustKmh,
        risk: this.hourRisk(hour),
      }));

    const next6h = next12h.slice(0, 7);

    const hasThunderstorm = this.hasWeatherCode([snapshot.current, ...next6h], [95, 96, 99]);
    const hasHail = this.hasWeatherCode([snapshot.current, ...next6h], [96, 99]);
    const maxGust = this.max([snapshot.current.gustKmh, ...next6h.map((h: any) => h.gustKmh)]);
    const maxRainChance = this.max(next6h.map((h: any) => h.rainChance));

    const vehicleHail = hasHail ? 'move vehicle' : hasThunderstorm ? 'monitor' : 'low';
    const windDanger = maxGust >= HIGH_WIND_KMH ? 'secure now' : maxGust >= 45 ? 'monitor' : 'low';
    const stormEta = this.findFirstRiskEta(next6h);
    const floodConcern =
      !river ? 'unknown' : river.trend === 'rising' && river.difference24hCm > 50 ? 'watch' : 'none';

    const severity: RiskLevel =
      hasHail || maxGust >= HIGH_WIND_KMH
        ? 'danger'
        : hasThunderstorm || maxGust >= 45 || maxRainChance >= 50
          ? 'watch'
          : 'normal';

    return {
      headline:
        severity === 'danger'
          ? 'Action needed'
          : severity === 'watch'
            ? 'Watch conditions'
            : 'No elevated risk in available forecast',

      severity,
      confidence: 'single-source',
      dataQuality,

      subtitle:
        severity === 'normal'
          ? 'This forecast model shows no elevated risk in the next six hours; this is not a radar observation.'
          : 'Weather risk is building. Monitor radar and alerts.',

      recommendations:
        severity === 'normal'
          ? [
              'No urgent action.',
              'Check independent warnings before weather-dependent decisions.',
              'Keep normal monitoring active.',
            ]
          : [
              'Check vehicle exposure.',
              'Secure loose outdoor materials.',
              'Monitor radar updates.',
            ],

      today: this.todaySummary(snapshot),

      daily: (snapshot.daily || []).slice(0, 12),

      risks: {
        vehicleHail,
        stormEta: stormEta || 'none forecast',
        windDanger,
        floodConcern,
      },

      radarSummary: radarUnavailable,

      timeline: next12h,
    };
  }

  private todaySummary(snapshot: any) {
    const today = snapshot.daily?.[0];
    const hourly = snapshot.hourly || [];

    return {
      tempMax: today?.tempMax ?? null,
      tempMin: today?.tempMin ?? null,
      windMaxKmh: today?.windMaxKmh ?? this.max(hourly.map((h: any) => h.windKmh)),
      gustMaxKmh: today?.gustMaxKmh ?? this.max(hourly.map((h: any) => h.gustKmh)),
      rainTotalMm: today?.rainTotalMm ?? 0,
      rainChanceMax: today?.rainChanceMax ?? this.max(hourly.map((h: any) => h.rainChance)),
    };
  }

  private hourRisk(hour: any) {
    if ([95, 96, 99].includes(hour.weatherCode)) return 'storm';
    if ((hour.gustKmh || 0) >= 60) return 'wind';
    if ((hour.rainChance || 0) >= 40 || (hour.precipitationMm || 0) > 0) return 'rain';
    return 'safe';
  }

  private findFirstRiskEta(items: Array<{ offset: number; risk?: string }>) {
    const risky = items.find((item) => item.risk && item.risk !== 'safe');
    if (!risky) return null;
    return risky.offset === 0 ? 'now' : `+${risky.offset}h`;
  }

  private hasWeatherCode(hours: any[], codes: number[]) {
    return hours.some((hour) => codes.includes(hour.weatherCode));
  }

  private max(values: Array<number | null | undefined>) {
    const clean = values.filter((v): v is number => typeof v === 'number');
    return clean.length ? Math.max(...clean) : 0;
  }
}
