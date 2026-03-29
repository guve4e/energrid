import { describe, expect, it } from 'vitest';
import { estimateProject } from './estimate.engine';
import type { PricingCatalogRow } from './estimate.types';

const catalog: PricingCatalogRow[] = [
  {
    code: 'power_point_up_to_3m',
    category: 'installation_power',
    name_bg: 'Power point up to 3m',
    unit: 'точка',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'low_current_point_up_to_3m',
    category: 'installation_low_current',
    name_bg: 'Low current point up to 3m',
    unit: 'точка',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'power_line_extra_meter_after_3m',
    category: 'installation_power',
    name_bg: 'Power extra meter',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'low_current_line_extra_meter_after_3m',
    category: 'installation_low_current',
    name_bg: 'Low current extra meter',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'chasing_brick_per_meter',
    category: 'chasing',
    name_bg: 'Brick chasing',
    unit: 'л.м.',
    base_price: 10,
    pricing_mode: 'per_meter',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'chasing_concrete_per_meter',
    category: 'chasing',
    name_bg: 'Concrete chasing',
    unit: 'л.м.',
    base_price: 12,
    pricing_mode: 'per_meter',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'socket_or_switch_concealed',
    category: 'device_mount',
    name_bg: 'Concealed socket/switch',
    unit: 'бр.',
    base_price: 10,
    pricing_mode: 'fixed',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'three_phase_socket',
    category: 'device_mount',
    name_bg: 'Three phase socket',
    unit: 'бр.',
    base_price: 40,
    pricing_mode: 'fixed',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'apartment_panel_up_to_8',
    category: 'panel',
    name_bg: 'Apartment panel up to 8',
    unit: 'бр.',
    base_price: 20,
    pricing_mode: 'fixed',
    rules_json: {},
    is_active: true,
  },
  {
    code: 'onsite_consultation_paid',
    category: 'consultation',
    name_bg: 'Onsite consultation',
    unit: 'бр.',
    base_price: 30,
    pricing_mode: 'fixed',
    rules_json: {},
    is_active: true,
  },
];

describe('estimateProject', () => {
  it('calculates a simple power point up to 3m', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
      points: [
        {
          kind: 'power_point',
          quantity: 2,
          routeLengthMeters: 3,
          wallType: 'none',
        },
      ],
    });

    expect(result.subtotal).toBe(40);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      code: 'power_point_up_to_3m',
      quantity: 2,
      subtotal: 40,
    });
    expect(result.confidence).toBe('high');
  });

  it('adds extra meters for routes above 3m', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
      points: [
        {
          kind: 'power_point',
          quantity: 4,
          routeLengthMeters: 5,
          wallType: 'none',
        },
      ],
    });

    expect(result.subtotal).toBe(160);
    expect(result.lines).toHaveLength(2);

    expect(result.lines[0]).toMatchObject({
      code: 'power_point_up_to_3m',
      quantity: 4,
      subtotal: 80,
    });

    expect(result.lines[1]).toMatchObject({
      code: 'power_line_extra_meter_after_3m',
      quantity: 8,
      subtotal: 80,
    });

    expect(result.confidence).toBe('medium');
  });

  it('uses shared-route heuristic for brick chasing', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
      points: [
        {
          kind: 'power_point',
          quantity: 4,
          routeLengthMeters: 5,
          wallType: 'brick',
        },
      ],
    });

    const chasing = result.lines.find((x) => x.code === 'chasing_brick_per_meter');
    expect(chasing).toBeDefined();
    expect(chasing?.quantity).toBe(11);
    expect(chasing?.subtotal).toBe(110);
    expect(result.subtotal).toBe(270);
  });

  it('uses concrete chasing row when wall type is concrete', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
      points: [
        {
          kind: 'power_point',
          quantity: 2,
          routeLengthMeters: 4,
          wallType: 'concrete',
        },
      ],
    });

    const chasing = result.lines.find((x) => x.code === 'chasing_concrete_per_meter');
    expect(chasing).toBeDefined();
    expect(chasing?.quantity).toBe(5.6);
    expect(chasing?.subtotal).toBe(67.2);
  });

  it('adds devices, panels and consultation', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
      includeConsultation: true,
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

    expect(result.subtotal).toBe(150);
    expect(result.lines.map((x) => x.code)).toEqual([
      'socket_or_switch_concealed',
      'three_phase_socket',
      'apartment_panel_up_to_8',
      'onsite_consultation_paid',
    ]);
  });

  it('returns low confidence for nearly empty requests', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
    });

    expect(result.subtotal).toBe(0);
    expect(result.lines).toHaveLength(0);
    expect(result.confidence).toBe('low');
  });

  it('throws when a required catalog row is missing', () => {
    const brokenCatalog = catalog.filter((x) => x.code !== 'power_point_up_to_3m');

    expect(() =>
      estimateProject(brokenCatalog, {
        tenantSlug: 'energrid',
        points: [
          {
            kind: 'power_point',
            quantity: 1,
            routeLengthMeters: 3,
            wallType: 'none',
          },
        ],
      }),
    ).toThrow('Missing pricing catalog row for code: power_point_up_to_3m');
  });

  it('ignores zero-quantity device lines', () => {
    const result = estimateProject(catalog, {
      tenantSlug: 'energrid',
      devices: [
        {
          kind: 'socket_or_switch_concealed',
          quantity: 0,
        },
      ],
    });

    expect(result.subtotal).toBe(0);
    expect(result.lines).toHaveLength(0);
  });
});
