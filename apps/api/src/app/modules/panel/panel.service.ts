import { Injectable } from '@nestjs/common';
import {
  analyzeCompiledPanel,
  compilePanelProject,
  PanelCompileRequest,
} from '@energrid/domain-panel';

@Injectable()
export class PanelService {
  compile(payload: PanelCompileRequest) {
    const compileResult = compilePanelProject(payload.project);
    const diagnostics = analyzeCompiledPanel(compileResult);

    return {
      ok: compileResult.ok && !diagnostics.some((d) => d.severity === 'error'),
      compiled: compileResult.compiled,
      diagnostics,
    };
  }

  analyze(payload: PanelCompileRequest) {
    const compileResult = compilePanelProject(payload.project);
    const diagnostics = analyzeCompiledPanel(compileResult);

    return {
      ok: !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
    };
  }

  compileAnalyze(payload: PanelCompileRequest) {
    return this.compile(payload);
  }
}
