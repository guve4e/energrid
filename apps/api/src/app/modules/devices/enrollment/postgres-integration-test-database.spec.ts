import {
  assertEnrollmentTestDatabase,
  createVerifiedEnrollmentTestPool,
} from './postgres-integration-test-database';

describe('PostgreSQL integration database guard', () => {
  it('rejects a different database after only a read-only identity query', async () => {
    const statements: string[] = [];
    const connection = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [{ database_name: 'energrid' }] };
      },
    };

    await expect(assertEnrollmentTestDatabase(connection)).rejects.toThrow(
      'PostgreSQL integration tests require database "energrid_physical_inventory_test"; connected database was "energrid".',
    );
    expect(statements).toEqual([
      'SELECT current_database() AS database_name',
    ]);
    expect(statements.some(sql => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(sql))).toBe(false);
  });

  it('fails before opening a pool when the integration URL is missing', async () => {
    const previous = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL;
    delete process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL;

    try {
      await expect(createVerifiedEnrollmentTestPool()).rejects.toThrow(
        'ENERGRID_ENROLLMENT_TEST_DATABASE_URL is required for PostgreSQL integration tests.',
      );
    } finally {
      if (previous !== undefined) {
        process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL = previous;
      }
    }
  });
});
