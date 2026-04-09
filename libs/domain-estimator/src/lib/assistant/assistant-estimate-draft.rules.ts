import type {
  AssistantEstimateDraft,
  DeviceDraft,
  PanelDraft,
  PointDraft,
} from './assistant-estimate-draft.types';

export interface DraftValidationResult {
  canPreview: boolean;
  missing: string[];
}

export function validateDraft(
  draft: AssistantEstimateDraft,
): DraftValidationResult {
  const missing: string[] = [];

  const hasPoints = draft.points.length > 0;
  const hasDevices = draft.devices.length > 0;
  const hasPanels = draft.panels.length > 0;

  if (!hasPoints && !hasDevices && !hasPanels) {
    return {
      canPreview: false,
      missing: ['scope'],
    };
  }

  for (const point of draft.points) {
    validatePoint(point, missing);
  }

  for (const device of draft.devices) {
    validateDevice(device, missing);
  }

  for (const panel of draft.panels) {
    validatePanel(panel, missing);
  }

  return {
    canPreview: missing.length === 0,
    missing,
  };
}

export function canCallPreview(draft: AssistantEstimateDraft): boolean {
  return validateDraft(draft).canPreview;
}

function validatePoint(point: PointDraft, missing: string[]) {
  if (!point.quantity || point.quantity <= 0) {
    missing.push('point.quantity');
  }

  if (!point.routeLengthMeters || point.routeLengthMeters <= 0) {
    missing.push('point.routeLengthMeters');
  }
}

function validateDevice(device: DeviceDraft, missing: string[]) {
  if (!device.quantity || device.quantity <= 0) {
    missing.push('device.quantity');
  }
}

function validatePanel(panel: PanelDraft, missing: string[]) {
  if (!panel.quantity || panel.quantity <= 0) {
    missing.push('panel.quantity');
  }
}
