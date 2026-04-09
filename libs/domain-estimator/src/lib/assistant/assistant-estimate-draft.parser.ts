import type {
  AssistantEstimateDraft,
  DeviceDraft,
  PanelDraft,
  PointDraft,
  WallType,
} from './assistant-estimate-draft.types';
import type { EstimateRequestInput } from '../estimate.types';

function normalizeText(input: string): string {
  let text = input.toLowerCase().trim();

  const replacements: Array<[RegExp, string]> = [
    [/cena/g, 'цена'],
    [/oferta/g, 'оферта'],
    [/trqbva/g, 'трябва'],
    [/iskam/g, 'искам'],
    [/ami/g, 'ами'],
    [/remont/g, 'ремонт'],
    [/obiknoven+i/g, 'обикновени'],
    [/obiknoven/g, 'обикновен'],
    [/garsionera/g, 'гарсониера'],
    [/garsoniera/g, 'гарсониера'],

    [/to4ki/g, 'точки'],
    [/tochki/g, 'точки'],
    [/to4ka/g, 'точка'],
    [/tochka/g, 'точка'],

    [/kontakti/g, 'контакти'],
    [/kontakt/g, 'контакт'],
    [/kontact/g, 'контакт'],

    [/kluchove/g, 'ключове'],
    [/kluch/g, 'ключ'],

    [/osvetlenie/g, 'осветление'],
    [/tabl[o0]/g, 'табло'],
    [/trifazen/g, 'трифазен'],

    [/klu4ove/g, 'ключове'],
    [/klu4/g, 'ключ'],
    [/to6ki/g, 'точки'],
    [/to6ka/g, 'точка'],

    [/instalaciya/g, 'инсталация'],
    [/instalaciq/g, 'инсталация'],
    [/instalciya/g, 'инсталация'],
    [/instalciq/g, 'инсталация'],

    [/dobavqne/g, 'добавяне'],
    [/podmqna/g, 'подмяна'],
    [/cqlostna/g, 'цялостна'],
    [/staq/g, 'стая'],
    [/staqta/g, 'стаята'],
    [/vklu4/g, 'включ'],
    [/metra/g, 'метра'],
    [/metur/g, 'метър'],
    [/metar/g, 'метър'],
  ];

  for (const [pattern, value] of replacements) {
    text = text.replace(pattern, value);
  }

  return text.replace(/\s+/g, ' ').trim();
}

function extractFirstNumber(text: string): number | undefined {
  const match = text.match(/\b(\d+(?:[.,]\d+)?)\b/);
  if (!match) return undefined;
  return Number(match[1].replace(',', '.'));
}

function extractMeters(text: string): number | undefined {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:м|мет(?:ър|ра|ри)?)/i);
  if (!match) return undefined;
  return Number(match[1].replace(',', '.'));
}

function extractWallType(text: string): WallType | undefined {
  if (text.includes('бетон')) return 'concrete';
  if (text.includes('тухл')) return 'brick';
  if (text.includes('гипсокартон')) return 'drywall';
  if (text.includes('без къртене')) return 'none';
  return undefined;
}

function detectPointKind(text: string): PointDraft['kind'] | null {
  if (
    text.includes('слаботок') ||
    text.includes('lan') ||
    text.includes('internet point') ||
    text.includes('интернет точк')
  ) {
    return 'low_current_point';
  }

  if (text.includes('точк') || text.includes('силноток')) {
    return 'power_point';
  }

  return null;
}

function detectDeviceKind(text: string): DeviceDraft['kind'] | null {
  if (text.includes('трифаз')) return 'three_phase_socket';
  if (text.includes('вентилатор')) return 'bathroom_fan';
  if (text.includes('датчик')) return 'motion_sensor';
  if (text.includes('интернет розет') || text.includes('телефонна розет')) {
    return 'internet_outlet';
  }
  if (
    text.includes('освет') ||
    text.includes('ламп') ||
    text.includes('плафон')
  ) {
    return 'light_fixture_basic';
  }
  if (
    text.includes('контакт') ||
    text.includes('ключ') ||
    text.includes('розет')
  ) {
    return 'socket_or_switch_concealed';
  }

  return null;
}

