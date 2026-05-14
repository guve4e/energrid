export type EstimateJobType =
  | 'boiler_installation'
  | 'boiler_replacement'
  | 'stove_installation'
  | 'ac_installation'
  | 'points'
  | 'panel';

export type EstimateWallType = 'brick' | 'concrete' | 'none';
export type EstimatePowerSource = 'panel' | 'existing_line';
export type EstimateConnectionMode = 'existing_cable_only' | 'new_line_required';

export interface EstimateUpdate {
  jobType?: EstimateJobType;
  updates: Partial<{
    quantity: number;
    routeLengthMeters: number;
    wallType: EstimateWallType;
    powerSource: EstimatePowerSource;
    panelKind:
      | 'boiler_panel'
      | 'apartment_panel_up_to_4'
      | 'apartment_panel_up_to_8'
      | 'apartment_panel_above_8';
    replacement: boolean;
    connectionMode: EstimateConnectionMode;
  }>;
  askExplanation?: boolean;
  userIntent?: 'estimate' | 'followup' | 'explanation' | 'unknown';
  scopeSwitch?: boolean;
}
