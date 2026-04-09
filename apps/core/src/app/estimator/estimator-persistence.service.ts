import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import {
  estimateProject,
  type EstimateRequestInput,
  type EstimateResult,
} from '@energrid/domain-estimator';
import { PG_POOL } from '../db.module';
import { CatalogRepository } from './catalog.repository';
import { ProjectsRepository } from './projects.repository';
import { EstimatesRepository } from './estimates.repository';

export interface PersistEstimateInput {
  estimateInput: EstimateRequestInput;
  source?: 'assistant' | 'manual' | 'designer';
  leadId?: string | null;
  conversationId?: string | null;
  projectName?: string | null;
  city?: string | null;
  address?: string | null;
}

export interface PersistEstimateResult {
  project: any;
  estimate: any;
  lines: any[];
  result: EstimateResult;
}

@Injectable()
export class EstimatorPersistenceService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly catalogRepo: CatalogRepository,
    private readonly projectsRepo: ProjectsRepository,
    private readonly estimatesRepo: EstimatesRepository,
  ) {}

  async persistEstimate(input: PersistEstimateInput): Promise<PersistEstimateResult> {
    const catalog = await this.catalogRepo.getActiveCatalog();
    const result = estimateProject(catalog, input.estimateInput);

    const client = await this.pool.connect();

    try {
      await client.query('begin');

      const project = await this.projectsRepo.create(client, {
        tenantSlug: input.estimateInput.tenantSlug,
        leadId: input.leadId ?? null,
        conversationId: input.conversationId ?? null,
        status: 'estimated',
        name: input.projectName ?? null,
        city: input.city ?? null,
        address: input.address ?? null,
      });

      const estimate = await this.estimatesRepo.createEstimate(
        client,
        project.id,
        result,
        input.source ?? 'manual',
      );

      const lines = await this.estimatesRepo.createEstimateLines(
        client,
        estimate.id,
        result.lines,
      );

      await client.query('commit');

      return {
        project,
        estimate,
        lines,
        result,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
