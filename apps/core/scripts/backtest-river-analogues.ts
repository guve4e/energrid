console.log('[backtest] script loading');

import assert from 'node:assert/strict';
import { Pool } from 'pg';

import {
  HistoricalAnalogueEngine,
  RiverState,
} from '../src/app/weather/river/analogue/historical-analogue.engine';

type Direction = 'rising' | 'falling' | 'stable';

interface HistoricalRow {
  observedDate: string;
  level: number;
  previousDayLevel: number;
  nextDayLevel: number;
  delta24h: number;
  delta3d: number | null;
  nextDayDelta: number;
  discharge: number | null;
  temperature: number | null;
  month: number;
}

interface Prediction {
  observedDate: string;
  actualDelta: number;
  predictedDelta: number;
  gatedDelta: number;
  persistenceDelta: number;
  zeroDelta: number;
  analogueCount: number;
  bestScore: number;
  directionalAgreementPct: number;
  analogueDirection: Direction;
  gateUsedAnalogue: boolean;
}

interface Metrics {
  samples: number;
  mae: number;
  rmse: number;
  bias: number;
  directionAccuracyPct: number;
}

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. Run with DATABASE_URL=$(node apps/core/scripts/db-url.js).',
  );
}

const STATION_CODE =
  process.env.RIVER_BACKTEST_STATION ?? 'novo-selo';

const TOP_K = Number(
  process.env.RIVER_BACKTEST_TOP_K ?? 20,
);

const MIN_CANDIDATES = Number(
  process.env.RIVER_BACKTEST_MIN_CANDIDATES ?? 10,
);

const EXCLUSION_DAYS = Number(
  process.env.RIVER_BACKTEST_EXCLUSION_DAYS ?? 30,
);

const TEST_FROM =
  process.env.RIVER_BACKTEST_FROM ?? '2000-01-01';

const TEST_TO =
  process.env.RIVER_BACKTEST_TO ?? '2025-12-31';

const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 90000,
  query_timeout: 95000,
});

const analogueEngine =
  new HistoricalAnalogueEngine();

function round(
  value: number,
  digits = 2,
): number {
  return Number(value.toFixed(digits));
}

function median(values: number[]): number {
  assert.ok(
    values.length > 0,
    'median() requires at least one value',
  );

  const sorted = [...values].sort(
    (left, right) => left - right,
  );

  const midpoint = Math.floor(
    sorted.length / 2,
  );

  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }

  return (
    sorted[midpoint - 1] +
    sorted[midpoint]
  ) / 2;
}

function direction(
  delta: number,
): Direction {
  if (delta >= 2) return 'rising';
  if (delta <= -2) return 'falling';
  return 'stable';
}

function calculateMetrics(
  predictions: Prediction[],
  selector: (
    prediction: Prediction,
  ) => number,
): Metrics {
  if (!predictions.length) {
    return {
      samples: 0,
      mae: 0,
      rmse: 0,
      bias: 0,
      directionAccuracyPct: 0,
    };
  }

  let absoluteError = 0;
  let squaredError = 0;
  let signedError = 0;
  let correctDirection = 0;

  for (const prediction of predictions) {
    const predicted = selector(prediction);
    const error =
      predicted -
      prediction.actualDelta;

    absoluteError += Math.abs(error);
    squaredError += error * error;
    signedError += error;

    if (
      direction(predicted) ===
      direction(prediction.actualDelta)
    ) {
      correctDirection += 1;
    }
  }

  return {
    samples: predictions.length,
    mae: round(
      absoluteError /
        predictions.length,
    ),
    rmse: round(
      Math.sqrt(
        squaredError /
          predictions.length,
      ),
    ),
    bias: round(
      signedError /
        predictions.length,
    ),
    directionAccuracyPct: round(
      (
        correctDirection /
        predictions.length
      ) * 100,
      1,
    ),
  };
}

async function loadSeries(): Promise<
  HistoricalRow[]
