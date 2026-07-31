import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { InstallationsService } from './installations.service';
import type {
  CreateCircuitDto,
  CreateInstallationDto,
  CreatePanelDto,
  CreateServiceEntryDto,
  UpdateCircuitDto,
  UpdateInstallationDto,
  UpdatePanelDto,
} from './installations.dto';

@ApiTags('installations')
@Controller('installations')
export class InstallationsController {
  constructor(private readonly installations: InstallationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an installation passport' })
  createInstallation(@Body() dto: CreateInstallationDto) {
    return this.installations.createInstallation(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List installation passports' })
  listInstallations() {
    return this.installations.listInstallations();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an installation passport' })
  @ApiParam({ name: 'id', description: 'Installation id' })
  getInstallation(@Param('id') id: string) {
    return this.installations.getInstallation(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an installation passport' })
  @ApiParam({ name: 'id', description: 'Installation id' })
  updateInstallation(@Param('id') id: string, @Body() dto: UpdateInstallationDto) {
    return this.installations.updateInstallation(id, dto);
  }

  @Post(':id/panels')
  @ApiOperation({ summary: 'Create a panel for an installation' })
  @ApiParam({ name: 'id', description: 'Installation id' })
  createPanel(@Param('id') id: string, @Body() dto: CreatePanelDto) {
    return this.installations.createPanel(id, dto);
  }

  @Patch('panels/:panelId')
  @ApiOperation({ summary: 'Update an installation panel' })
  @ApiParam({ name: 'panelId', description: 'Panel id' })
  updatePanel(@Param('panelId') panelId: string, @Body() dto: UpdatePanelDto) {
    return this.installations.updatePanel(panelId, dto);
  }

  @Post('panels/:panelId/circuits')
  @ApiOperation({ summary: 'Create a circuit in a panel' })
  @ApiParam({ name: 'panelId', description: 'Panel id' })
  createCircuit(@Param('panelId') panelId: string, @Body() dto: CreateCircuitDto) {
    return this.installations.createCircuit(panelId, dto);
  }

  @Patch('circuits/:circuitId')
  @ApiOperation({ summary: 'Update a circuit' })
  @ApiParam({ name: 'circuitId', description: 'Circuit id' })
  updateCircuit(@Param('circuitId') circuitId: string, @Body() dto: UpdateCircuitDto) {
    return this.installations.updateCircuit(circuitId, dto);
  }

  @Delete('circuits/:circuitId')
  @ApiOperation({ summary: 'Delete a circuit' })
  @ApiParam({ name: 'circuitId', description: 'Circuit id' })
  deleteCircuit(@Param('circuitId') circuitId: string) {
    return this.installations.deleteCircuit(circuitId);
  }

  @Post(':id/service-entries')
  @ApiOperation({ summary: 'Create a service entry for an installation' })
  @ApiParam({ name: 'id', description: 'Installation id' })
  createServiceEntry(@Param('id') id: string, @Body() dto: CreateServiceEntryDto) {
    return this.installations.createServiceEntry(id, dto);
  }
}
