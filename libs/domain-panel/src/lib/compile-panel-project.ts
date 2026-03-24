import {
  BreakerState,
  CircuitConnectionState,
  CircuitSuggestion,
  CompiledPanel,
  PanelCompileResult,
  PanelDiagnostic,
  RawCircuit,
  RawCombGroup,
  RawPlacedDevice,
  RawRail,
  RawWire,
} from './panel.types';

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function makeDiagnostic(
  id: string,
  severity: PanelDiagnostic['severity'],
  kind: string,
  message: string,
  path?: string,
): PanelDiagnostic {
  return { id, severity, kind, message, path };
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalizeRails(value: unknown): RawRail[] {
  return asArray<Record<string, unknown>>(value)
    .map((r): RawRail | null => {
      const id = asString(r.id);
      const y = asNumber(r.y);
      if (!id || y === null) return null;
      return { id, y };
    })
    .filter(notNull);
}

function normalizeDevices(value: unknown): RawPlacedDevice[] {
  return asArray<Record<string, unknown>>(value)
    .map((d): RawPlacedDevice | null => {
      const uid = asString(d.uid);
      const archetypeId = asString(d.archetypeId);
      const railId = asString(d.railId);
      const slot = asNumber(d.slot);
      const widthModules = asNumber(d.widthModules);

      if (!uid || !archetypeId || !railId || slot === null || widthModules === null) {
        return null;
      }

      return {
        uid,
        archetypeId,
        railId,
        slot,
        widthModules,
        label: asString(d.label),
        isMain: d.isMain === true,
        poles: asNumber(d.poles) ?? undefined,
        hasNeutral: typeof d.hasNeutral === 'boolean' ? d.hasNeutral : undefined,
        neutralPosition:
          d.neutralPosition === 'left' || d.neutralPosition === 'right'
            ? d.neutralPosition
            : undefined,
      };
    })
    .filter(notNull);
}

function normalizeCombs(value: unknown): RawCombGroup[] {
  return asArray<Record<string, unknown>>(value)
    .map((c): RawCombGroup | null => {
      const id = asString(c.id);
      const railId = asString(c.railId);
      const startSlot = asNumber(c.startSlot);
      const endSlot = asNumber(c.endSlot);

      if (!id || !railId || startSlot === null || endSlot === null) {
        return null;
      }

      return {
        id,
        railId,
        sourceUid: c.sourceUid === null ? null : asString(c.sourceUid),
        startSlot,
        endSlot,
        side: c.side === 'bottom' ? 'bottom' : 'top',
      };
    })
    .filter(notNull);
}

function normalizeWires(value: unknown): RawWire[] {
  return asArray<Record<string, unknown>>(value)
    .map((w): RawWire | null => {
      const id = asString(w.id);
      const from = (w.from ?? {}) as Record<string, unknown>;
      const to = (w.to ?? {}) as Record<string, unknown>;
      const spec = (w.spec ?? {}) as Record<string, unknown>;
      const anchorFrom = asString(from.anchorId);
      const anchorTo = asString(to.anchorId);
      const kind =
        spec.kind === 'N' ? 'N' : spec.kind === 'PE' ? 'PE' : spec.kind === 'L' ? 'L' : null;
      const gaugeMm2 = asNumber(spec.gaugeMm2);
      const createdAt = asNumber(w.createdAt);

      if (!id || !anchorFrom || !anchorTo || !kind || gaugeMm2 === null || createdAt === null) {
        return null;
      }

      return {
        id,
        from: { anchorId: anchorFrom },
        to: { anchorId: anchorTo },
        spec: {
          kind,
          gaugeMm2,
          color: asString(spec.color),
          cableType: asString(spec.cableType),
          label: asString(spec.label),
        },
        createdAt,
      };
    })
    .filter(notNull);
}

function normalizeCircuits(value: unknown): RawCircuit[] {
  return asArray<Record<string, unknown>>(value)
    .map((c): RawCircuit | null => {
      const id = asString(c.id);
      const label = asString(c.label);
      const type = c.type === '1P+N' ? '1P+N' : c.type === '1P' ? '1P' : null;
      const loadKw = asNumber(c.loadKw);

      if (!id || !label || !type || loadKw === null) return null;

      const cable = (c.cable ?? {}) as Record<string, unknown>;

      return {
        id,
        label,
        type,
        loadKw,
        breakerUid: c.breakerUid === null ? null : asString(c.breakerUid),
        loadProfile:
          c.loadProfile === 'lighting' ||
          c.loadProfile === 'sockets' ||
          c.loadProfile === 'motor' ||
          c.loadProfile === 'heater' ||
          c.loadProfile === 'mixed'
            ? c.loadProfile
            : undefined,
        breakerCurve:
          c.breakerCurve === 'B' || c.breakerCurve === 'C' || c.breakerCurve === 'D'
            ? c.breakerCurve
            : undefined,
        breakerRatingA: asNumber(c.breakerRatingA) ?? undefined,
        cable: {
          csaMm2: asNumber(cable.csaMm2) ?? 2.5,
          hasPE: typeof cable.hasPE === 'boolean' ? cable.hasPE : true,
        },
      };
    })
    .filter(notNull);
}

function buildDevicesByUid(devices: RawPlacedDevice[]) {
  return Object.fromEntries(devices.map((d) => [d.uid, d]));
}

function buildCircuitsById(circuits: RawCircuit[]) {
  return Object.fromEntries(circuits.map((c) => [c.id, c]));
}

function buildBreakerCircuitMap(circuits: RawCircuit[]) {
  return Object.fromEntries(
    circuits
      .filter((c) => !!c.breakerUid)
      .map((c) => [c.breakerUid as string, c]),
  );
}

function detectMainBreakerUid(devices: RawPlacedDevice[]) {
  const mains = devices.filter((d) => d.isMain);
  return mains.length ? mains[0].uid : null;
}

function buildFedDeviceUids(
  devices: RawPlacedDevice[],
  combs: RawCombGroup[],
): string[] {
  const out = new Set<string>();

  for (const d of devices) {
    const start = d.slot;
    const end = d.slot + d.widthModules - 1;

    const fed = combs.some(
      (c) =>
        c.railId === d.railId &&
        rangesOverlap(start, end, c.startSlot, c.endSlot),
    );

    if (fed) out.add(d.uid);
  }

  return Array.from(out);
}

function buildCircuitStates(
  circuits: RawCircuit[],
  devicesByUid: Record<string, RawPlacedDevice>,
  fedDeviceUids: string[],
): Record<string, CircuitConnectionState> {
  const fed = new Set(fedDeviceUids);

  return Object.fromEntries(
    circuits.map((c) => {
      const breaker = c.breakerUid ? devicesByUid[c.breakerUid] : undefined;
      const hasBreaker = !!breaker;
      const hasL = !!breaker && fed.has(breaker.uid);
      const hasN = c.type === '1P+N';
      const hasPE = Boolean(c.cable.hasPE);
      const isComplete = c.type === '1P+N' ? hasL && hasN && hasPE : hasL && hasPE;

      return [
        c.id,
        {
          hasBreaker,
          hasL,
          hasN,
          hasPE,
          isComplete,
        },
      ];
    }),
  );
}

function buildBreakerStates(
  devices: RawPlacedDevice[],
  fedDeviceUids: string[],
  breakerCircuitMap: Record<string, RawCircuit>,
): Record<string, BreakerState> {
  const fed = new Set(fedDeviceUids);

  return Object.fromEntries(
    devices.map((d) => [
      d.uid,
      {
        isMain: d.isMain,
        isFed: fed.has(d.uid),
        hasCircuit: !!breakerCircuitMap[d.uid],
      },
    ]),
  );
}

function chooseSuggestedCurve(circuit: RawCircuit): 'B' | 'C' | 'D' {
  switch (circuit.loadProfile) {
    case 'lighting':
      return 'B';
    case 'motor':
      return 'D';
    case 'heater':
    case 'sockets':
    case 'mixed':
    default:
      return 'C';
  }
}

function chooseSuggestedRatingA(currentA: number): number {
  const standard = [6, 10, 16, 20, 25, 32, 40, 50, 63];
  const designCurrent = currentA * 1.15;

  for (const r of standard) {
    if (r >= designCurrent) return r;
  }

  return 63;
}

function buildCircuitSuggestions(
  circuits: RawCircuit[],
): Record<string, CircuitSuggestion> {
  return Object.fromEntries(
    circuits.map((c) => {
      const estimatedCurrentA = round1((c.loadKw * 1000) / 230);
      const suggestedCurve = chooseSuggestedCurve(c);
      const suggestedRatingA = chooseSuggestedRatingA(estimatedCurrentA);

      return [
        c.id,
        {
          estimatedCurrentA,
          suggestedCurve,
          suggestedRatingA,
          suggestedLabel: `${suggestedCurve}${suggestedRatingA}`,
        },
      ];
    }),
  );
}

export function compilePanelProject(project: unknown): PanelCompileResult {
  const diagnostics: PanelDiagnostic[] = [];

  if (!project || typeof project !== 'object') {
    return {
      ok: false,
      compiled: null,
      diagnostics: [
        makeDiagnostic(
          'project.invalid',
          'error',
          'Project',
          'Project payload must be an object.',
          'project',
        ),
      ],
    };
  }

  const root = project as Record<string, unknown>;
  const meta = (root.meta ?? {}) as Record<string, unknown>;
  const snapshot = (root.snapshot ?? {}) as Record<string, unknown>;

  const rails = normalizeRails(snapshot.rails);
  const devices = normalizeDevices(snapshot.devices);
  const combs = normalizeCombs(snapshot.combs);
  const wires = normalizeWires(snapshot.wires);
  const circuits = normalizeCircuits(snapshot.circuits);

  if (!rails.length) {
    diagnostics.push(
      makeDiagnostic('rails.empty', 'warning', 'Rails', 'Project has no rails.', 'snapshot.rails'),
    );
  }

  if (!devices.length) {
    diagnostics.push(
      makeDiagnostic(
        'devices.empty',
        'warning',
        'Devices',
        'Project has no devices.',
        'snapshot.devices',
      ),
    );
  }

  const devicesByUid = buildDevicesByUid(devices);
  const circuitsById = buildCircuitsById(circuits);
  const breakerCircuitMap = buildBreakerCircuitMap(circuits);
  const mainBreakerUid = detectMainBreakerUid(devices);
  const fedDeviceUids = buildFedDeviceUids(devices, combs);
  const circuitStates = buildCircuitStates(circuits, devicesByUid, fedDeviceUids);
  const breakerStates = buildBreakerStates(devices, fedDeviceUids, breakerCircuitMap);
  const circuitSuggestions = buildCircuitSuggestions(circuits);

  const compiled: CompiledPanel = {
    schemaVersion:
      typeof root.schemaVersion === 'number' ? root.schemaVersion : null,
    meta: {
      name: asString(meta.name),
      createdAt: asString(meta.createdAt),
      updatedAt: asString(meta.updatedAt),
    },
    snapshot: {
      rails,
      devices,
      combs,
      wires,
      circuits,
      reservePercent: asNumber(snapshot.reservePercent),
    },
    stats: {
      railCount: rails.length,
      deviceCount: devices.length,
      combCount: combs.length,
      wireCount: wires.length,
      circuitCount: circuits.length,
    },
    derived: {
      devicesByUid,
      circuitsById,
      breakerCircuitMap,
      mainBreakerUid,
      fedDeviceUids,
      circuitStates,
      breakerStates,
      circuitSuggestions,
      __debugCompilerVersion: 'panel-compiler-v2',
    } as any,
  };

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    compiled,
    diagnostics,
  };
}
