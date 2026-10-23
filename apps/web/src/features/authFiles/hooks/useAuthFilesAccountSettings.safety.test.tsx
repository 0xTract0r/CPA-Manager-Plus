import { act, createElement, createRef, useImperativeHandle } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import {
  useAuthFilesAccountSettings,
  type UseAuthFilesAccountSettingsResult,
} from './useAuthFilesAccountSettings';

const mocks = vi.hoisted(() => ({
  api: {
    getAccountSettings: vi.fn(),
    downloadText: vi.fn(),
    lookup: vi.fn(),
    list: vi.fn(),
    updateAccountSettings: vi.fn(),
    patchFieldsWithPluginSourceFallback: vi.fn(),
    saveTextVerified: vi.fn(),
  },
  notify: vi.fn(),
  confirm: vi.fn(),
  refresh: vi.fn(),
  keyStats: vi.fn(),
  probe: vi.fn(),
  scope: { apiBase: 'http://a.local', managementKey: 'a-key' },
  disabled: false,
}));
vi.mock('@/services/api', () => ({ authFilesApi: mocks.api }));
vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: unknown) => unknown) =>
    selector({ showNotification: mocks.notify, showConfirmation: mocks.confirm }),
}));
vi.mock('@/services/api/proxyProbe', () => ({ probeProxyConnectivity: mocks.probe }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
const file: AuthFileItem = {
  name: 'legacy.json',
  id: 'runtime-1',
  auth_index: 'index-1',
  type: 'claude',
};
const raw = ' {"type":"claude","prefix":"old","priority":0}\n';
const proxy = 'socks5://synthetic.example:1080';
const scopeA = { apiBase: 'http://a.local', managementKey: 'a-key' };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const renderers: ReactTestRenderer[] = [];
function mount() {
  const ref = createRef<UseAuthFilesAccountSettingsResult>();
  function Harness() {
    const value = useAuthFilesAccountSettings({
      requestScope: mocks.scope,
      disableControls: mocks.disabled,
      loadFiles: mocks.refresh,
      loadKeyStats: mocks.keyStats,
      accounts: [file],
    });
    useImperativeHandle(ref, () => value, [value]);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(Harness));
  });
  renderers.push(renderer);
  return {
    current: () => ref.current!,
    rerender: () => act(() => renderer.update(createElement(Harness))),
  };
}
async function open(hook: ReturnType<typeof mount>, target = file) {
  await act(async () => hook.current().openAccountSettingsEditor(target));
}
function change(
  hook: ReturnType<typeof mount>,
  field: 'note' | 'prefix' | 'rawJsonText' | 'proxyUrl',
  value: string
) {
  act(() => hook.current().handleAccountSettingsChange(field, value));
}
async function save(hook: ReturnType<typeof mount>) {
  await act(async () => hook.current().handleAccountSettingsSave());
}
beforeEach(() => {
  Object.values(mocks.api).forEach((mock) => mock.mockReset());
  mocks.notify.mockReset();
  mocks.confirm.mockReset();
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.keyStats.mockReset().mockResolvedValue(undefined);
  mocks.probe.mockReset().mockResolvedValue({ ok: true, exitIp: '192.0.2.1', reason: 'ok' });
  mocks.scope = { ...scopeA };
  mocks.disabled = false;
  mocks.api.getAccountSettings.mockResolvedValue({ proxy_url: proxy, note: 'old' });
  mocks.api.downloadText.mockResolvedValue(raw);
  mocks.api.lookup.mockResolvedValue([file]);
  mocks.api.list.mockResolvedValue({ files: [file] });
});
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
});

