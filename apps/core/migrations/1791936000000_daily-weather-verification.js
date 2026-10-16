exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE weather_daily_forecasts (
    id bigserial PRIMARY KEY,
    location text NOT NULL, provider text NOT NULL, model_version text NOT NULL,
    issued_at timestamptz NOT NULL, issued_hour timestamptz NOT NULL,
    target_date date NOT NULL, timezone text NOT NULL,
    starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
    lead_days integer NOT NULL CHECK (lead_days BETWEEN 1 AND 10),
    metric text NOT NULL CHECK (metric IN ('precipitation_mm','gust_kmh')),
    predicted double precision NOT NULL CHECK (predicted >= 0 AND predicted < 'Infinity'::float8),
    input_snapshot jsonb NOT NULL,
    actual double precision, observation_source text, observation_ids bigint[],
    absolute_error double precision, squared_error double precision, signed_error double precision,
    evaluated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_at > issued_at AND ends_at > starts_at),
    CHECK ((ends_at-starts_at) IN (interval '23 hours',interval '24 hours',interval '25 hours')),
    UNIQUE(location,provider,model_version,issued_hour,target_date,metric)
  );
  CREATE INDEX weather_daily_forecast_due ON weather_daily_forecasts(ends_at) WHERE evaluated_at IS NULL;`);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE weather_daily_forecasts;');
};
