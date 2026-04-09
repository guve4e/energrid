export type EstimateWallType = 'none' | 'brick' | 'concrete';

export interface PricingCatalogRow {
  code: string;
  category: string;
  name_bg: string;
  unit: string;
  base_price: number;
  pricing_mode: 'fixed' | 'per_meter';
  rules_json?: Record<string, unknown> | null;
  labor_included?: boolean;
  materials_included?: boolean;
  is_active?: boolean;
}

export interface EstimatePointInput {
  kind: 'power_point' | 'low_current_point';
  quantity: number;
  routeLengthMeters: number;
  wallType?: EstimateWallType;
}

export type EstimateSimpleDeviceKind =
  | 'socket_or_switch_concealed'
  | 'socket_or_switch_surface'
  | 'three_phase_socket'
  | 'bathroom_fan'
  | 'motion_sensor'
  | 'internet_outlet'
  | 'light_fixture_basic';

export type EstimateApplianceConnectionKind =
  | 'boiler_connection'
  | 'stove_connection'
  | 'ac_connection';

export type EstimateDeviceKind =
  | EstimateSimpleDeviceKind
  | EstimateApplianceConnectionKind;

export interface EstimateDeviceInput {
  kind: EstimateDeviceKind;
  quantity: number;
  routeLengthMeters?: number;
  wallType?: EstimateWallType;
}

export interface EstimatePanelInput {
  kind:
    | 'apartment_panel_up_to_4'
    | 'apartment_panel_up_to_8'
    | 'apartment_panel_above_8'
    | 'boiler_panel';
  quantity: number;
}

export interface EstimateRequestInput {
  tenantSlug: string;
  includeConsultation?: boolean;
  points?: EstimatePointInput[];
  devices?: EstimateDeviceInput[];
  panels?: EstimatePanelInput[];
  notes?: string | null;
}

export interface EstimateLineResult {
  code: string;
  label: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  subtotal: number;
}

export interface EstimateResult {
  currency: 'EUR';
  subtotal: number;
  confidence: 'low' | 'medium' | 'high';
  needsInspection: boolean;
  assumptions: string[];
  lines: EstimateLineResult[];
}
