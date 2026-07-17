import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({
  connectionString: databaseUrl,
});

type Direction =
  | 'rising'
  | 'falling'
  | 'stable'
  | 'unknown';

function directionFromChange(
  changeCm: number,
): Exclude<Direction, 'unknown'> {
  if (changeCm >= 2) return 'rising';
  if (changeCm <= -2) return 'falling';
  return 'stable';
}

async function main() {
  const forecasts = await pool.query(`
    SELECT
      id::text AS id,
      station,
      target_at AS "targetAt",
      observed_level_at_issue::float
        AS "observedLevelAtIssue",
      predicted_level::float
        AS "predictedLevel",
      predicted_min::float
        AS "predictedMin",
      predicted_max::float
        AS "predictedMax",
      predicted_direction
        AS "predictedDirection"
    FROM river_forecasts
    WHERE evaluated_at IS NULL
      AND target_at <= now()
    ORDER BY target_at ASC
    LIMIT 100
  `);

  let evaluated = 0;
  let awaitingReading = 0;

  for (const forecast of forecasts.rows) {
    const readingResult = await pool.query(`
      SELECT
        level_cm::float AS "levelCm",
        fetched_at AS "fetchedAt"
      FROM river_readings
      WHERE lower(station) =
            lower($1)
        AND level_cm IS NOT NULL
        AND fetched_at BETWEEN
            $2::timestamptz -
              interval '90 minutes'
            AND
            $2::timestamptz +
              interval '90 minutes'
      ORDER BY
        abs(
          extract(
            epoch FROM (
              fetched_at -
              $2::timestamptz
            )
          )
        )
      LIMIT 1
    `, [
      forecast.station,
      forecast.targetAt,
    ]);

    const reading =
      readingResult.rows[0];

    if (!reading) {
      awaitingReading += 1;
      continue;
    }

    const signedError =
      reading.levelCm -
      forecast.predictedLevel;

    const absoluteError =
      Math.abs(signedError);

    const rangeHit =
      forecast.predictedMin == null ||
      forecast.predictedMax == null
        ? null
        : reading.levelCm >=
            forecast.predictedMin &&
          reading.levelCm <=
            forecast.predictedMax;

    const actualDirection =
      directionFromChange(
        reading.levelCm -
          forecast.observedLevelAtIssue,
      );

    const directionCorrect =
      forecast.predictedDirection === 'unknown'
        ? null
        : actualDirection ===
          forecast.predictedDirection;

    const update = await pool.query(`
      UPDATE river_forecasts
      SET
        actual_level = $2,
        signed_error = $3,
        absolute_error = $4,
        range_hit = $5,
        direction_correct = $6,
        evaluated_at = now()
      WHERE id = $1
        AND evaluated_at IS NULL
      RETURNING id
    `, [
      forecast.id,
      reading.levelCm,
      signedError,
      absoluteError,
      rangeHit,
      directionCorrect,
    ]);

    if (update.rowCount) {
      evaluated += 1;
    }
  }

  console.log({
    due: forecasts.rowCount,
    evaluated,
    awaitingReading,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
