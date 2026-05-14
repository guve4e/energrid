import type { EstimateConversationDraft } from './estimate-draft.types';
import type { EstimateUpdate } from './estimate-intake.types';

export function createEmptyEstimateDraft(
  tenantSlug: string,
): EstimateConversationDraft {
  return {
    tenantSlug,
    notes: '',
  };
}

export function computeMissingFields(draft: any): string[] {
  if (!draft.jobType) return ['jobType'];

  switch (draft.jobType) {
    case 'boiler_replacement': {
      const missing: string[] = [];

      if (!draft.quantity) missing.push('quantity');

      if (!draft.connectionMode && !draft.powerSource) {
        missing.push('connectionMode');
      }

      return missing;
    }

    case 'boiler_installation': {
      const missing: string[] = [];

      if (!draft.quantity) missing.push('quantity');
      if (!draft.powerSource) missing.push('powerSource');
      if (!draft.routeLengthMeters) missing.push('routeLengthMeters');

      if (draft.routeLengthMeters && !draft.wallType) {
        missing.push('wallType');
      }

      return missing;
    }

    default:
      return [];
  }
}

export function mergeEstimateDraft(input: {
  currentDraft?: EstimateConversationDraft | null;
  update: EstimateUpdate;
  tenantSlug: string;
  rawMessage?: string;
}): EstimateConversationDraft {
  const draft =
    input.currentDraft ?? createEmptyEstimateDraft(input.tenantSlug);

  const nextDraft: EstimateConversationDraft = {
    ...draft,
    tenantSlug: input.tenantSlug,
  };

  const msg = input.rawMessage?.toLowerCase() ?? '';

  // 🔥 INTENT DETECTION (minimal)
  if (/защо|zashto/.test(msg)) {
    nextDraft.currentIntent = 'question_why';
  } else {
    nextDraft.currentIntent = 'answer';
  }

  // 🔥 FORCE replacement detection
  if (/podmeni|podmqna|smqna|замяна|подмяна|replace/.test(msg)) {
    nextDraft.jobType = 'boiler_replacement';
    nextDraft.quantity = nextDraft.quantity ?? 1;
  }

  if (input.update.jobType) {
    nextDraft.jobType = input.update.jobType;
  }

  const updates = input.update.updates ?? {};

  // 🔥 APPLY DIRECT UPDATES
  Object.assign(nextDraft, updates);

  // 🔥 FALLBACK: bind short answers to last asked field
  if (
    Object.keys(updates).length === 0 &&
    draft.currentQuestionField
  ) {
    if (draft.currentQuestionField === 'routeLengthMeters') {
      const match = msg.match(/\d+/);
      if (match) {
        nextDraft.routeLengthMeters = Number(match[0]);
      }
    }

    if (draft.currentQuestionField === 'quantity') {
      const match = msg.match(/\d+/);
      if (match) {
        nextDraft.quantity = Number(match[0]);
      }
    }

    if (draft.currentQuestionField === 'connectionMode') {
      if (/да|yes|има|ok/.test(msg)) {
        nextDraft.connectionMode = 'existing_cable_only';
      }
      if (/не|no/.test(msg)) {
        nextDraft.connectionMode = 'new_line_required';
      }
    }
  }

  nextDraft.notes = [draft.notes, input.rawMessage]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 2000);

  return nextDraft;
}
