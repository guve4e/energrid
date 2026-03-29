exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('projects', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    tenant_slug: { type: 'text', notNull: true },
    lead_id: { type: 'uuid' },
    conversation_id: { type: 'uuid' },
    status: {
      type: 'text',
      notNull: true,
      default: 'new',
    },
    name: { type: 'text' },
    city: { type: 'text' },
    address: { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createTable('estimates', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'projects',
      onDelete: 'cascade',
    },
    source: {
      type: 'text',
      notNull: true,
    },
    subtotal: {
      type: 'numeric(12,2)',
      notNull: true,
    },
    currency: {
      type: 'text',
      notNull: true,
      default: 'EUR',
    },
    confidence: {
      type: 'text',
      notNull: true,
    },
    needs_inspection: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    assumptions_json: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'[]'::jsonb`),
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createTable('estimate_lines', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    estimate_id: {
      type: 'uuid',
      notNull: true,
      references: 'estimates',
      onDelete: 'cascade',
    },
    code: {
      type: 'text',
      notNull: true,
    },
    label: {
      type: 'text',
      notNull: true,
    },
    quantity: {
      type: 'numeric(12,2)',
      notNull: true,
    },
    unit: {
      type: 'text',
      notNull: true,
    },
    unit_price: {
      type: 'numeric(12,2)',
      notNull: true,
    },
    subtotal: {
      type: 'numeric(12,2)',
      notNull: true,
    },
  });

  pgm.createTable('pricing_catalog', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    code: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    category: {
      type: 'text',
      notNull: true,
    },
    name_bg: {
      type: 'text',
      notNull: true,
    },
    unit: {
      type: 'text',
      notNull: true,
    },
    base_price: {
      type: 'numeric(12,2)',
      notNull: true,
    },
    pricing_mode: {
      type: 'text',
      notNull: true
    },
    rules_json: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{}'::jsonb`),
    },
    labor_included: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    materials_included: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('projects', 'tenant_slug');
  pgm.createIndex('projects', 'lead_id');
  pgm.createIndex('projects', 'conversation_id');
  pgm.createIndex('estimates', 'project_id');
  pgm.createIndex('estimate_lines', 'estimate_id');
  pgm.createIndex('pricing_catalog', 'category');
  pgm.createIndex('pricing_catalog', 'is_active');
};

exports.down = (pgm) => {
  pgm.dropTable('estimate_lines', { ifExists: true });
  pgm.dropTable('estimates', { ifExists: true });
  pgm.dropTable('projects', { ifExists: true });
  pgm.dropTable('pricing_catalog', { ifExists: true });
};