describe('legacy account editor verified writes', () => {
  it('keeps a runtime/index verified legacy account without optional account metadata writable', async () => {
    const h = mount();
    await open(h);
    change(h, 'note', 'new');
    await save(h);
    expect(mocks.api.updateAccountSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'legacy.json', note: 'new' }),
      { name: 'legacy.json', runtimeId: 'runtime-1', authIndex: 'index-1', provider: 'claude' },
      scopeA
    );
    expect(mocks.api.patchFieldsWithPluginSourceFallback).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it('routes fields alone through verified fallback without replaying account settings', async () => {
    const h = mount();
    await open(h);
    change(h, 'prefix', 'new');
    await save(h);
    expect(mocks.api.updateAccountSettings).not.toHaveBeenCalled();
    expect(mocks.api.patchFieldsWithPluginSourceFallback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runtimeId: 'runtime-1', authIndex: 'index-1' }),
      { prefix: 'new' },
      [expect.objectContaining({ runtimeId: 'runtime-1' })],
      scopeA,
      expect.any(Function)
    );
  });
  it('rejects a name-only identity before lookup or any write', async () => {
    const h = mount();
    await open(h, { name: 'legacy.json', type: 'claude' });
    change(h, 'note', 'new');
    await save(h);
    expect(mocks.api.lookup).not.toHaveBeenCalled();
    expect(mocks.api.updateAccountSettings).not.toHaveBeenCalled();
    expect(mocks.api.saveTextVerified).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'replaced-runtime' },
    { account_id: 'replacement-account' },
    { provider: 'codex', type: 'codex' },
  ])('rejects identity replacement %j with the same name/index', async (replacement) => {
    const h = mount();
    const original = { ...file, account_id: 'original-account' };
    await open(h, original);
    change(h, 'note', 'new');
    mocks.api.lookup.mockResolvedValue([{ ...original, ...replacement }]);
    await save(h);
    expect(mocks.api.updateAccountSettings).not.toHaveBeenCalled();
    expect(mocks.api.patchFieldsWithPluginSourceFallback).not.toHaveBeenCalled();
  });
  it('does not hydrate a closed or switched editor from a late download', async () => {
    const pending = deferred<string>();
    mocks.api.downloadText.mockReturnValue(pending.promise);
    const h = mount();
    let loading!: Promise<void>;
    act(() => {
      loading = h.current().openAccountSettingsEditor(file);
    });
    act(() => h.current().closeAccountSettingsEditor());
    mocks.scope = { apiBase: 'http://b.local', managementKey: 'b-key' };
    h.rerender();
    await act(async () => {
      pending.resolve(raw);
      await loading;
    });
    expect(h.current().accountSettingsEditor).toBeNull();
    expect(mocks.api.downloadText).toHaveBeenCalledWith('legacy.json', scopeA);
  });
  it('does not write after a scoped proxy probe finishes on a different connection', async () => {
    const pending = deferred<{ ok: boolean; exitIp: string; reason: 'ok' }>();
    mocks.probe.mockReturnValue(pending.promise);
    const h = mount();
    await open(h);
    change(h, 'proxyUrl', 'socks5://new.example:1080');
    let saving!: Promise<void>;
    await act(async () => {
      saving = h.current().handleAccountSettingsSave();
      await Promise.resolve();
    });
    mocks.scope = { apiBase: 'http://b.local', managementKey: 'b-key' };
    h.rerender();
    await act(async () => {
      pending.resolve({ ok: true, exitIp: '192.0.2.1', reason: 'ok' });
      await saving;
    });
    expect(mocks.probe).toHaveBeenCalledWith('socks5://new.example:1080', scopeA);
    expect(mocks.api.updateAccountSettings).not.toHaveBeenCalled();
    expect(h.current().accountSettingsEditor).toBeNull();
  });
  it('stops the second write when the first write finishes after closing and reopening', async () => {
    const pending = deferred<undefined>();
    mocks.api.updateAccountSettings.mockReturnValue(pending.promise);
    const h = mount();
    await open(h);
    change(h, 'note', 'new');
    change(h, 'prefix', 'new');
    let saving!: Promise<void>;
    await act(async () => {
      saving = h.current().handleAccountSettingsSave();
      await Promise.resolve();
    });
    act(() => h.current().closeAccountSettingsEditor());
    await open(h);
    await act(async () => {
      pending.resolve(undefined);
      await saving;
    });
    expect(mocks.api.patchFieldsWithPluginSourceFallback).not.toHaveBeenCalled();
    expect(h.current().accountSettingsEditor?.note).toBe('old');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it('preserves the failed fields draft and does not replay a successful settings write', async () => {
    mocks.api.patchFieldsWithPluginSourceFallback.mockRejectedValueOnce(new Error('fields failed'));
    const h = mount();
    await open(h);
    change(h, 'note', 'new');
    change(h, 'prefix', 'new');
    await save(h);
    expect(h.current().accountSettingsEditor?.prefix).toBe('new');
    expect(h.current().accountSettingsEditor?.originalSerializedRequest).toContain('new');
    await save(h);
    expect(mocks.api.updateAccountSettings).toHaveBeenCalledTimes(1);
    expect(mocks.api.patchFieldsWithPluginSourceFallback).toHaveBeenCalledTimes(2);
  });
  it('rejects a stale raw confirmation and submits the original bytes once for a current confirmation', async () => {
    const pending = deferred<undefined>();
    mocks.api.saveTextVerified.mockReturnValue(pending.promise);
    const h = mount();
    await open(h);
    change(h, 'rawJsonText', '{"type":"claude","prefix":"new"}');
    await save(h);
    const stale = mocks.confirm.mock.calls[0][0];
    change(h, 'rawJsonText', '{"type":"claude","prefix":"latest"}');
    await act(async () => stale.onConfirm());
    expect(mocks.api.saveTextVerified).not.toHaveBeenCalled();
    await save(h);
    const current = mocks.confirm.mock.calls[1][0];
    let first!: Promise<void>;
    await act(async () => {
      first = current.onConfirm();
      await Promise.resolve();
      await current.onConfirm();
    });
    expect(mocks.api.saveTextVerified).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runtimeId: 'runtime-1' }),
      '{"type":"claude","prefix":"latest"}',
      [expect.objectContaining({ runtimeId: 'runtime-1' })],
      raw,
      scopeA,
      expect.any(Function)
    );
    await act(async () => {
      pending.resolve(undefined);
      await first;
    });
  });
  it('revalidates identity after a raw confirmation before calling overwrite', async () => {
    const h = mount();
    await open(h);
    change(h, 'rawJsonText', '{"type":"claude","prefix":"new"}');
    await save(h);
    mocks.api.lookup.mockResolvedValue([{ ...file, id: 'replacement' }]);
    await act(async () => mocks.confirm.mock.calls[0][0].onConfirm());
    expect(mocks.api.saveTextVerified).not.toHaveBeenCalled();
  });
  it('reports refresh failure after a successful write without pretending the write failed', async () => {
    mocks.refresh.mockRejectedValue(new Error('refresh failed'));
    const h = mount();
    await open(h);
    change(h, 'note', 'new');
    await save(h);
    expect(mocks.api.updateAccountSettings).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith('保存成功，但刷新失败，请手动刷新。', 'warning');
    expect(h.current().accountSettingsEditor?.saving).toBe(false);
    expect(h.current().accountSettingsDirty).toBe(false);
  });
});
