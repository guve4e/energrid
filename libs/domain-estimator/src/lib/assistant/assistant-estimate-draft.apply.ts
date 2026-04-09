import type {
  AssistantEstimateDraft,
  DeviceDraft,
  PanelDraft,
  PointDraft,
} from './assistant-estimate-draft.types';
import type { AssistantExtraction } from './assistant-intake-extractor.types';

function createEmptyDraft(tenantSlug: string): AssistantEstimateDraft {
  return {
    tenantSlug,
    includeConsultation: false,
    points: [],
    devices: [],
    panels: [],
    notes: '',
  };
}

export function applyExtractionToDraft(input: {
  tenantSlug: string;
  extraction: AssistantExtraction;
  currentDraft?: AssistantEstimateDraft | null;
}): AssistantEstimateDraft {
  const draft = input.currentDraft
    ? structuredClone(input.currentDraft)
    : createEmptyDraft(input.tenantSlug);

  const e = input.extraction;

  if (e.action === 'set_scope' || e.action === 'add_scope') {
    if (e.entityType === 'device') {
      draft.devices.push({
        kind: e.entityKind as DeviceDraft['kind'],
        quantity: e.quantity,
      });
    }

    if (e.entityType === 'point') {
      draft.points.push({
        kind: e.entityKind as PointDraft['kind'],
        quantity: e.quantity,
        routeLengthMeters: e.routeLengthMeters,
        wallType: e.wallType,
      });
    }

    if (e.entityType === 'panel') {
      draft.panels.push({
        kind: e.entityKind as PanelDraft['kind'],
        quantity: e.quantity ?? 1,
      });
    }
  }

  if (e.action === 'fill_missing_field') {
    if (e.field === 'quantity') {
      const target =
        draft.devices.find((x) => !x.quantity) ||
        draft.points.find((x) => !x.quantity) ||
        draft.panels.find((x) => !x.quantity);

      if (target && typeof e.value === 'number') {
        target.quantity = e.value;
      }
    }

    if (e.field === 'routeLengthMeters') {
      const point = draft.points.find((x) => !x.routeLengthMeters);
      if (point && typeof e.value === 'number') {
        point.routeLengthMeters = e.value;
      }
    }
  }

  return draft;
}
