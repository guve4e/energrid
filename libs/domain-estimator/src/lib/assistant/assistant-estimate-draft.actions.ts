import type { AssistantEstimateDraft } from './assistant-estimate-draft.types';
import { validateDraft } from './assistant-estimate-draft.rules';
import { getQuestionForMissing } from './assistant-estimate-draft.prompts';

export type DraftNextAction =
  | {
      type: 'ready_for_preview';
    }
  | {
      type: 'ask_missing_field';
      field: string;
      question: string;
    };

export function getDraftValidation(draft: AssistantEstimateDraft) {
  return validateDraft(draft);
}

export function getFirstMissingDraftField(
  draft: AssistantEstimateDraft,
): string | null {
  const result = validateDraft(draft);
  return result.missing[0] ?? null;
}

export function getDraftQuestion(
  draft: AssistantEstimateDraft,
): string | null {
  const field = getFirstMissingDraftField(draft);
  return field ? getQuestionForMissing(field) : null;
}

export function getDraftNextAction(
  draft: AssistantEstimateDraft,
): DraftNextAction {
  const result = validateDraft(draft);

  if (result.canPreview) {
    return {
      type: 'ready_for_preview',
    };
  }

  const field = result.missing[0] ?? 'unknown';

  return {
    type: 'ask_missing_field',
    field,
    question: getQuestionForMissing(field),
  };
}
