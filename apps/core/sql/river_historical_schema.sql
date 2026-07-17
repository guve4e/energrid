CREATE TABLE IF NOT EXISTS river_stations (
  id BIGSERIAL PRIMARY KEY,

  code VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'BG',
  river VARCHAR(80) NOT NULL DEFAULT 'Danube',

  river_order INTEGER,
  latitude NUMERIC(9, 6),
  longitude NUMERIC(9, 6),

  has_live_data BOOLEAN NOT NULL DEFAULT false,
  has_historical_data BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS river_historical_datasets (
  id BIGSERIAL PRIMARY KEY,

  station_id BIGINT NOT NULL
    REFERENCES river_stations(id)
    ON DELETE RESTRICT,

  provider VARCHAR(80) NOT NULL,
  metric VARCHAR(40) NOT NULL,
  unit VARCHAR(20) NOT NULL,

  resolution VARCHAR(20) NOT NULL DEFAULT 'daily',
  aggregation VARCHAR(30) NOT NULL DEFAULT 'daily_mean',

  coverage_from DATE,
  coverage_to DATE,

  source_file VARCHAR(255) NOT NULL,
  source_url TEXT,
  source_period VARCHAR(80),

  checksum_sha256 CHAR(64),
  quality VARCHAR(30) NOT NULL DEFAULT 'official',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_river_historical_dataset_metric
    CHECK (
      metric IN (
        'water_level',
        'water_discharge',
        'water_temperature'
      )
    ),

  CONSTRAINT chk_river_historical_dataset_resolution
    CHECK (
      resolution IN (
        'hourly',
        'daily',
        'monthly',
        'annual'
      )
    ),

  CONSTRAINT uq_river_historical_dataset
    UNIQUE (
      station_id,
      provider,
      metric,
      aggregation,
      source_file
    )
);

CREATE TABLE IF NOT EXISTS river_historical_readings (
  id BIGSERIAL PRIMARY KEY,

  dataset_id BIGINT NOT NULL
    REFERENCES river_historical_datasets(id)
    ON DELETE CASCADE,

  station_id BIGINT NOT NULL
    REFERENCES river_stations(id)
    ON DELETE RESTRICT,

  observed_date DATE NOT NULL,
  value NUMERIC(12, 3) NOT NULL,

  quality VARCHAR(30) NOT NULL DEFAULT 'official',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_river_historical_reading
    UNIQUE (
      dataset_id,
      observed_date
    )
);

CREATE INDEX IF NOT EXISTS idx_river_historical_station_date
  ON river_historical_readings (
    station_id,
    observed_date
  );

CREATE INDEX IF NOT EXISTS idx_river_historical_dataset_date
  ON river_historical_readings (
    dataset_id,
    observed_date
  );

CREATE INDEX IF NOT EXISTS idx_river_historical_datasets_station_metric
  ON river_historical_datasets (
    station_id,
    metric
  );

INSERT INTO river_stations (
  code,
  name,
  river_order,
  has_live_data,
  has_historical_data
)
VALUES
  ('novo-selo', 'Novo Selo', 10, true, true),
  ('vidin', 'Vidin', 20, true, false),
  ('lom', 'Lom', 30, true, true),
  ('oryahovo', 'Oryahovo', 40, true, true),
  ('svishtov', 'Svishtov', 50, true, true),
  ('ruse', 'Ruse', 60, true, true),
  ('silistra', 'Silistra', 70, true, true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  river_order = EXCLUDED.river_order,
  has_live_data = EXCLUDED.has_live_data,
  has_historical_data = EXCLUDED.has_historical_data,
  updated_at = now();
