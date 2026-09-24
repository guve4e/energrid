import { brierScore, riverDirection, scoreForecast } from './forecast-verification';
describe('forecast scoring', () => {
  it('keeps error direction and range coverage explicit', () => {
    expect(scoreForecast(10, 13, 8, 12)).toEqual({ signedError: 3, absoluteError: 3, squaredError: 9, rangeHit: false });
    expect(scoreForecast(10, 8, 8, 12).rangeHit).toBe(true);
    expect(scoreForecast(10, 8).rangeHit).toBeNull();
    expect(() => scoreForecast(NaN, 8)).toThrow();
    expect(() => scoreForecast(10, 8, 12, 8)).toThrow();
  });
  it('scores probabilities and river directions without inventing confidence', () => {
    expect(brierScore(0.8, true)).toBeCloseTo(0.04);
    expect(brierScore(0.8, false)).toBeCloseTo(0.64);
    expect(() => brierScore(80, true)).toThrow();
    expect(riverDirection(2)).toBe('rising');
    expect(riverDirection(-2)).toBe('falling');
    expect(riverDirection(1.9)).toBe('stable');
  });
});
