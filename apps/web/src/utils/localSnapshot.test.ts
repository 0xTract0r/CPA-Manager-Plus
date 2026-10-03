import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocalSnapshotTime } from './localSnapshot';

afterEach(() => vi.unstubAllGlobals());
describe('local snapshot boundary', () => {
  it('only freezes valid loopback snapshots', () => {
    for (const [hostname, search, expected] of [
      ['127.0.0.1', '?snapshot_at=1790989620000', 1790989620000],
      ['production.example', '?snapshot_at=1790989620000', undefined],
      ['localhost', '?snapshot_at=-1', undefined],
      ['localhost', '', undefined],
    ] as const) {
      vi.stubGlobal('window', { location: { hostname, search } });
      expect(getLocalSnapshotTime()).toBe(expected);
    }
  });
});
