import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocalSnapshotTime, getLocalSnapshotAccess } from './localSnapshot';

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
  it('requires loopback, matching snapshot and explicit read-only service confirmation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { location: { hostname: 'production.example', search: '?snapshot_at=1234' } });
    expect(await getLocalSnapshotAccess()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1', search: '?snapshot_at=1234' } });
    for (const [header, toMs, mode, access, expected] of [
      ['', 1234, 'read-only', 'local-snapshot-preview', undefined],
      ['read-only', 1235, 'read-only', 'local-snapshot-preview', undefined],
      ['read-only', 1234, 'normal', 'local-snapshot-preview', undefined],
      ['read-only', 1234, 'read-only', 'arbitrary-key', undefined],
      ['read-only', 1234, 'read-only', 'local-snapshot-preview', 'local-snapshot-preview'],
    ] as const) {
      fetch.mockResolvedValue(new Response(JSON.stringify({ to_ms: toMs, preview_mode: mode, preview_access: access }), { headers: { 'X-CPAMP-Snapshot': header } }));
      expect(await getLocalSnapshotAccess()).toBe(expected);
    }
  });
});
