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

export interface EstimateDeviceInput {
  kind:
    | 'socket_or_switch_concealed'
    | 'socket_or_switch_surface'
    | 'three_phase_socket'
    | 'bathroom_fan'
    | 'light_fixture_basic'
    | 'motion_sensor'
    | 'internet_outlet';
  quantity: number;
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
