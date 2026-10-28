import { convertToEur, decimalString, financeDecimal, roundDecimal } from './decimal';
import { euroValue, reconcileItemsAgainstTotal } from './expense-rules';

describe('personal finance exact decimal rules', () => {
  it('preserves historical BGN conversion provenance and does not invent missing FX', () => {
    const original = decimalString('135.6');
    const missingFx = euroValue(original, 'BGN');
    expect(original).toBe('135.6');
    expect(missingFx).toEqual({ amountEur: null, fx: null });
    expect(convertToEur('135.6', '1.95583')).toBe('69.33');
    const converted = euroValue(original, 'BGN', null, {
      rate: '1.95583', convention: 'currency_units_per_eur', source: 'legacy-import', effectiveAt: null, provider: null,
    });
    expect(converted.amountEur).toBe('69.33');
    expect(converted.fx?.rate).toBe('1.95583');
    expect(euroValue('135.6', 'BGN', '69.33117909020723', {
      rate: '1.95583', convention: 'currency_units_per_eur', source: 'legacy-import', effectiveAt: null, provider: null,
    }).amountEur).toBe('69.33117909020723');
  });

  it('uses ties-to-even for deterministic EUR cent rounding', () => {
    expect(roundDecimal('1.005', 2)).toBe('1');
    expect(roundDecimal('1.015', 2)).toBe('1.02');
  });

  it('rejects a value that PostgreSQL numeric storage would otherwise round', () => {
    expect(() => financeDecimal('0.1234567890123456789')).toThrow(/precision/);
  });

  it('reconciles receipt lines using exact decimal totals', () => {
    const result = reconcileItemsAgainstTotal([
      { lineTotal: '19.99', currency: 'EUR' },
      { lineTotal: '3.01', currency: 'EUR' },
    ], '23.00', 'EUR');
    expect(result).toMatchObject({ matched: true, calculatedTotal: '23', receiptTotal: '23', difference: '0' });
    expect(reconcileItemsAgainstTotal([{ lineTotal: '22.99', currency: 'EUR' }], '23', 'EUR').matched).toBe(false);
    expect(() => reconcileItemsAgainstTotal([{ lineTotal: '23', currency: 'BGN' }], '23', 'EUR')).toThrow(/receipt currency/);
  });
});