> {
  console.log(
    `Loading merged multivariate series for ${STATION_CODE}...`,
  );

  const result = await pool.query(
    `
    WITH compatible_readings AS (
      SELECT
        d.metric,
        r.observed_date,
        r.value::float AS value,

        row_number() OVER (
          PARTITION BY
            d.metric,
            r.observed_date
          ORDER BY
            d.imported_at DESC,
            d.coverage_to DESC NULLS LAST,
            d.id DESC
        ) AS preference_rank

      FROM river_historical_readings r

      JOIN river_historical_datasets d
        ON d.id = r.dataset_id

      JOIN river_stations s
        ON s.id = r.station_id

      WHERE s.code = $1
        AND d.metric IN (
          'water_level',
          'water_discharge',
          'water_temperature'
        )
        AND d.resolution = 'daily'
        AND d.aggregation = 'daily_mean'
    ),

    preferred_readings AS (
      SELECT
        metric,
        observed_date,
        value
      FROM compatible_readings
      WHERE preference_rank = 1
    ),

    daily_metrics AS (
      SELECT
        observed_date,

        max(value) FILTER (
          WHERE metric = 'water_level'
        ) AS level,

        max(value) FILTER (
          WHERE metric = 'water_discharge'
        ) AS discharge,

        max(value) FILTER (
          WHERE metric = 'water_temperature'
        ) AS temperature

      FROM preferred_readings
      GROUP BY observed_date
    ),

    ordered_series AS (
      SELECT
        observed_date,
        level,
        discharge,
        temperature,

        lag(level, 1) OVER (
          ORDER BY observed_date
        ) AS previous_day_level,

        lag(level, 3) OVER (
          ORDER BY observed_date
        ) AS three_days_ago_level,

        lead(level, 1) OVER (
          ORDER BY observed_date
        ) AS next_day_level,

        lag(observed_date, 1) OVER (
          ORDER BY observed_date
        ) AS previous_date,

        lag(observed_date, 3) OVER (
          ORDER BY observed_date
        ) AS three_days_ago_date,

        lead(observed_date, 1) OVER (
          ORDER BY observed_date
        ) AS next_date

      FROM daily_metrics
      WHERE level IS NOT NULL
    )

    SELECT
      to_char(
        observed_date,
        'YYYY-MM-DD'
      ) AS "observedDate",

      level,

      previous_day_level
        AS "previousDayLevel",

      next_day_level
        AS "nextDayLevel",

      level - previous_day_level
        AS "delta24h",

      CASE
        WHEN three_days_ago_date =
             observed_date - interval '3 days'
        THEN level - three_days_ago_level
        ELSE NULL
      END AS "delta3d",

      next_day_level - level
        AS "nextDayDelta",

      discharge,
      temperature,

      EXTRACT(
        MONTH FROM observed_date
      )::int AS month

    FROM ordered_series

    WHERE previous_day_level IS NOT NULL
      AND next_day_level IS NOT NULL
      AND previous_date =
          observed_date - interval '1 day'
      AND next_date =
          observed_date + interval '1 day'

    ORDER BY observed_date ASC
    `,
    [STATION_CODE],
  );

  console.log(
    `Loaded ${result.rows.length} multivariate historical rows.`,
  );

  return result.rows.map((row) => ({
    observedDate:
      String(row.observedDate).slice(0, 10),

    level:
      Number(row.level),

    previousDayLevel:
      Number(row.previousDayLevel),

    nextDayLevel:
      Number(row.nextDayLevel),

    delta24h:
      Number(row.delta24h),

    delta3d:
      row.delta3d == null
        ? null
        : Number(row.delta3d),

    nextDayDelta:
      Number(row.nextDayDelta),

    discharge:
      row.discharge == null
        ? null
        : Number(row.discharge),

    temperature:
      row.temperature == null
        ? null
        : Number(row.temperature),

    month:
      Number(row.month),
  }));
}

function findAnalogues(
  target: HistoricalRow,
  availableHistory: HistoricalRow[],
) {
  const targetDate = new Date(
    `${target.observedDate}T00:00:00Z`,
  ).getTime();

  const currentState: RiverState = {
    level: target.level,
    delta24h: target.delta24h,
    delta3d: target.delta3d,
    discharge: target.discharge,
    temperature: target.temperature,
    month: target.month,
  };

  return availableHistory
    .filter((candidate) => {
      if (
        candidate.month !== target.month
      ) {
        return false;
      }

      const candidateDate = new Date(
        `${candidate.observedDate}T00:00:00Z`,
      ).getTime();

      const distanceDays =
        Math.abs(
          targetDate -
            candidateDate,
        ) / 86_400_000;

      return (
        candidateDate < targetDate &&
        distanceDays >
          EXCLUSION_DAYS
      );
    })
    .map((candidate) => ({
      candidate,
      score: analogueEngine.score(
        currentState,
        {
          level: candidate.level,
          delta24h:
            candidate.delta24h,
          delta3d:
            candidate.delta3d,
          discharge:
            candidate.discharge,
          temperature:
            candidate.temperature,
          month: candidate.month,
        },
      ),
    }))
    .sort(
      (left, right) =>
        left.score - right.score,
    )
    .slice(0, TOP_K);
}

