const migration = require('../../migrations/1792480800000_mqtt-publisher-attribution-v1.js') as {
  up(pgm: { sql(statement: string): void }): void;
  down(): never;
};

describe('MQTT publisher attribution migration', () => {
  it('adds scoped publisher evidence after physical inventory and rejects nullable connected evidence', () => {
    const statements: string[] = [];
    migration.up({ sql: statement => statements.push(statement) });
    const sql = statements.join('\n');

    expect(sql).toContain('CREATE TABLE device_inventory.mqtt_publisher_evidence');
    expect(sql).toContain('FOREIGN KEY (tenant_id,site_id,physical_device_id)');
    expect(sql).toContain("connection_state='connected' AND published_topic IS NOT NULL");
    expect(sql).toContain('payload_sha256 IS NOT NULL');
    expect(sql).toContain('identity_verification');
    expect(sql).toContain('mqtt_publisher_evidence_retention');
  });

  it('is forward-only', () => {
    expect(() => migration.down()).toThrow('forward-only');
  });
});
