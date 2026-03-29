const { Client } = require('pg');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
  quiet: true,
});

const { estimateProject } = require('../../../libs/domain-estimator/src/lib/estimate.engine.ts');

function must(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function dbConfig() {
  return {
    host: must('PGHOST'),
    port: Number(must('PGPORT')),
    database: must('PGDATABASE'),
    user: must('PGUSER'),
    password: must('PGPASSWORD'),
    ssl:
      String(process.env.PGSSL || '').toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : false,
  };
}

async function main() {
  const client = new Client(dbConfig());

  try {
    await client.connect();

    const { rows } = await client.query(`
      select
        code,
        category,
        name_bg,
        unit,
        base_price,
        pricing_mode,
        rules_json,
        labor_included,
        materials_included,
        is_active
      from pricing_catalog
      where is_active = true
      order by category, code
    `);

    const result = estimateProject(rows, {
      tenantSlug: 'energrid',
      includeConsultation: true,
      points: [
        {
          kind: 'power_point',
          quantity: 4,
          routeLengthMeters: 5,
          wallType: 'brick',
        },
        {
          kind: 'low_current_point',
          quantity: 2,
          routeLengthMeters: 3,
          wallType: 'none',
        },
      ],
      devices: [
        {
          kind: 'socket_or_switch_concealed',
          quantity: 6,
        },
        {
          kind: 'three_phase_socket',
          quantity: 1,
        },
      ],
      panels: [
        {
          kind: 'apartment_panel_up_to_8',
          quantity: 1,
        },
      ],
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
