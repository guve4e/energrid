exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE personal_finance.receipts
      ADD COLUMN reviewed_total numeric(38, 18),
      ADD COLUMN reviewed_currency char(3),
      ADD CONSTRAINT personal_finance_receipt_reviewed_total_pair
        CHECK ((reviewed_total IS NULL) = (reviewed_currency IS NULL)),
      ADD CONSTRAINT personal_finance_receipt_reviewed_total_nonnegative
        CHECK (reviewed_total IS NULL OR reviewed_total >= 0),
      ADD CONSTRAINT personal_finance_receipt_reviewed_currency_iso
        CHECK (reviewed_currency IS NULL OR reviewed_currency ~ '^[A-Z]{3}$');
  `);
};

// Receipt originals and confirmed expenses remain intact on rollback.
exports.down = () => {};
