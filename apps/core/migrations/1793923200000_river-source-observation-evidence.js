// Preserves parsed provider observations independently of the legacy river_readings
// table, where fetched_at historically mixes fetch and measurement time.
// This does not certify historical records or enable forecasting.
exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE river_source_observations (
    id bigserial PRIMARY KEY,
    source_key text NOT NULL UNIQUE CHECK (source_key ~ '^[0-9a-f]{64}$'),
    station text NOT NULL CHECK (length(trim(station)) > 0),
    provider text NOT NULL CHECK (length(trim(provider)) > 0),
    source_reported_at text,
    observed_at timestamptz,
    observation_time_basis text NOT NULL CHECK (
      observation_time_basis IN ('verified', 'date-only', 'timezone-unverified', 'unknown')),
    river_km numeric, elevation_m numeric, level_cm numeric,
    discharge_m3s numeric, difference_24h_cm numeric,
    trend text, water_temp_c numeric,
    first_fetched_at timestamptz NOT NULL,
    last_fetched_at timestamptz NOT NULL,
    poll_count integer NOT NULL DEFAULT 1 CHECK (poll_count >= 1),
    CHECK ((observation_time_basis = 'verified' AND observed_at IS NOT NULL)
      OR (observation_time_basis <> 'verified' AND observed_at IS NULL)),
    CHECK (last_fetched_at >= first_fetched_at)
  );
  CREATE INDEX river_source_observations_station_last_fetch
    ON river_source_observations (lower(station), last_fetched_at DESC);
  `);
};

exports.down = (pgm) => {
  // An archive containing source evidence must not be silently destroyed by rollback.
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM river_source_observations LIMIT 1) THEN
      RAISE EXCEPTION 'Export river_source_observations before rollback';
    END IF;
  END $$;
  DROP TABLE river_source_observations;`);
};
