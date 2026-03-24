import {
  CompiledPanel,
  PanelCompileResult,
  PanelDiagnostic,
} from './panel.types';

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

  const rails = asArray(snapshot.rails);
  const devices = asArray(snapshot.devices);
  const combs = asArray(snapshot.combs);
  const wires = asArray(snapshot.wires);
  const circuits = asArray(snapshot.circuits);

  if (!rails.length) {
    diagnostics.push(
      makeDiagnostic(
        'rails.empty',
        'warning',
        'Rails',
        'Project has no rails.',
        'snapshot.rails',
      ),
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
  };

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    compiled,
    diagnostics,
  };
}
