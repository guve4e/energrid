exports.up = (pgm) => {
  pgm.sql(`
    CREATE SCHEMA personal_finance;

    CREATE TABLE personal_finance.merchants (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 180),
      normalized_name text NOT NULL CHECK (length(btrim(normalized_name)) BETWEEN 1 AND 180),
      aliases text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, id),
      UNIQUE (account_id, normalized_name)
    );

    CREATE TABLE personal_finance.expense_drafts (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('proposed','needs_review','confirmed','rejected')),
      expense_date date,
      amount numeric(38,18),
      currency char(3),
      merchant_name text,
      merchant_id uuid,
      category text,
      description text,
      tags text[] NOT NULL DEFAULT '{}',
      source_kind text NOT NULL,
      source_id text,
      extraction_provider text,
      extraction_model text,
      source_content_hash text,
      confirmed_expense_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      UNIQUE (account_id, id),
      FOREIGN KEY (account_id, merchant_id) REFERENCES personal_finance.merchants(account_id, id),
      CHECK (amount IS NULL OR amount > 0),
      CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
      CHECK (status <> 'confirmed' OR confirmed_expense_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX personal_finance_draft_source_idempotency
      ON personal_finance.expense_drafts(account_id, source_kind, source_id)
      WHERE source_id IS NOT NULL;
    CREATE INDEX personal_finance_drafts_account_recent
      ON personal_finance.expense_drafts(account_id, created_at DESC);

    CREATE TABLE personal_finance.expenses (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      expense_date date NOT NULL,
      amount numeric(38,18) NOT NULL CHECK (amount > 0),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      amount_eur numeric(38,18) CHECK (amount_eur IS NULL OR amount_eur >= 0),
      fx_rate numeric(38,18) CHECK (fx_rate IS NULL OR fx_rate > 0),
      fx_rate_convention text CHECK (fx_rate_convention IS NULL OR fx_rate_convention = 'currency_units_per_eur'),
      fx_source text,
      fx_effective_at timestamptz,
      fx_provider text,
      merchant_id uuid,
      merchant_name text,
      category text NOT NULL CHECK (length(btrim(category)) BETWEEN 1 AND 80),
      description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
      tags text[] NOT NULL DEFAULT '{}',
      liters numeric(38,18) CHECK (liters IS NULL OR liters > 0),
      source_kind text NOT NULL CHECK (length(btrim(source_kind)) BETWEEN 1 AND 40),
      source_id text,
      legacy_record_id text,
      source_created_at timestamptz,
      source_updated_at timestamptz,
      confirmed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      confirmed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (account_id, id),
      FOREIGN KEY (account_id, merchant_id) REFERENCES personal_finance.merchants(account_id, id)
    );
    CREATE UNIQUE INDEX personal_finance_expense_source_idempotency
      ON personal_finance.expenses(account_id, source_kind, source_id)
      WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX personal_finance_expense_legacy_idempotency
      ON personal_finance.expenses(account_id, legacy_record_id)
      WHERE legacy_record_id IS NOT NULL;
    CREATE INDEX personal_finance_expenses_account_date
      ON personal_finance.expenses(account_id, expense_date DESC, id DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX personal_finance_expenses_account_category_date
      ON personal_finance.expenses(account_id, category, expense_date DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX personal_finance_expenses_account_merchant_date
      ON personal_finance.expenses(account_id, merchant_id, expense_date DESC)
      WHERE deleted_at IS NULL;

    CREATE TABLE personal_finance.expense_items (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      expense_id uuid NOT NULL,
      description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 240),
      product_code text,
      quantity numeric(38,18) NOT NULL CHECK (quantity > 0),
      unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
      unit_price numeric(38,18) NOT NULL CHECK (unit_price >= 0),
      discount numeric(38,18) NOT NULL DEFAULT 0 CHECK (discount >= 0),
      tax numeric(38,18) NOT NULL DEFAULT 0 CHECK (tax >= 0),
      line_total numeric(38,18) NOT NULL CHECK (line_total >= 0),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      source_receipt_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, id),
      FOREIGN KEY (account_id, expense_id) REFERENCES personal_finance.expenses(account_id, id) ON DELETE CASCADE
    );
    CREATE INDEX personal_finance_items_account_expense
      ON personal_finance.expense_items(account_id, expense_id);
    CREATE INDEX personal_finance_items_account_product_currency
      ON personal_finance.expense_items(account_id, product_code, currency);
    CREATE INDEX personal_finance_items_account_description
      ON personal_finance.expense_items(account_id, description);

    CREATE TABLE personal_finance.expense_draft_items (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      draft_id uuid NOT NULL,
      description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 240),
      product_code text,
      quantity numeric(38,18) NOT NULL CHECK (quantity > 0),
      unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 40),
      unit_price numeric(38,18) NOT NULL CHECK (unit_price >= 0),
      discount numeric(38,18) NOT NULL DEFAULT 0 CHECK (discount >= 0),
      tax numeric(38,18) NOT NULL DEFAULT 0 CHECK (tax >= 0),
      line_total numeric(38,18) NOT NULL CHECK (line_total >= 0),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      source_receipt_id uuid,
      UNIQUE (account_id, id),
      FOREIGN KEY (account_id, draft_id) REFERENCES personal_finance.expense_drafts(account_id, id) ON DELETE CASCADE
    );
    CREATE INDEX personal_finance_draft_items_account_draft
      ON personal_finance.expense_draft_items(account_id, draft_id);

    CREATE TABLE personal_finance.receipts (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      draft_id uuid,
      expense_id uuid,
      content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/heic','application/pdf')),
      byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 10485760),
      storage_key text NOT NULL CHECK (length(btrim(storage_key)) BETWEEN 1 AND 500),
      status text NOT NULL CHECK (status IN ('attached','processing','review_required','reconciled','failed')),
      extracted_totals jsonb CHECK (extracted_totals IS NULL OR jsonb_typeof(extracted_totals) = 'object'),
      parser_provider text,
      parser_model text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, id),
      UNIQUE (account_id, storage_key),
      FOREIGN KEY (account_id, draft_id) REFERENCES personal_finance.expense_drafts(account_id, id),
      FOREIGN KEY (account_id, expense_id) REFERENCES personal_finance.expenses(account_id, id),
      CHECK (num_nonnulls(draft_id, expense_id) <= 1)
    );
    CREATE UNIQUE INDEX personal_finance_receipt_dedupe
      ON personal_finance.receipts(account_id, content_hash);
    CREATE INDEX personal_finance_receipts_account_draft
      ON personal_finance.receipts(account_id, draft_id) WHERE draft_id IS NOT NULL;

    ALTER TABLE personal_finance.expense_items
      ADD CONSTRAINT personal_finance_item_receipt_same_account
      FOREIGN KEY (account_id, source_receipt_id) REFERENCES personal_finance.receipts(account_id, id);
    ALTER TABLE personal_finance.expense_draft_items
      ADD CONSTRAINT personal_finance_draft_item_receipt_same_account
      FOREIGN KEY (account_id, source_receipt_id) REFERENCES personal_finance.receipts(account_id, id);
    ALTER TABLE personal_finance.expense_drafts
      ADD CONSTRAINT personal_finance_confirmed_expense_same_account
      FOREIGN KEY (account_id, confirmed_expense_id) REFERENCES personal_finance.expenses(account_id, id);

    CREATE TABLE personal_finance.provenance_events (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      expense_id uuid,
      draft_id uuid,
      receipt_id uuid,
      event_type text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 80),
      actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
      source_kind text NOT NULL CHECK (length(btrim(source_kind)) BETWEEN 1 AND 40),
      source_id text,
      provider text,
      model text,
      content_hash text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (account_id, expense_id) REFERENCES personal_finance.expenses(account_id, id),
      FOREIGN KEY (account_id, draft_id) REFERENCES personal_finance.expense_drafts(account_id, id),
      FOREIGN KEY (account_id, receipt_id) REFERENCES personal_finance.receipts(account_id, id),
      CHECK (num_nonnulls(expense_id, draft_id, receipt_id) >= 1)
    );
    CREATE INDEX personal_finance_provenance_expense_timeline
      ON personal_finance.provenance_events(account_id, expense_id, occurred_at DESC) WHERE expense_id IS NOT NULL;
    CREATE INDEX personal_finance_provenance_draft_timeline
      ON personal_finance.provenance_events(account_id, draft_id, occurred_at DESC) WHERE draft_id IS NOT NULL;
    CREATE INDEX personal_finance_provenance_receipt_timeline
      ON personal_finance.provenance_events(account_id, receipt_id, occurred_at DESC) WHERE receipt_id IS NOT NULL;

    CREATE FUNCTION personal_finance.reject_provenance_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Provenance events are immutable'; END $$;
    CREATE TRIGGER personal_finance_provenance_immutable
      BEFORE UPDATE OR DELETE ON personal_finance.provenance_events
      FOR EACH ROW EXECUTE FUNCTION personal_finance.reject_provenance_mutation();
  `);
};

// This additive schema holds financial history. Rollback is intentionally a no-op.
exports.down = () => {};
