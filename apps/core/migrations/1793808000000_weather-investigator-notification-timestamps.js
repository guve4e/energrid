// The V1 LAB investigator set first_notified_at when a finding was merely
// prepared. No delivery integration existed, so those values are not proof of
// notification. Restore the honest unknown/not-delivered state before delivery
// semantics are introduced. Run against an isolated LAB database only.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE weather_investigation_findings
    SET first_notified_at = NULL
    WHERE first_notified_at IS NOT NULL;
  `);
};

// Cannot reconstruct timestamps that never represented deliveries.
exports.down = () => {};
