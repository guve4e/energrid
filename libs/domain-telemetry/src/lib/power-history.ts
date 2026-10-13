export interface PowerObservation {
  observedAt: string;
  powerW: number | null;
  seriesId?: string;
}

export interface PowerAsset {
  id: string;
  displayName: string;
  tenantId: string;
  siteId: string;
  timezone: string;
  activeThresholdW: number;
  measurementSources?: Array<{
    deviceId: string;
    channel: string;
    from: string;
    to?: string;
  }>;
  capacityLiters?: number;
  schedule?: { start: string; end: string; effectiveFrom?: string };
}

export interface PowerHistoryQuery {
  from: string;
  to: string;
}

export interface PowerHistory {
  observations: PowerObservation[];
  rejectedReadings: number;
  source: string;
  timestampBasis: 'collector-received' | 'device-observed' | 'mixed';
}

export interface PowerHistoryReader {
  read(assetId: string, query: PowerHistoryQuery): Promise<PowerHistory>;
}

export interface PowerStatistics {
  energyKwh: number | null;
  averagePowerW: number | null;
  peakPowerW: number | null;
  activeMinutes: number | null;
  outsideScheduleKwh: number | null;
  coveragePct: number;
  coveredSeconds: number;
  expectedSeconds: number;
}

export interface PowerHour extends PowerStatistics {
  from: string;
  to: string;
  localDate: string;
  localHour: string;
}

export interface PowerDay extends PowerStatistics {
  date: string;
}

export interface PowerAnalysis {
  method: 'power-step-estimate';
  maxGapSeconds: number;
  summary: PowerStatistics;
  hourly: PowerHour[];
  daily: PowerDay[];
  invalidReadings: number;
  duplicateReadings: number;
  conflictingReadings: number;
}

type Accumulator = {
  expectedSeconds: number;
  coveredSeconds: number;
  wattSeconds: number;
  activeSeconds: number;
  outsideWattSeconds: number;
  peak: number | null;
};

function empty(expectedSeconds = 0): Accumulator {
  return {
    expectedSeconds,
    coveredSeconds: 0,
    wattSeconds: 0,
    activeSeconds: 0,
    outsideWattSeconds: 0,
    peak: null,
  };
}

function stats(a: Accumulator, scheduleKnown: boolean): PowerStatistics {
  const known = a.coveredSeconds > 0;
  return {
    energyKwh: known ? a.wattSeconds / 3_600_000 : null,
    averagePowerW: known ? a.wattSeconds / a.coveredSeconds : null,
    peakPowerW: a.peak,
    activeMinutes: known ? a.activeSeconds / 60 : null,
    outsideScheduleKwh:
      known && scheduleKnown ? a.outsideWattSeconds / 3_600_000 : null,
    coveragePct:
      a.expectedSeconds > 0 ? (100 * a.coveredSeconds) / a.expectedSeconds : 0,
    coveredSeconds: a.coveredSeconds,
    expectedSeconds: a.expectedSeconds,
  };
}

