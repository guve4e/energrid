exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE device_inventory.mqtt_publisher_evidence (
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      physical_device_id TEXT,
      shelly_protocol_id TEXT,
      broker_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      peer_ip INET NOT NULL,
      published_topic TEXT,
      payload_sha256 CHAR(64),
      observed_at TIMESTAMPTZ NOT NULL,
      connection_state TEXT NOT NULL CHECK (connection_state IN ('connected','disconnected')),
      identity_verification TEXT NOT NULL DEFAULT 'publisher_observed'
        CHECK (identity_verification IN ('unmatched','publisher_observed','rpc_verified','rpc_mismatch','rpc_unreachable','not_plausible')),
      verified_lan_ip INET,
      PRIMARY KEY (tenant_id,site_id,broker_id,event_id),
      FOREIGN KEY (tenant_id,site_id,physical_device_id)
        REFERENCES device_inventory.physical_devices (tenant_id,site_id,physical_device_id),
      CHECK (shelly_protocol_id IS NULL OR length(btrim(shelly_protocol_id)) > 0),
      CHECK (length(btrim(broker_id)) > 0),
      CHECK (length(btrim(client_id)) > 0),
      CHECK ((connection_state='connected' AND published_topic IS NOT NULL
          AND payload_sha256 IS NOT NULL AND length(btrim(published_topic)) > 0
          AND payload_sha256 ~ '^[0-9a-f]{64}$')
        OR (connection_state='disconnected' AND published_topic IS NULL AND payload_sha256 IS NULL)),
      CHECK ((physical_device_id IS NULL AND shelly_protocol_id IS NULL
          AND identity_verification='unmatched' AND verified_lan_ip IS NULL)
        OR (physical_device_id IS NOT NULL AND shelly_protocol_id IS NOT NULL
          AND identity_verification<>'unmatched'
          AND ((identity_verification='rpc_verified' AND verified_lan_ip IS NOT NULL)
            OR (identity_verification<>'rpc_verified' AND verified_lan_ip IS NULL))))
    );
    CREATE INDEX mqtt_publisher_evidence_physical_history
      ON device_inventory.mqtt_publisher_evidence
        (tenant_id,site_id,physical_device_id,observed_at DESC);
    CREATE INDEX mqtt_publisher_evidence_client_history
      ON device_inventory.mqtt_publisher_evidence
        (broker_id,client_id,observed_at DESC);
    CREATE INDEX mqtt_publisher_evidence_retention
      ON device_inventory.mqtt_publisher_evidence
        (tenant_id,site_id,observed_at);
  `);
};

exports.down = () => {
  throw new Error('This evidence migration is forward-only.');
};
