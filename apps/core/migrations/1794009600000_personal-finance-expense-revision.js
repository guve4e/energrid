exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE personal_finance.expenses
      ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
  `);
};

// Reject rollback rather than silently discarding the migration ledger entry.
exports.down = () => {
  throw new Error('Irreversible migration: expense revision history must be preserved.');
};
