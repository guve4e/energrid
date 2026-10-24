exports.up = (pgm) => {
  pgm.sql(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 20 AND 512),
      display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
      role text NOT NULL CHECK (role IN ('admin','installer','viewer')),
      is_active boolean NOT NULL DEFAULT true,
      session_version integer NOT NULL DEFAULT 0 CHECK (session_version >= 0),
      password_changed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (email = lower(btrim(email))),
      CHECK (length(email) BETWEEN 3 AND 320)
    );
    CREATE TABLE auth.sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      session_version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now(),
      idle_expires_at timestamptz NOT NULL,
      absolute_expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoke_reason text,
      created_ip_hash bytea CHECK (created_ip_hash IS NULL OR octet_length(created_ip_hash)=32),
      last_ip_hash bytea CHECK (last_ip_hash IS NULL OR octet_length(last_ip_hash)=32),
      CHECK (idle_expires_at <= absolute_expires_at),
      CHECK (absolute_expires_at > created_at)
    );
    CREATE INDEX auth_sessions_active_user ON auth.sessions(user_id, last_used_at DESC) WHERE revoked_at IS NULL;
    CREATE TABLE auth.refresh_tokens (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
      token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
      status text NOT NULL CHECK (status IN ('current','used','revoked')),
      issued_at timestamptz NOT NULL DEFAULT now(),
      consumed_at timestamptz,
      expires_at timestamptz NOT NULL,
      CHECK ((status='used' AND consumed_at IS NOT NULL) OR status<>'used')
    );
    CREATE UNIQUE INDEX auth_one_current_refresh_per_session ON auth.refresh_tokens(session_id) WHERE status='current';
    CREATE INDEX auth_refresh_session_history ON auth.refresh_tokens(session_id, issued_at DESC);
    CREATE TABLE auth.audit_events (
      id bigserial PRIMARY KEY,
      event_type text NOT NULL CHECK (event_type IN ('login_success','login_failure','logout','logout_all','refresh_reuse','session_revoked','password_reset','admin_bootstrap')),
      user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
      ip_hash bytea CHECK (ip_hash IS NULL OR octet_length(ip_hash)=32),
      details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX auth_audit_recent ON auth.audit_events(created_at DESC);
    CREATE TABLE auth.login_rate_limits (
      email_hash bytea NOT NULL CHECK (octet_length(email_hash)=32),
      ip_hash bytea NOT NULL CHECK (octet_length(ip_hash)=32),
      failures integer NOT NULL CHECK (failures BETWEEN 1 AND 5),
      window_started_at timestamptz NOT NULL,
      blocked_until timestamptz,
      PRIMARY KEY(email_hash,ip_hash)
    );
    CREATE TABLE auth.refresh_rate_limits (
      ip_hash bytea PRIMARY KEY CHECK (octet_length(ip_hash)=32),
      attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 61),
      window_started_at timestamptz NOT NULL,
      blocked_until timestamptz
    );
  `)
}

exports.down = (pgm) => { pgm.sql('DROP SCHEMA auth CASCADE') }
