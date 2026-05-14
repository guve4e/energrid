import { Injectable } from '@nestjs/common';
import { CatalogRepository } from '../estimator/catalog.repository';
import type { PricingCatalogRow } from '@energrid/domain-estimator';

@Injectable()
export class CatalogV2Service {
  private cache = new Map<string, PricingCatalogRow>();
  private loadedAt = 0;
  private readonly ttlMs = 60_000;

  constructor(private readonly catalogRepo: CatalogRepository) {}

  async getByCode(code: string): Promise<PricingCatalogRow> {
    await this.ensureLoaded();

    const row = this.cache.get(code);
    if (!row) {
      throw new Error(`Missing pricing catalog row for code: ${code}`);
    }

    return row;
  }

  async getManyByCodes(codes: string[]): Promise<Record<string, PricingCatalogRow>> {
    await this.ensureLoaded();

    const result: Record<string, PricingCatalogRow> = {};

    for (const code of codes) {
      const row = this.cache.get(code);
      if (!row) {
        throw new Error(`Missing pricing catalog row for code: ${code}`);
      }
      result[code] = row;
    }

    return result;
  }

  async listActive(): Promise<PricingCatalogRow[]> {
    await this.ensureLoaded();
    return Array.from(this.cache.values());
  }

  invalidate(): void {
    this.cache.clear();
    this.loadedAt = 0;
  }

  private async ensureLoaded(): Promise<void> {
    const now = Date.now();

    if (this.cache.size > 0 && now - this.loadedAt < this.ttlMs) {
      return;
    }

    const rows = await this.catalogRepo.getActiveCatalog();

    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.code, row);
    }

    this.loadedAt = now;
  }
}
