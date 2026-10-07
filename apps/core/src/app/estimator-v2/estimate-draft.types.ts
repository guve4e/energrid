import type {
  EstimateConnectionMode,
  EstimateJobType,
} from './estimate-intake.types';

export interface EstimateConversationDraft {
  tenantSlug: string;
  templateVersion?: string;
  corridorCount?: number;
  bathroomCount?: number;
  terraceCount?: number;
  pendingOffer?: 'breakdown';

  jobType?: EstimateJobType;
  propertyType?: 'studio' | 'apartment' | 'house';
  areaSqm?: number;
  buildingStage?: 'new' | 'renovation';
  hasBoiler?: boolean;
  hasAc?: boolean;
  acCount?: number;
    roomCount?: number;
    socketCount?: number;
    lightingPointCount?: number;
    smartRelayCount?: number;
    separateKitchen?: boolean;
    hasOven?: boolean;
    hasHob?: boolean;
    hasDryer?: boolean;
    hasDishwasher?: boolean;
  hasCooker?: boolean;
  hasWashingMachine?: boolean;
  planAccepted?: boolean;

  quantity?: number;
  routeLengthMeters?: number;
  wallType?: 'brick' | 'concrete' | 'none';
  powerSource?: 'panel' | 'existing_line';
  panelKind?:
    | 'boiler_panel'
    | 'apartment_panel_up_to_4'
    | 'apartment_panel_up_to_8'
    | 'apartment_panel_above_8'
    | 'panel_standard' | 'panel_modern' | 'panel_full_protection' | 'panel_custom';

  replacement?: boolean;
  connectionMode?: EstimateConnectionMode;

  currentQuestionField?:
    | 'kitchenAppliances' | 'hasCooker' | 'hasWashingMachine'
    | 'areaSqm' | 'buildingStage' | 'propertyType' | 'hasBoiler' | 'hasAc' | 'planAccepted'
    | 'jobType'
    | 'quantity'
    | 'routeLengthMeters'
    | 'wallType'
    | 'powerSource'
    | 'panelKind'
    | 'connectionMode';

  currentIntent?: 'answer' | 'question_why' | 'explain';

  notes?: string;
}
