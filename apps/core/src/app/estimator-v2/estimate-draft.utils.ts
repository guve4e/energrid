import type { EstimateConversationDraft } from './estimate-draft.types';
import type { EstimateUpdate } from './estimate-intake.types';

export function createEmptyEstimateDraft(tenantSlug: string): EstimateConversationDraft {
  return { tenantSlug, notes: '' };
}

export function computeMissingFields(draft: EstimateConversationDraft): string[] {
  if (!draft.jobType) return ['jobType'];
  const missing: string[] = [];
  if (!Number.isInteger(draft.quantity) || Number(draft.quantity) <= 0) missing.push('quantity');
  if (draft.jobType === 'panel') {
    if (!draft.panelKind) missing.push('panelKind');
    return missing;
  }
  const isPoint = draft.jobType === 'points';
  const mode = draft.connectionMode || (draft.powerSource === 'panel' ? 'new_line_required' : draft.powerSource === 'existing_line' ? 'existing_cable_only' : undefined);
  if (!isPoint && !mode) missing.push('connectionMode');
  if (isPoint || mode === 'new_line_required') {
    if (!Number.isFinite(draft.routeLengthMeters) || Number(draft.routeLengthMeters) <= 0) missing.push('routeLengthMeters');
    if (!draft.wallType) missing.push('wallType');
  }
  return missing;
}

export function mergeEstimateDraft(input: {
  currentDraft?: EstimateConversationDraft | null;
  update: EstimateUpdate;
  tenantSlug: string;
  rawMessage?: string;
}): EstimateConversationDraft {
  const old = input.currentDraft ?? createEmptyEstimateDraft(input.tenantSlug);
  const changed = input.update.jobType && old.jobType && input.update.jobType !== old.jobType;
  const sameBoiler = String(input.update.jobType).startsWith('boiler_') && String(old.jobType).startsWith('boiler_');
  const reset = (changed && !sameBoiler) || input.update.scopeSwitch;
  const draft = reset ? createEmptyEstimateDraft(input.tenantSlug) : old;
  const next: EstimateConversationDraft = { ...draft, tenantSlug: input.tenantSlug };
  if (input.update.jobType) next.jobType = input.update.jobType;
  for (const [key, value] of Object.entries(input.update.updates ?? {})) {
    if (value != null) (next as unknown as Record<string, unknown>)[key] = value;
  }
  const updates = input.update.updates ?? {};
  if (['areaSqm', 'propertyType', 'buildingStage', 'hasBoiler', 'hasAc', 'acCount', 'hasCooker', 'hasWashingMachine'].some(key =>
    key in updates && (updates as Record<string, unknown>)[key] !== (draft as unknown as Record<string, unknown>)[key])) next.planAccepted = false;
  if (updates.hasAc === false) delete next.acCount;
  else if (updates.acCount != null) next.hasAc = true;
  if (updates.connectionMode) next.powerSource = updates.connectionMode === 'existing_cable_only' ? 'existing_line' : 'panel';
  else if (updates.powerSource) next.connectionMode = updates.powerSource === 'existing_line' ? 'existing_cable_only' : 'new_line_required';
  const message = input.rawMessage?.trim().toLowerCase() ?? '';
  if (!reset && Object.keys(updates).length === 0 && draft.currentQuestionField) {
    const match = message.match(/^(\d+(?:[.,]\d+)?)\s*(?:m|м|метра|meters|броя|бр\.?)?$/);
    if (match && (draft.currentQuestionField === 'quantity' || draft.currentQuestionField === 'routeLengthMeters')) {
      next[draft.currentQuestionField] = Number(match[1].replace(',', '.'));
    }
  }
  next.currentIntent = input.update.askExplanation ? 'explain' : 'answer';
  delete next.currentQuestionField;
  next.notes = [draft.notes, input.rawMessage].filter(Boolean).join(' | ').slice(-2000);
  return next;
}
