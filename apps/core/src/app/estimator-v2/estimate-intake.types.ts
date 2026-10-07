export type EstimateJobType =
  | 'residential_installation'
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
    propertyType: 'studio' | 'apartment' | 'house';
    areaSqm: number;
    buildingStage: 'new' | 'renovation';
    hasBoiler: boolean;
    hasAc: boolean;
    acCount: number;
    roomCount: number;
    corridorCount: number;
    bathroomCount: number;
    terraceCount: number;
    socketCount: number;
    lightingPointCount: number;
    smartRelayCount: number;
    separateKitchen: boolean;
    hasOven: boolean;
    hasHob: boolean;
    hasDryer: boolean;
    hasDishwasher: boolean;
    hasCooker: boolean;
    hasWashingMachine: boolean;
    planAccepted: boolean;
    quantity: number;
    routeLengthMeters: number;
    wallType: EstimateWallType;
    powerSource: EstimatePowerSource;
    panelKind:
      | 'boiler_panel'
      | 'apartment_panel_up_to_4'
      | 'apartment_panel_up_to_8'
      | 'apartment_panel_above_8'
    | 'panel_standard' | 'panel_modern' | 'panel_full_protection' | 'panel_custom';
    replacement: boolean;
    connectionMode: EstimateConnectionMode;
  }>;
  askExplanation?: boolean;
  userIntent?: 'estimate' | 'followup' | 'explanation' | 'unknown';
  scopeSwitch?: boolean;
}
