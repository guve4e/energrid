export type WeatherEventType =
  | 'rain'
  | 'snow'
  | 'freeze'
  | 'wind'
  | 'thunderstorm'
  | 'hail'
  | 'official_warning';
export type WeatherSeverity = 'low' | 'moderate' | 'high' | 'severe';

export interface WeatherFinding {
  eventType: WeatherEventType;
  startsAt: string;
  endsAt: string;
  location: string;
  severity: WeatherSeverity;
  confidence: 'low' | 'medium' | 'high';
  uncertainty: string;
  evidenceRefs: string[];
  consequences: string[];
  preparation: string[];
  bulgarianExplanation: string;
}

export interface WeatherInvestigationResult {
  provider: string;
  model: string;
  findings: WeatherFinding[];
  summary: string;
}
