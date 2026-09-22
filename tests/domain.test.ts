import { describe, it, expect } from 'vitest';
import { patch, subtract, reminderDate } from '../packages/domain/src/index.js';
import { validateValues, schemas } from '../packages/contracts/src/index.js';
describe('controlled optional attributes', () => {
  it('accepts a single date without invented defaults', () =>
    expect(validateValues('lifecycle', { expiry: { date: '2026-09-25' } })).toEqual({
      expiry: { date: '2026-09-25' },
    }));
  it('rejects contradictions, missing measurement units and unknown fields', () => {
    expect(() =>
      validateValues('lifecycle', {
        opening: { state: 'SEALED', opened_at: '2026-09-22T00:00:00Z' },
      }),
    ).toThrow();
    expect(() => validateValues('contents', { remaining: { value: '1' } })).toThrow();
    expect(() =>
      validateValues('contents', { remaining: { value: '101', unit: 'percent' } }),
    ).toThrow();
    expect(() => validateValues('product', { arbitrary: 'x' })).toThrow();
  });
  it('preserves untouched values and rejects overlapping or component paths', () => {
    expect(
      patch(
        { expiry: { date: '2026-09-25' } },
        { 'opening.state': 'OPENED' },
        [],
        ['expiry.date', 'opening.state'],
      ),
    ).toEqual({ expiry: { date: '2026-09-25' }, opening: { state: 'OPENED' } });
    expect(() => patch({}, { 'remaining.value': '2' }, [], ['remaining'])).toThrow();
    expect(() => patch({}, { a: 1 }, ['a'], ['a'])).toThrow();
  });
  it('keeps decimal subtraction exact and propagates unknown accuracy', () => {
    expect(
      subtract({ value: '0.3', unit: 'mL' }, { value: '0.1', unit: 'mL' }, 'MEASURED').remaining
        .value,
    ).toBe('0.2');
    expect(
      subtract({ value: '1', unit: 'mL' }, { value: '0.1', unit: 'mL' }, 'MEASURED'),
    ).not.toHaveProperty('accuracy');
    expect(() => subtract({ value: '1', unit: 'mL' }, { value: '2', unit: 'mL' })).toThrow();
  });
  it('derives opening expiry in household timezone without fabricating missing dates', () => {
    expect(
      reminderDate({ expiry: { after_opening_days: 2 } }, 'Asia/Shanghai').date,
    ).toBeUndefined();
    expect(
      reminderDate(
        { opening: { opened_at: '2026-09-22T23:00:00Z' }, expiry: { after_opening_days: 2 } },
        'Asia/Shanghai',
      ).date,
    ).toBe('2026-09-25');
  });
  it('does not expose automatic selection or implicit quantity consumption', () => {
    expect(
      schemas.consume_items.safeParse({
        selection: { policy: 'FEFO' },
        count: 1,
        idempotency_key: 'x',
      }).success,
    ).toBe(false);
  });
});

it('does not round long decimal quantities during subtraction', () => {
  expect(
    subtract(
      { value: '123456789012345678901234567890.123', unit: 'mL' },
      { value: '0.001', unit: 'mL' },
    ).remaining.value,
  ).toBe('123456789012345678901234567890.122');
});

it('validates complete entity-prefixed standard UUIDs without accepting shortened or legacy aliases', async () => {
  const { entityId, idKinds } = await import('../packages/contracts/src/ids.js');
  const uuid = '11111111-1111-4111-8111-000000000001';
  for (const kind of idKinds) {
    expect(entityId(kind).parse(`${kind}_${uuid}`)).toBe(`${kind}_${uuid}`);
    for (const invalid of [
      uuid,
      `${kind}_${uuid.slice(0, 22)}`,
      `${kind}_${uuid}x`,
      `x${kind}_${uuid}`,
      `${kind}_AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`,
    ])
      expect(entityId(kind).safeParse(invalid).success).toBe(false);
  }
});
