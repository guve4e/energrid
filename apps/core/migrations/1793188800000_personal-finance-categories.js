exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE personal_finance.categories (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
      description text CHECK (description IS NULL OR length(description) <= 500),
      parent_id uuid,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, id),
      FOREIGN KEY (account_id, parent_id) REFERENCES personal_finance.categories(account_id, id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX personal_finance_categories_active_name
      ON personal_finance.categories(account_id, lower(btrim(name))) WHERE archived_at IS NULL;
    CREATE INDEX personal_finance_categories_account_parent
      ON personal_finance.categories(account_id, parent_id);

    ALTER TABLE personal_finance.expenses ADD COLUMN category_id uuid;
    ALTER TABLE personal_finance.expenses
      ADD CONSTRAINT personal_finance_expense_category_same_account
      FOREIGN KEY (account_id, category_id) REFERENCES personal_finance.categories(account_id, id) ON DELETE RESTRICT;
    CREATE INDEX personal_finance_expenses_account_category_id_date
      ON personal_finance.expenses(account_id, category_id, expense_date DESC)
      WHERE deleted_at IS NULL AND category_id IS NOT NULL;

    CREATE TABLE personal_finance.category_events (
      id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      category_id uuid NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      event_type text NOT NULL CHECK (event_type IN ('category.created','category.renamed','category.archived')),
      details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (account_id, category_id) REFERENCES personal_finance.categories(account_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX personal_finance_category_events_timeline
      ON personal_finance.category_events(account_id, category_id, occurred_at DESC);
    CREATE FUNCTION personal_finance.reject_category_event_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Category audit events are immutable'; END $$;
    CREATE TRIGGER personal_finance_category_events_immutable
      BEFORE UPDATE OR DELETE ON personal_finance.category_events
      FOR EACH ROW EXECUTE FUNCTION personal_finance.reject_category_event_mutation();

    INSERT INTO personal_finance.categories(id, account_id, name)
    SELECT gen_random_uuid(), u.id, seed.name
    FROM auth.users u
    CROSS JOIN (VALUES
      ('Groceries'), ('Restaurants'), ('Fuel'), ('Auto'), ('Home'), ('Utilities'),
      ('Health'), ('Personal'), ('Pets'), ('Entertainment'), ('Internet'), ('Mobile'),
      ('Cloud Services'), ('Streaming'), ('Software')
    ) AS seed(name)
    ON CONFLICT DO NOTHING;
  `);
};

// Finance history and its category references are retained on rollback.
exports.down = () => {};
