export type RiverTrend = 'rising' | 'falling' | 'stable' | 'unknown';

export interface RiverStationReading {
  station: string;
  elevationM: number | null;
  levelCm: number | null;
  dischargeM3s: number | null;
  difference24hCm: number | null;
  trend: RiverTrend;
  waterTempC: number | null;
  provider: string;
  fetchedAt: string;
}

export interface RiverIntelligence {
  headline: string;
  navigationRisk: 'low' | 'watch' | 'danger';
  boatRisk: 'normal' | 'watch' | 'avoid';
  next24h: RiverTrend;
  confidence: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface RiverDashboard {
  mainStation: RiverStationReading | null;
  nearbyStations: RiverStationReading[];
  intelligence: RiverIntelligence;
}
