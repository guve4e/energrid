import { Pool } from 'pg';

type DailyPoint = {
  date: string;
  level: number;
  delta: number;
  nextDelta: number;
};

type JoinedPoint = {
  date: string;
  downstreamDelta: number;
  upstreamDelta: number;
  actualNextDelta: number;
};

type Metrics = {
  samples: number;
  mae: number;
  rmse: number;
  bias: number;
  directionAccuracyPct: number;
};

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}

const UPSTREAM =
  process.env.RIVER_PROPAGATION_UPSTREAM ??
  'novo-selo';

const DOWNSTREAM =
  process.env.RIVER_PROPAGATION_DOWNSTREAM ??
  'lom';

const TRAIN_TO =
  process.env.RIVER_PROPAGATION_TRAIN_TO ??
  '2023-12-31';

const TEST_FROM =
  process.env.RIVER_PROPAGATION_TEST_FROM ??
  '2024-01-01';

const TEST_TO =
  process.env.RIVER_PROPAGATION_TEST_TO ??
  '2025-12-31';

const MAX_LAG_DAYS = Number(
  process.env.RIVER_PROPAGATION_MAX_LAG ?? 3,
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 90000,
  query_timeout: 95000,
});

function round(
  value: number,
  digits = 3,
): number {
  return Number(value.toFixed(digits));
}

function direction(
  delta: number,
): 'rising' | 'falling' | 'stable' {
  if (delta >= 2) return 'rising';
  if (delta <= -2) return 'falling';
  return 'stable';
}

async function loadSeries(
  station: string,
): Promise<DailyPoint[]> {
  console.log(`Loading ${station}...`);

  const result = await pool.query(
    `
    WITH candidates AS (
      SELECT
        r.observed_date,
        r.value::float AS level,

        row_number() OVER (
          PARTITION BY r.observed_date
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
        AND d.metric = 'water_level'
        AND d.resolution = 'daily'
        AND d.aggregation = 'daily_mean'
    ),

    merged AS (
      SELECT
        observed_date,
        level
      FROM candidates
      WHERE preference_rank = 1
    ),

    ordered AS (
      SELECT
        observed_date,
        level,

        lag(level) OVER (
          ORDER BY observed_date
        ) AS previous_level,

        lead(level) OVER (
          ORDER BY observed_date
        ) AS next_level,

        lag(observed_date) OVER (
          ORDER BY observed_date
        ) AS previous_date,

        lead(observed_date) OVER (
          ORDER BY observed_date
        ) AS next_date

      FROM merged
    )

    SELECT
      to_char(
        observed_date,
        'YYYY-MM-DD'
      ) AS date,

      level,

      level - previous_level AS delta,

      next_level - level AS "nextDelta"

    FROM ordered

    WHERE previous_level IS NOT NULL
      AND next_level IS NOT NULL

      AND previous_date =
          observed_date - interval '1 day'

      AND next_date =
          observed_date + interval '1 day'

    ORDER BY observed_date
    `,
    [station],
  );

  const rows = result.rows.map((row) => ({
    date: String(row.date).slice(0, 10),
    level: Number(row.level),
    delta: Number(row.delta),
    nextDelta: Number(row.nextDelta),
  }));

  console.log(
    `${station}: ${rows.length} rows, ` +
      `${rows[0]?.date ?? '--'} -> ` +
      `${rows.at(-1)?.date ?? '--'}`,
  );

  return rows;
}

function dateMinusDays(
  date: string,
  days: number,
): string {
  const value = new Date(`${date}T00:00:00Z`);

  value.setUTCDate(
    value.getUTCDate() - days,
  );

  return value
    .toISOString()
    .slice(0, 10);
}

function joinSeries(
  upstream: DailyPoint[],
  downstream: DailyPoint[],
  lagDays: number,
): JoinedPoint[] {
  const upstreamByDate = new Map(
    upstream.map((point) => [
      point.date,
      point,
    ]),
  );

  return downstream
    .map((point) => {
      /*
       * lagDays = 1 means:
       * downstream outcome tomorrow is informed by
       * the upstream change one day before today.
       */
      const upstreamDate =
        dateMinusDays(
          point.date,
          lagDays,
        );

      const upstreamPoint =
        upstreamByDate.get(upstreamDate);

      if (!upstreamPoint) {
        return null;
      }

      return {
        date: point.date,
        downstreamDelta: point.delta,
        upstreamDelta: upstreamPoint.delta,
        actualNextDelta: point.nextDelta,
      };
    })
    .filter(
      (point): point is JoinedPoint =>
        point != null,
    );
}

