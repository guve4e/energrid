import { Pool, type PoolConfig, type QueryResult } from 'pg';

export const enrollmentTestDatabaseName =
  'energrid_physical_inventory_test';

type DatabaseNameResult = Pick<QueryResult<{ database_name: string }>, 'rows'>;
type DatabaseNameQuery = {
  query(sql: string): Promise<DatabaseNameResult>;
};

export async function assertEnrollmentTestDatabase(
  database: DatabaseNameQuery,
): Promise<void> {
  const result = await database.query(
    'SELECT current_database() AS database_name',
  );
  const actual = result.rows[0]?.database_name;

  if (actual !== enrollmentTestDatabaseName) {
    throw new Error(
      `PostgreSQL integration tests require database "${enrollmentTestDatabaseName}"; connected database was "${actual ?? 'unknown'}".`,
    );
  }
}

export async function createVerifiedEnrollmentTestPool(
  options: Pick<PoolConfig, 'max' | 'connectionTimeoutMillis'> = {},
): Promise<Pool> {
  const connectionString = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL;
  if (!connectionString?.trim()) {
    throw new Error(
      'ENERGRID_ENROLLMENT_TEST_DATABASE_URL is required for PostgreSQL integration tests.',
    );
  }

  const pool = new Pool({ connectionString, ...options });
  try {
    await assertEnrollmentTestDatabase(pool);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
