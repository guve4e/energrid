import { RiverRegionalIntelligenceService } from './river-regional-intelligence.service';
import { RiverWaterLevelHistoricalContext } from './river-historical-context.service';

function historical(station: string, current: number, median: number): RiverWaterLevelHistoricalContext {
  const range = { minimum: -24, minimumDate: '2003-10-03', maximum: 706,
    maximumDate: '1974-10-31', median, percentile: 0,
    minimumCm: -24, maximumCm: 706, medianCm: median };
  return {
    station, metric: 'water_level', unit: 'cm', currentValue: current, currentValueCm: current,
    coverage: { from: '1936-01-01', to: '2025-12-31', observations: 32873, years: 90 },
    allTime: range, seasonal: { ...range, month: 10 }, assessment: 'record-low',
  };
}

describe('RiverRegionalIntelligenceService', () => {
  const observedAt = new Date('2026-10-10T07:00:00Z');
  const upstream = historical('novo-selo', -97, 196.5);
  const downstream = historical('lom', -46, 239);

  function createService(archives: (RiverWaterLevelHistoricalContext | null)[]) {
    const provider = { getStations: jest.fn().mockResolvedValue([
      { station: 'Novo Selo', levelCm: -97 },
      { station: 'Vidin', levelCm: -64 },
      { station: 'Lom', levelCm: -46 },
    ]) };
    const history = { getWaterLevelContext: jest.fn()
      .mockResolvedValueOnce(archives[0]).mockResolvedValueOnce(archives[1]) };
    return { service: new RiverRegionalIntelligenceService(provider as never, history as never), history };
  }

  it('uses the requested seasonal context, not a hard-coded July headline', async () => {
    const { service, history } = createService([upstream, downstream]);
    const result = await service.getVidinContext(observedAt);
    expect(result.referenceMonth).toBe(10);
    expect(result.currentLevelCm).toBe(-64);
    expect(result.regional).toMatchObject({ assessment: 'record-low', confidence: 'high', agreement: 'strong' });
    expect(result.regional.headline).toContain('seasonal');
    expect(result.regional.headline).not.toContain('July');
    expect(result.regional.reasons[0]).toContain('-293.5 cm versus the monthly median');
    expect(history.getWaterLevelContext).toHaveBeenCalledWith('novo-selo', -97, observedAt);
    expect(history.getWaterLevelContext).toHaveBeenCalledWith('lom', -46, observedAt);
  });

  it('marks a single available historical reference as provisional', async () => {
    const { service } = createService([upstream, null]);
    const result = await service.getVidinContext(observedAt);
    expect(result.regional).toMatchObject({ confidence: 'medium', agreement: 'partial' });
    expect(result.regional.explanation).toContain('Only one');
    expect(result.references.downstream.historical).toBeNull();
    expect(result.references.downstream.currentLevelCm).toBe(-46);
  });

  it('does not infer a historical classification when both archives are unavailable', async () => {
    const { service } = createService([null, null]);
    const result = await service.getVidinContext(observedAt);
    expect(result.regional).toMatchObject({ assessment: 'unavailable', agreement: 'unavailable',
      seasonalPercentileRange: { minimum: null, maximum: null } });
    expect(result.currentLevelCm).toBe(-64);
  });
});