/*
 * Solve a 3x3 linear system using Gaussian elimination.
 *
 * Model:
 *
 * downstreamNextDelta =
 *   intercept
 *   + localWeight * downstreamDelta
 *   + upstreamWeight * upstreamDelta
 */
function solve3x3(
  matrix: number[][],
  vector: number[],
): number[] {
  const augmented = matrix.map(
    (row, index) => [
      ...row,
      vector[index],
    ],
  );

  for (
    let column = 0;
    column < 3;
    column += 1
  ) {
    let pivot = column;

    for (
      let row = column + 1;
      row < 3;
      row += 1
    ) {
      if (
        Math.abs(
          augmented[row][column],
        ) >
        Math.abs(
          augmented[pivot][column],
        )
      ) {
        pivot = row;
      }
    }

    if (
      Math.abs(
        augmented[pivot][column],
      ) < 1e-9
    ) {
      throw new Error(
        'Regression matrix is singular.',
      );
    }

    [
      augmented[column],
      augmented[pivot],
    ] = [
      augmented[pivot],
      augmented[column],
    ];

    const divisor =
      augmented[column][column];

    for (
      let item = column;
      item < 4;
      item += 1
    ) {
      augmented[column][item] /=
        divisor;
    }

    for (
      let row = 0;
      row < 3;
      row += 1
    ) {
      if (row === column) continue;

      const factor =
        augmented[row][column];

      for (
        let item = column;
        item < 4;
        item += 1
      ) {
        augmented[row][item] -=
          factor *
          augmented[column][item];
      }
    }
  }

  return augmented.map(
    (row) => row[3],
  );
}

function fitLocalOnlyRegression(
  rows: JoinedPoint[],
) {
  const count = rows.length;

  const meanLocal =
    rows.reduce(
      (sum, row) =>
        sum + row.downstreamDelta,
      0,
    ) / count;

  const meanTarget =
    rows.reduce(
      (sum, row) =>
        sum + row.actualNextDelta,
      0,
    ) / count;

  let covariance = 0;
  let variance = 0;

  for (const row of rows) {
    const localCentered =
      row.downstreamDelta - meanLocal;

    covariance +=
      localCentered *
      (row.actualNextDelta - meanTarget);

    variance +=
      localCentered * localCentered;
  }

  const localWeight =
    variance > 0
      ? covariance / variance
      : 0;

  const intercept =
    meanTarget -
    localWeight * meanLocal;

  return {
    intercept,
    localWeight,
  };
}

function fitRegression(
  rows: JoinedPoint[],
) {
  let n = 0;

  let sumLocal = 0;
  let sumUpstream = 0;
  let sumTarget = 0;

  let sumLocalSquared = 0;
  let sumUpstreamSquared = 0;
  let sumLocalUpstream = 0;

  let sumLocalTarget = 0;
  let sumUpstreamTarget = 0;

  for (const row of rows) {
    const local =
      row.downstreamDelta;

    const upstream =
      row.upstreamDelta;

    const target =
      row.actualNextDelta;

    n += 1;

    sumLocal += local;
    sumUpstream += upstream;
    sumTarget += target;

    sumLocalSquared +=
      local * local;

    sumUpstreamSquared +=
      upstream * upstream;

    sumLocalUpstream +=
      local * upstream;

    sumLocalTarget +=
      local * target;

    sumUpstreamTarget +=
      upstream * target;
  }

  const matrix = [
    [
      n,
      sumLocal,
      sumUpstream,
    ],
    [
      sumLocal,
      sumLocalSquared,
      sumLocalUpstream,
    ],
    [
      sumUpstream,
      sumLocalUpstream,
      sumUpstreamSquared,
    ],
  ];

  const vector = [
    sumTarget,
    sumLocalTarget,
    sumUpstreamTarget,
  ];

  const [
    intercept,
    localWeight,
    upstreamWeight,
  ] = solve3x3(matrix, vector);

  return {
    intercept,
    localWeight,
    upstreamWeight,
  };
}

