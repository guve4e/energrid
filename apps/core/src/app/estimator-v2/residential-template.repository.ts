import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import type { ResidentialTemplate } from './residential-template';

export function validateResidentialTemplate(version: string, config: Record<string, unknown>): ResidentialTemplate {
  if (!config || typeof config !== 'object') throw new ServiceUnavailableException('Invalid residential template');
  for (const key of ['socketsPerRoom','kitchenSockets','corridorSockets','bathroomSockets','routeMin','routeMax','corridorCount','bathroomCount','terraceCount']) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || (key !== 'routeMin' && key !== 'routeMax' && !Number.isInteger(value))) throw new ServiceUnavailableException(`Invalid template ${key}`);
  }
  // The active point catalog item includes 3 metres; do not silently reinterpret it.
  if (config.routeMin !== 3 || Number(config.routeMax) < 3) throw new ServiceUnavailableException('Template routes conflict with point catalog scope');
  for (const key of ['boiler','oven','hob','washer','dishwasher','dryer']) if (typeof config[key] !== 'boolean') throw new ServiceUnavailableException(`Invalid template ${key}`);
  if (typeof config.defaultPanelCode !== 'string' || !['panel_modern','panel_full_protection','panel_custom'].includes(config.defaultPanelCode)) throw new ServiceUnavailableException('Invalid template panel');
  const descriptions = config.panelDescriptions as Record<string, unknown>;
  if (!descriptions || typeof descriptions[config.defaultPanelCode] !== 'string') throw new ServiceUnavailableException('Missing panel description');
  return { ...config, version } as ResidentialTemplate;
}

@Injectable()
export class ResidentialTemplateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async get(version?: string): Promise<ResidentialTemplate> {
    const { rows } = await this.pool.query(
      version ? 'select version, config from residential_estimate_templates where version = $1' : 'select version, config from residential_estimate_templates where is_default = true',
      version ? [version] : [],
    );
    if (rows.length !== 1) throw new ServiceUnavailableException('Residential template is not configured');
    return validateResidentialTemplate(rows[0].version, rows[0].config);
  }
}
