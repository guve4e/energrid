import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PanelService } from './panel.service';

class PanelRequestDto {
  @ApiProperty({
    description: 'Raw panel project JSON from the panel editor.',
    example: {
      schemaVersion: 1,
      meta: {
        name: 'Apartment panel',
      },
      rails: [],
      devices: [],
      combs: [],
      wires: [],
      circuits: [],
    },
  })
  project!: unknown;
}

const panelRequestExample = {
  project: {
    schemaVersion: 1,
    meta: {
      name: 'Apartment panel',
    },
    rails: [],
    devices: [],
    combs: [],
    wires: [],
    circuits: [],
  },
};

const panelDiagnosticsResponse = {
  ok: true,
  diagnostics: [],
};

@ApiTags('panel')
@Controller('panel')
export class PanelController {
  constructor(private readonly panelService: PanelService) {}

  @Post('compile')
  @ApiOperation({ summary: 'Compile a panel project and return diagnostics' })
  @ApiBody({ type: PanelRequestDto, examples: { basic: { value: panelRequestExample } } })
  @ApiOkResponse({
    description: 'Compiled panel project and diagnostics.',
    schema: {
      example: {
        ok: true,
        compiled: null,
        diagnostics: [],
      },
    },
  })
  compile(@Body() body: { project: unknown }) {
    return this.panelService.compile(body);
  }

  @Post('analyze')
  @ApiOperation({ summary: 'Analyze a panel project and return diagnostics only' })
  @ApiBody({ type: PanelRequestDto, examples: { basic: { value: panelRequestExample } } })
  @ApiOkResponse({
    description: 'Panel diagnostics without returning the compiled project.',
    schema: { example: panelDiagnosticsResponse },
  })
  analyze(@Body() body: { project: unknown }) {
    return this.panelService.analyze(body);
  }

  @Post('compile-analyze')
  @ApiOperation({ summary: 'Compile and analyze a panel project' })
  @ApiBody({ type: PanelRequestDto, examples: { basic: { value: panelRequestExample } } })
  @ApiOkResponse({
    description: 'Alias of compile; returns compiled project and diagnostics.',
    schema: {
      example: {
        ok: true,
        compiled: null,
        diagnostics: [],
      },
    },
  })
  compileAnalyze(@Body() body: { project: unknown }) {
    return this.panelService.compileAnalyze(body);
  }
}
