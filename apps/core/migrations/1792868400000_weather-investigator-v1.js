exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE weather_investigation_snapshots (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      site_id text NOT NULL,
      captured_at timestamptz NOT NULL,
      provider text NOT NULL,
      model text,
      location text NOT NULL,
      latitude double precision NOT NULL,
      longitude double precision NOT NULL,
      evidence jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX weather_investigation_snapshot_scope ON weather_investigation_snapshots(tenant_id, site_id, created_at DESC);
    CREATE TABLE weather_investigation_findings (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      site_id text NOT NULL,
      event_type text NOT NULL,
      stable_key text NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      location text NOT NULL,
      severity text NOT NULL,
      confidence text NOT NULL,
      uncertainty text NOT NULL,
      evidence_refs jsonb NOT NULL,
      consequences jsonb NOT NULL,
      preparation jsonb NOT NULL,
      explanation_bg text NOT NULL,
      reasoning_summary text NOT NULL,
      evidence_snapshot_id bigint REFERENCES weather_investigation_snapshots(id),
      provider text NOT NULL,
      model text NOT NULL,
      notification_state text NOT NULL CHECK (notification_state IN ('prepared','acknowledged','dismissed')) DEFAULT 'prepared',
      first_notified_at timestamptz,
      last_updated_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_at timestamptz,
      dismissed_at timestamptz,
      UNIQUE (tenant_id, site_id, stable_key)
    );
    CREATE INDEX weather_investigation_findings_active ON weather_investigation_findings(tenant_id, site_id, starts_at) WHERE notification_state = 'prepared';
  `);
};

// Additive V1 migration: rollback is intentionally a no-op to avoid deleting saved findings.
exports.down = () => {};
