exports.up = (pgm) => {
  pgm.createTable('river_forecasts', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },

    station: {
      type: 'varchar(120)',
      notNull: true,
    },

    model_version: {
      type: 'varchar(80)',
      notNull: true,
    },

    issued_at: {
      type: 'timestamptz',
      notNull: true,
    },

    target_at: {
      type: 'timestamptz',
      notNull: true,
    },

    horizon_hours: {
      type: 'integer',
      notNull: true,
    },

    observed_level_at_issue: {
      type: 'numeric(12,3)',
      notNull: true,
    },

    predicted_level: {
      type: 'numeric(12,3)',
      notNull: true,
    },

    predicted_min: {
      type: 'numeric(12,3)',
    },

    predicted_max: {
      type: 'numeric(12,3)',
    },

    predicted_direction: {
      type: 'varchar(20)',
      notNull: true,
    },

    confidence: {
      type: 'varchar(20)',
      notNull: true,
    },

    confidence_score: {
      type: 'numeric(5,2)',
    },

    input_snapshot: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{}'::jsonb`),
    },

    actual_level: {
      type: 'numeric(12,3)',
    },

    signed_error: {
      type: 'numeric(12,3)',
    },

    absolute_error: {
      type: 'numeric(12,3)',
    },

    range_hit: {
      type: 'boolean',
    },

    direction_correct: {
      type: 'boolean',
    },

    evaluated_at: {
      type: 'timestamptz',
    },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint(
    'river_forecasts',
    'chk_river_forecasts_horizon',
    {
      check:
        'horizon_hours > 0 AND horizon_hours <= 168',
    },
  );

  pgm.addConstraint(
    'river_forecasts',
    'chk_river_forecasts_direction',
    {
      check:
        "predicted_direction IN ('rising', 'falling', 'stable', 'unknown')",
    },
  );

  pgm.addConstraint(
    'river_forecasts',
    'chk_river_forecasts_confidence',
    {
      check:
        "confidence IN ('high', 'medium', 'low')",
    },
  );

  pgm.addConstraint(
    'river_forecasts',
    'chk_river_forecasts_range',
    {
      check: `
        predicted_min IS NULL
        OR predicted_max IS NULL
        OR predicted_min <= predicted_max
      `,
    },
  );

  pgm.createIndex(
    'river_forecasts',
    ['station', 'target_at'],
    {
      name:
        'idx_river_forecasts_station_target',
    },
  );

  pgm.createIndex(
    'river_forecasts',
    ['station', 'issued_at'],
    {
      name:
        'idx_river_forecasts_station_issued',
    },
  );

  pgm.createIndex(
    'river_forecasts',
    ['evaluated_at', 'target_at'],
    {
      name:
        'idx_river_forecasts_pending_evaluation',
    },
  );

  pgm.createIndex(
    'river_forecasts',
    [
      'station',
      'model_version',
      'issued_at',
      'horizon_hours',
    ],
    {
      name:
        'uq_river_forecast_issue',
      unique: true,
    },
  );
};

exports.down = (pgm) => {
  pgm.dropTable(
    'river_forecasts',
    {
      ifExists: true,
      cascade: true,
    },
  );
};
