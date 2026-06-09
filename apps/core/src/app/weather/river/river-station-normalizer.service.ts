import { Injectable } from '@nestjs/common';
import { RiverStationReading } from './river.types';

export interface NormalizedRiverStation {
  key: string;
  label: string;
  role: 'upstream' | 'local' | 'downstream' | 'far-upstream';
  readings: RiverStationReading[];
  bestReading: RiverStationReading | null;
}

@Injectable()
export class RiverStationNormalizerService {
  normalize(readings: RiverStationReading[]): NormalizedRiverStation[] {
    const groups = new Map<string, NormalizedRiverStation>();

    for (const reading of readings) {
      const match = this.match(reading.station);

      if (!match) continue;

      const existing =
        groups.get(match.key) ??
        {
          key: match.key,
          label: match.label,
          role: match.role,
          readings: [],
          bestReading: null,
        };

      existing.readings.push(reading);
      existing.bestReading = this.pickBest(existing.readings);

      groups.set(match.key, existing);
    }

    return [...groups.values()].sort((a, b) => this.roleWeight(a.role) - this.roleWeight(b.role));
  }

  private match(station: string): Pick<NormalizedRiverStation, 'key' | 'label' | 'role'> | null {
    const s = station.toLowerCase();

    if (s.includes('batina')) return { key: 'batina', label: 'Batina', role: 'far-upstream' };
    if (s.includes('апатин') || s.includes('apatin')) return { key: 'apatin', label: 'Apatin', role: 'far-upstream' };
    if (s.includes('бого') || s.includes('bogojevo')) return { key: 'bogojevo', label: 'Bogojevo', role: 'far-upstream' };
    if (s.includes('drobeta')) return { key: 'drobeta', label: 'Drobeta Turnu Severin', role: 'far-upstream' };
    if (s.includes('gruia')) return { key: 'gruia', label: 'Gruia', role: 'far-upstream' };

    if (s.includes('novo selo')) return { key: 'novo-selo', label: 'Novo Selo', role: 'upstream' };
    if (s.includes('gomotartsi')) return { key: 'gomotartsi', label: 'Gomotartsi', role: 'upstream' };

    if (s.includes('vidin') || s.includes('kalafat') || s.includes('calafat')) {
      return { key: 'vidin-calafat', label: 'Vidin / Calafat', role: 'local' };
    }

    if (s.includes('lom')) return { key: 'lom', label: 'Lom', role: 'downstream' };
    if (s.includes('oryahovo') || s.includes('оряхово')) return { key: 'oryahovo', label: 'Oryahovo', role: 'downstream' };
    if (s.includes('bechet')) return { key: 'bechet', label: 'Bechet', role: 'downstream' };
    if (s.includes('corabia')) return { key: 'corabia', label: 'Corabia', role: 'downstream' };
    if (s.includes('turnu')) return { key: 'turnu-magurele', label: 'Turnu Măgurele', role: 'downstream' };
    if (s.includes('giurgiu')) return { key: 'giurgiu', label: 'Giurgiu', role: 'downstream' };

    return null;
  }

  private pickBest(readings: RiverStationReading[]): RiverStationReading | null {
    if (!readings.length) return null;

    return [...readings].sort((a, b) => {
      const providerScore = this.providerScore(b.provider) - this.providerScore(a.provider);
      if (providerScore !== 0) return providerScore;

      const freshness =
        new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime();

      return freshness;
    })[0];
  }

  private providerScore(provider: string): number {
    if (provider === 'appd-bg') return 3;
    if (provider === 'danubeportal') return 2;
    return 1;
  }

  private roleWeight(role: NormalizedRiverStation['role']): number {
    if (role === 'far-upstream') return 1;
    if (role === 'upstream') return 2;
    if (role === 'local') return 3;
    return 4;
  }
}
