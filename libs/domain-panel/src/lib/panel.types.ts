export type PanelCompileRequest = {
  project: unknown;
};

export type PanelDiagnosticSeverity = 'error' | 'warning' | 'info';

export type PanelDiagnostic = {
  id: string;
  severity: PanelDiagnosticSeverity;
  kind: string;
  message: string;
  path?: string;
};

export type RawRail = {
  id: string;
  y: number;
};

export type RawPlacedDevice = {
  uid: string;
  archetypeId: string;
  railId: string;
  slot: number;
  widthModules: number;
  label: string | undefined;
  isMain: boolean;
  poles: number | undefined;
  hasNeutral: boolean | undefined;
  neutralPosition: 'left' | 'right' | undefined;
};

export type RawCombGroup = {
  id: string;
  railId: string;
  sourceUid: string | null | undefined;
  startSlot: number;
  endSlot: number;
  side: 'top' | 'bottom';
};

export type RawWire = {
  id: string;
  from: { anchorId: string };
  to: { anchorId: string };
  spec: {
    kind: 'L' | 'N' | 'PE';
    gaugeMm2: number;
    color: string | undefined;
    cableType: string | undefined;
    label: string | undefined;
  };
  createdAt: number;
};

export type RawCircuit = {
  id: string;
  label: string;
  type: '1P' | '1P+N';
  loadKw: number;
  breakerUid: string | null | undefined;
  loadProfile:
    | 'lighting'
    | 'sockets'
    | 'motor'
    | 'heater'
    | 'mixed'
    | undefined;
  breakerCurve: 'B' | 'C' | 'D' | undefined;
  breakerRatingA: number | undefined;
  cable: {
    csaMm2: number;
    hasPE: boolean;
  };
};

export type CircuitConnectionState = {
  hasBreaker: boolean;
  hasL: boolean;
  hasN: boolean;
  hasPE: boolean;
  isComplete: boolean;
};

export type BreakerState = {
  isMain: boolean;
  isFed: boolean;
  hasCircuit: boolean;
};

export type CircuitSuggestion = {
  estimatedCurrentA: number;
  suggestedCurve: 'B' | 'C' | 'D';
  suggestedRatingA: number;
  suggestedLabel: string;
};

export type CompiledPanel = {
  schemaVersion: number | null;
  meta: {
    name: string | undefined;
    createdAt: string | undefined;
    updatedAt: string | undefined;
  };
  snapshot: {
    rails: RawRail[];
    devices: RawPlacedDevice[];
    combs: RawCombGroup[];
    wires: RawWire[];
    circuits: RawCircuit[];
    reservePercent: number | null;
  };
  stats: {
    railCount: number;
    deviceCount: number;
    combCount: number;
    wireCount: number;
    circuitCount: number;
  };
  derived: {
    devicesByUid: Record<string, RawPlacedDevice>;
    circuitsById: Record<string, RawCircuit>;
    breakerCircuitMap: Record<string, RawCircuit>;
    mainBreakerUid: string | null;
    fedDeviceUids: string[];
    circuitStates: Record<string, CircuitConnectionState>;
    breakerStates: Record<string, BreakerState>;
    circuitSuggestions: Record<string, CircuitSuggestion>;
  };
};

export type PanelCompileResult = {
  ok: boolean;
  compiled: CompiledPanel | null;
  diagnostics: PanelDiagnostic[];
};