function detectPanelKind(text: string): PanelDraft['kind'] | null {
  if (text.includes('бойлерно табло')) return 'boiler_panel';
  if (text.includes('табло')) return 'apartment_panel_up_to_8';
  return null;
}

function findIncompletePointByKind(
  draft: AssistantEstimateDraft,
  kind: PointDraft['kind'],
): PointDraft | undefined {
  return draft.points.find(
    (x) => x.kind === kind && (!x.quantity || !x.routeLengthMeters),
  );
}

function findIncompleteDeviceByKind(
  draft: AssistantEstimateDraft,
  kind: DeviceDraft['kind'],
): DeviceDraft | undefined {
  return draft.devices.find((x) => x.kind === kind && !x.quantity);
}


function findIncompletePanelByKind(
  draft: AssistantEstimateDraft,
  kind: PanelDraft['kind'],
): PanelDraft | undefined {
  return draft.panels.find((x) => x.kind === kind && !x.quantity);
}

function findLatestPointByKind(
  draft: AssistantEstimateDraft,
  kind: PointDraft['kind'],
): PointDraft | undefined {
  return [...draft.points].reverse().find((x) => x.kind === kind);
}

function findLatestDeviceByKind(
  draft: AssistantEstimateDraft,
  kind: DeviceDraft['kind'],
): DeviceDraft | undefined {
  return [...draft.devices].reverse().find((x) => x.kind === kind);
}

function findLatestPanelByKind(
  draft: AssistantEstimateDraft,
  kind: PanelDraft['kind'],
): PanelDraft | undefined {
  return [...draft.panels].reverse().find((x) => x.kind === kind);
}

function hasIncompletePointOfKind(
  draft: AssistantEstimateDraft,
  kind: PointDraft['kind'] | null,
): boolean {
  if (!kind) return false;
  return draft.points.some(
    (x) => x.kind === kind && (!x.quantity || !x.routeLengthMeters),
  );
}

function hasIncompleteDeviceOfKind(
  draft: AssistantEstimateDraft,
  kind: DeviceDraft['kind'] | null,
): boolean {
  if (!kind) return false;
  return draft.devices.some((x) => x.kind === kind && !x.quantity);
}

function hasIncompletePanelOfKind(
  draft: AssistantEstimateDraft,
  kind: PanelDraft['kind'] | null,
): boolean {
  if (!kind) return false;
  return draft.panels.some((x) => x.kind === kind && !x.quantity);
}


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

function draftHasAnyItems(draft: AssistantEstimateDraft): boolean {
  return (
    draft.points.length > 0 ||
    draft.devices.length > 0 ||
    draft.panels.length > 0
  );
}

function hasAdditiveCue(text: string): boolean {
  return (
    text.includes('още') ||
    text.includes('добав') ||
    text.includes('отделно') ||
    text.includes('също') ||
    text.includes('плюс') ||
    text.includes('plus')
  );
}

function hasPriceIntent(text: string): boolean {
  return (
    text.includes('цена') ||
    text.includes('колко струва') ||
    text.includes('оферта') ||
    text.includes('ориентировъчно') ||
    text.includes('ориентировъчна') ||
    text.includes('estimate') ||
    text.includes('price') ||
    text.includes('cost') ||
    text.includes('quote')
  );
}

