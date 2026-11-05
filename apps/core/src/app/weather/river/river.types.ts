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
  /** When Energrid retrieved the source page; never the gauge measurement time. */
  fetchedAt: string;
  /** Exact gauge measurement instant only when the source time zone is verified. */
  observedAt: string | null;
  /** Unmodified date/time text from the source (not an instant). */
  sourceReportedAt: string | null;
  observationTimeBasis: 'verified' | 'date-only' | 'timezone-unverified' | 'unknown';
  /** Danube river kilometre; not gauge elevation or water level datum. */
  riverKm: number | null;
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
