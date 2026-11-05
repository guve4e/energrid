import { estimatePowerEnergy } from './power-energy-estimate';

const start = '2026-01-01T00:00:00.000Z';
const end = '2026-01-01T01:00:00.000Z';
const hourMs = 60 * 60_000;

function sample(offsetMs: number, value: number | null, overrides: Record<string, unknown> = {}) {
  return {
    observedAt: new Date(Date.parse(start) + offsetMs).toISOString(),
    value,
    quality: value === null ? 'invalid' : 'measured',
    unit: 'W',
    ...overrides,
  } as const;
}

describe('deterministic power-to-energy estimate', () => {
  it('integrates constant power to known kWh', () => {
    const estimate = estimatePowerEnergy([sample(0, 1000), sample(hourMs, 1000)], start, end, hourMs);
    expect(estimate).toMatchObject({ status: 'estimated', method: 'trapezoidal', signedEnergyKwh: 1, coveredDurationSeconds: 3600, requestedDurationSeconds: 3600, coveragePercent: 100, uncoveredGaps: [] });
  });

  it('integrates variable and irregularly timed observations using actual elapsed durations', () => {
    const estimate = estimatePowerEnergy([
      sample(0, 1000), sample(30 * 60_000, 2000), sample(hourMs, 1000),
    ], start, end, hourMs);
    expect(estimate.signedEnergyKwh).toBeCloseTo(1.5, 12);

    const irregular = estimatePowerEnergy([
      sample(0, 1000), sample(10 * 60_000, 3000), sample(50 * 60_000, 1000), sample(hourMs, 1000),
    ], start, end, hourMs);
    // 0-10m: 2kW average; 10-50m: 2kW average; 50-60m: 1kW.
    expect(irregular.signedEnergyKwh).toBeCloseTo(1.8333333333333333, 12);
  });

  it('collapses identical duplicate timestamps and rejects conflicting duplicates as a gap', () => {
    const duplicate = sample(30 * 60_000, 1000);
    const sameValue = estimatePowerEnergy([
      sample(0, 1000), duplicate, { ...duplicate }, sample(hourMs, 1000),
    ], start, end, hourMs);
    expect(sameValue).toMatchObject({ status: 'estimated', signedEnergyKwh: 1, coveredDurationSeconds: 3600 });

    const conflict = estimatePowerEnergy([
      sample(0, 1000), duplicate, sample(30 * 60_000, 2000), sample(hourMs, 1000),
    ], start, end, hourMs);
    expect(conflict).toMatchObject({ status: 'insufficient_coverage', signedEnergyKwh: null, coveredDurationSeconds: 0 });
    expect(conflict.uncoveredGaps.filter(gap => gap.reason === 'conflicting_duplicate_timestamp')).toHaveLength(2);
  });

  it('leaves long missing intervals and unobserved boundaries uncovered', () => {
    const longGap = estimatePowerEnergy([
      sample(0, 1000), sample(10 * 60_000, 1000),
    ], start, new Date(Date.parse(start) + 10 * 60_000).toISOString(), 5 * 60_000);
    expect(longGap).toMatchObject({ status: 'insufficient_coverage', signedEnergyKwh: null, uncoveredGaps: [expect.objectContaining({ reason: 'maximum_interval_exceeded', durationSeconds: 600 })] });

    const bounded = estimatePowerEnergy([
      sample(100_000, 1000), sample(500_000, 1000),
    ], start, new Date(Date.parse(start) + 600_000).toISOString(), 400_000);
    expect(bounded).toMatchObject({ status: 'partial_estimate', signedEnergyKwh: 1000 * 400 / 3_600_000, coveredDurationSeconds: 400, requestedDurationSeconds: 600, coveragePercent: 400 / 600 * 100 });
    expect(bounded.uncoveredGaps).toEqual([
      expect.objectContaining({ durationSeconds: 100, reason: 'boundary' }),
      expect.objectContaining({ durationSeconds: 100, reason: 'boundary' }),
    ]);
  });

  it('preserves negative power and labels a window with no usable interval insufficient', () => {
    const exportEstimate = estimatePowerEnergy([sample(0, -1000), sample(hourMs, -1000)], start, end, hourMs);
    expect(exportEstimate.signedEnergyKwh).toBe(-1);

    const insufficient = estimatePowerEnergy([sample(20 * 60_000, 1000)], start, end, hourMs);
    expect(insufficient).toMatchObject({ status: 'insufficient_coverage', signedEnergyKwh: null, coveredDurationSeconds: 0, requestedDurationSeconds: 3600 });
    expect(insufficient.uncoveredGaps.reduce((sum, gap) => sum + gap.durationSeconds, 0)).toBe(3600);
  });

  it('does not integrate invalid observations or non-watt values', () => {
    const estimate = estimatePowerEnergy([
      sample(0, 1000), sample(30 * 60_000, null),
      sample(hourMs, 1000),
    ], start, end, hourMs);
    expect(estimate).toMatchObject({ status: 'insufficient_coverage', signedEnergyKwh: null });
    expect(estimate.uncoveredGaps.map(gap => gap.reason)).toContain('invalid_sample');

    const wrongUnit = estimatePowerEnergy([
      sample(0, 1000, { unit: 'kW' }), sample(hourMs, 1000),
    ], start, end, hourMs);
    expect(wrongUnit.status).toBe('insufficient_coverage');
  });
});
