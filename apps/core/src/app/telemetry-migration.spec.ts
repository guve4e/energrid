describe('electrical telemetry migration definition', () => {
  const migration =
    require('../../migrations/1791676800000_electrical-telemetry.js') as {
      up(pgm: { sql: (query: string) => void }): void;
      down(pgm: { sql: (query: string) => void }): void;
    };
  it('creates isolated raw, work and summary tables with unit/quality and idempotency constraints', () => {
    const sql = jest.fn();
    migration.up({ sql });
    const definition = sql.mock.calls[0][0] as string;
    expect(definition).toContain('CREATE SCHEMA telemetry');
    expect(definition).toContain('CREATE TABLE telemetry.readings');
    expect(definition).toContain('CREATE TABLE telemetry.dirty_hours');
    expect(definition).toContain('CREATE TABLE telemetry.hourly');
    expect(definition).toContain(
      'PRIMARY KEY (tenant_id,site_id,device_id,channel,metric,observed_at)',
    );
    expect(definition).toContain("metric='power' AND unit='W'");
    expect(definition).toContain("quality='invalid' AND value IS NULL");
    expect(definition).not.toContain('DELETE FROM');
    expect(definition).not.toContain('weather');
    expect(definition).not.toContain('river');
  });
  it('has an explicit reverse migration limited to its own schema', () => {
    const sql = jest.fn();
    migration.down({ sql });
    expect(sql.mock.calls[0][0]).toBe(
      'DROP TABLE telemetry.hourly; DROP TABLE telemetry.dirty_hours; DROP TABLE telemetry.readings; DROP SCHEMA telemetry;',
    );
  });
});
