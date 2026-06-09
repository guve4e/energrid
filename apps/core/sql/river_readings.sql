CREATE TABLE IF NOT EXISTS river_readings (
  id BIGSERIAL PRIMARY KEY,
  station TEXT NOT NULL,
  provider TEXT NOT NULL,
  level_cm NUMERIC,
  discharge_m3s NUMERIC,
  difference_24h_cm NUMERIC,
  trend TEXT,
  water_temp_c NUMERIC,
  elevation_m NUMERIC,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_river_readings_station_fetched
  ON river_readings (station, fetched_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_river_readings_unique
  ON river_readings (station, provider, fetched_at);
