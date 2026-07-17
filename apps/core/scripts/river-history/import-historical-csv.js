const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({
  path: path.resolve(__dirname, '../../../../.env'),
});

function must(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

async function main() {
  const csvPath = process.argv[2];

  if (!csvPath) {
    throw new Error(
      'Usage: node import-historical-csv.js <normalized-csv-path>',
    );
  }

  const absoluteCsvPath = path.resolve(csvPath);
  const csvBuffer = fs.readFileSync(absoluteCsvPath);
  const checksum = crypto
    .createHash('sha256')
    .update(csvBuffer)
    .digest('hex');

  const lines = csvBuffer
    .toString('utf8')
    .split(/\r?\n/)
    .filter(Boolean);

  const headers = parseCsvLine(lines[0]);
  const index = Object.fromEntries(
    headers.map((header, position) => [header, position]),
  );

  const rows = lines.slice(1).map((line) => {
    const columns = parseCsvLine(line);

    return {
      station: columns[index.station],
      stationCode: columns[index.stationCode],
      observedDate: columns[index.observedDate],
      metric: columns[index.metric],
      value: Number(columns[index.value]),
      unit: columns[index.unit],
      provider: columns[index.provider],
      resolution: columns[index.resolution],
      aggregation: columns[index.aggregation],
      quality: columns[index.quality],
      sourceFile: columns[index.sourceFile],
    };
  });

  if (!rows.length) {
    throw new Error('CSV contains no data rows');
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  const pool = new Pool({
    host: must('PGHOST'),
    port: Number(must('PGPORT')),
    database: must('PGDATABASE'),
    user: must('PGUSER'),
    password: must('PGPASSWORD'),
    ssl:
      String(process.env.PGSSL || '').toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : false,
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const stationResult = await client.query(
      `
      SELECT id
      FROM river_stations
      WHERE code = $1
      `,
      [first.stationCode],
    );

    if (!stationResult.rowCount) {
      throw new Error(`Unknown river station: ${first.stationCode}`);
    }

    const stationId = stationResult.rows[0].id;

    const datasetResult = await client.query(
      `
      INSERT INTO river_historical_datasets (
        station_id,
        provider,
        metric,
        unit,
        resolution,
        aggregation,
        coverage_from,
        coverage_to,
        source_file,
        source_period,
        checksum_sha256,
        quality
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (
        station_id,
        provider,
        metric,
        aggregation,
        source_file
      )
      DO UPDATE SET
        coverage_from = EXCLUDED.coverage_from,
        coverage_to = EXCLUDED.coverage_to,
        unit = EXCLUDED.unit,
        resolution = EXCLUDED.resolution,
        source_period = EXCLUDED.source_period,
        checksum_sha256 = EXCLUDED.checksum_sha256,
        quality = EXCLUDED.quality,
        imported_at = now()
      RETURNING id
      `,
      [
        stationId,
        first.provider,
        first.metric,
        first.unit,
        first.resolution,
        first.aggregation,
        first.observedDate,
        last.observedDate,
        first.sourceFile,
        `${first.observedDate.slice(0, 4)}-${last.observedDate.slice(0, 4)}`,
        checksum,
        first.quality,
      ],
    );

    const datasetId = datasetResult.rows[0].id;
    const batchSize = 500;
    let inserted = 0;

    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const placeholders = [];
      const params = [];

      batch.forEach((row, rowIndex) => {
        const base = rowIndex * 5;

        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`,
        );

        params.push(
          datasetId,
          stationId,
          row.observedDate,
          row.value,
          row.quality,
        );
      });

      const result = await client.query(
        `
        INSERT INTO river_historical_readings (
          dataset_id,
          station_id,
          observed_date,
          value,
          quality
        )
        VALUES ${placeholders.join(',')}
        ON CONFLICT (dataset_id, observed_date)
        DO UPDATE SET
          value = EXCLUDED.value,
          quality = EXCLUDED.quality,
          imported_at = now()
        `,
        params,
      );

      inserted += result.rowCount;
    }

    await client.query('COMMIT');

    console.log(`Dataset ID: ${datasetId}`);
    console.log(`Rows processed: ${rows.length}`);
    console.log(`Rows written: ${inserted}`);
    console.log(`Coverage: ${first.observedDate} → ${last.observedDate}`);
    console.log(`Checksum: ${checksum}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
