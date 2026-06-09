import { Injectable, Logger } from '@nestjs/common';
import { RiverStationReading } from './river.types';

@Injectable()
export class DanubePortalProviderService {
  private readonly logger = new Logger(DanubePortalProviderService.name);
  private readonly url = 'https://www.danubeportal.com/waterLevel';

  async getStations(): Promise<RiverStationReading[]> {
    try {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`DanubePortal HTTP ${res.status}`);

      const html = await res.text();
      const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);

      return rows
        .map((row) => this.parseRow(row))
        .filter((item): item is RiverStationReading => !!item)
        .filter((item) => this.isUsefulStation(item.station));
    } catch (error) {
      this.logger.warn(`DanubePortal scrape failed: ${String(error)}`);
      return [];
    }
  }

  private parseRow(row: string): RiverStationReading | null {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
      this.cleanCell(match[1]),
    );

    // Expected:
    // station | fairway | rkm | date time | level cm | map
    if (cells.length < 5) return null;

    const station = cells[0];
    const river = cells[1];
    const rkm = this.toNumber(cells[2]);
    const fetchedAt = this.parseDate(cells[3]);
    const levelCm = this.toNumber(cells[4]);

    if (!station || !river || levelCm == null) return null;

    return {
      station,
      elevationM: rkm,
      levelCm,
      dischargeM3s: null,
      difference24hCm: null,
      trend: 'unknown',
      waterTempC: null,
      provider: 'danubeportal',
      fetchedAt,
    };
  }

  private isUsefulStation(station: string): boolean {
    const normalized = station.toLowerCase();

    return [
      'vidin',
      'calafat',
      'gomotartsi',
      'гомотарци',
      'novo selo',
      'лом',
      'lom',
      'oryahovo',
      'оряхово',
      'nikopol',
      'никопол',
      'bechet',
      'corabia',
      'turnu',
      'giurgiu',
      'drobeta',
      'gruia',
      'apatin',
      'апатин',
      'bogojevo',
      'богојево',
      'bezdan',
      'batina',
    ].some((name) => normalized.includes(name));
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

  private parseDate(value?: string): string {
    if (!value) return new Date().toISOString();

    const cleaned = value.trim();

    // DanubePortal usually gives: YYYY-MM-DD HH:mm
    const match = cleaned.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (match) {
      // Store consistently; exact timezone source may vary by provider.
      return new Date(`${match[1]}T${match[2]}:00Z`).toISOString();
    }

    const parsed = new Date(cleaned);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
}
