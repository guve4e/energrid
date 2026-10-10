export interface ForecastDay {
  date: string;
  tempMax: number | null;
  tempMin: number | null;
  rainTotalMm: number | null;
  rainChanceMax: number | null;
  weatherCode: number | null;
  condition: string;
  gustMaxKmh: number | null;
  windMaxKmh?: number | null;
  sourceModel?: string | null;
  agreement?: 'agreement' | 'disagreement' | 'single-model';
  selectionReason?: string;
  disagreementReasons?: string[];
}

export interface ForecastHour {
  time: string;
  temperature: number | null;
  feelsLike: number | null;
  humidity: number | null;
  pressure: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  precipitationMm: number | null;
  rainChance: number | null;
  condition: string;
}

export interface ForecastDayDetails {
  date: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  sourceProvider: string;
  sourceModel: string | null;
  hours: ForecastHour[];
  coverage: {
    status: 'complete' | 'partial' | 'unavailable';
    availableHours: number;
    expectedHours: number;
    precipitationHours: number;
  };
  statistics: {
    wetHours: number | null;
    maxHourlyMm: number | null;
    peakRainAt: string | null;
    peakGustAt: string | null;
    meanHumidityPct: number | null;
    meanPressureHpa: number | null;
    rainWindows: Array<{ startsAt: string; endsAt: string }>;
  };
  models: Array<ForecastDay & { provider: string; model: string | null }>;
}
