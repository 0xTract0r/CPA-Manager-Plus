import { describe, expect, it } from 'vitest';
import { formatModified } from './constants';

describe('credential file modification time', () => {
  const file = { name: 'ordinary.json', type: 'qwen' };

  it.each([0, '0', '0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000000000Z', 'bad-date'])(
    'shows the missing value for %s', (modtime) => {
      expect(formatModified({ ...file, modtime })).toBe('-');
    }
  );

  it('keeps valid seconds, milliseconds and RFC3339 inputs equivalent', () => {
    const iso = '2026-10-01T13:15:12.000Z';
    const ms = Date.parse(iso);
    const expected = formatModified({ ...file, modtime: iso });
    expect(expected).not.toBe('-');
    for (const modtime of [ms / 1000, ms]) {
      expect(formatModified({ ...file, modtime })).toBe(expected);
    }
  });
});
