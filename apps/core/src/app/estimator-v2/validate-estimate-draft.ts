import { BadRequestException } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';

export function validateEstimateDraft(value: unknown, tenantSlug: string): EstimateConversationDraft | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid estimate draft');
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = { tenantSlug };
  const enums: Record<string, string[]> = {
    pendingOffer: ['breakdown'],
    jobType: ['residential_installation', 'boiler_installation', 'boiler_replacement', 'stove_installation', 'ac_installation', 'points', 'panel'],
    propertyType: ['studio', 'apartment', 'house'],
    buildingStage: ['new', 'renovation'],
    wallType: ['brick', 'concrete', 'none'],
    powerSource: ['panel', 'existing_line'],
    connectionMode: ['existing_cable_only', 'new_line_required'],
    panelKind: ['boiler_panel', 'apartment_panel_up_to_4', 'apartment_panel_up_to_8', 'apartment_panel_above_8', 'panel_standard', 'panel_modern', 'panel_full_protection', 'panel_custom'],
    currentQuestionField: ['kitchenAppliances', 'hasCooker', 'hasWashingMachine', 'areaSqm', 'buildingStage', 'propertyType', 'hasBoiler', 'hasAc', 'planAccepted', 'jobType', 'quantity', 'routeLengthMeters', 'wallType', 'powerSource', 'panelKind', 'connectionMode'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (input[key] == null) continue;
    if (typeof input[key] !== 'string' || !allowed.includes(input[key] as string)) throw new BadRequestException(`Invalid ${key}`);
    result[key] = input[key];
  }
  if (input.templateVersion != null) {
    if (typeof input.templateVersion !== 'string' || !/^[a-z0-9-]{1,80}$/.test(input.templateVersion)) throw new BadRequestException('Invalid templateVersion');
    result.templateVersion = input.templateVersion;
  }
  for (const key of ['quantity', 'routeLengthMeters', 'areaSqm', 'acCount', 'roomCount', 'corridorCount', 'bathroomCount', 'terraceCount', 'socketCount', 'lightingPointCount', 'smartRelayCount']) {
    const number = input[key];
    if (number == null) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 10000 || ((key === 'quantity' || key === 'acCount') && (!Number.isInteger(number) || number === 0))) throw new BadRequestException(`Invalid ${key}`);
    if (['roomCount', 'socketCount', 'lightingPointCount', 'smartRelayCount'].includes(key) && (!Number.isInteger(number) || number > 500 || (key === 'roomCount' && (number < 1 || number > 20)))) throw new BadRequestException(`Invalid ${key}`);
    result[key] = number;
    if (['corridorCount', 'bathroomCount', 'terraceCount'].includes(key) && (!Number.isInteger(number) || number > 20)) throw new BadRequestException(`Invalid ${key}`);
  }
  for (const key of ['hasBoiler', 'hasAc', 'separateKitchen', 'hasOven', 'hasHob', 'hasDryer', 'hasDishwasher', 'hasCooker', 'hasWashingMachine', 'planAccepted']) if (typeof input[key] === 'boolean') result[key] = input[key];
  if (input.areaSqm != null && Number(input.areaSqm) <= 0) throw new BadRequestException('Invalid areaSqm');
  if (typeof input.replacement === 'boolean') result.replacement = input.replacement;
  if (typeof input.notes === 'string') result.notes = input.notes.slice(-2000);
  return result as unknown as EstimateConversationDraft;
}
