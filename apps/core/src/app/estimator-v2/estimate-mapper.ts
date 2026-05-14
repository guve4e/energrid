import type { EstimateRequestInput } from '@energrid/domain-estimator';
import type { EstimateConversationDraft } from './estimate-draft.types';

export function mapDraftToEstimateRequest(
  draft: EstimateConversationDraft,
): EstimateRequestInput {
  if (!draft.jobType) {
    return {
      tenantSlug: draft.tenantSlug,
      points: [],
      devices: [],
      panels: [],
      notes: draft.notes ?? null,
    };
  }

  switch (draft.jobType) {
    case 'boiler_installation':
      return {
        tenantSlug: draft.tenantSlug,
        points:
          draft.connectionMode === 'existing_cable_only'
            ? []
            : [
                {
                  kind: 'power_point',
                  quantity: draft.quantity ?? 1,
                  routeLengthMeters: draft.routeLengthMeters ?? 0,
                  wallType: draft.wallType ?? 'none',
                },
              ],
        devices: [],
        panels:
          draft.powerSource === 'panel' || draft.panelKind === 'boiler_panel'
            ? [{ kind: 'boiler_panel', quantity: 1 }]
            : [],
        notes: draft.notes ?? null,
      };

    case 'boiler_replacement':
      return {
        tenantSlug: draft.tenantSlug,
        points:
          draft.connectionMode === 'existing_cable_only'
            ? []
            : [
                {
                  kind: 'power_point',
                  quantity: draft.quantity ?? 1,
                  routeLengthMeters: draft.routeLengthMeters ?? 0,
                  wallType: draft.wallType ?? 'none',
                },
              ],
        devices: [],
        panels:
          draft.powerSource === 'panel' || draft.panelKind === 'boiler_panel'
            ? [{ kind: 'boiler_panel', quantity: 1 }]
            : [],
        notes: draft.notes ?? null,
      };

    case 'stove_installation':
      return {
        tenantSlug: draft.tenantSlug,
        points: [
          {
            kind: 'power_point',
            quantity: draft.quantity ?? 1,
            routeLengthMeters: draft.routeLengthMeters ?? 0,
            wallType: draft.wallType ?? 'none',
          },
        ],
        devices: [{ kind: 'three_phase_socket', quantity: draft.quantity ?? 1 }],
        panels: [],
        notes: draft.notes ?? null,
      };

    case 'ac_installation':
      return {
        tenantSlug: draft.tenantSlug,
        points: [
          {
            kind: 'power_point',
            quantity: draft.quantity ?? 1,
            routeLengthMeters: draft.routeLengthMeters ?? 0,
            wallType: draft.wallType ?? 'none',
          },
        ],
        devices: [],
        panels: [],
        notes: draft.notes ?? null,
      };

    case 'points':
      return {
        tenantSlug: draft.tenantSlug,
        points: [
          {
            kind: 'power_point',
            quantity: draft.quantity ?? 1,
            routeLengthMeters: draft.routeLengthMeters ?? 0,
            wallType: draft.wallType ?? 'none',
          },
        ],
        devices: [],
        panels: [],
        notes: draft.notes ?? null,
      };

    case 'panel':
      return {
        tenantSlug: draft.tenantSlug,
        points: [],
        devices: [],
        panels: draft.panelKind ? [{ kind: draft.panelKind, quantity: 1 }] : [],
        notes: draft.notes ?? null,
      };
  }
}
