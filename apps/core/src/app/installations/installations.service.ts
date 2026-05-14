import { Injectable, NotFoundException } from '@nestjs/common';
import { InstallationsRepository } from './installations.repository';
import type {
  CreateCircuitDto,
  CreateInstallationDto,
  CreatePanelDto,
  CreateServiceEntryDto,
} from './installations.dto';

@Injectable()
export class InstallationsService {
  constructor(private readonly repo: InstallationsRepository) {}

  createInstallation(dto: CreateInstallationDto) {
    return this.repo.createInstallation(dto);
  }

  listInstallations() {
    return this.repo.listInstallations();
  }

  async getInstallation(id: string) {
    const record = await this.repo.getInstallation(id);

    if (!record) {
      throw new NotFoundException(`Installation not found: ${id}`);
    }

    return record;
  }

  createPanel(installationId: string, dto: CreatePanelDto) {
    return this.repo.createPanel(installationId, dto);
  }

  createCircuit(panelId: string, dto: CreateCircuitDto) {
    return this.repo.createCircuit(panelId, dto);
  }

  createServiceEntry(installationId: string, dto: CreateServiceEntryDto) {
    return this.repo.createServiceEntry(installationId, dto);
  }
}
