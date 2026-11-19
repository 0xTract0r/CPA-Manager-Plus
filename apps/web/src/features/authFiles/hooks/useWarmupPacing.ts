import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthFileItem } from '@/types';
import { authFilesApi } from '@/services/api/authFiles';
import { getAuthFileSelectionKey, getAuthFilePatchTarget } from '../model/authFilesPageModel';
import { pacingNumber, pacingStatus } from '../model/warmupPacing';
import { isAuthFileReauthRequired } from '../constants';

export function pacingAccountState(file: AuthFileItem | null) {
  if (!file) return 'missing';
  if (file.disabled || file.status === 'disabled') return 'disabled';
  if (
    isAuthFileReauthRequired(file) ||
    file.availability_reason === 'reauth_required' ||
    file.status === 'reauth_required'
  )
    return 'reauth';
  if (file.unavailable || ['error', 'unavailable'].includes(String(file.status)))
    return 'unavailable';
  return 'available';
}

export function useWarmupPacing(file: AuthFileItem | null, open: boolean) {
  const identity = file ? getAuthFileSelectionKey(file) : '';
  const base = useRef(file);
  base.current = file;
  const [state, setState] = useState<{
    identity: string;
    file: AuthFileItem | null;
    received: number;
    age: number;
    failed: boolean;
    missing: boolean;
  }>({ identity: '', file: null, received: 0, age: Infinity, failed: false, missing: false });
  const [now, setNow] = useState(() => performance.now());
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!open || !identity || typeof document === 'undefined') return;
    let active = true;
    let controller: AbortController | null = null;
    let zeroRefreshed = false;
    const target = getAuthFilePatchTarget(base.current!);
    const index = target.authIndex === undefined ? '' : String(target.authIndex).trim();
    const fetchSnapshot = async () => {
      if (!active || document.hidden || controller) return;
      if (!index) {
        setState({
          identity,
          file: base.current,
          received: performance.now(),
          age: Infinity,
          failed: true,
          missing: false,
        });
        return;
      }
      const request = new AbortController();
      controller = request;
      try {
        const response = await authFilesApi.getWarmupPacing(target.name, index, request.signal);
        if (!active || request.signal.aborted) return;
        if (response.name !== target.name || String(response.auth_index) !== index)
          throw new Error('identity mismatch');
        const observed = Date.parse(
          response.account_scheduling.warmup_traffic_pacing?.observed_at || ''
        );
        const received = performance.now();
        setState({
          identity,
          file: { ...base.current!, ...response, authIndex: index },
          received,
          age: Number.isFinite(observed) ? Math.max(0, (Date.now() - observed) / 1000) : Infinity,
          failed: false,
          missing: false,
        });
        setNow(received);
      } catch (error) {
        if (!active || request.signal.aborted) return;
        const status =
          (error as { status?: number; response?: { status?: number } }).status ??
          (error as { response?: { status?: number } }).response?.status;
        setState((previous) => ({
          ...(previous.identity === identity
            ? previous
            : { identity, file: base.current, received: performance.now(), age: Infinity }),
          failed: true,
          missing: status === 404,
        }));
      } finally {
        if (controller === request) controller = null;
      }
    };
    refreshRef.current = () => void fetchSnapshot();
    const visibility = () => {
      if (document.hidden) {
        controller?.abort();
        controller = null;
      } else {
        setNow(performance.now());
        void fetchSnapshot();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    void fetchSnapshot();
    const poll = window.setInterval(() => void fetchSnapshot(), 5000);
    const tick = window.setInterval(() => {
      if (!document.hidden) setNow(performance.now());
    }, 1000);
    const expiry = window.setInterval(() => {
      // 零点重验由下方单调状态计算触发；每次打开最多触发一次，之后5秒轮询校准。
      if (zeroRefreshed) return;
      const eta = etaRef.current;
      if (eta === 0) {
        zeroRefreshed = true;
        void fetchSnapshot();
      }
    }, 1000);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(poll);
      clearInterval(tick);
      clearInterval(expiry);
      document.removeEventListener('visibilitychange', visibility);
      refreshRef.current = () => {};
    };
  }, [identity, open]);
  const current = state.identity === identity ? state : null;
  const liveFile = current?.missing ? null : (current?.file ?? file);
  const age = current ? current.age + Math.max(0, now - current.received) / 1000 : Infinity;
  const stale = age >= 15;
  const snapshot = liveFile?.account_scheduling?.warmup_traffic_pacing;
  const baseEta = pacingNumber(snapshot?.admission_balance_eta_seconds);
  const eta =
    open &&
    !stale &&
    !current?.failed &&
    pacingAccountState(liveFile) === 'available' &&
    pacingStatus(snapshot) === 'active' &&
    baseEta !== null
      ? Math.max(0, Math.ceil(baseEta - age))
      : null;
  const etaRef = useRef<number | null>(eta);
  etaRef.current = eta;
  return {
    file: liveFile,
    age,
    stale,
    failed: current?.failed ?? false,
    loaded: Boolean(current),
    eta,
    refresh,
  };
}
