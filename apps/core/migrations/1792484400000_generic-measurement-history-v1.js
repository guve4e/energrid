/** Shared historical numeric measurements; metric semantics are validated by trusted app definitions. */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX logical_component_assignment_identity
      ON device_inventory.logical_component_assignments
        (tenant_id, site_id, device_id, physical_device_id);

    CREATE TABLE telemetry.measurements (
      schema_version smallint NOT NULL CHECK (schema_version = 1),
      tenant_id text NOT NULL CHECK (length(btrim(tenant_id)) BETWEEN 1 AND 160),
      site_id text NOT NULL CHECK (length(btrim(site_id)) BETWEEN 1 AND 160),
      device_id text NOT NULL CHECK (length(btrim(device_id)) BETWEEN 1 AND 160),
      physical_device_id text CHECK (physical_device_id IS NULL OR length(btrim(physical_device_id)) BETWEEN 1 AND 160),
      component_id text NOT NULL CHECK (length(btrim(component_id)) BETWEEN 1 AND 160),
      channel text NOT NULL CHECK (length(btrim(channel)) BETWEEN 1 AND 160),
      metric text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{0,63}$'),
      unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 32),
      value double precision,
      quality text NOT NULL CHECK (quality IN ('measured', 'invalid')),
      source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 160),
      provenance text NOT NULL CHECK (length(btrim(provenance)) BETWEEN 1 AND 160),
      sample_id text NOT NULL CHECK (length(btrim(sample_id)) BETWEEN 1 AND 160),
      observed_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      FOREIGN KEY (tenant_id, site_id, device_id)
        REFERENCES device_inventory.enrollments (tenant_id, site_id, device_id),
      FOREIGN KEY (tenant_id, site_id, device_id, physical_device_id)
        REFERENCES device_inventory.logical_component_assignments
          (tenant_id, site_id, device_id, physical_device_id),
      CHECK ((quality = 'invalid' AND value IS NULL) OR
        (quality = 'measured' AND value IS NOT NULL AND value > '-Infinity'::float8 AND value < 'Infinity'::float8)),
      CHECK (observed_at <= received_at + interval '5 minutes'),
      PRIMARY KEY (tenant_id, site_id, device_id, component_id, channel, metric, sample_id)
    );
    CREATE INDEX telemetry_measurements_history
      ON telemetry.measurements (tenant_id, site_id, device_id, component_id, channel, metric, observed_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE telemetry.measurements;
    DROP INDEX device_inventory.logical_component_assignment_identity;`);
};
