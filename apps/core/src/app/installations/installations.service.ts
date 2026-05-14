import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InstallationsRepository } from './installations.repository';
import type {
  CreateCircuitDto,
  CreateInstallationDto,
  CreatePanelDto,
  CreateServiceEntryDto,
  UpdateCircuitDto,
  UpdateInstallationDto,
  UpdatePanelDto,
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

  async updateInstallation(id: string, dto: UpdateInstallationDto) {
    const record = await this.repo.updateInstallation(id, dto);

    if (!record) {
      throw new NotFoundException(`Installation not found: ${id}`);
    }

    return record;
  }

  createPanel(installationId: string, dto: CreatePanelDto) {
    return this.repo.createPanel(installationId, dto);
  }

  async updatePanel(id: string, dto: UpdatePanelDto) {
    const panel = await this.repo.updatePanel(id, dto);

    if (!panel) {
      throw new NotFoundException(`Panel not found: ${id}`);
    }

    return panel;
  }

  async createCircuit(panelId: string, dto: CreateCircuitDto) {
    try {
      return await this.repo.createCircuit(panelId, dto);
    } catch (error: unknown) {
      if (isPgUniqueViolation(error)) {
        throw new ConflictException(
          'Circuit number already exists for this panel',
        );
      }

      throw error;
    }
  }

  async updateCircuit(id: string, dto: UpdateCircuitDto) {
    try {
      const circuit = await this.repo.updateCircuit(id, dto);

      if (!circuit) {
        throw new NotFoundException(`Circuit not found: ${id}`);
      }

      return circuit;
    } catch (error: unknown) {
      if (isPgUniqueViolation(error)) {
        throw new ConflictException(
          'Circuit number already exists for this panel',
        );
      }

      throw error;
    }
  }

  async deleteCircuit(id: string) {
    const deleted = await this.repo.deleteCircuit(id);

    if (!deleted) {
      throw new NotFoundException(`Circuit not found: ${id}`);
    }

    return { deleted: true };
  }

  createServiceEntry(installationId: string, dto: CreateServiceEntryDto) {
    return this.repo.createServiceEntry(installationId, dto);
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