function shouldStartFreshDraft(input: {
  normalized: string;
  currentDraft?: AssistantEstimateDraft | null;
  pointKind: PointDraft['kind'] | null;
  deviceKind: DeviceDraft['kind'] | null;
  panelKind: PanelDraft['kind'] | null;
  maybeQty?: number;
  maybeMeters?: number;
}): boolean {
  const {
    normalized,
    currentDraft,
    pointKind,
    deviceKind,
    panelKind,
    maybeQty,
    maybeMeters,
  } = input;

  if (!currentDraft || !draftHasAnyItems(currentDraft)) {
    return false;
  }

  if (hasAdditiveCue(normalized)) {
    return false;
  }

  const hasExplicitScope = Boolean(pointKind || deviceKind || panelKind);
  const hasAnyNumber =
    typeof maybeQty === 'number' || typeof maybeMeters === 'number';

  const matchesIncompleteExistingItem =
    hasIncompletePointOfKind(currentDraft, pointKind) ||
    hasIncompleteDeviceOfKind(currentDraft, deviceKind) ||
    hasIncompletePanelOfKind(currentDraft, panelKind) ||
    (!pointKind &&
      !deviceKind &&
      !panelKind &&
      ((typeof maybeQty === 'number' &&
        currentDraft.points.some((x) => !x.quantity)) ||
        (typeof maybeQty === 'number' &&
          currentDraft.devices.some((x) => !x.quantity)) ||
        (typeof maybeQty === 'number' &&
          currentDraft.panels.some((x) => !x.quantity)) ||
        (typeof maybeMeters === 'number' &&
          currentDraft.points.some((x) => !x.routeLengthMeters))));

  if (matchesIncompleteExistingItem) {
    return false;
  }

  const isFullEstimateQuery = hasPriceIntent(normalized) && hasAnyNumber;

  const isExplicitNewSpec =
    hasExplicitScope &&
    (typeof maybeQty === 'number' || typeof maybeMeters === 'number');

  return isFullEstimateQuery || isExplicitNewSpec;
}

