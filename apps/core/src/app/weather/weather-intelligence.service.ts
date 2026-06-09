import { Injectable } from '@nestjs/common';

type RiskLevel = 'normal' | 'watch' | 'danger';

@Injectable()
export class WeatherIntelligenceService {
  analyze(snapshot: any, river: any, riskReport: any) {
    const hourly = snapshot.hourly || [];
    const currentTime = snapshot.current?.time;
    const startIndex = this.findCurrentHourIndex(hourly, currentTime);

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

    const hasThunderstorm = this.hasWeatherCode(next6h, [95, 96, 99]);
    const hasHail = this.hasWeatherCode(next6h, [96, 99]);
    const maxGust = this.max(next6h.map((h: any) => h.gustKmh));
    const maxRainChance = this.max(next6h.map((h: any) => h.rainChance));

    const vehicleHail = hasHail ? 'move vehicle' : hasThunderstorm ? 'monitor' : 'low';
    const windDanger = maxGust >= 70 ? 'secure now' : maxGust >= 45 ? 'monitor' : 'low';
    const stormEta = this.findFirstRiskEta(next6h);
    const floodConcern =
      river?.trend === 'rising' && river?.difference24hCm > 50 ? 'watch' : 'none';

    const severity: RiskLevel =
      hasHail || maxGust >= 70
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
            : 'Clear next 6 hours',

      severity,
      confidence: 'medium',

      subtitle:
        severity === 'normal'
          ? 'No hail or severe storm activity detected near your location.'
          : 'Weather risk is building. Monitor radar and alerts.',

      recommendations:
        severity === 'normal'
          ? [
              'No urgent action.',
              'Vehicle can stay outside for now.',
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
        stormEta: stormEta || 'clear 6h',
        windDanger,
        floodConcern,
      },

      radarSummary: {
        stormDirection: hasThunderstorm ? 'organized cells possible' : 'no organized cell',
        nearestCell: hasThunderstorm ? 'monitor radar sector' : 'none nearby',
        eta: stormEta || 'clear 6h',
        trend: severity === 'normal' ? 'flat' : 'building',
      },

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

  private findCurrentHourIndex(hourly: any[], currentTime?: string) {
    if (!hourly.length) return 0;
    if (!currentTime) return 0;

    const current = new Date(currentTime).getTime();

    const exact = hourly.findIndex((hour) => hour.time === currentTime);
    if (exact >= 0) return exact;

    const firstFuture = hourly.findIndex((hour) => new Date(hour.time).getTime() >= current);
    return firstFuture >= 0 ? firstFuture : 0;
  }

  private max(values: Array<number | null | undefined>) {
    const clean = values.filter((v): v is number => typeof v === 'number');
    return clean.length ? Math.max(...clean) : 0;
  }
}
