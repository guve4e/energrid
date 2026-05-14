import type {
  EstimateConnectionMode,
  EstimateJobType,
} from './estimate-intake.types';

export interface EstimateConversationDraft {
  tenantSlug: string;

  jobType?: EstimateJobType;

  quantity?: number;
  routeLengthMeters?: number;
  wallType?: 'brick' | 'concrete' | 'none';
  powerSource?: 'panel' | 'existing_line';
  panelKind?:
    | 'boiler_panel'
    | 'apartment_panel_up_to_4'
    | 'apartment_panel_up_to_8'
    | 'apartment_panel_above_8';

  replacement?: boolean;
  connectionMode?: EstimateConnectionMode;

  currentQuestionField?:
    | 'quantity'
    | 'routeLengthMeters'
    | 'wallType'
    | 'powerSource'
    | 'panelKind'
    | 'connectionMode';

  currentIntent?: 'answer' | 'question_why' | 'explain';

  notes?: string;
}
