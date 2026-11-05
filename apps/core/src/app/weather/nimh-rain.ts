import { StationDailyObservation } from './weather-station-daily';
import {
  WEATHER_TIMEZONE,
  weatherDate,
  validWeatherDate,
} from './weather-calendar';

export const NIMH_RAIN_SOURCE = 'nimh:1020:daily-rain-raw-unit-unverified';
const NIMH_STATION = { id: '1020', name: 'Vidin' };

export function nimhRainSourceUrl(year: number, month: number) {
  return `https://info.meteo.bg/openData/static/csvs/mosv_prec_${year}${String(month).padStart(2, '0')}.csv`;
}

export function parseNimhRainCsv(
  csv: string,
  year: number,
  month: number,
  sourceUrl: string,
  fetchedAt: string,
  now: Date,
): StationDailyObservation[] {
  if (!validWeatherDate(`${year}-${String(month).padStart(2, '0')}-01`))
    throw new Error('Invalid NIMH report month');
  if (
    !Number.isFinite(Date.parse(fetchedAt)) ||
    sourceUrl !== nimhRainSourceUrl(year, month)
  )
    throw new Error('Invalid NIMH source provenance');

  const lines = csv
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split(/\r?\n/);
  const header = lines.shift()?.split(',');
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    !header ||
    header.length !== daysInMonth + 2 ||
    header[0].trim() !== '' ||
    header[1].trim() !== '' ||
    header.slice(2).some((value, index) => value.trim() !== String(index + 1))
  ) {
    throw new Error('Invalid NIMH daily rain date header');
  }

  let vidin: string[] | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('"')) throw new Error('Unexpected quoted NIMH CSV field');
    const fields = line.split(',');
    if (fields.length !== header.length)
      throw new Error('Invalid NIMH CSV row width');
    if (fields[0].trim() !== NIMH_STATION.id) continue;
    if (vidin) throw new Error('Duplicate NIMH station 1020');
    if (fields[1].trim().toLowerCase() !== 'vidin')
      throw new Error('NIMH station 1020 is not Vidin');
    vidin = fields;
  }
  if (!vidin) throw new Error('NIMH station 1020 is missing');

  const today = weatherDate(now);
  const firstDate = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  const observations: StationDailyObservation[] = [];
  for (let index = 1; index <= daysInMonth; index++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(index).padStart(2, '0')}`;
    if (date < firstDate || date >= today) continue;
    const rawValue = vidin[index + 1].trim();
    // Blank and n.a. mean unavailable; only an explicit numeric zero is a measurement.
    if (!rawValue || /^n\.a\.?$/i.test(rawValue)) continue;
    if (!/^\d+(?:\.\d*)?$/.test(rawValue))
      throw new Error(`Invalid NIMH rainfall value for ${date}`);
    // The existing numeric column is only a raw-number carrier until the unit is known.
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value > 1000)
      throw new Error(`Invalid NIMH rainfall value for ${date}`);

    observations.push({
      date,
      metric: 'precipitation_mm',
      value,
      timezone: WEATHER_TIMEZONE,
      periodBasis: 'unverified',
      startsAt: null,
      endsAt: null,
      periodReference: null,
      original: {
        source: 'NIMH',
        sourceUrl,
        fetchedAt,
        station: NIMH_STATION,
        reportDate: date,
        rawValue,
        rawUnit: 'unverified',
        numericUnitStatus: 'unverified',
        valueRepresentation: 'unscaled raw number; numeric unit unverified',
        dataStatus: 'preliminary-operational-unverified',
      },
    });
  }
  return observations;
}
