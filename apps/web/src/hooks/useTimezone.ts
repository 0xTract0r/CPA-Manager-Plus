import { useCallback, useSyncExternalStore } from 'react';

import {
  DEFAULT_TIME_ZONE,
  getTimeZone,
  getTimeZoneOffsetLabel,
  resetTimeZone as resetGlobalTimeZone,
  setTimeZone as setGlobalTimeZone,
  subscribeTimeZone,
} from '@/utils/timezone';

export interface UseTimezoneResult {
  /** 当前全局展示时区（IANA 名，如 `Asia/Shanghai`）。 */
  timeZone: string;
  /** 当前时区的 UTC 偏移标注，如 `UTC+8`。 */
  offsetLabel: string;
  /** 是否仍是默认时区（UTC+8）。TZ2 的设置 UI 据此显示「已改」状态。 */
  isDefault: boolean;
  /** 设置全局时区并持久化，触发所有订阅组件重渲染。 */
  setTimeZone: (tz: string) => void;
  /** 恢复默认时区（UTC+8）并清除持久化覆盖。 */
  resetTimeZone: () => void;
}

/**
 * 订阅全局时区配置的 React hook。
 *
 * 组件调用它即可在时区被切换（TZ2 的设置 UI）时自动重渲染。纯格式化函数
 * （`utils/datetime` 的 `formatInTimezone` 等）在渲染期同步读取同一个全局配置，
 * 因此组件只要订阅本 hook 就能保证展示时间跟随全局时区更新。
 *
 * 本任务默认时区固定 UTC+8，不改变用户当前所见；hook 主要为 TZ2 预留接线。
 */
export function useTimezone(): UseTimezoneResult {
  const timeZone = useSyncExternalStore(subscribeTimeZone, getTimeZone, getTimeZone);
  const setTimeZone = useCallback((tz: string) => setGlobalTimeZone(tz), []);
  const resetTimeZone = useCallback(() => resetGlobalTimeZone(), []);

  return {
    timeZone,
    offsetLabel: getTimeZoneOffsetLabel(timeZone),
    isDefault: timeZone === DEFAULT_TIME_ZONE,
    setTimeZone,
    resetTimeZone,
  };
}
