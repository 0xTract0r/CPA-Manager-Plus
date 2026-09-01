import { describe, expect, it, vi } from 'vitest';
import {
  ensureProxiesReachableForSave,
  ensureProxyReachableForSave,
  runProxyPreflight,
  validateProxyUrlFormat,
} from './proxyPreflight';

describe('validateProxyUrlFormat', () => {
  it('treats empty as empty (not invalid)', () => {
    expect(validateProxyUrlFormat('   ')).toEqual({ valid: false, reason: 'empty' });
  });

  it('rejects unsupported schemes', () => {
    expect(validateProxyUrlFormat('ftp://host:21')).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects malformed urls', () => {
    expect(validateProxyUrlFormat('not a url')).toEqual({ valid: false, reason: 'invalid' });
  });

  it('accepts http/https/socks5/socks5h', () => {
    expect(validateProxyUrlFormat('http://user:pass@host:8080')).toEqual({ valid: true });
    expect(validateProxyUrlFormat('https://host:8443')).toEqual({ valid: true });
    expect(validateProxyUrlFormat('socks5://host:1080')).toEqual({ valid: true });
    expect(validateProxyUrlFormat('socks5h://user:pass@host:1080')).toEqual({ valid: true });
  });
});

describe('runProxyPreflight', () => {
  it('does not touch the probe when the format is invalid', async () => {
    const probe = vi.fn();

    const result = await runProxyPreflight('not a url', { probe });

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_proxy_url');
    expect(result.message).toBe('代理格式非法');
  });

  it('returns empty_proxy_url without probing when empty', async () => {
    const probe = vi.fn();

    const result = await runProxyPreflight('', { probe });

    expect(probe).not.toHaveBeenCalled();
    expect(result.reason).toBe('empty_proxy_url');
    expect(result.message).toBe('请填写代理');
  });

  it('probes once the format passes and surfaces probe failure with fallback message', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: false, exitIp: '', reason: 'dial_failed' });

    const result = await runProxyPreflight('socks5://host:1080', { probe });

    expect(probe).toHaveBeenCalledWith('socks5://host:1080');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('无法经该代理连通');
  });

  it('prefers translate() output when provided', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, exitIp: '1.2.3.4', reason: 'ok' });

    const result = await runProxyPreflight('http://host:1', {
      probe,
      translate: (reason) => `T:${reason}`,
    });

    expect(result.ok).toBe(true);
    expect(result.exitIp).toBe('1.2.3.4');
    expect(result.message).toBe('T:ok');
  });

  it('skips the probe and passes when the proxy is unchanged from previousProxyUrl', async () => {
    const probe = vi.fn();

    const result = await runProxyPreflight('socks5://host:1080', {
      probe,
      previousProxyUrl: 'socks5://host:1080',
    });

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.exitIp).toBe('');
    expect(result.reason).toBe('ok');
  });

  it('treats surrounding whitespace as unchanged when comparing to previousProxyUrl', async () => {
    const probe = vi.fn();

    const result = await runProxyPreflight('  socks5://host:1080  ', {
      probe,
      previousProxyUrl: 'socks5://host:1080',
    });

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('probes when the proxy changed from previousProxyUrl', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, exitIp: '1.2.3.4', reason: 'ok' });

    const result = await runProxyPreflight('socks5://new:1080', {
      probe,
      previousProxyUrl: 'socks5://old:1080',
    });

    expect(probe).toHaveBeenCalledWith('socks5://new:1080');
    expect(result.ok).toBe(true);
  });

  it('probes a newly filled proxy when previousProxyUrl is empty', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, exitIp: '1.2.3.4', reason: 'ok' });

    await runProxyPreflight('socks5://host:1080', { probe, previousProxyUrl: '' });

    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('ensureProxyReachableForSave', () => {
  it('passes through empty proxy without probing', async () => {
    const probe = vi.fn();
    const onFail = vi.fn();

    const res = await ensureProxyReachableForSave({ proxyUrl: '  ', onFail, probe });

    expect(res.passed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it('starts probing, blocks and calls onFail when the probe fails', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: false, exitIp: '', reason: 'timeout' });
    const onFail = vi.fn();
    const onProbeStart = vi.fn();

    const res = await ensureProxyReachableForSave({
      proxyUrl: 'http://host:1',
      onFail,
      onProbeStart,
      probe,
    });

    expect(onProbeStart).toHaveBeenCalledTimes(1);
    expect(res.passed).toBe(false);
    expect(onFail).toHaveBeenCalledWith('连通超时', expect.objectContaining({ reason: 'timeout' }));
  });

  it('passes and exposes the exit ip when the probe succeeds', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, exitIp: '9.9.9.9', reason: 'ok' });

    const res = await ensureProxyReachableForSave({
      proxyUrl: 'http://host:1',
      onFail: vi.fn(),
      probe,
    });

    expect(res.passed).toBe(true);
    expect(res.result?.exitIp).toBe('9.9.9.9');
  });

  it('passes without probing when the proxy is unchanged from previousProxyUrl', async () => {
    const probe = vi.fn();
    const onFail = vi.fn();

    const res = await ensureProxyReachableForSave({
      proxyUrl: 'http://host:1',
      previousProxyUrl: 'http://host:1',
      onFail,
      probe,
    });

    expect(res.passed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('ensureProxiesReachableForSave', () => {
  it('returns true immediately when every entry is empty', async () => {
    const probe = vi.fn();

    const passed = await ensureProxiesReachableForSave({
      proxyUrls: ['', '   '],
      onFail: vi.fn(),
      probe,
    });

    expect(passed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('skips empties and short-circuits on the first failing entry (original index)', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, exitIp: '1.1.1.1', reason: 'ok' })
      .mockResolvedValueOnce({ ok: false, exitIp: '', reason: 'dial_failed' });
    const onFail = vi.fn();

    const passed = await ensureProxiesReachableForSave({
      proxyUrls: ['', 'http://a:1', 'http://b:2', ''],
      onFail,
      probe,
    });

    expect(passed).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onFail).toHaveBeenCalledWith(
      '无法经该代理连通',
      2,
      expect.objectContaining({ reason: 'dial_failed' })
    );
  });

  it('returns true when all non-empty entries pass', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, exitIp: '1.1.1.1', reason: 'ok' });

    const passed = await ensureProxiesReachableForSave({
      proxyUrls: ['http://a:1'],
      onFail: vi.fn(),
      probe,
    });

    expect(passed).toBe(true);
  });

  it('only probes new/changed entries, skipping values already present in previousProxyUrls', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, exitIp: '1.1.1.1', reason: 'ok' });

    const passed = await ensureProxiesReachableForSave({
      proxyUrls: ['http://old:1', 'http://new:2'],
      previousProxyUrls: ['http://old:1'],
      onFail: vi.fn(),
      probe,
    });

    expect(passed).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('http://new:2');
  });

  it('skips probing entirely when every entry value is already persisted', async () => {
    const probe = vi.fn();

    const passed = await ensureProxiesReachableForSave({
      proxyUrls: ['http://a:1', 'http://b:2'],
      previousProxyUrls: ['http://a:1', 'http://b:2'],
      onFail: vi.fn(),
      probe,
    });

    expect(passed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
