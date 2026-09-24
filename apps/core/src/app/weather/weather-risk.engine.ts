import { Injectable } from '@nestjs/common';
import { assessWeather, forecastWindow, HIGH_WIND_KMH, WeatherSnapshot } from './weather-data-quality';

@Injectable()
export class WeatherRiskEngine {
  evaluate(snapshot: WeatherSnapshot) {
    const quality = assessWeather(snapshot);
    if (!quality.forecastUsable) return { level: 'unknown', risks: [], dataQuality: quality };
    const risks: string[] = [];
    const readings = [snapshot.current, ...forecastWindow(snapshot).slice(0, 7)];
    if (readings.some(reading => reading.gustKmh! >= HIGH_WIND_KMH)) risks.push('HIGH_WIND');
    if (readings.some(reading => [95, 96, 99].includes(reading.weatherCode!))) risks.push('THUNDERSTORM');
    return { level: risks.length ? 'high' : 'low', risks, dataQuality: quality };
  }
}
