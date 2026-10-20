/**
 * Adds durable retirement and explicit reenrollment to device enrollment.
 * Existing enrollment rows and history remain unchanged.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE device_inventory.enrollments
      DROP CONSTRAINT enrollments_status_check;
    ALTER TABLE device_inventory.enrollments
      ADD CONSTRAINT enrollments_status_check
      CHECK (status IN ('enrolled', 'suspended', 'retired'));

    ALTER TABLE device_inventory.enrollment_events
      DROP CONSTRAINT enrollment_events_action_check;
    ALTER TABLE device_inventory.enrollment_events
      ADD CONSTRAINT enrollment_events_action_check
      CHECK (action IN (
        'enrolled', 'suspended', 'reactivated', 'retired', 'reenrolled'
      ));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM device_inventory.enrollments WHERE status = 'retired'
      ) OR EXISTS (
        SELECT 1 FROM device_inventory.enrollment_events
        WHERE action IN ('retired', 'reenrolled')
      ) THEN
        RAISE EXCEPTION 'Cannot revert enrollment retirement with retained history';
      END IF;
    END $$;

    ALTER TABLE device_inventory.enrollments
      DROP CONSTRAINT enrollments_status_check;
    ALTER TABLE device_inventory.enrollments
      ADD CONSTRAINT enrollments_status_check
      CHECK (status IN ('enrolled', 'suspended'));

    ALTER TABLE device_inventory.enrollment_events
      DROP CONSTRAINT enrollment_events_action_check;
    ALTER TABLE device_inventory.enrollment_events
      ADD CONSTRAINT enrollment_events_action_check
      CHECK (action IN ('enrolled', 'suspended', 'reactivated'));
  `);
};
