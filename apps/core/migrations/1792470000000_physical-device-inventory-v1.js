/**
 * Protocol-independent physical devices, components, endpoints and evidence.
 * Enrollment remains the logical-device approval boundary.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE device_inventory.physical_devices (
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      physical_device_id TEXT NOT NULL,
      vendor TEXT,
      hardware_model TEXT,
      firmware_version TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id, site_id, physical_device_id),
      CHECK (length(btrim(tenant_id)) > 0),
      CHECK (length(btrim(site_id)) > 0),
      CHECK (last_seen_at >= first_seen_at)
    );
    CREATE TABLE device_inventory.physical_device_identity_claims (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
      physical_device_id TEXT NOT NULL, identity_namespace TEXT NOT NULL,
      identity_value TEXT NOT NULL, identity_scope TEXT NOT NULL DEFAULT '',
      evidence_source TEXT NOT NULL,
      verification_status TEXT NOT NULL CHECK (verification_status IN ('protocol_observed','user_confirmed','hardware_verified')),
      first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
      associated_at TIMESTAMPTZ, associated_by TEXT, is_current BOOLEAN NOT NULL DEFAULT TRUE,
      FOREIGN KEY (tenant_id,site_id,physical_device_id) REFERENCES device_inventory.physical_devices (tenant_id,site_id,physical_device_id),
      CHECK (length(btrim(identity_namespace)) > 0), CHECK (length(btrim(identity_value)) > 0),
      CHECK (length(btrim(evidence_source)) > 0), CHECK (last_seen_at >= first_seen_at),
      CHECK ((verification_status='protocol_observed' AND associated_at IS NULL AND associated_by IS NULL)
        OR (verification_status IN ('user_confirmed','hardware_verified') AND associated_at IS NOT NULL AND length(btrim(associated_by)) > 0))
    );
    CREATE UNIQUE INDEX physical_identity_one_current_claim
      ON device_inventory.physical_device_identity_claims
        (tenant_id,site_id,identity_scope,identity_namespace,lower(identity_value)) WHERE is_current;
    CREATE INDEX physical_identity_asset_claims
      ON device_inventory.physical_device_identity_claims (tenant_id,site_id,physical_device_id,is_current);

    CREATE TABLE device_inventory.physical_device_components (
      tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, physical_device_id TEXT NOT NULL,
      component_key TEXT NOT NULL, capabilities TEXT[] NOT NULL DEFAULT '{}',
      first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id,site_id,physical_device_id,component_key),
      FOREIGN KEY (tenant_id,site_id,physical_device_id) REFERENCES device_inventory.physical_devices (tenant_id,site_id,physical_device_id),
      CHECK (length(btrim(component_key)) > 0), CHECK (last_seen_at >= first_seen_at)
    );
    CREATE TABLE device_inventory.physical_device_endpoints (
      tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, physical_device_id TEXT NOT NULL,
      protocol TEXT NOT NULL, endpoint_kind TEXT NOT NULL, address TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id,site_id,physical_device_id,protocol,endpoint_kind),
      FOREIGN KEY (tenant_id,site_id,physical_device_id) REFERENCES device_inventory.physical_devices (tenant_id,site_id,physical_device_id),
      CHECK (length(btrim(protocol)) > 0), CHECK (length(btrim(endpoint_kind)) > 0),
      CHECK (length(btrim(address)) > 0), CHECK (address !~* '://[^/@]+:[^/@]+@')
    );

    CREATE TABLE device_inventory.physical_device_network_observations (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
      physical_device_id TEXT NOT NULL, ip_address INET NOT NULL, mac_address TEXT,
      hostname TEXT, gateway_id TEXT, network_scope TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
      evidence_source TEXT NOT NULL,
      verification_status TEXT NOT NULL CHECK (verification_status IN ('user_confirmed','hardware_verified')),
      associated_at TIMESTAMPTZ NOT NULL, associated_by TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT TRUE,
      FOREIGN KEY (tenant_id,site_id,physical_device_id) REFERENCES device_inventory.physical_devices (tenant_id,site_id,physical_device_id),
      CHECK (length(btrim(network_scope)) > 0), CHECK (length(btrim(evidence_source)) > 0),
      CHECK (length(btrim(associated_by)) > 0)
    );
    CREATE UNIQUE INDEX physical_network_one_current_per_asset_scope
      ON device_inventory.physical_device_network_observations (tenant_id,site_id,physical_device_id,network_scope) WHERE is_current;
    CREATE UNIQUE INDEX physical_network_mac_claim_is_unique
      ON device_inventory.physical_device_network_observations (tenant_id,site_id,network_scope,lower(mac_address)) WHERE is_current AND mac_address IS NOT NULL;
    CREATE INDEX physical_network_observation_history
      ON device_inventory.physical_device_network_observations (tenant_id,site_id,physical_device_id,observed_at DESC);

    CREATE TABLE device_inventory.logical_component_assignments (
      tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, device_id TEXT NOT NULL,
      physical_device_id TEXT NOT NULL, component_key TEXT, logical_role TEXT,
      assigned_at TIMESTAMPTZ NOT NULL, assigned_by TEXT NOT NULL,
      PRIMARY KEY (tenant_id,site_id,device_id),
      FOREIGN KEY (tenant_id,site_id,device_id) REFERENCES device_inventory.enrollments (tenant_id,site_id,device_id),
      FOREIGN KEY (tenant_id,site_id,physical_device_id) REFERENCES device_inventory.physical_devices (tenant_id,site_id,physical_device_id),
      FOREIGN KEY (tenant_id,site_id,physical_device_id,component_key) REFERENCES device_inventory.physical_device_components (tenant_id,site_id,physical_device_id,component_key),
      CHECK (component_key IS NULL OR length(btrim(component_key)) > 0),
      CHECK (logical_role IS NULL OR length(btrim(logical_role)) > 0), CHECK (length(btrim(assigned_by)) > 0)
    );
    CREATE UNIQUE INDEX logical_component_one_enrollment
      ON device_inventory.logical_component_assignments (tenant_id,site_id,physical_device_id,component_key) WHERE component_key IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE device_inventory.logical_component_assignments;
    DROP TABLE device_inventory.physical_device_network_observations;
    DROP TABLE device_inventory.physical_device_endpoints;
    DROP TABLE device_inventory.physical_device_components;
    DROP TABLE device_inventory.physical_device_identity_claims;
    DROP TABLE device_inventory.physical_devices;`);
};
