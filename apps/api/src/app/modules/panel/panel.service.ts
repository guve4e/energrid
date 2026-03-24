import { Injectable } from '@nestjs/common';
import { compilePanelProject } from '../../../../../../libs/domain-panel/src/lib/compile-panel-project';
import { analyzeCompiledPanel } from '../../../../../../libs/domain-panel/src/lib/analyze-panel';
import type { PanelCompileRequest } from '../../../../../../libs/domain-panel/src/lib/panel.types';

@Injectable()
export class PanelService {
  compile(payload: PanelCompileRequest) {
    const compileResult = compilePanelProject(payload.project);
    const diagnostics = analyzeCompiledPanel(compileResult);

    return {
      ok: compileResult.ok && !diagnostics.some((d: { severity: string }) => d.severity === 'error'),
      compiled: compileResult.compiled,
      diagnostics,
    };
  }

  analyze(payload: PanelCompileRequest) {
    const compileResult = compilePanelProject(payload.project);
    const diagnostics = analyzeCompiledPanel(compileResult);

    return {
      ok: !diagnostics.some((d: { severity: string }) => d.severity === 'error'),
      diagnostics,
    };
  }

  compileAnalyze(payload: PanelCompileRequest) {
    return this.compile(payload);
  }
}
