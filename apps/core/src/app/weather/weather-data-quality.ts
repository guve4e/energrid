/** All instants are ISO 8601 UTC; daily dates remain provider-local calendar dates. */
export interface WeatherReading {
  time: string | null;
  temperature: number | null;
  feelsLike: number | null;
  humidity: number | null;
  pressure: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  weatherCode: number | null;
  condition: string;
}
export interface WeatherHour extends WeatherReading {
  rainChance: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  showersMm: number | null;
}
export interface WeatherDay {
  date: string;
  tempMax: number | null;
  tempMin: number | null;
  rainTotalMm: number | null;
  rainChanceMax: number | null;
  weatherCode: number | null;
  condition: string;
  windMaxKmh: number | null;
  gustMaxKmh: number | null;
}
export interface WeatherSnapshot {
  location: string;
  coordinates: { latitude: number; longitude: number };
  provider: string;
  model?: string;
  fetchedAt: string;
  availability: 'available' | 'unavailable';
  units: { temperature: 'celsius'; wind: 'km/h'; precipitation: 'mm' };
  current: WeatherReading;
  hourly: WeatherHour[];
  daily: WeatherDay[];
  alerts: unknown[];
}
export const HOUR_MS = 60 * 60 * 1000;
export const HIGH_WIND_KMH = 70;
const weatherCodes = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
export function forecastWindow(snapshot: WeatherSnapshot, now = Date.now()): WeatherHour[] {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS;
  return snapshot.hourly.filter(h => Date.parse(h.time ?? '') >= start)
    .sort((a, b) => Date.parse(a.time ?? '') - Date.parse(b.time ?? ''));
}
function validRiskReading(reading: WeatherReading): boolean {
  return Number.isFinite(reading.gustKmh) && reading.gustKmh! >= 0 &&
    weatherCodes.has(reading.weatherCode!);
}
export function assessWeather(snapshot: WeatherSnapshot, now = Date.now()) {
  const reasons: string[] = [];
  if (snapshot.availability !== 'available') reasons.push('provider_unavailable');
  const fetchedAge = now - Date.parse(snapshot.fetchedAt);
  const currentAge = now - Date.parse(snapshot.current.time ?? '');
  const stale = !Number.isFinite(fetchedAge) || fetchedAge < -300000 || fetchedAge > 30 * 60000 ||
    !Number.isFinite(currentAge) || currentAge < -300000 || currentAge > 2 * HOUR_MS;
  if (stale) reasons.push('stale_or_invalid_timestamp');
  if (!validRiskReading(snapshot.current)) reasons.push('missing_current_risk_fields');
  const hours = forecastWindow(snapshot, now).slice(0, 7);
  const start = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (hours.length < 7 || hours.some((h, i) =>
    Date.parse(h.time ?? '') !== start + i * HOUR_MS || !validRiskReading(h) ||
    !Number.isFinite(h.rainChance) || h.rainChance! < 0 || h.rainChance! > 100 ||
    !Number.isFinite(h.precipitationMm) || h.precipitationMm! < 0)) {
    reasons.push('incomplete_six_hour_forecast');
  }
  const status = snapshot.availability !== 'available' ? 'unavailable' :
    stale ? 'stale' : reasons.length ? 'partial' : 'available';
  return { status, reasons, forecastUsable: reasons.length === 0,
    // Device policies and independent-source validation are not implemented yet.
    automationEligible: false as const };
}
