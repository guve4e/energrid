const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

const repositoryRoot = path.resolve(__dirname, '../../..');
const apiRoot = path.join(repositoryRoot, 'apps/api');
const expectedDatabase = 'energrid_physical_inventory_test';

function requiredConnectionValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing PostgreSQL configuration: ${name}`);
  return value;
}

function testConnectionString() {
  const existingUrl = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL?.trim();
  if (existingUrl) return existingUrl;

  const envPath = path.join(repositoryRoot, '.env');
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });

  const configuredDatabase = requiredConnectionValue('PGDATABASE');
  if (configuredDatabase !== 'energrid') {
    throw new Error(
      'The existing PostgreSQL source must target "energrid" before the integration runner changes only its database target.',
    );
  }

  const connection = new URL('postgresql://localhost');
  connection.username = requiredConnectionValue('PGUSER');
  connection.password = requiredConnectionValue('PGPASSWORD');
  connection.hostname = requiredConnectionValue('PGHOST');
  connection.port = requiredConnectionValue('PGPORT');
  connection.pathname = `/${expectedDatabase}`;
  if (process.env.PGSSL?.toLowerCase() === 'true') {
    connection.searchParams.set('sslmode', 'require');
  }
  return connection.toString();
}

async function verifyDatabase(connectionString) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query(
      'SELECT current_database() AS database_name',
    );
    const actual = result.rows[0]?.database_name;
    if (actual !== expectedDatabase) {
      throw new Error(
        `Refusing to run PostgreSQL integration tests: expected "${expectedDatabase}", connected database was "${actual ?? 'unknown'}".`,
      );
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  let connectionString;
  try {
    connectionString = testConnectionString();
    await verifyDatabase(connectionString);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PostgreSQL integration preflight failed.');
    process.exitCode = 1;
    return;
  }

  console.log(`Verified PostgreSQL integration target: ${expectedDatabase}`);
  const jest = require.resolve('jest/bin/jest');
  const result = spawnSync(process.execPath, [
    jest,
    '--config', 'jest.config.cts',
    '--runInBand',
    '--verbose',
    '--runTestsByPath',
    'src/app/modules/devices/enrollment/postgres-device-enrollment.integration.spec.ts',
    'src/app/modules/devices/enrollment/postgres-physical-device-inventory.integration.spec.ts',
    'src/app/modules/telemetry/generic-measurements/postgres-generic-measurement.integration.spec.ts',
  ], {
    cwd: apiRoot,
    env: { ...process.env, ENERGRID_ENROLLMENT_TEST_DATABASE_URL: connectionString },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'PostgreSQL integration run failed.');
  process.exitCode = 1;
});
