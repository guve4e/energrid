const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
  quiet: true,
});

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

const items = [
  {
    code: 'power_point_up_to_3m',
    category: 'installation_power',
    name_bg: 'Изграждане на силнотокова инсталация до 3м.',
    unit: 'точка',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {
      maxLengthMeters: 3,
      kind: 'power_point',
    },
  },
  {
    code: 'low_current_point_up_to_3m',
    category: 'installation_low_current',
    name_bg: 'Изграждане на слаботокова инсталация до 3м.',
    unit: 'точка',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {
      maxLengthMeters: 3,
      kind: 'low_current_point',
    },
  },
  {
    code: 'power_line_extra_meter_after_3m',
    category: 'installation_power',
    name_bg: 'Изграждане на силова електрическа инсталация над 3 метра.',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {
      appliesAfterMeters: 3,
      kind: 'power_line_extra_meter',
    },
  },
  {
    code: 'low_current_line_extra_meter_after_3m',
    category: 'installation_low_current',
    name_bg: 'Изграждане на слаботокова инсталация над 3 метра.',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {
      appliesAfterMeters: 3,
      kind: 'low_current_line_extra_meter',
    },
  },
  {
    code: 'chasing_brick_per_meter',
    category: 'chasing',
    name_bg: 'Къртене на улей за електроинсталация в тухла.',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {
      wallType: 'brick',
      kind: 'chasing',
    },
  },
  {
    code: 'chasing_concrete_per_meter',
    category: 'chasing',
    name_bg: 'Къртене на улей за електроинсталация в бетон.',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {
      wallType: 'concrete',
      kind: 'chasing',
    },
  },
  {
    code: 'socket_or_switch_concealed',
    category: 'device_mount',
    name_bg: 'Ключове и контакти за скрит монтаж.',
    unit: 'бр.',
    base_price: 10,
    pricing_mode: 'fixed',
    rules_json: {
      mountType: 'concealed',
      kind: 'socket_or_switch',
    },
  },
  {
    code: 'socket_or_switch_surface',
    category: 'device_mount',
    name_bg: 'Ключове и контакти за открит монтаж.',
    unit: 'бр.',
    base_price: 10,
    pricing_mode: 'fixed',
    rules_json: {
      mountType: 'surface',
      kind: 'socket_or_switch',
    },
  },
  {
    code: 'three_phase_socket',
    category: 'device_mount',
    name_bg: 'Трифазен контакт.',
    unit: 'бр.',
    base_price: 40,
    pricing_mode: 'fixed',
    rules_json: {
      phaseType: 'three_phase',
      kind: 'socket',
    },
  },
  {
    code: 'boiler_panel',
    category: 'panel',
    name_bg: 'Бойлерно табло.',
    unit: 'бр.',
    base_price: 40,
    pricing_mode: 'fixed',
    rules_json: {
      kind: 'boiler_panel',
    },
  },
  {
    code: 'apartment_panel_up_to_4',
    category: 'panel',
    name_bg: 'Апартаментно ел табло от 4 позиции.',
    unit: 'бр.',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {
      maxPositions: 4,
      kind: 'apartment_panel',
    },
  },
  {
    code: 'apartment_panel_up_to_8',
    category: 'panel',
    name_bg: 'Апартаментно ел табло до 8 позиции.',
    unit: 'бр.',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {
      maxPositions: 8,
      kind: 'apartment_panel',
    },
  },
  {
    code: 'apartment_panel_above_8',
    category: 'panel',
    name_bg: 'Апартаментно ел табло над 8 позиции.',
    unit: 'бр.',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {
      minPositions: 9,
      kind: 'apartment_panel',
    },
  },
  {
    code: 'bathroom_fan',
    category: 'device_mount',
    name_bg: 'Вентилатор за баня.',
    unit: 'бр.',
    base_price: 40,
    pricing_mode: 'fixed',
    rules_json: {
      kind: 'bathroom_fan',
    },
  },
  {
    code: 'light_fixture_basic',
    category: 'lighting',
    name_bg: 'Осветително тяло тип плафониера.',
    unit: 'бр.',
    base_price: 40,
    pricing_mode: 'fixed',
    rules_json: {
      kind: 'light_fixture_basic',
    },
  },
  {
    code: 'motion_sensor',
    category: 'lighting',
    name_bg: 'Датчик за движение.',
    unit: 'бр.',
    base_price: 40,
    pricing_mode: 'fixed',
    rules_json: {
      kind: 'motion_sensor',
    },
  },
  {
    code: 'internet_outlet',
    category: 'low_current_devices',
    name_bg: 'Розетки – интернет, телефон.',
    unit: 'бр.',
    base_price: 10,
    pricing_mode: 'fixed',
    rules_json: {
      kind: 'internet_outlet',
    },
  },
  {
    code: 'onsite_consultation_paid',
    category: 'consultation',
    name_bg: 'Консултации от специалист на място (офериране).',
    unit: 'бр.',
    base_price: 30,
    pricing_mode: 'fixed',
    rules_json: {
      kind: 'onsite_consultation',
    },
  },
];

async function upsertCatalogItem(client, item) {
  await client.query(
    `
    insert into pricing_catalog (
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
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (code)
    do update set
      category = excluded.category,
      name_bg = excluded.name_bg,
      unit = excluded.unit,
      base_price = excluded.base_price,
      pricing_mode = excluded.pricing_mode,
      rules_json = excluded.rules_json,
      labor_included = excluded.labor_included,
      materials_included = excluded.materials_included,
      is_active = excluded.is_active,
      updated_at = now()
    `,
    [
      item.code,
      item.category,
      item.name_bg,
      item.unit,
      item.base_price,
      item.pricing_mode,
      JSON.stringify(item.rules_json ?? {}),
      true,
      false,
      true,
    ],
  );
}

async function main() {
  const client = new Client(dbConfig());

  try {
    await client.connect();
    console.log(`[seed] connected to ${process.env.PGDATABASE}`);

    for (const item of items) {
      await upsertCatalogItem(client, item);
      console.log(`[seed] upserted ${item.code}`);
    }

    console.log(`[seed] done: ${items.length} catalog items`);
  } catch (error) {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
