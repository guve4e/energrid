exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE device_inventory.physical_device_network_observations
      ALTER COLUMN associated_at DROP NOT NULL,
      ALTER COLUMN associated_by DROP NOT NULL;

    ALTER TABLE device_inventory.physical_device_network_observations
      DROP CONSTRAINT physical_device_network_observations_verification_status_check,
      ADD CONSTRAINT physical_device_network_observations_verification_status_check
        CHECK (verification_status IN ('protocol_observed','user_confirmed','hardware_verified')),
      ADD CONSTRAINT physical_device_network_observations_verification_provenance_check
        CHECK (
          (verification_status='protocol_observed' AND associated_at IS NULL AND associated_by IS NULL)
          OR
          (verification_status IN ('user_confirmed','hardware_verified')
            AND associated_at IS NOT NULL AND associated_by IS NOT NULL
            AND length(btrim(associated_by)) > 0)
        );
  `);
};

exports.down = () => {
  throw new Error('This provenance migration is forward-only.');
};
