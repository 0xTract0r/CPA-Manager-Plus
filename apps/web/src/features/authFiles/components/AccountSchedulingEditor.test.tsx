import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSchedulingEditor } from './AccountSchedulingEditor';
import { editorFixture } from '../model/schedulingEditor.test-fixture';
import type {
  AuthFileAccountScheduling,
  AuthFileAccountSchedulingPreviewResponse,
} from '@/types/authFile';
const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  save: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  translate: vi.fn((key: string) => key),
}));
vi.mock('@/services/api/authFiles', () => ({
  authFilesApi: { previewAccountScheduling: mocks.preview, updateAccountScheduling: mocks.save },
}));
vi.mock('@/stores', () => ({
  useNotificationStore: (
    selector: (s: {
      showNotification: typeof mocks.notify;
      showConfirmation: typeof mocks.confirm;
    }) => unknown
  ) => selector({ showNotification: mocks.notify, showConfirmation: mocks.confirm }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: 'zh-CN' } }),
}));
const response = (view: AuthFileAccountScheduling): AuthFileAccountSchedulingPreviewResponse => ({
  name: 'one.json',
  auth_index: 'one',
  preview: true,
  account_scheduling: structuredClone(view),
  current_account_scheduling: structuredClone(view),
});
let renderer: ReactTestRenderer | undefined;
const by = (id: string) => renderer!.root.findByProps({ 'data-testid': id });
function mount(view = editorFixture(), onStateChange = vi.fn()) {
  act(() => {
    renderer = create(
      <AccountSchedulingEditor
        fileName="one.json"
        authIndex="one"
        initialScheduling={view}
        onStateChange={onStateChange}
      />
    );
  });
  return onStateChange;
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(210);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.preview.mockReset();
  mocks.save.mockReset();
  mocks.notify.mockReset();
  mocks.confirm.mockReset();
  mocks.translate.mockClear();
  mocks.preview.mockResolvedValue(response(editorFixture()));
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('unified scheduling editor', () => {
  it.each(['input', 'clear-button'])(
    'confirms every cleared-anchor save via %s, preserving cancelled drafts',
    async (method) => {
      mount();
      await tick();
      act(() => {
        if (method === 'input') by('editor-anchor').props.onChange({ target: { value: '' } });
        else by('editor-clear-anchor').props.onClick();
      });
      await tick();
      act(() => by('apply-account-limits').props.onClick());
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(by('editor-anchor').props.value).toBe('');
      // 关闭确认框即取消：不写账号，也不撤销用户草稿。
      const cancelled = mocks.confirm.mock.lastCall![0];
      act(() => cancelled.onCancel?.());
      expect(mocks.save).not.toHaveBeenCalled();
      expect(by('editor-anchor').props.value).toBe('');
      act(() => by('apply-account-limits').props.onClick());
      const saved = editorFixture();
      saved.first_production_at = null;
      mocks.save.mockResolvedValue({ account_scheduling: saved });
      const accepted = mocks.confirm.mock.lastCall![0];
      await act(async () => {
        await Promise.all([accepted.onConfirm(), accepted.onConfirm()]);
      });
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
        name: 'one.json',
        auth_index: 'one',
        first_production_at: null,
      });
      expect(by('editor-anchor').props.value).toBe('');
    }
  );
  it('keeps authoritative profiles visible without dirty values and hides them for a pending candidate', async () => {
    mount();
    const waiting = () =>
      by('speed-profile-picker')
        .findAllByType('small')
        .some((node) => node.children.includes('auth_files.scheduling_editor.awaiting_preview'));
    expect(waiting()).toBe(false);
    expect(by('account-scheduling-editor').props['data-preview-ready']).toBe(false);
    await tick();
    act(() => by('speed-profile-high').props.onChange());
    expect(waiting()).toBe(true);
    await tick();
    const saved = editorFixture();
    saved.warmup_control!.speed_profile = 'high';
    mocks.save.mockResolvedValue({ account_scheduling: saved });
    await act(async () => by('apply-account-limits').props.onClick());
    expect(waiting()).toBe(false);
    expect(by('speed-profile-high').props.checked).toBe(true);
    expect(by('account-scheduling-editor').props['data-preview-ready']).toBe(false);
    act(() => by('speed-profile-low').props.onChange());
    expect(waiting()).toBe(true);
    act(() =>
      renderer!.root
        .findAll(
          (node) =>
            node.props.children === 'auth_files.scheduling_editor.discard' &&
            typeof node.props.onClick === 'function'
        )[0]
        .props.onClick()
    );
    expect(waiting()).toBe(false);
    expect(by('speed-profile-high').props.checked).toBe(true);
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it.each(['membership', 'unrelated-fixed'])(
    'shows actual expiry and restart only when the temporary layer is resent: %s',
    async (change) => {
      const view = editorFixture();
      for (const [name, value] of [
        ['rpm', 7],
        ['concurrency', 2],
      ] as const)
        Object.assign(view.limit_policy!.fields[name], {
          temporary: value,
          effective: value,
          source: 'temporary',
        });
      Object.assign(view.limit_policy!.fields.request_capacity, {
        fixed: 8,
        effective: 8,
        source: 'fixed',
      });
      Object.assign(view.limit_policy!, {
        temporary_status: 'active',
        temporary_issued_at: '2026-01-01T00:00:00Z',
        temporary_expires_at: '2026-01-01T00:30:00Z',
      });
      mocks.preview.mockResolvedValue(response(view));
      mount(view);
      await tick();
      act(() => {
        if (change === 'membership')
          by('editor-limit-mode-rpm').props.onChange({ target: { value: 'fixed' } });
        else by('editor-limit-request_capacity').props.onChange({ target: { value: '9' } });
      });
      await tick();
      const request = mocks.preview.mock.lastCall![0];
      const footer = by('editor-change-preview');
      const restart = footer
        .findAllByType('strong')
        .filter((node) => node.children.includes('auth_files.scheduling_editor.temporary_restart'));
      if (change === 'membership') {
        expect(request).toEqual({
          name: 'one.json',
          auth_index: 'one',
          limit_overrides: { rpm: 7 },
          temporary_limits: { duration_minutes: 30, overrides: { concurrency: 2 } },
        });
        expect(restart).toHaveLength(1);
        expect(
          footer
            .findAllByType('dd')
            .some((node) => node.children.includes('auth_files.scheduling_editor.original_expiry'))
        ).toBe(true);
        expect(mocks.translate).toHaveBeenCalledWith(
          'auth_files.scheduling_editor.original_expiry',
          {
            time: new Date(view.limit_policy!.temporary_expires_at!).toLocaleString('zh-CN'),
          }
        );
        expect(mocks.translate).toHaveBeenCalledWith(
          'auth_files.scheduling_editor.temporary_restart',
          { count: 30 }
        );
      } else {
        expect(request).toEqual({
          name: 'one.json',
          auth_index: 'one',
          limit_overrides: { request_capacity: 9 },
        });
        expect(restart).toHaveLength(0);
      }
      expect(mocks.save).not.toHaveBeenCalled();
    }
  );
  it('keeps the age-based selection stable when restoring a saved 30-day period from mature', async () => {
    const view = editorFixture();
    Object.assign(view.warmup_control!, {
      warmup_mode: 'mature',
      warmup_period_days: 30,
      effective_period_days: 30,
      manual_mature: true,
    });
    view.warmup!.mature = true;
    mocks.preview.mockResolvedValue(response(view));
    mount(view);
    await tick();
    act(() => by('warmup-mode-auto').props.onChange());
    await tick();
    expect(by('warmup-mode-auto').props.checked).toBe(true);
    expect(by('warmup-mode-days').props.checked).toBe(true);
    expect(mocks.preview.mock.lastCall![0]).toEqual({
      name: 'one.json',
      auth_index: 'one',
      warmup_mode: 'auto',
    });
    const saved = structuredClone(view);
    Object.assign(saved.warmup_control!, { warmup_mode: 'auto', manual_mature: false });
    saved.warmup!.mature = false;
    mocks.save.mockResolvedValue({ account_scheduling: saved });
    await act(async () => by('apply-account-limits').props.onClick());
    expect(by('warmup-mode-auto').props.checked).toBe(true);
    expect(by('warmup-mode-days').props.checked).toBe(true);
    expect(by('warmup-period-days').props.value).toBe('30');
  });
  it('defaults legacy-auto to unselected presets and makes only a no-op preview', async () => {
    const state = mount();
    await tick();
    expect(by('editor-source-preset').props.checked).toBe(true);
    expect(by('speed-profile-medium').props.checked).toBe(false);
    expect(mocks.preview.mock.calls[0][0]).toEqual({ name: 'one.json', auth_index: 'one' });
    expect(by('apply-account-limits').props.disabled).toBe(true);
    expect(state).toHaveBeenLastCalledWith({ dirty: false, saving: false });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('clears a preset without numerical changes in one save and resets success on new editing', async () => {
    const view = editorFixture();
    view.warmup_control!.speed_profile = 'high';
    mocks.preview.mockResolvedValue(response(view));
    mount(view);
    await tick();
    act(() => by('editor-source-custom').props.onChange());
    await tick();
    expect(mocks.preview.mock.lastCall![0]).toEqual({
      name: 'one.json',
      auth_index: 'one',
      speed_profile: null,
    });
    const saved = editorFixture();
    mocks.save.mockResolvedValue({ account_scheduling: saved });
    await act(async () => by('apply-account-limits').props.onClick());
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({
      name: 'one.json',
      auth_index: 'one',
      speed_profile: null,
    });
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(by('apply-account-limits').props.children).toContain('saved_button');
    act(() => by('speed-profile-low').props.onChange());
    expect(by('apply-account-limits').props.children).not.toContain('saved_button');
  });
  it.each(['fixed', 'temporary', 'rate'] as const)(
    'previews and saves one identical legal body for preset to custom %s',
    async (kind) => {
      const view = editorFixture();
      view.warmup_control!.speed_profile = 'high';
      mocks.preview.mockResolvedValue(response(view));
      mount(view);
      await tick();
      act(() => by('editor-source-custom').props.onChange());
      act(() => {
        if (kind === 'rate') by('editor-rate').props.onChange({ target: { value: '1.25' } });
        else by('editor-limit-mode-rpm').props.onChange({ target: { value: kind } });
      });
      if (kind !== 'rate')
        act(() => by('editor-limit-rpm').props.onChange({ target: { value: '7' } }));
      await tick();
      const request = mocks.preview.mock.lastCall![0];
      expect(request).toEqual({
        name: 'one.json',
        auth_index: 'one',
        ...(kind === 'rate'
          ? { rate_scale: 1.25 }
          : kind === 'fixed'
            ? { limit_overrides: { rpm: 7 } }
            : { temporary_limits: { duration_minutes: 15, overrides: { rpm: 7 } } }),
      });
      const saved = editorFixture();
      saved.warmup_control!.speed_profile = null;
      saved.warmup_control!.source = 'legacy';
      mocks.save.mockResolvedValue({ account_scheduling: saved });
      await act(async () => by('apply-account-limits').props.onClick());
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith(request);
      expect(by('speed-profile-high').props.checked).toBe(false);
    }
  );
  it.each(['0', '101'])(
    'links invalid custom RPM %s to its field and blocks preview/save',
    async (value) => {
      mount();
      await tick();
      act(() => by('editor-source-custom').props.onChange());
      act(() => by('editor-limit-mode-rpm').props.onChange({ target: { value: 'fixed' } }));
      const calls = mocks.preview.mock.calls.length;
      act(() => by('editor-limit-rpm').props.onChange({ target: { value } }));
      await tick();
      const input = by('editor-limit-rpm');
      expect(input.props['aria-invalid']).toBe(true);
      expect(
        renderer!.root.findByProps({ id: input.props['aria-describedby'] }).children
      ).toContain('auth_files.scheduling_editor.integer_range');
      expect(mocks.preview).toHaveBeenCalledTimes(calls);
      expect(by('apply-account-limits').props.disabled).toBe(true);
    }
  );
  it('links invalid maintenance values and period to the corresponding input', async () => {
    mount();
    await tick();
    for (const [id, value] of [
      ['editor-rate', '0'],
      ['editor-anchor', '2999-01-01T00:00'],
    ]) {
      act(() => by(id).props.onChange({ target: { value } }));
      expect(by(id).props['aria-invalid']).toBe(true);
      expect(renderer!.root.findByProps({ id: by(id).props['aria-describedby'] })).toBeTruthy();
    }
    act(() => by('warmup-mode-days').props.onChange());
    act(() => by('warmup-period-days').props.onChange({ target: { value: '0' } }));
    expect(by('warmup-period-days').props['aria-invalid']).toBe(true);
    expect(
      renderer!.root.findByProps({ id: by('warmup-period-days').props['aria-describedby'] })
    ).toBeTruthy();
    expect(by('apply-account-limits').props.disabled).toBe(true);
  });
  it('does not submit invalid periods or expose an old candidate', async () => {
    mount();
    await tick();
    const calls = mocks.preview.mock.calls.length;
    act(() => by('warmup-mode-days').props.onChange());
    act(() => by('warmup-period-days').props.onChange({ target: { value: '0' } }));
    await tick();
    expect(mocks.preview).toHaveBeenCalledTimes(calls);
    expect(by('apply-account-limits').props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain('invalid_period');
  });
  it('drops stale preview responses and aborts the previous request', async () => {
    let resolveFirst!: (v: AuthFileAccountSchedulingPreviewResponse) => void;
    let resolveSecond!: (v: AuthFileAccountSchedulingPreviewResponse) => void;
    mocks.preview
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );
    mount();
    await tick();
    act(() => by('speed-profile-high').props.onChange());
    await tick();
    const later = response(editorFixture());
    later.account_scheduling.effective_limits!.rpm = 12;
    await act(async () => resolveSecond(later));
    const before = JSON.stringify(renderer!.toJSON());
    const stale = response(editorFixture());
    stale.account_scheduling.effective_limits!.rpm = 99;
    await act(async () => resolveFirst(stale));
    expect(JSON.stringify(renderer!.toJSON())).toBe(before);
    expect(mocks.preview.mock.calls[0][1].aborted).toBe(true);
  });
  it('requires preview support rather than presenting saved profiles as a candidate', async () => {
    mocks.preview.mockRejectedValue({ status: 404 });
    mount();
    await tick();
    act(() => by('speed-profile-high').props.onChange());
    await tick();
    expect(by('apply-account-limits').props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain('preview_unsupported');
  });
  it('keeps failed-save draft and has only one primary save button', async () => {
    mount();
    await tick();
    act(() => by('speed-profile-high').props.onChange());
    await tick();
    mocks.save.mockRejectedValue(new Error('failed'));
    await act(async () => by('apply-account-limits').props.onClick());
    expect(by('speed-profile-high').props.checked).toBe(true);
    expect(
      renderer!.root
        .findAllByProps({ 'data-testid': 'apply-account-limits' })
        .filter((node) => node.type === 'button')
    ).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain('save_error');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('shows mature server limits and disables only warm-up custom fields', async () => {
    const view = editorFixture();
    view.warmup!.mature = true;
    Object.assign(view.effective_limits!, {
      rpm: 19,
      concurrency: 3,
      daily_budget: 0,
      pacing_applies: false,
    });
    view.warmup_control!.speed_profile = 'medium';
    mocks.preview.mockResolvedValue(response(view));
    mount(view);
    expect(by('editor-mature-policy')).toBeTruthy();
    await tick();
    expect(by('editor-mature-policy')).toBeTruthy();
    expect(renderer!.root.findAllByProps({ 'data-testid': 'speed-profile-low' })).toHaveLength(0);
    act(() => by('editor-source-custom').props.onChange());
    await tick();
    expect(by('editor-limit-mode-request_capacity').props.disabled).toBe(true);
    expect(by('editor-limit-mode-rpm').props.disabled).toBe(false);
  });
});