async function main() {
  console.log('[backtest] main started');
  const series = await loadSeries();

  if (!series.length) {
    throw new Error(
      `No historical daily water-level data found for ${STATION_CODE}.`,
    );
  }

  const predictions: Prediction[] = [];

  const rowsByMonth = new Map<
    number,
    HistoricalRow[]
  >();

  for (const row of series) {
    const bucket =
      rowsByMonth.get(row.month) ?? [];

    bucket.push(row);
    rowsByMonth.set(row.month, bucket);
  }

  console.log(
    'Feature coverage:',
    {
      delta3d: series.filter(
        (row) => row.delta3d != null,
      ).length,
      discharge: series.filter(
        (row) => row.discharge != null,
      ).length,
      temperature: series.filter(
        (row) => row.temperature != null,
      ).length,
    },
  );

  console.log(
    `Archive range: ${series[0]?.observedDate ?? '--'} -> ${
      series.at(-1)?.observedDate ?? '--'
    }`,
  );

  console.log(
    `Requested test range: ${TEST_FROM} -> ${TEST_TO}`,
  );

  const eligibleTargets = series.filter(
    (target) => {
      const date = String(
        target.observedDate,
      ).slice(0, 10);

      return (
        date >= TEST_FROM &&
        date <= TEST_TO
      );
    },
  );

  console.log(
    `Backtesting ${eligibleTargets.length} days for ${STATION_CODE}...`,
  );

  for (
    let index = 0;
    index < eligibleTargets.length;
    index += 1
  ) {
    const target = eligibleTargets[index];

    if (
      index % 250 === 0
    ) {
      console.log(
        `Progress: ${index}/${eligibleTargets.length}`,
      );
    }
    const analogues = findAnalogues(
      target,
      rowsByMonth.get(target.month) ?? [],
    );

    if (
      analogues.length <
      MIN_CANDIDATES
    ) {
      continue;
    }

    const analogueDeltas = analogues.map(
      ({ candidate }) =>
        candidate.nextDayDelta,
    );

    const predictedDelta =
      median(analogueDeltas);

    const fallingCount =
      analogueDeltas.filter(
        (delta) => direction(delta) === 'falling',
      ).length;

    const risingCount =
      analogueDeltas.filter(
        (delta) => direction(delta) === 'rising',
      ).length;

    const stableCount =
      analogueDeltas.length -
      fallingCount -
      risingCount;

    const dominantCount = Math.max(
      fallingCount,
      risingCount,
      stableCount,
    );

    const analogueDirection: Direction =
      dominantCount === fallingCount
        ? 'falling'
        : dominantCount === risingCount
          ? 'rising'
          : 'stable';

    const directionalAgreementPct =
      analogueDeltas.length
        ? (
            dominantCount /
            analogueDeltas.length
          ) * 100
        : 0;

    /*
     * Conservative gate:
     *
     * Only trust the analogue magnitude when the closest
     * match is strong and at least 75% of outcomes agree.
     * Otherwise fall back to zero change.
     */
    const gateUsedAnalogue =
      analogues[0].score <= 10 &&
      directionalAgreementPct >= 75;

    const gatedDelta =
      gateUsedAnalogue
        ? predictedDelta
        : 0;

    predictions.push({
      observedDate:
        target.observedDate,
      actualDelta:
        target.nextDayDelta,
      predictedDelta,
      gatedDelta,
      persistenceDelta:
        target.delta24h,
      zeroDelta: 0,
      analogueCount:
        analogues.length,
      bestScore:
        analogues[0].score,
      directionalAgreementPct:
        round(
          directionalAgreementPct,
          1,
        ),
      analogueDirection,
      gateUsedAnalogue,
    });
  }

  const analogueMetrics =
    calculateMetrics(
      predictions,
      (prediction) =>
        prediction.predictedDelta,
    );

  const gatedMetrics =
    calculateMetrics(
      predictions,
      (prediction) =>
        prediction.gatedDelta,
    );

  const persistenceMetrics =
    calculateMetrics(
      predictions,
      (prediction) =>
        prediction.persistenceDelta,
    );

  const zeroMetrics =
    calculateMetrics(
      predictions,
      (prediction) =>
        prediction.zeroDelta,
    );

  const improvementVsPersistence =
    persistenceMetrics.mae > 0
      ? round(
          (
            (
              persistenceMetrics.mae -
              analogueMetrics.mae
            ) /
            persistenceMetrics.mae
          ) * 100,
          1,
        )
      : 0;

  const improvementVsZero =
    zeroMetrics.mae > 0
      ? round(
          (
            (
              zeroMetrics.mae -
              analogueMetrics.mae
            ) /
            zeroMetrics.mae
          ) * 100,
          1,
        )
      : 0;

  const worst = [...predictions]
    .sort(
      (left, right) =>
        Math.abs(
          right.predictedDelta -
            right.actualDelta,
        ) -
        Math.abs(
          left.predictedDelta -
            left.actualDelta,
        ),
    )
    .slice(0, 10)
    .map((prediction) => ({
      ...prediction,
      error: round(
        prediction.predictedDelta -
          prediction.actualDelta,
      ),
    }));

  console.log(
    JSON.stringify(
      {
        configuration: {
          station: STATION_CODE,
          topK: TOP_K,
          minimumCandidates:
            MIN_CANDIDATES,
          exclusionDays:
            EXCLUSION_DAYS,
          testFrom: TEST_FROM,
          testTo: TEST_TO,
          historicalRows:
            series.length,
        },
        results: {
          analogue:
            analogueMetrics,
          gatedAnalogue:
            gatedMetrics,
          gatedUsage: {
            usedAnalogue:
              predictions.filter(
                (prediction) =>
                  prediction.gateUsedAnalogue,
              ).length,
            usedZeroFallback:
              predictions.filter(
                (prediction) =>
                  !prediction.gateUsedAnalogue,
              ).length,
          },
          persistenceBaseline:
            persistenceMetrics,
          zeroChangeBaseline:
            zeroMetrics,
          improvementVsPersistencePct:
            improvementVsPersistence,
          improvementVsZeroPct:
            improvementVsZero,
        },
        worstForecasts: worst,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
