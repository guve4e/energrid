exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE weather_observations (
      id bigserial PRIMARY KEY,
      location text NOT NULL, source text NOT NULL,
      metric text NOT NULL CHECK (metric IN ('temperature_c','gust_kmh','precipitation_mm')),
      observed_at timestamptz NOT NULL, window_start_at timestamptz,
      value double precision NOT NULL CHECK (value > '-Infinity'::float8 AND value < 'Infinity'::float8),
      received_at timestamptz NOT NULL DEFAULT now(),
      CHECK (window_start_at IS NULL OR window_start_at < observed_at),
      UNIQUE (location, source, metric, observed_at)
    );
    CREATE INDEX weather_observation_match ON weather_observations(location, metric, observed_at);
    CREATE TABLE weather_forecasts (
      id bigserial PRIMARY KEY,
      location text NOT NULL, provider text NOT NULL, model_version text NOT NULL,
      issued_at timestamptz NOT NULL, issued_hour timestamptz NOT NULL,
      target_at timestamptz NOT NULL, window_start_at timestamptz,
      horizon_hours integer NOT NULL CHECK (horizon_hours IN (1,6,24)),
      metric text NOT NULL CHECK (metric IN ('temperature_c','gust_kmh','precipitation_mm','rain_probability')),
      predicted double precision NOT NULL CHECK (predicted > '-Infinity'::float8 AND predicted < 'Infinity'::float8),
      baseline double precision,
      input_snapshot jsonb NOT NULL,
      observation_id bigint REFERENCES weather_observations(id),
      actual double precision, signed_error double precision, absolute_error double precision,
      squared_error double precision, brier_score double precision, baseline_absolute_error double precision,
      evaluated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (target_at > issued_at),
      CHECK (window_start_at IS NULL OR (window_start_at >= issued_at AND window_start_at < target_at)),
      UNIQUE (location, provider, model_version, issued_hour, horizon_hours, metric)
    );
    CREATE INDEX weather_forecast_due ON weather_forecasts(target_at) WHERE evaluated_at IS NULL;
    ALTER TABLE river_forecasts ADD COLUMN issued_hour timestamptz,
      ADD COLUMN actual_provider text,
      ADD COLUMN actual_reading_at timestamptz,
      ADD COLUMN verification_version text NOT NULL DEFAULT 'legacy',
      ADD COLUMN observation_time_basis text NOT NULL DEFAULT 'unknown',
      ADD COLUMN baseline_absolute_error double precision;
    CREATE UNIQUE INDEX river_forecast_issue_hour ON river_forecasts(station,model_version,issued_hour,horizon_hours);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE weather_forecasts; DROP TABLE weather_observations;
    ALTER TABLE river_forecasts DROP COLUMN issued_hour, DROP COLUMN actual_provider, DROP COLUMN actual_reading_at,
      DROP COLUMN verification_version, DROP COLUMN observation_time_basis, DROP COLUMN baseline_absolute_error;`);
};
