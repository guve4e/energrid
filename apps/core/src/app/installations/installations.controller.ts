import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { InstallationsService } from './installations.service';
import type {
  CreateCircuitDto,
  CreateInstallationDto,
  CreatePanelDto,
  CreateServiceEntryDto,
} from './installations.dto';

@Controller('installations')
export class InstallationsController {
  constructor(private readonly installations: InstallationsService) {}

  @Post()
  createInstallation(@Body() dto: CreateInstallationDto) {
    return this.installations.createInstallation(dto);
  }

  @Get()
  listInstallations() {
    return this.installations.listInstallations();
  }

  @Get(':id')
  getInstallation(@Param('id') id: string) {
    return this.installations.getInstallation(id);
  }

  @Post(':id/panels')
  createPanel(@Param('id') id: string, @Body() dto: CreatePanelDto) {
    return this.installations.createPanel(id, dto);
  }

  @Post('panels/:panelId/circuits')
  createCircuit(@Param('panelId') panelId: string, @Body() dto: CreateCircuitDto) {
    return this.installations.createCircuit(panelId, dto);
  }

  @Post(':id/service-entries')
  createServiceEntry(@Param('id') id: string, @Body() dto: CreateServiceEntryDto) {
    return this.installations.createServiceEntry(id, dto);
  }
}
