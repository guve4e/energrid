/**
 * Energrid Device Enrollment V1
 *
 * Explicit enrollment, independent of:
 * - Discovery
 * - Observation authorization
 * - Command authorization
 * - Connectivity
 *
 * Existing devices are not automatically enrolled.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE SCHEMA device_inventory;

    CREATE TABLE device_inventory.enrollments (
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      device_id TEXT NOT NULL,

      display_name TEXT NOT NULL,

      status TEXT NOT NULL
        CHECK (status IN ('enrolled', 'suspended')),

      enrolled_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,

      version BIGINT NOT NULL DEFAULT 1
        CHECK (version > 0),

      PRIMARY KEY (tenant_id, site_id, device_id),

      CHECK (length(btrim(tenant_id)) > 0),
      CHECK (length(btrim(site_id)) > 0),
      CHECK (length(btrim(device_id)) > 0),
      CHECK (length(btrim(display_name)) > 0),
      CHECK (updated_at >= enrolled_at)
    );

    CREATE INDEX device_enrollments_site_status
      ON device_inventory.enrollments (
        tenant_id,
        site_id,
        status
      );

    CREATE TABLE device_inventory.enrollment_events (
      event_id TEXT PRIMARY KEY,

      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      device_id TEXT NOT NULL,

      action TEXT NOT NULL
        CHECK (
          action IN (
            'enrolled',
            'suspended',
            'reactivated'
          )
        ),

      actor TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,

      FOREIGN KEY (tenant_id, site_id, device_id)
        REFERENCES device_inventory.enrollments (
          tenant_id,
          site_id,
          device_id
        ),

      CHECK (length(btrim(actor)) > 0)
    );

    CREATE INDEX device_enrollment_events_history
      ON device_inventory.enrollment_events (
        tenant_id,
        site_id,
        device_id,
        occurred_at DESC
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE device_inventory.enrollment_events;
    DROP TABLE device_inventory.enrollments;
    DROP SCHEMA device_inventory;
  `);
};
