import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NIMH_RAIN_SOURCE,
  nimhRainSourceUrl,
  parseNimhRainCsv,
} from './nimh-rain';

// Two exact rows from NIMH's October 2026 monthly CSV, downloaded 2026-11-05.
// Source: https://info.meteo.bg/openData/static/csvs/mosv_prec_202610.csv
const fixture = readFileSync(
  join(__dirname, 'testdata/nimh-vidin-202610.csv'),
  'utf8',
);
const url = nimhRainSourceUrl(2026, 10);
const fetchedAt = '2026-11-05T12:00:00.000Z';
const now = new Date('2026-11-05T12:00:00.000Z');

describe('NIMH daily rain reports', () => {
  it('matches station 1020 to Vidin and preserves report provenance and raw values', () => {
    const observations = parseNimhRainCsv(
      fixture,
      2026,
      10,
      url,
      fetchedAt,
      now,
    );
    expect(NIMH_RAIN_SOURCE).toBe('nimh:1020:daily-rain-raw-unit-unverified');
    expect(observations.map((o) => o.date)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-27',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
    ]);
    expect(observations.map((o) => o.value)).toEqual([
      2, 6, 0, 0, 2, 3,
    ]);
    expect(observations[0]).toMatchObject({
      metric: 'precipitation_mm',
      timezone: 'Europe/Sofia',
      periodBasis: 'unverified',
      startsAt: null,
      endsAt: null,
      periodReference: null,
      original: {
        source: 'NIMH',
        sourceUrl: url,
        fetchedAt,
        station: { id: '1020', name: 'Vidin' },
        reportDate: '2026-10-22',
        rawValue: '2.',
        rawUnit: 'unverified',
        numericUnitStatus: 'unverified',
        valueRepresentation: 'unscaled raw number; numeric unit unverified',
        dataStatus: 'preliminary-operational-unverified',
      },
    });
  });

  it('keeps blank values missing and explicit zero as a measurement', () => {
    const observations = parseNimhRainCsv(
      fixture,
      2026,
      10,
      url,
      fetchedAt,
      now,
    );
    expect(observations.some((o) => o.date === '2026-10-24')).toBe(false);
    expect(observations.find((o) => o.date === '2026-10-27')?.value).toBe(0);
    expect(observations.find((o) => o.date === '2026-10-29')?.value).toBe(0);
    const [header, station] = fixture.trimEnd().split('\n');
    const fields = station.split(',');
    fields[25] = ' n.a. ';
    expect(
      parseNimhRainCsv(
        `${header}\n${fields.join(',')}`,
        2026,
        10,
        url,
        fetchedAt,
        now,
      ).some((o) => o.date === '2026-10-24'),
    ).toBe(false);
  });

  it.each([
    ['spring DST', '2026-03-29', new Date('2026-04-01T12:00:00Z')],
    ['autumn DST', '2026-10-25', new Date('2026-11-05T12:00:00Z')],
  ])('does not invent a timestamp around %s', (_label, reportDate, asOf) => {
    const [year, month, day] = (reportDate as string).split('-').map(Number);
    const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const header = `, ,${Array.from({ length: count }, (_, i) => ` ${i + 1} `).join(',')}`;
    const values = Array.from({ length: count }, (_, i) =>
      i + 1 === day ? '1.' : '',
    );
    const csv = `${header}\n1020,Vidin,${values.join(',')}\n`;
    const [y, m] = [year, month];
    const result = parseNimhRainCsv(
      csv,
      y,
      m,
      nimhRainSourceUrl(y, m),
      fetchedAt,
      asOf as Date,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: reportDate,
      timezone: 'Europe/Sofia',
      periodBasis: 'unverified',
      startsAt: null,
      endsAt: null,
    });
  });

  it('rejects wrong station identity, duplicate station rows, invalid dates, units, and malformed files', () => {
    const [header, station] = fixture.trimEnd().split('\n');
    const run = (csv: string) =>
      parseNimhRainCsv(csv, 2026, 10, url, fetchedAt, now);
    const invalidUnit = station.split(',');
    invalidUnit[23] = ' mm';
    expect(() =>
      run(`${header}\n1020,Montana,${station.split(',').slice(2).join(',')}`),
    ).toThrow('not Vidin');
    expect(() => run(`${header}\n${station}\n${station}`)).toThrow('Duplicate');
    expect(() => run(`${header.replace('  1 ', ' 32 ')}\n${station}`)).toThrow(
      'header',
    );
    expect(() => run(`${header}\n${invalidUnit.join(',')}`)).toThrow(
      'rainfall value',
    );
    expect(() =>
      run(`${header}\n${station.split(',').slice(0, -1).join(',')}`),
    ).toThrow('row width');
    expect(() =>
      run(`${header}\n1019,Montana,${station.split(',').slice(2).join(',')}`),
    ).toThrow('missing');
    expect(() =>
      parseNimhRainCsv(fixture, 2026, 13, url, fetchedAt, now),
    ).toThrow('month');
    expect(() =>
      parseNimhRainCsv(fixture, 2026, 10, url, 'not-a-date', now),
    ).toThrow('provenance');
    expect(() =>
      parseNimhRainCsv(
        fixture,
        2026,
        10,
        'https://info.meteo.bg/other.csv',
        fetchedAt,
        now,
      ),
    ).toThrow('provenance');
  });
});
