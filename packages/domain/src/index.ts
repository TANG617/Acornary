import { Decimal } from 'decimal.js';

// Inputs are bounded to 80 decimal characters; preserve exact arithmetic and household totals.
Decimal.set({ precision: 200 });

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: unknown = undefined,
  ) {
    super(message);
  }
}
export function requireFact(
  condition: unknown,
  code: string,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
export const terminal = new Set(['CONSUMED', 'DISPOSED', 'LOST', 'ARCHIVED']);
export type Accuracy = 'ESTIMATED' | 'MEASURED';
export type Measurement = { value: string; unit: string };
export function subtract(
  current: Measurement,
  amount: Measurement,
  beforeAccuracy?: Accuracy,
  inputAccuracy?: Accuracy,
) {
  requireFact(
    current.unit === amount.unit,
    'UNIT_MISMATCH',
    'Use the same declared unit; no implicit conversion without a basis.',
  );
  const value = new Decimal(current.value),
    delta = new Decimal(amount.value);
  requireFact(delta.gt(0), 'ATTRIBUTE_VALIDATION_FAILED', 'Consumption must be positive.');
  requireFact(value.gte(delta), 'INSUFFICIENT_CONTENT', 'Consumption exceeds remaining contents.');
  const accuracy =
    beforeAccuracy && inputAccuracy
      ? beforeAccuracy === 'MEASURED' && inputAccuracy === 'MEASURED'
        ? 'MEASURED'
        : 'ESTIMATED'
      : undefined;
  return {
    remaining: { value: value.minus(delta).toFixed(), unit: current.unit },
    ...(accuracy ? { accuracy } : {}),
  };
}
export function getPath(value: any, path: string): any {
  return path.split('.').reduce((v, k) => v?.[k], value);
}
export function prune(value: any): any {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      prune(value[key]);
      if (
        value[key] &&
        typeof value[key] === 'object' &&
        !Array.isArray(value[key]) &&
        !Object.keys(value[key]).length
      )
        delete value[key];
    }
  }
  return value;
}
export function patch(
  values: any,
  set: Record<string, unknown>,
  unset: string[],
  allowed: string[],
) {
  const paths = [...Object.keys(set), ...unset];
  requireFact(
    new Set(paths).size === paths.length,
    'ATTRIBUTE_VALIDATION_FAILED',
    'A path cannot occur more than once.',
  );
  for (const path of paths) {
    requireFact(
      allowed.includes(path),
      'ATTRIBUTE_VALIDATION_FAILED',
      `Unknown or non-atomic path: ${path}`,
    );
    requireFact(
      !paths.some((other) => other !== path && other.startsWith(path + '.')),
      'ATTRIBUTE_VALIDATION_FAILED',
      'Overlapping paths.',
    );
  }
  const result = structuredClone(values);
  for (const path of paths) {
    const keys = path.split('.');
    const last = keys.pop()!;
    let obj = result;
    for (const key of keys) obj = obj[key] ??= {};
    if (Object.hasOwn(set, path)) obj[last] = set[path];
    else delete obj[last];
  }
  return prune(result);
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function changes(before: Record<string, any>, after: Record<string, any>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((path) => canonical(before[path]) !== canonical(after[path]))
    .map((path) => ({
      path,
      before_present: Object.hasOwn(before, path),
      after_present: Object.hasOwn(after, path),
      ...(Object.hasOwn(before, path) ? { before: before[path] } : {}),
      ...(Object.hasOwn(after, path) ? { after: after[path] } : {}),
    }));
}
export function reminderDate(lifecycle: any, timezone: string): { date?: string; basis: string[] } {
  const dates: string[] = [];
  const basis: string[] = [];
  if (lifecycle?.expiry?.date) {
    dates.push(lifecycle.expiry.date);
    basis.push('lifecycle.expiry.date');
  }
  if (lifecycle?.opening?.opened_at && lifecycle?.expiry?.after_opening_days) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(lifecycle.opening.opened_at));
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    const d = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + lifecycle.expiry.after_opening_days);
    dates.push(d.toISOString().slice(0, 10));
    basis.push('lifecycle.opening.opened_at + lifecycle.expiry.after_opening_days');
  }
  return { ...(dates.length ? { date: dates.sort()[0] } : {}), basis };
}