export function applyMessageToDraft(input: {
  tenantSlug: string;
  message: string;
  currentDraft?: AssistantEstimateDraft | null;
}): AssistantEstimateDraft {
  const normalized = normalizeText(input.message);
  const maybeQty = extractFirstNumber(normalized);
  const maybeMeters = extractMeters(normalized);
  const maybeWallType = extractWallType(normalized);
  const pointKind = detectPointKind(normalized);
  const deviceKind = detectDeviceKind(normalized);
  const panelKind = detectPanelKind(normalized);

  const additive = hasAdditiveCue(normalized);

  const shouldResetDraft = shouldStartFreshDraft({
    normalized,
    currentDraft: input.currentDraft,
    pointKind,
    deviceKind,
    panelKind,
    maybeQty,
    maybeMeters,
  });

  const draft = structuredClone(
    shouldResetDraft
      ? createEmptyDraft(input.tenantSlug)
      : input.currentDraft ?? createEmptyDraft(input.tenantSlug),
  );

  draft.tenantSlug = input.tenantSlug;

  if (normalized.includes('оглед') || normalized.includes('консултац')) {
    draft.includeConsultation = true;
  }

  if (pointKind) {
    const existingPoint = findIncompletePointByKind(draft, pointKind);
    const latestPoint = findLatestPointByKind(draft, pointKind);

    if (existingPoint) {
      if (maybeQty) {
        existingPoint.quantity = maybeQty;
      }
      if (maybeMeters) {
        existingPoint.routeLengthMeters = maybeMeters;
      }
      if (maybeWallType) {
        existingPoint.wallType = maybeWallType;
      }
    } else if (
      additive &&
      latestPoint &&
      typeof latestPoint.quantity === 'number' &&
      !maybeMeters &&
      !maybeWallType
    ) {
      if (typeof maybeQty === 'number') {
        latestPoint.quantity += maybeQty;
      }
    } else {
      draft.points.push({
        kind: pointKind,
        quantity: maybeQty,
        routeLengthMeters: maybeMeters,
        wallType: maybeWallType,
      });
    }
  } else if (deviceKind) {
    const existingDevice = findIncompleteDeviceByKind(draft, deviceKind);
    const latestDevice = findLatestDeviceByKind(draft, deviceKind);

    if (existingDevice) {
      if (maybeQty) {
        existingDevice.quantity = maybeQty;
      }
    } else if (
      additive &&
      latestDevice &&
      typeof latestDevice.quantity === 'number' &&
      typeof maybeQty === 'number'
    ) {
      latestDevice.quantity += maybeQty;
    } else {
      draft.devices.push({
        kind: deviceKind,
        quantity: maybeQty,
      });
    }
  } else if (panelKind) {
    const existingPanel = findIncompletePanelByKind(draft, panelKind);
    const latestPanel = findLatestPanelByKind(draft, panelKind);

    if (existingPanel) {
      if (maybeQty) {
        existingPanel.quantity = maybeQty;
      }
    } else if (
      additive &&
      latestPanel &&
      typeof latestPanel.quantity === 'number' &&
      typeof maybeQty === 'number'
    ) {
      latestPanel.quantity += maybeQty;
    } else {
      draft.panels.push({
        kind: panelKind,
        quantity: maybeQty ?? 1,
      });
    }
  } else if (maybeQty) {
    const pointMissingQty = draft.points.find((x) => !x.quantity);
    if (pointMissingQty) {
      pointMissingQty.quantity = maybeQty;
    } else {
      const deviceMissingQty = draft.devices.find((x) => !x.quantity);
      if (deviceMissingQty) {
        deviceMissingQty.quantity = maybeQty;
      } else {
        const panelMissingQty = draft.panels.find((x) => !x.quantity);
        if (panelMissingQty) {
          panelMissingQty.quantity = maybeQty;
        }
      }
    }
  }

  const pointMissingMeters = draft.points.find((x) => !x.routeLengthMeters);
  if (pointMissingMeters && maybeMeters && !pointKind && !deviceKind && !panelKind) {
    pointMissingMeters.routeLengthMeters = maybeMeters;
  }

  const pointMissingWall = draft.points.find((x) => !x.wallType);
  if (pointMissingWall && maybeWallType && !pointKind && !deviceKind && !panelKind) {
    pointMissingWall.wallType = maybeWallType;
  }

  draft.notes = [draft.notes, input.message]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1000);

  return draft;
}

function mapWallTypeToEstimateWallType(
  wallType: WallType | undefined,
): 'none' | 'brick' | 'concrete' | undefined {
  if (!wallType) return undefined;
  if (wallType === 'drywall') return 'none';
  return wallType;
}

export function mapDraftToEstimateInput(
  draft: AssistantEstimateDraft,
): EstimateRequestInput {
  return {
    tenantSlug: draft.tenantSlug,
    includeConsultation: draft.includeConsultation ?? false,
    points: draft.points
      .filter(
        (x): x is Required<Pick<PointDraft, 'kind' | 'quantity' | 'routeLengthMeters'>> &
          Pick<PointDraft, 'wallType'> =>
          Boolean(x.kind && x.quantity && x.routeLengthMeters),
      )
      .map((x) => ({
        kind: x.kind,
        quantity: x.quantity,
        routeLengthMeters: x.routeLengthMeters,
        wallType: mapWallTypeToEstimateWallType(x.wallType),
      })),
    devices: draft.devices
      .filter(
        (x): x is Required<Pick<DeviceDraft, 'kind' | 'quantity'>> =>
          Boolean(x.kind && x.quantity),
      )
      .map((x) => ({
        kind: x.kind,
        quantity: x.quantity,
      })),
    panels: draft.panels
      .filter(
        (x): x is Required<Pick<PanelDraft, 'kind' | 'quantity'>> =>
          Boolean(x.kind && x.quantity),
      )
      .map((x) => ({
        kind: x.kind,
        quantity: x.quantity,
      })),
    notes: draft.notes ?? null,
  };
}
