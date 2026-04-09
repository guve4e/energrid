export type WallType = 'brick' | 'concrete' | 'drywall' | 'none';

export interface PointDraft {
  kind: 'power_point' | 'low_current_point';
  quantity?: number;
  routeLengthMeters?: number;
  wallType?: WallType;
}

export interface DeviceDraft {
  kind:
    | 'socket_or_switch_concealed'
    | 'socket_or_switch_surface'
    | 'three_phase_socket'
    | 'bathroom_fan'
    | 'motion_sensor'
    | 'internet_outlet'
    | 'light_fixture_basic'
    | 'boiler_connection'
    | 'stove_connection'
    | 'ac_connection';
  quantity?: number;
}

export interface PanelDraft {
  kind:
    | 'apartment_panel_up_to_4'
    | 'apartment_panel_up_to_8'
    | 'apartment_panel_above_8'
    | 'boiler_panel';
  quantity?: number;
}

export interface AssistantEstimateDraft {
  tenantSlug: string;
  includeConsultation?: boolean;
  points: PointDraft[];
  devices: DeviceDraft[];
  panels: PanelDraft[];
  notes?: string;
}
