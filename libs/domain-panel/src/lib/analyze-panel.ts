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

  const { snapshot, derived } = compileResult.compiled;

  const devices = snapshot.devices;
  const circuits = snapshot.circuits;
  const mainBreakers = devices.filter((d) => d.isMain);

  if (mainBreakers.length > 1) {
    diagnostics.push(
      makeDiagnostic(
        'main.multiple',
        'error',
        'Main',
        `Multiple main breakers detected (${mainBreakers.length}).`,
        'snapshot.devices',
      ),
    );
  }

  for (const c of circuits) {
    const breakerUid = c.breakerUid ?? undefined;

    if (!breakerUid) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.unassigned.${c.id}`,
          'warning',
          'Circuit',
          `"${c.label}" has no breaker assigned.`,
          'snapshot.circuits',
        ),
      );
      continue;
    }

    if (!derived.devicesByUid[breakerUid]) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.missingBreaker.${c.id}`,
          'error',
          'Circuit',
          `"${c.label}" references a missing breaker "${breakerUid}".`,
          'snapshot.circuits',
        ),
      );
      continue;
    }

    const state = derived.circuitStates[c.id];

    if (!state.hasL) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.unfed.${c.id}`,
          'error',
          'Feed',
          `"${c.label}" is on an unfed breaker.`,
          'snapshot.circuits',
        ),
      );
    }

    if (!state.hasPE) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.nope.${c.id}`,
          'warning',
          'PE',
          `"${c.label}" has no PE conductor declared.`,
          'snapshot.circuits',
        ),
      );
    }

    if (!state.isComplete) {
      diagnostics.push(
        makeDiagnostic(
          `circuit.incomplete.${c.id}`,
          'info',
          'Circuit',
          `"${c.label}" is not fully complete.`,
          'snapshot.circuits',
        ),
      );
    }
  }

  for (const d of devices) {
    const state = derived.breakerStates[d.uid];
    if (!state) continue;

    if (!d.isMain && !state.hasCircuit) {
      diagnostics.push(
        makeDiagnostic(
          `breaker.nocircuit.${d.uid}`,
          'info',
          'Breaker',
          `"${d.label ?? d.uid}" has no circuit.`,
          'snapshot.devices',
        ),
      );
    }

    if (!d.isMain && !state.isFed) {
      diagnostics.push(
        makeDiagnostic(
          `breaker.unfed.${d.uid}`,
          'warning',
          'Breaker',
          `"${d.label ?? d.uid}" is not fed.`,
          'snapshot.devices',
        ),
      );
    }
  }

  return diagnostics;
}
