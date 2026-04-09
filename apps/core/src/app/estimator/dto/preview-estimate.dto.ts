export class PreviewEstimateDto {
  tenantSlug!: string;
  includeConsultation?: boolean;
  points?: Array<{
    kind: 'power_point' | 'low_current_point';
    quantity: number;
    routeLengthMeters: number;
    wallType?: 'none' | 'brick' | 'concrete';
  }>;
  devices?: Array<{
    kind:
      | 'socket_or_switch_concealed'
      | 'socket_or_switch_surface'
      | 'three_phase_socket'
      | 'bathroom_fan'
      | 'light_fixture_basic'
      | 'motion_sensor'
      | 'internet_outlet';
    quantity: number;
  }>;
  panels?: Array<{
    kind:
      | 'apartment_panel_up_to_4'
      | 'apartment_panel_up_to_8'
      | 'apartment_panel_above_8'
      | 'boiler_panel';
    quantity: number;
  }>;
  notes?: string | null;
}
