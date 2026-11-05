import { Injectable, Logger } from '@nestjs/common';
import { fetchRiverHtml } from './river-provider-http';
import { RiverStationReading, RiverTrend } from './river.types';

@Injectable()
export class AppdDanubeProviderService {
  private readonly logger = new Logger(AppdDanubeProviderService.name);
  private readonly url = 'https://www.appd-bg.org/index-en';

  async getStations(): Promise<RiverStationReading[]> {
    try {
      const html = await fetchRiverHtml(this.url);
      const rows = this.extractRows(html);
      const fetchedAt = new Date().toISOString();
      // The page gives a publication date, not a per-gauge measurement instant.
      // Some values may still be from the previous day.
      const sourceDate = html.match(/water levels on[^<]*?(\d{2}\.\d{2}\.\d{4})/i)?.[1] ?? null;

      return ['Novo Selo', 'Vidin', 'Lom', 'Oryahovo']
        .map((station) => this.parseStationFromRows(rows, station, fetchedAt, sourceDate))
        .filter((item): item is RiverStationReading => !!item);
    } catch (error) {
      this.logger.warn(`APPD river scrape failed: ${String(error)}`);
      return [];
    }
  }

  private extractRows(html: string): string[] {
    return [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  }

  private parseStationFromRows(
    rows: string[], station: string, fetchedAt: string, sourceDate: string | null,
  ): RiverStationReading | null {
    const candidates = rows
      .map((row) => this.extractCells(row))
      .filter((cells) => cells[0]?.toLowerCase() === station.toLowerCase());

    if (!candidates.length) return null;

    const cells =
      candidates.find((row) => row.length >= 6 && this.toNumber(row[2]) != null) ??
      candidates[0];

    return {
      station,
      elevationM: null,
      riverKm: this.toNumber(cells[1]),
      levelCm: this.toNumber(cells[2]),
      dischargeM3s: this.toNumber(cells[3]),
      difference24hCm: this.toNumber(cells[4]),
      trend: this.trendFromDifference(this.toNumber(cells[4])),
      waterTempC: this.toNumber(cells[5]),
      provider: 'appd-bg',
      fetchedAt,
      observedAt: null,
      sourceReportedAt: sourceDate,
      observationTimeBasis: sourceDate ? 'date-only' : 'unknown',
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
