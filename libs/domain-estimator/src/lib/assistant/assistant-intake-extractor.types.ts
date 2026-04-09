export type AssistantExtraction =
  | {
      action: 'set_scope';
      entityType: 'point' | 'device' | 'panel';
      entityKind: string;
      quantity?: number;
      routeLengthMeters?: number;
      wallType?: 'brick' | 'concrete' | 'drywall' | 'none';
      notes?: string;
    }
  | {
      action: 'add_scope';
      entityType: 'point' | 'device' | 'panel';
      entityKind: string;
      quantity?: number;
      routeLengthMeters?: number;
      wallType?: 'brick' | 'concrete' | 'drywall' | 'none';
      notes?: string;
    }
  | {
      action: 'fill_missing_field';
      field: 'quantity' | 'routeLengthMeters' | 'wallType';
      value: string | number;
    }
  | {
      action: 'ask_explanation';
    }
  | {
      action: 'unknown';
      notes?: string;
    };
