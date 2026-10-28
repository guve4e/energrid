exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE personal_finance.expense_items
      ADD COLUMN normalized_description text,
      ADD COLUMN packaging text,
      ADD COLUMN tax_included boolean NOT NULL DEFAULT false,
      ADD COLUMN category_id uuid,
      ADD COLUMN extraction_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE personal_finance.expense_items
      ADD CONSTRAINT personal_finance_item_category_same_account
      FOREIGN KEY (account_id, category_id) REFERENCES personal_finance.categories(account_id, id);

    ALTER TABLE personal_finance.expense_draft_items
      ADD COLUMN normalized_description text,
      ADD COLUMN packaging text,
      ADD COLUMN tax_included boolean NOT NULL DEFAULT false,
      ADD COLUMN category_id uuid,
      ADD COLUMN extraction_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE personal_finance.expense_draft_items
      ADD CONSTRAINT personal_finance_draft_item_category_same_account
      FOREIGN KEY (account_id, category_id) REFERENCES personal_finance.categories(account_id, id);

    ALTER TABLE personal_finance.receipts
      ADD COLUMN extraction_schema_version text,
      ADD COLUMN document_type text,
      ADD COLUMN source_text text,
      ADD COLUMN extraction_result jsonb,
      ADD COLUMN extraction_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN user_reviewed_at timestamptz,
      ADD COLUMN reviewed_as_total_only boolean NOT NULL DEFAULT false,
      ADD COLUMN document_deleted_at timestamptz,
      ADD COLUMN reviewed_adjustments jsonb;
    ALTER TABLE personal_finance.receipts
      ADD CONSTRAINT personal_finance_receipt_extraction_object
      CHECK (extraction_result IS NULL OR jsonb_typeof(extraction_result) = 'object'),
      ADD CONSTRAINT personal_finance_receipt_adjustments_array
      CHECK (reviewed_adjustments IS NULL OR jsonb_typeof(reviewed_adjustments) = 'array'),
      ADD CONSTRAINT personal_finance_receipt_warnings_array
      CHECK (jsonb_typeof(extraction_warnings) = 'array'),
      ADD CONSTRAINT personal_finance_receipt_document_type
      CHECK (document_type IS NULL OR document_type IN ('receipt', 'invoice', 'other')),
      ADD CONSTRAINT personal_finance_receipt_source_text_size
      CHECK (source_text IS NULL OR length(source_text) <= 30000);
  `);
};

exports.down = () => {};
