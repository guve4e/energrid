exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE weather_station_daily_observations (
    id bigserial PRIMARY KEY, location text NOT NULL, source text NOT NULL, report_date date NOT NULL,
    metric text NOT NULL CHECK (metric IN ('precipitation_mm','gust_kmh','temperature_min_c','temperature_max_c')),
    value double precision NOT NULL CHECK (value > '-Infinity'::float8 AND value < 'Infinity'::float8),
    timezone text NOT NULL, period_basis text NOT NULL CHECK (period_basis IN ('unverified','local-calendar-day')),
    starts_at timestamptz, ends_at timestamptz, period_reference text, source_snapshot jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((period_basis='unverified' AND starts_at IS NULL AND ends_at IS NULL AND period_reference IS NULL)
      OR (period_basis='local-calendar-day' AND starts_at IS NOT NULL AND ends_at IS NOT NULL
        AND period_reference IS NOT NULL AND length(trim(period_reference))>0 AND ends_at>starts_at)),
    UNIQUE(location,source,report_date,metric)
  );
  CREATE INDEX weather_station_daily_match ON weather_station_daily_observations(location,source,report_date,metric);
  CREATE TABLE weather_observation_collection_runs (
    source text PRIMARY KEY, last_attempt_at timestamptz NOT NULL, status_snapshot jsonb
  );
  ALTER TABLE weather_daily_forecasts DROP CONSTRAINT weather_daily_forecasts_metric_check;
  ALTER TABLE weather_daily_forecasts ADD CONSTRAINT weather_daily_forecasts_metric_check
    CHECK (metric IN ('precipitation_mm','gust_kmh','temperature_min_c','temperature_max_c'));
  ALTER TABLE weather_daily_forecasts DROP CONSTRAINT weather_daily_forecasts_predicted_check;
  ALTER TABLE weather_daily_forecasts ADD CONSTRAINT weather_daily_forecasts_predicted_check
    CHECK (predicted > '-Infinity'::float8 AND predicted < 'Infinity'::float8
      AND (metric IN ('temperature_min_c','temperature_max_c') OR predicted>=0));
  ALTER TABLE weather_daily_forecasts ADD COLUMN daily_observation_id bigint REFERENCES weather_station_daily_observations(id),
    ADD COLUMN observation_time_basis text NOT NULL DEFAULT 'complete-hourly-intervals';`);
};

exports.down = (pgm) => {
  // Refuse a destructive rollback once the new temperature metrics have recorded history.
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM weather_daily_forecasts WHERE metric IN ('temperature_min_c','temperature_max_c'))
    OR EXISTS (SELECT 1 FROM weather_station_daily_observations)
    THEN RAISE EXCEPTION 'Retain daily temperature history before rolling back station verification'; END IF; END $$;
  ALTER TABLE weather_daily_forecasts DROP COLUMN daily_observation_id, DROP COLUMN observation_time_basis;
  ALTER TABLE weather_daily_forecasts DROP CONSTRAINT weather_daily_forecasts_metric_check;
  ALTER TABLE weather_daily_forecasts ADD CONSTRAINT weather_daily_forecasts_metric_check CHECK (metric IN ('precipitation_mm','gust_kmh'));
  ALTER TABLE weather_daily_forecasts DROP CONSTRAINT weather_daily_forecasts_predicted_check;
  ALTER TABLE weather_daily_forecasts ADD CONSTRAINT weather_daily_forecasts_predicted_check CHECK (predicted>=0 AND predicted<'Infinity'::float8);
  DROP TABLE weather_observation_collection_runs; DROP TABLE weather_station_daily_observations;`);
};
