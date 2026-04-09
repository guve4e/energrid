import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';

@Injectable()
export class CatalogRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getActiveCatalog() {
    const { rows } = await this.pool.query(`
      select
        code,
        category,
        name_bg,
        unit,
        base_price,
        pricing_mode,
        rules_json,
        labor_included,
        materials_included,
        is_active
      from pricing_catalog
      where is_active = true
    `);

    return rows;
  }
}
