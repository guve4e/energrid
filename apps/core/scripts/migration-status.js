const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5000,
});

async function main() {
  const exists = await pool.query(`
    SELECT to_regclass(
      'public.pgmigrations'
    ) AS table_name
  `);

  if (!exists.rows[0]?.table_name) {
    console.log(
      'No pgmigrations table exists.'
    );
    return;
  }

  const result = await pool.query(`
    SELECT
      id,
      name,
      run_on AS "runOn"
    FROM pgmigrations
    ORDER BY id ASC
  `);

  console.table(result.rows);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
