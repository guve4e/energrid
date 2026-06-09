import { Injectable, Logger } from '@nestjs/common';
import { RiverStationReading, RiverTrend } from './river.types';

@Injectable()
export class AppdDanubeProviderService {
  private readonly logger = new Logger(AppdDanubeProviderService.name);
  private readonly url = 'https://www.appd-bg.org/index-en';

  async getStations(): Promise<RiverStationReading[]> {
    try {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`APPD HTTP ${res.status}`);

      const html = await res.text();
      const rows = this.extractRows(html);

      return ['Novo Selo', 'Vidin', 'Lom', 'Oryahovo']
        .map((station) => this.parseStationFromRows(rows, station))
        .filter((item): item is RiverStationReading => !!item);
    } catch (error) {
      this.logger.warn(`APPD river scrape failed: ${String(error)}`);
      return [];
    }
  }

  private extractRows(html: string): string[] {
    return [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  }

  private parseStationFromRows(rows: string[], station: string): RiverStationReading | null {
    const candidates = rows
      .map((row) => this.extractCells(row))
      .filter((cells) => cells[0]?.toLowerCase() === station.toLowerCase());

    if (!candidates.length) return null;

    const cells =
      candidates.find((row) => row.length >= 6 && this.toNumber(row[2]) != null) ??
      candidates[0];

    return {
      station,
      elevationM: this.toNumber(cells[1]),
      levelCm: this.toNumber(cells[2]),
      dischargeM3s: this.toNumber(cells[3]),
      difference24hCm: this.toNumber(cells[4]),
      trend: this.trendFromDifference(this.toNumber(cells[4])),
      waterTempC: this.toNumber(cells[5]),
      provider: 'appd-bg',
      fetchedAt: new Date().toISOString(),
    };
  }

  private extractCells(row: string): string[] {
    return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
      this.cleanCell(match[1]),
    );
  }

  private cleanCell(value: string): string {
    return value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toNumber(value?: string): number | null {
    if (!value) return null;

    const normalized = value.replace(',', '.').match(/[-+]?\d+(\.\d+)?/)?.[0];
    if (!normalized) return null;

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private trendFromDifference(diff: number | null): RiverTrend {
    if (diff == null) return 'unknown';
    if (diff > 3) return 'rising';
    if (diff < -3) return 'falling';
    return 'stable';
  }
}
