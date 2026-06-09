ALTER TABLE river_readings
  ADD COLUMN IF NOT EXISTS fetched_hour TIMESTAMPTZ;

UPDATE river_readings
SET fetched_hour = date_trunc('hour', fetched_at)
WHERE fetched_hour IS NULL;

ALTER TABLE river_readings
  ALTER COLUMN fetched_hour SET NOT NULL;

DROP INDEX IF EXISTS idx_river_readings_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_river_readings_station_provider_hour
  ON river_readings (station, provider, fetched_hour);