function calculateMetrics(
  rows: JoinedPoint[],
  predict: (
    row: JoinedPoint,
  ) => number,
): Metrics {
  if (!rows.length) {
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
  let directionCorrect = 0;

  for (const row of rows) {
    const predicted =
      predict(row);

    const error =
      predicted -
      row.actualNextDelta;

    absoluteError +=
      Math.abs(error);

    squaredError +=
      error * error;

    signedError += error;

    if (
      direction(predicted) ===
      direction(
        row.actualNextDelta,
      )
    ) {
      directionCorrect += 1;
    }
  }

  return {
    samples: rows.length,

    mae: round(
      absoluteError / rows.length,
      2,
    ),

    rmse: round(
      Math.sqrt(
        squaredError / rows.length,
      ),
      2,
    ),

    bias: round(
      signedError / rows.length,
      2,
    ),

    directionAccuracyPct: round(
      (
        directionCorrect /
        rows.length
      ) * 100,
      1,
    ),
  };
}

async function main() {
  const [
    upstreamSeries,
    downstreamSeries,
  ] = await Promise.all([
    loadSeries(UPSTREAM),
    loadSeries(DOWNSTREAM),
  ]);

  const experiments = [];

  for (
    let lagDays = 0;
    lagDays <= MAX_LAG_DAYS;
    lagDays += 1
  ) {
    const joined = joinSeries(
      upstreamSeries,
      downstreamSeries,
      lagDays,
    );

    const training = joined.filter(
      (row) =>
        row.date <= TRAIN_TO,
    );

    const testing = joined.filter(
      (row) =>
        row.date >= TEST_FROM &&
        row.date <= TEST_TO,
    );

    if (
      training.length < 100 ||
      testing.length === 0
    ) {
      experiments.push({
        lagDays,
        error:
          'Insufficient overlapping data.',
        trainingSamples:
          training.length,
        testingSamples:
          testing.length,
      });

      continue;
    }

    const coefficients =
      fitRegression(training);

    const localOnlyCoefficients =
      fitLocalOnlyRegression(training);

    const regressionMetrics =
      calculateMetrics(
        testing,
        (row) =>
          coefficients.intercept +
          coefficients.localWeight *
            row.downstreamDelta +
          coefficients.upstreamWeight *
            row.upstreamDelta,
      );

    const localOnlyMetrics =
      calculateMetrics(
        testing,
        (row) =>
          localOnlyCoefficients.intercept +
          localOnlyCoefficients.localWeight *
            row.downstreamDelta,
      );

    const localPersistenceMetrics =
      calculateMetrics(
        testing,
        (row) =>
          row.downstreamDelta,
      );

    const zeroChangeMetrics =
      calculateMetrics(
        testing,
        () => 0,
      );

    experiments.push({
      lagDays,

      trainingSamples:
        training.length,

      testingSamples:
        testing.length,

      coefficients: {
        intercept:
          round(
            coefficients.intercept,
          ),

        localWeight:
          round(
            coefficients.localWeight,
          ),

        upstreamWeight:
          round(
            coefficients.upstreamWeight,
          ),
      },

      regression:
        regressionMetrics,

      localOnlyModel: {
        coefficients: {
          intercept:
            round(
              localOnlyCoefficients.intercept,
            ),

          localWeight:
            round(
              localOnlyCoefficients.localWeight,
            ),
        },

        metrics:
          localOnlyMetrics,
      },

      upstreamValueAddedPct:
        localOnlyMetrics.mae > 0
          ? round(
              (
                (
                  localOnlyMetrics.mae -
                  regressionMetrics.mae
                ) /
                localOnlyMetrics.mae
              ) * 100,
              1,
            )
          : 0,

      localPersistenceBaseline:
        localPersistenceMetrics,

      zeroChangeBaseline:
        zeroChangeMetrics,

      improvementVsZeroPct:
        zeroChangeMetrics.mae > 0
          ? round(
              (
                (
                  zeroChangeMetrics.mae -
                  regressionMetrics.mae
                ) /
                zeroChangeMetrics.mae
              ) * 100,
              1,
            )
          : 0,

      improvementVsPersistencePct:
        localPersistenceMetrics.mae > 0
          ? round(
              (
                (
                  localPersistenceMetrics.mae -
                  regressionMetrics.mae
                ) /
                localPersistenceMetrics.mae
              ) * 100,
              1,
            )
          : 0,
    });
  }

  const successful =
    experiments.filter(
      (experiment) =>
        'regression' in experiment,
    );

  const best =
    successful.length
      ? [...successful].sort(
          (left, right) =>
            left.regression.mae -
            right.regression.mae,
        )[0]
      : null;

  console.log(
    JSON.stringify(
      {
        configuration: {
          upstream: UPSTREAM,
          downstream: DOWNSTREAM,
          trainTo: TRAIN_TO,
          testFrom: TEST_FROM,
          testTo: TEST_TO,
          maximumLagDays:
            MAX_LAG_DAYS,
        },

        best,

        experiments,
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
