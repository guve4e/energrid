import { Body, Controller, Post } from '@nestjs/common';
import { PanelService } from './panel.service';

@Controller('panel')
export class PanelController {
  constructor(private readonly panelService: PanelService) {}

  @Post('compile')
  compile(@Body() body: { project: unknown }) {
    return this.panelService.compile(body);
  }

  @Post('analyze')
  analyze(@Body() body: { project: unknown }) {
    return this.panelService.analyze(body);
  }

  @Post('compile-analyze')
  compileAnalyze(@Body() body: { project: unknown }) {
    return this.panelService.compileAnalyze(body);
  }
}
