/** Exact base-10 arithmetic for finance values. No binary floating point is used. */
export type DecimalInput = string | number | bigint;

const POWERS_OF_TEN = Array.from({ length: 101 }, (_, index) => 10n ** BigInt(index));

function expandExponent(value: string): string {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return value;
  const [, sign, whole, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 80) {
    throw new Error('Decimal exponent is outside the supported range');
  }
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function decimalString(input: DecimalInput): string {
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new Error('Money value must be finite');
  }
  const expanded = expandExponent(String(input).trim());
  if (expanded.length > 100) throw new Error('Money value exceeds the supported length');
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(expanded)) {
    throw new Error('Money value must be a base-10 decimal');
  }
  const negative = expanded.startsWith('-');
  const unsigned = negative ? expanded.slice(1) : expanded;
  const [whole, fraction = ''] = unsigned.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const normalized = trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

/** PostgreSQL NUMERIC(38,18) storage bound; reject instead of letting PostgreSQL round. */
export function financeDecimal(input: DecimalInput): string {
  const normalized = decimalString(input);
  const unsigned = normalized.startsWith('-') ? normalized.slice(1) : normalized;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 18 || whole.length > 20) {
    throw new Error('Financial value exceeds supported precision (20 integer and 18 fractional digits)');
  }
  return normalized;
}

function parts(input: DecimalInput): { coefficient: bigint; scale: number } {
  const normalized = decimalString(input);
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  if (fraction.length > 80) throw new Error('Money precision exceeds 80 places');
  return { coefficient, scale: fraction.length };
}

function format(coefficient: bigint, scale: number): string {
  if (scale < 0 || scale >= POWERS_OF_TEN.length) throw new Error('Unsupported decimal scale');
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return decimalString(`${negative ? '-' : ''}${value}`);
}

function scaled(input: DecimalInput, scale: number): bigint {
  const { coefficient, scale: inputScale } = parts(input);
  return coefficient * POWERS_OF_TEN[scale - inputScale];
}

export function addDecimal(left: DecimalInput, right: DecimalInput): string {
  const a = parts(left);
  const b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  return format(scaled(left, scale) + scaled(right, scale), scale);
}

export function compareDecimal(left: DecimalInput, right: DecimalInput): number {
  const a = parts(left);
  const b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  const x = scaled(left, scale);
  const y = scaled(right, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function multiplyDecimal(left: DecimalInput, right: DecimalInput): string {
  const a = parts(left);
  const b = parts(right);
  return format(a.coefficient * b.coefficient, a.scale + b.scale);
}

/** Divide by a positive integer and round using the finance domain's ties-to-even rule. */
export function divideDecimalByInteger(input: DecimalInput, divisor: number, scale = 2): string {
  if (!Number.isSafeInteger(divisor) || divisor <= 0) throw new Error('Divisor must be a positive integer');
  if (!Number.isInteger(scale) || scale < 0 || scale > 80) throw new Error('Invalid decimal scale');
  const { coefficient, scale: inputScale } = parts(input);
  const numerator = coefficient * POWERS_OF_TEN[scale];
  const denominator = POWERS_OF_TEN[inputScale] * BigInt(divisor);
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && quotient % 2n !== 0n)) quotient++;
  return format(negative ? -quotient : quotient, scale);
}

/** Round to `scale` places using bankers rounding (ties to even). */
export function roundDecimal(input: DecimalInput, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 80) throw new Error('Invalid rounding scale');
  const { coefficient, scale: inputScale } = parts(input);
  if (inputScale <= scale) return format(coefficient * POWERS_OF_TEN[scale - inputScale], scale);
  const divisor = POWERS_OF_TEN[inputScale - scale];
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const doubled = remainder * 2n;
  if (doubled > divisor || (doubled === divisor && quotient % 2n !== 0n)) quotient++;
  return format(negative ? -quotient : quotient, scale);
}

/**
 * Convert source units to EUR. `rate` means source-currency units per EUR.
 * Computed conversions are rounded to EUR cents using ties-to-even.
 */
export function convertToEur(amount: DecimalInput, rate: DecimalInput, scale = 2): string {
  const a = parts(amount);
  const r = parts(rate);
  if (r.coefficient <= 0n) throw new Error('FX rate must be greater than zero');
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new Error('Invalid EUR scale');
  let numerator = (a.coefficient < 0n ? -a.coefficient : a.coefficient) * POWERS_OF_TEN[r.scale + scale];
  let denominator = r.coefficient * POWERS_OF_TEN[a.scale];
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  let rounded = quotient;
  if (doubled > denominator || (doubled === denominator && quotient % 2n !== 0n)) rounded++;
  if (a.coefficient < 0n) rounded = -rounded;
  return format(rounded, scale);
}

export function sumDecimals(values: readonly DecimalInput[]): string {
  return values.reduce<string>((sum, value) => addDecimal(sum, value), '0');
}

export function isDecimal(value: unknown): value is string | number {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  try {
    decimalString(value);
    return true;
  } catch {
    return false;
  }
}