function clockMinutes(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error('Invalid schedule time');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export function localDateAt(
  instant: string | number,
  timezone: string,
): string {
  return formattedDate(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
    instant,
  );
}

function formattedDate(
  formatter: Intl.DateTimeFormat,
  instant: string | number,
): string {
  const parts = formatter.formatToParts(new Date(instant));
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}

/** Integrate only bounded, bracketed intervals. No extrapolation across outages or after the last sample. */
export function analyzePowerHistory(
  observations: readonly PowerObservation[],
  query: PowerHistoryQuery,
  asset: Pick<PowerAsset, 'timezone' | 'activeThresholdW' | 'schedule'>,
  maxGapSeconds = 300,
): PowerAnalysis {
  const from = Date.parse(query.from),
    to = Date.parse(query.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    to - from > 31 * 86400000
  )
    throw new Error('Invalid power history range');
  if (
    !Number.isFinite(maxGapSeconds) ||
    maxGapSeconds <= 0 ||
    !Number.isFinite(asset.activeThresholdW) ||
    asset.activeThresholdW < 0
  )
    throw new Error('Invalid power analysis settings');
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: asset.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: asset.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateAt = (at: number) => formattedDate(dateFormatter, at);
  const schedule = asset.schedule;
  const startMinute = schedule ? clockMinutes(schedule.start) : 0;
  const endMinute = schedule ? clockMinutes(schedule.end) : 0;
  if (schedule && startMinute === endMinute)
    throw new Error('Schedule must have distinct start and end');
  const effective = schedule?.effectiveFrom;
  if (
    effective &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(effective) ||
      !Number.isFinite(Date.parse(`${effective}T00:00:00Z`)) ||
      new Date(`${effective}T00:00:00Z`).toISOString().slice(0, 10) !==
        effective)
  )
    throw new Error('Invalid schedule effective date');
  const scheduleKnown = (date: string) =>
    Boolean(schedule && (!effective || date >= effective));
  const byTime = new Map<number, number | null>();
  const seriesByTime = new Map<number, string | undefined>();
  let invalidReadings = 0,
    duplicateReadings = 0,
    conflictingReadings = 0;
  for (const observation of observations) {
    const at = Date.parse(observation.observedAt);
    if (!Number.isFinite(at)) {
      invalidReadings++;
      continue;
    }
    const power =
      typeof observation.powerW === 'number' &&
      Number.isFinite(observation.powerW) &&
      observation.powerW >= 0
        ? observation.powerW
        : null;
    if (power === null) invalidReadings++;
    if (byTime.has(at)) {
      duplicateReadings++;
      if (
        byTime.get(at) !== power ||
        seriesByTime.get(at) !== observation.seriesId
      ) {
        byTime.set(at, null);
        conflictingReadings++;
      }
    } else {
      byTime.set(at, power);
      seriesByTime.set(at, observation.seriesId);
    }
  }
  const samples = [...byTime].sort((a, b) => a[0] - b[0]);
  const hourKeyFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: asset.timezone,
    hour: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const hours: Array<{
    from: number;
    to: number;
    date: string;
    hour: string;
    acc: Accumulator;
  }> = [];
  const hourByMinute = new Map<number, (typeof hours)[number]>();
  const days = new Map<string, Accumulator>();
  const total = empty((to - from) / 1000);
  let previousKey = '';
  for (let at = from; at < to; ) {
    const end = Math.min(to, (Math.floor(at / 60000) + 1) * 60000);
    const date = dateAt(at);
    const key = `${date}|${hourKeyFormatter.format(new Date(at))}`;
    if (key !== previousKey)
      hours.push({
        from: at,
        to: end,
        date,
        hour: formatter.format(new Date(at)),
        acc: empty(),
      });
    const hour = hours[hours.length - 1];
    hour.to = end;
    hour.acc.expectedSeconds += (end - at) / 1000;
    hourByMinute.set(Math.floor(at / 60000), hour);
    previousKey = key;
    const day = days.get(date) ?? empty();
    day.expectedSeconds += (end - at) / 1000;
    days.set(date, day);
    at = end;
  }
  for (let i = 0; i + 1 < samples.length; i++) {
    if (seriesByTime.get(samples[i][0]) !== seriesByTime.get(samples[i + 1][0]))
      continue;
    const [at, power] = samples[i],
      [nextAt, nextPower] = samples[i + 1];
    if (
      power === null ||
      nextPower === null ||
      nextAt - at > maxGapSeconds * 1000
    )
      continue;
    let cursor = Math.max(from, at);
    const end = Math.min(to, nextAt);
    while (cursor < end) {
      const bucket = hourByMinute.get(Math.floor(cursor / 60000))!;
      // Split at local minute boundaries so schedules also work across DST and midnight.
      const pieceEnd = Math.min(
        end,
        bucket.to,
        (Math.floor(cursor / 60000) + 1) * 60000,
      );
      const seconds = (pieceEnd - cursor) / 1000;
      const date = bucket.date;
      const minute = clockMinutes(formatter.format(new Date(cursor)));
      const inside =
        startMinute < endMinute
          ? minute >= startMinute && minute < endMinute
          : minute >= startMinute || minute < endMinute;
      for (const acc of [bucket.acc, days.get(bucket.date)!, total]) {
        acc.coveredSeconds += seconds;
        acc.wattSeconds += power * seconds;
        acc.activeSeconds += power >= asset.activeThresholdW ? seconds : 0;
        acc.peak = Math.max(acc.peak ?? 0, power);
        if (scheduleKnown(date) && !inside)
          acc.outsideWattSeconds += power * seconds;
      }
      cursor = pieceEnd;
    }
  }
  return {
    method: 'power-step-estimate',
    maxGapSeconds,
    // A mixed pre/post-schedule range must not claim a complete outside-schedule estimate.
    summary: stats(total, [...days.keys()].every(scheduleKnown)),
    hourly: hours.map((hour) => ({
      from: new Date(hour.from).toISOString(),
      to: new Date(hour.to).toISOString(),
      localDate: hour.date,
      localHour: hour.hour,
      ...stats(hour.acc, scheduleKnown(hour.date)),
    })),
    daily: [...days].map(([date, acc]) => ({
      date,
      ...stats(acc, scheduleKnown(date)),
    })),
    invalidReadings,
    duplicateReadings,
    conflictingReadings,
  };
}
