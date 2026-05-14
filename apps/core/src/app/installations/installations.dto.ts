export interface CreateInstallationDto {
  customerName: string;
  customerPhone?: string;
  propertyAddress: string;
  notes?: string;
}

export interface UpdateInstallationDto {
  customerName?: string;
  customerPhone?: string;
  propertyAddress?: string;
  status?: string;
  notes?: string;
}

export interface CreatePanelDto {
  name: string;
  location?: string;
  mainBreaker?: string;
  groundingType?: string;
  notes?: string;
}

export interface UpdatePanelDto {
  name?: string;
  location?: string;
  mainBreaker?: string;
  groundingType?: string;
  notes?: string;
}

export interface CreateCircuitDto {
  circuitNo: number;
  label: string;
  breakerType?: string;
  breakerAmps?: number;
  breakerCurve?: string;
  cableType?: string;
  cableMm2?: number;
  rcdGroup?: string;
  room?: string;
  notes?: string;
}

export interface UpdateCircuitDto {
  circuitNo?: number;
  label?: string;
  breakerType?: string;
  breakerAmps?: number;
  breakerCurve?: string;
  cableType?: string;
  cableMm2?: number;
  rcdGroup?: string;
  room?: string;
  notes?: string;
}

export interface CreateServiceEntryDto {
  type: string;
  date?: string;
  title: string;
  notes?: string;
}
