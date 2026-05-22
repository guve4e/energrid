import { Injectable, Logger } from '@nestjs/common';

type DanubeData = {
  station: string;
  elevationM: number | null;
  levelCm: number | null;
  difference24hCm: number | null;
  trend: 'rising' | 'falling' | 'stable' | 'unknown';
  waterTempC: number | null;
  provider: string;
  fetchedAt: string;
};

@Injectable()
export class DanubeProviderService {
  private readonly logger = new Logger(DanubeProviderService.name);

  async getVidinRiverData(): Promise<DanubeData> {
    try {
      const response = await fetch('https://www.appd-bg.org/index-en');

      if (!response.ok) {
        throw new Error(`APPD HTTP ${response.status}`);
      }

      const html = await response.text();
      return this.parseVidinRow(html);
    } catch (error) {
      this.logger.warn(`Danube provider failed: ${String(error)}`);

      return {
        station: 'Vidin',
        elevationM: null,
        levelCm: null,
        difference24hCm: null,
        trend: 'unknown',
        waterTempC: null,
        provider: 'appd-bg-fallback',
        fetchedAt: new Date().toISOString(),
      };
    }
  }

  private parseVidinRow(html: string): DanubeData {
    const rowMatch = html.match(/<tr>\s*<td>\s*Vidin\s*<\/td>[\s\S]*?<\/tr>/i);

    if (!rowMatch) {
      throw new Error('Could not find Vidin row in APPD HTML');
    }

    const row = rowMatch[0];

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
      this.cleanCell(match[1]),
    );

    if (cells.length < 6) {
      throw new Error(`Unexpected Vidin row cell count: ${cells.length}`);
    }

    const station = cells[0] || 'Vidin';
    const elevationM = this.toNumber(cells[1]);
    const levelCm = this.toNumber(cells[2]);
    const difference24hCm = this.toNumber(cells[4]);
    const waterTempC = this.toNumber(cells[5]);

    return {
      station,
      elevationM,
      levelCm,
      difference24hCm,
      trend: this.getTrend(difference24hCm),
      waterTempC,
      provider: 'appd-bg',
      fetchedAt: new Date().toISOString(),
    };
  }

  private cleanCell(value: string): string {
    return value
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toNumber(value: string | undefined): number | null {
    if (!value) return null;

    const normalized = value.replace(',', '.').replace(/[^\d.+-]/g, '');
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
  }

  private getTrend(value: number | null): DanubeData['trend'] {
    if (value == null) return 'unknown';
    if (value > 0) return 'rising';
    if (value < 0) return 'falling';
    return 'stable';
  }
}
