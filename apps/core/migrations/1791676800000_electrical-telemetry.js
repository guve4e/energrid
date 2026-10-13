exports.up = (pgm) => {
  pgm.sql(`
    CREATE SCHEMA telemetry;
    CREATE TABLE telemetry.readings (
      schema_version smallint NOT NULL CHECK (schema_version = 1),
      tenant_id text NOT NULL, site_id text NOT NULL, device_id text NOT NULL, channel text NOT NULL,
      metric text NOT NULL CHECK (metric IN ('power','energy_import_total','energy_export_total')),
      value double precision,
      unit text NOT NULL, quality text NOT NULL CHECK (quality IN ('measured','invalid')),
      observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
      timestamp_basis text NOT NULL CHECK (timestamp_basis IN ('device-observed','collector-received')),
      source text NOT NULL,
      CHECK ((metric='power' AND unit='W') OR (metric<>'power' AND unit='kWh')),
      CHECK ((quality='invalid' AND value IS NULL) OR
        (quality='measured' AND value IS NOT NULL AND value > '-Infinity'::float8 AND value < 'Infinity'::float8
          AND (metric='power' OR value>=0))),
      CHECK (observed_at <= received_at + interval '5 minutes'),
      PRIMARY KEY (tenant_id,site_id,device_id,channel,metric,observed_at)
    );
    CREATE TABLE telemetry.dirty_hours (
      tenant_id text NOT NULL, site_id text NOT NULL, device_id text NOT NULL, channel text NOT NULL,
      metric text NOT NULL, hour timestamptz NOT NULL, marked_at timestamptz NOT NULL DEFAULT now(),
      CHECK (hour = date_trunc('hour',hour,'UTC')),
      PRIMARY KEY (tenant_id,site_id,device_id,channel,metric,hour)
    );
    CREATE INDEX telemetry_dirty_work ON telemetry.dirty_hours(marked_at);
    CREATE TABLE telemetry.hourly (
      tenant_id text NOT NULL, site_id text NOT NULL, device_id text NOT NULL, channel text NOT NULL,
      metric text NOT NULL, hour timestamptz NOT NULL,
      aggregation_version smallint NOT NULL DEFAULT 1 CHECK (aggregation_version=1),
      statistics jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (hour = date_trunc('hour',hour,'UTC')),
      PRIMARY KEY (tenant_id,site_id,device_id,channel,metric,hour)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(
    'DROP TABLE telemetry.hourly; DROP TABLE telemetry.dirty_hours; DROP TABLE telemetry.readings; DROP SCHEMA telemetry;',
  );
};
