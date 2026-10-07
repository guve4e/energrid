import { ServiceUnavailableException } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';
import type { CatalogV2Service } from './catalog-v2.service';

export interface RangeEstimate {
  currency: 'EUR';
  min: number;
  max: number;
  needsInspection: true;
  assumptions: string[];
  lines: Array<{ code: string; label: string; quantity: number; unit: string; unitPriceMin: number; unitPriceMax: number; min: number; max: number }>;
}

export async function estimateAppliance(draft: EstimateConversationDraft, catalog: CatalogV2Service): Promise<RangeEstimate> {
  const boiler = draft.jobType?.startsWith('boiler_');
  const prefix = boiler ? 'boiler' : 'stove';
  const newLine = draft.connectionMode === 'new_line_required';
  const base = newLine ? `${prefix}_new_line_base` : boiler ? 'boiler_replacement_existing_cable' : 'stove_existing_cable';
  const round = (n: number) => Math.round(n * 100) / 100;
  const lines: RangeEstimate['lines'] = [];
  async function add(minCode: string, maxCode: string, quantity: number, label: string) {
    const rows = await catalog.getManyByCodes([minCode, maxCode]);
    const low = Number(rows[minCode].base_price);
    const high = Number(rows[maxCode].base_price);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) throw new ServiceUnavailableException('Invalid estimate catalog range');
    lines.push({ code: minCode === maxCode ? minCode : `${minCode} / ${maxCode}`, label, quantity, unit: rows[minCode].unit, unitPriceMin: low, unitPriceMax: high, min: round(low * quantity), max: round(high * quantity) });
  }
  const quantity = draft.quantity!;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Invalid appliance quantity');
  await add(`${base}_min`, `${base}_max`, quantity, newLine ? 'Свързване с ново трасе до 3 м на уред' : 'Свързване към съществуващ подходящ кабел');
  if (newLine) {
    const meters = draft.routeLengthMeters!;
    if (!Number.isFinite(meters) || meters <= 0) throw new Error('Invalid route length');
    const extra = Math.max(0, meters - 3) * quantity;
    if (extra) await add(`${prefix}_new_line_extra_meter_min`, `${prefix}_new_line_extra_meter_max`, extra, 'Допълнително трасе над 3 м на уред');
    if (draft.wallType === 'brick' || draft.wallType === 'concrete') {
      const code = `chasing_${draft.wallType}_per_meter`;
      await add(code, code, quantity * meters, draft.wallType === 'brick' ? 'Къртене в тухла' : 'Къртене в бетон');
    }
  }
  return { currency: 'EUR', min: round(lines.reduce((n, l) => n + l.min, 0)), max: round(lines.reduce((n, l) => n + l.max, 0)), needsInspection: true, lines,
    assumptions: ['Ориентировъчна цена за електрическата работа, преди оглед.', 'Материалите, ВиК монтажът и ремонтът на стените не са включени.', 'Подходящото захранване и необходимите защити се проверяват на място.', 'Данъчният режим се уточнява в окончателната оферта.', ...(newLine ? ['Дължината е за всеки уред; трасетата са изчислени отделно.'] : [])] };
}

export function formatRangeEstimate(estimate: RangeEstimate): string {
  return [`Ориентировъчен труд: ${estimate.min.toFixed(2)}–${estimate.max.toFixed(2)} EUR.`,
    ...estimate.lines.map(l => `${l.label}: ${l.quantity} ${l.unit} × ${l.unitPriceMin.toFixed(2)}–${l.unitPriceMax.toFixed(2)} = ${l.min.toFixed(2)}–${l.max.toFixed(2)} EUR.`),
    ...estimate.assumptions].join('\n');
}
