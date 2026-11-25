import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, it, expect, vi } from 'vitest';
import { useOrdinaryRefreshSettings } from './useOrdinaryRefreshSettings';
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/services/api/ordinaryAccountSettings', () => ({
  ordinaryAccountSettingsApi: api,
  OrdinarySettingsUnsupported: class extends Error {},
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const view = (id = 'a', revision = 'r1', enabled = true) => ({
  auth_index: id,
  revision,
  refresh_enabled: enabled,
  editable_fields: ['refresh_enabled'],
});
const options = (id = 'a') => ({
  target: { name: id + '.json', authIndex: id },
  connectionKey: 'connection-' + id,
  requestScope: {
    apiBase: 'http://' + id + '.invalid',
    managementKey: 'synthetic',
  },
  enabled: true,
  locked: false,
});
let result: ReturnType<typeof useOrdinaryRefreshSettings>;
let renderer: ReactTestRenderer | undefined;
function Probe({ settings }: { settings: ReturnType<typeof options> }) {
  result = useOrdinaryRefreshSettings(settings);
  return (
    <ToggleSwitch
      checked={Boolean(result.state?.saved?.refresh_enabled)}
      disabled={
        result.locked ||
        result.saving ||
        result.state?.status !== 'ready' ||
        result.state?.needsReload
      }
      onChange={(enabled) => {
        void result.update(enabled);
      }}
    />
  );
}
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.resetAllMocks();
});
async function mount(settings = options()) {
  await act(async () => {
    renderer = create(<Probe settings={settings} />);
  });
}
it('one toggle immediately PATCHes exact revision and verifies GET before changing checked value', async () => {
  api.get.mockResolvedValueOnce(view()).mockResolvedValueOnce(view('a', 'r2', false));
  api.patch.mockResolvedValue(view('a', 'r2', false));
  await mount();
  await act(async () =>
    renderer?.root.findByType('input').props.onChange({ target: { checked: false } })
  );
  expect(api.patch).toHaveBeenCalledWith(
    { name: 'a.json', authIndex: 'a' },
    'r1',
    false,
    options().requestScope
  );
  expect(renderer?.root.findByType('input').props.checked).toBe(false);
  expect(result.state?.saved?.revision).toBe('r2');
});
it('failure keeps original value, exposes error, and reload permits retry with current revision', async () => {
  api.get
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(view('a', 'r2'))
    .mockResolvedValueOnce(view('a', 'r3', false));
  api.patch.mockRejectedValueOnce({ status: 412 }).mockResolvedValueOnce(view('a', 'r3', false));
  await mount();
  await act(async () => result.update(false));
  expect(result.state?.saved?.refresh_enabled).toBe(true);
  expect(result.state?.error).toBe('accounts.refresh_save_error');
  expect(result.state?.needsReload).toBe(true);
  await act(async () => result.update(false));
  expect(api.patch).toHaveBeenCalledTimes(1);
  await act(async () => result.reload());
  await act(async () => result.update(false));
  expect(api.patch).toHaveBeenLastCalledWith(options().target, 'r2', false, options().requestScope);
  expect(result.state?.saved?.refresh_enabled).toBe(false);
});
it('blocks duplicate interaction while save is pending', async () => {
  let resolve!: (v: ReturnType<typeof view>) => void;
  api.get.mockResolvedValueOnce(view()).mockResolvedValueOnce(view('a', 'r2', false));
  api.patch.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    })
  );
  await mount();
  let saving: Promise<void> | undefined;
  await act(async () => {
    saving = result.update(false);
  });
  expect(renderer?.root.findByType('input').props.checked).toBe(true);
  expect(renderer?.root.findByType('input').props.disabled).toBe(true);
  await act(async () => result.update(false));
  expect(api.patch).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(view('a', 'r2', false));
    await saving;
  });
});
it('existing form draft disables mutation', async () => {
  api.get.mockResolvedValue(view());
  await mount({ ...options(), locked: true });
  expect(renderer?.root.findByType('input').props.disabled).toBe(true);
  await act(async () => result.update(false));
  expect(api.patch).not.toHaveBeenCalled();
});
it('unsupported upstream leaves original form independent', async () => {
  api.get.mockRejectedValue({ status: 404, data: '404 page not found' });
  await mount();
  expect(result.state?.status).toBe('unsupported');
  await act(async () => result.update(false));
  expect(api.patch).not.toHaveBeenCalled();
});
it('missing credential is a load error, not unsupported', async () => {
  api.get.mockRejectedValue({
    status: 404,
    data: { error: 'auth file not found' },
  });
  await mount();
  expect(result.state?.status).toBe('error');
  expect(result.state?.error).toBe('accounts.refresh_load_error');
});
it('rejects mismatched identity', async () => {
  api.get.mockResolvedValue(view('foreign'));
  await mount();
  await act(async () => result.update(false));
  expect(result.state?.status).toBe('error');
  expect(api.patch).not.toHaveBeenCalled();
});
it('readback mismatch keeps old value and never announces success', async () => {
  const saved = vi.fn();
  api.get.mockResolvedValue(view());
  api.patch.mockResolvedValue(view('a', 'r2', false));
  await mount({ ...options(), onSaved: saved } as ReturnType<typeof options>);
  await act(async () => result.update(false));
  expect(result.state?.saved?.refresh_enabled).toBe(true);
  expect(result.state?.error).toBe('accounts.refresh_readback_error');
  expect(saved).not.toHaveBeenCalled();
});
it('late PATCH cannot change a newly selected credential', async () => {
  let resolve!: (v: ReturnType<typeof view>) => void;
  api.get.mockResolvedValueOnce(view()).mockResolvedValueOnce(view('b', 'b-current'));
  api.patch.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    })
  );
  await mount();
  let saving: Promise<void> | undefined;
  await act(async () => {
    saving = result.update(false);
  });
  await act(async () => renderer?.update(<Probe settings={options('b')} />));
  await act(async () => {
    resolve(view('a', 'r2', false));
    await saving;
  });
  expect(result.state?.saved?.auth_index).toBe('b');
  expect(result.state?.saved?.revision).toBe('b-current');
  expect(api.get).toHaveBeenCalledTimes(2);
});
