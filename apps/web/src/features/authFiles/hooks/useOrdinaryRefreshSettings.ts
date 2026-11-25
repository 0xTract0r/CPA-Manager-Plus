import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ordinaryAccountSettingsApi,
  OrdinarySettingsUnsupported,
  type OrdinarySettingsTarget,
} from '@/services/api/ordinaryAccountSettings';
import type { ApiClientRequestScope } from '@/services/api/client';
import type { OrdinaryRefreshSettings } from '@/types/authFile';
type Options = {
  target: OrdinarySettingsTarget;
  connectionKey: string;
  requestScope?: ApiClientRequestScope;
  enabled: boolean;
  locked: boolean;
  onSaved?: () => void;
};
type State = {
  generation: number;
  status: 'loading' | 'ready' | 'unsupported' | 'error';
  saved?: OrdinaryRefreshSettings;
  saving: boolean;
  error: string;
  needsReload: boolean;
};
export function useOrdinaryRefreshSettings(options: Options) {
  const { target, connectionKey, requestScope, enabled, locked, onSaved } = options;
  const identity = JSON.stringify([connectionKey, target.name, target.authIndex, enabled]);
  const current = useRef({
    identity,
    base: requestScope?.apiBase,
    key: requestScope?.managementKey,
    generation: 0,
  });
  if (
    current.current.identity !== identity ||
    current.current.base !== requestScope?.apiBase ||
    current.current.key !== requestScope?.managementKey
  ) {
    current.current = {
      identity,
      base: requestScope?.apiBase,
      key: requestScope?.managementKey,
      generation: current.current.generation + 1,
    };
  }
  const generation = current.current.generation;
  const operation = useRef(0);
  const busy = useRef(false);
  const [value, setValue] = useState<State | null>(null);
  const state = value?.generation === generation ? value : null;
  const snapshot = useRef(state);
  snapshot.current = state;
  const load = useCallback(async () => {
    if (!enabled || !requestScope || !target.name || !target.authIndex) return;
    const gen = current.current.generation;
    const op = ++operation.current;
    const valid = () => gen === current.current.generation && op === operation.current;
    const selected = { ...target };
    const scope = { ...requestScope };
    setValue({
      generation: gen,
      status: 'loading',
      saving: false,
      error: '',
      needsReload: false,
    });
    try {
      const saved = await ordinaryAccountSettingsApi.get(selected, scope);
      if (!valid()) return;
      if (saved.auth_index !== selected.authIndex) throw new Error('selected credential changed');
      setValue({
        generation: gen,
        status: 'ready',
        saved,
        saving: false,
        error: '',
        needsReload: false,
      });
    } catch (error) {
      if (!valid()) return;
      const e = error as { status?: number; data?: { error?: unknown } };
      const unsupported =
        error instanceof OrdinarySettingsUnsupported ||
        e.status === 405 ||
        e.status === 501 ||
        (e.status === 404 && !e.data?.error);
      setValue({
        generation: gen,
        status: unsupported ? 'unsupported' : 'error',
        saving: false,
        error: unsupported ? '' : 'accounts.refresh_load_error',
        needsReload: true,
      });
    }
  }, [identity, requestScope?.apiBase, requestScope?.managementKey]);
  useEffect(() => {
    busy.current = false;
    void load();
    return () => {
      operation.current++;
    };
  }, [load]);
  const update = async (desired: boolean) => {
    const selectedState = snapshot.current;
    if (
      busy.current ||
      locked ||
      !enabled ||
      !requestScope ||
      !selectedState?.saved ||
      selectedState.status !== 'ready' ||
      selectedState.needsReload ||
      desired === selectedState.saved.refresh_enabled
    )
      return;
    const gen = generation;
    const op = ++operation.current;
    const selected = { ...target };
    const scope = { ...requestScope };
    const valid = () => gen === current.current.generation && op === operation.current;
    busy.current = true;
    setValue({ ...selectedState, saving: true, error: '' });
    let committed = false;
    try {
      const patched = await ordinaryAccountSettingsApi.patch(
        selected,
        selectedState.saved.revision,
        desired,
        scope
      );
      committed = true;
      if (!valid()) return;
      if (patched.auth_index !== selected.authIndex) throw new Error('selected credential changed');
      const saved = await ordinaryAccountSettingsApi.get(selected, scope);
      if (!valid()) return;
      if (saved.auth_index !== selected.authIndex || saved.refresh_enabled !== desired)
        throw new Error('settings readback mismatch');
      setValue({
        generation: gen,
        status: 'ready',
        saved,
        saving: false,
        error: '',
        needsReload: false,
      });
      onSaved?.();
    } catch {
      if (valid())
        setValue({
          ...selectedState,
          saving: false,
          error: committed ? 'accounts.refresh_readback_error' : 'accounts.refresh_save_error',
          needsReload: true,
        });
    } finally {
      if (valid()) busy.current = false;
    }
  };
  return {
    state,
    saving: Boolean(state?.saving),
    locked,
    reload: load,
    update,
  };
}
export type OrdinaryRefreshEditor = ReturnType<typeof useOrdinaryRefreshSettings>;
