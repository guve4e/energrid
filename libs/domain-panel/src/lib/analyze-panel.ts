import { PanelDiagnostic, PanelCompileResult } from './panel.types';

function makeDiagnostic(
  id: string,
  severity: PanelDiagnostic['severity'],
  kind: string,
  message: string,
  path?: string,
): PanelDiagnostic {
  return { id, severity, kind, message, path };
}

export function analyzeCompiledPanel(
  compileResult: PanelCompileResult,
): PanelDiagnostic[] {
  const diagnostics: PanelDiagnostic[] = [...compileResult.diagnostics];

  if (!compileResult.compiled) return diagnostics;

  const { snapshot } = compileResult.compiled;
  const devices = snapshot.devices as Array<Record<string, unknown>>;
  const circuits = snapshot.circuits as Array<Record<string, unknown>>;

  const breakerIds = new Set(
    devices
      .map((d) => (typeof d.uid === 'string' ? d.uid : null))
      .filter(Boolean) as string[],
  );

  for (const c of circuits) {
    const breakerUid =
      typeof c.breakerUid === 'string' ? c.breakerUid : undefined;
    const label = typeof c.label === 'string' ? c.label : 'Circuit';

    if (!breakerUid) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.unassigned.${label}`,
          'warning',
          'Circuit',
          `"${label}" has no breaker assigned.`,
          'snapshot.circuits',
        ),
      );
      continue;
    }

    if (!breakerIds.has(breakerUid)) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.missingBreaker.${label}`,
          'error',
          'Circuit',
          `"${label}" references a missing breaker "${breakerUid}".`,
          'snapshot.circuits',
        ),
      );
    }
  }

  return diagnostics;
}
