import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    post: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    post: mocks.post,
  },
}));

import { probeProxyConnectivity } from './proxyProbe';

beforeEach(() => {
  mocks.post.mockReset();
});

describe('probeProxyConnectivity', () => {
  it('posts to the fixed diagnostics path with proxy_url body and normalizes exit_ip', async () => {
    mocks.post.mockResolvedValue({ ok: true, exit_ip: '203.0.113.7', reason: 'ok' });

    const result = await probeProxyConnectivity('socks5://user:pass@host:1080');

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/diagnostics/proxy-connectivity-probe', {
      proxy_url: 'socks5://user:pass@host:1080',
    });
    expect(result).toEqual({ ok: true, exitIp: '203.0.113.7', reason: 'ok' });
  });

  it('preserves known failure reasons (dial_failed) with empty exit ip', async () => {
    mocks.post.mockResolvedValue({ ok: false, exit_ip: '', reason: 'dial_failed' });

    const result = await probeProxyConnectivity('socks5://host:1');

    expect(result).toEqual({ ok: false, exitIp: '', reason: 'dial_failed' });
  });

  it('coerces unknown reason to probe_failed and missing exit_ip to empty string', async () => {
    mocks.post.mockResolvedValue({ ok: false, reason: 'weird_reason' });

    const result = await probeProxyConnectivity('http://bad');

    expect(result).toEqual({ ok: false, exitIp: '', reason: 'probe_failed' });
  });

  it('falls back to probe_failed when the request throws', async () => {
    mocks.post.mockRejectedValue(new Error('network down'));

    const result = await probeProxyConnectivity('http://x');

    expect(result).toEqual({ ok: false, exitIp: '', reason: 'probe_failed' });
  });

  it('rejects a non-IP exit_ip (fail-closed to probe_failed) to block echoed arbitrary text', async () => {
    mocks.post.mockResolvedValue({ ok: true, exit_ip: 'not an ip <script>', reason: 'ok' });

    const result = await probeProxyConnectivity('socks5://host:1080');

    expect(result).toEqual({ ok: false, exitIp: '', reason: 'probe_failed' });
  });

  it('rejects an oversized exit_ip string', async () => {
    mocks.post.mockResolvedValue({ ok: true, exit_ip: '1.2.3.4'.repeat(20), reason: 'ok' });

    const result = await probeProxyConnectivity('socks5://host:1080');

    expect(result).toEqual({ ok: false, exitIp: '', reason: 'probe_failed' });
  });

  it('preserves a valid IPv6 exit_ip', async () => {
    mocks.post.mockResolvedValue({ ok: true, exit_ip: '2001:db8::1', reason: 'ok' });

    const result = await probeProxyConnectivity('socks5://host:1080');

    expect(result).toEqual({ ok: true, exitIp: '2001:db8::1', reason: 'ok' });
  });
});
