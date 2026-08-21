/**
 * 全局时区配置 —— 前端「面向用户」时间展示的唯一时区真源。
 *
 * 目标：把散落各处、部分硬编码 UTC+8、部分跟随浏览器本地时区的时间渲染，统一到
 * 同一个全局配置驱动。默认 UTC+8（Asia/Shanghai），可被持久化覆盖
 * （localStorage key `cpamp.timezone`），为后续把时区开关放进账号设置（TZ2）预留接口。
 *
 * 设计：本模块是纯 TS store（无 React 依赖），供纯格式化函数在渲染期同步读取
 * （见 `utils/datetime`）；React 组件用 `useTimezone()`（见 `hooks/useTimezone`）
 * 订阅变更，在时区被切换时触发重渲染。
 *
 * 边界：本模块只负责「展示时区」。发往后端的查询参数（since 等 `toISOString()`）、
 * 导出文件名、导出数据时间戳、内部状态比较仍然保持 UTC / ISO，不要改用本模块。
 */

/** 默认展示时区。用户运行环境固定 UTC+8（Asia/Shanghai）。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** localStorage 持久化 key。TZ2 的设置 UI 写这个 key。 */
export const TIME_ZONE_STORAGE_KEY = 'cpamp.timezone';

/**
 * 校验 IANA 时区名是否被当前运行时支持。非法/不支持时返回 false，
 * 调用方据此回退到默认时区，避免 `Intl.DateTimeFormat` 抛 RangeError。
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    // 传入非法时区时构造会抛 RangeError。
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 从 localStorage 读取持久化时区；缺失/非法/不可用时回退默认（UTC+8）。 */
function readPersistedTimeZone(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_TIME_ZONE;
    const raw = localStorage.getItem(TIME_ZONE_STORAGE_KEY)?.trim();
    if (raw && isValidTimeZone(raw)) return raw;
  } catch {
    // localStorage 不可用（隐私模式 / SSR / 权限受限）→ 用默认。
  }
  return DEFAULT_TIME_ZONE;
}

let currentTimeZone = readPersistedTimeZone();

type Listener = (tz: string) => void;
const listeners = new Set<Listener>();

/** 读取当前全局展示时区。 */
export function getTimeZone(): string {
  return currentTimeZone;
}

/**
 * 解析传入时区，缺省（未传 / 空 / 非法）时取当前全局配置。
 * 纯格式化函数用它把可选 `tz` 参数归一到一个有效 IANA 时区。
 */
export function resolveTimeZone(tz?: string | null): string {
  const candidate = tz?.trim();
  if (candidate && isValidTimeZone(candidate)) return candidate;
  return currentTimeZone;
}

/**
 * 设置全局展示时区并持久化，通知所有订阅者（触发组件重渲染）。
 * 供 TZ2 的设置 UI 调用；传入非法时区回退默认（UTC+8）。
 */
export function setTimeZone(tz: string): void {
  const next = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  if (next === currentTimeZone) return;
  currentTimeZone = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TIME_ZONE_STORAGE_KEY, next);
    }
  } catch {
    // 持久化失败不阻塞内存态更新。
  }
  listeners.forEach((listener) => listener(next));
}

/** 恢复默认时区（UTC+8）并清除持久化覆盖，通知订阅者。供 TZ2 的「重置」用。 */
export function resetTimeZone(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(TIME_ZONE_STORAGE_KEY);
    }
  } catch {
    // 忽略：内存态仍会被重置。
  }
  if (currentTimeZone !== DEFAULT_TIME_ZONE) {
    currentTimeZone = DEFAULT_TIME_ZONE;
    listeners.forEach((listener) => listener(DEFAULT_TIME_ZONE));
  }
}

/**
 * 订阅时区变更，返回取消订阅函数。
 * 供 `useTimezone()` 通过 `useSyncExternalStore` 接入 React 渲染。
 */
export function subscribeTimeZone(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 计算给定时区在给定时刻的 UTC 偏移标注，形如 `UTC+8` / `UTC+5:30` / `UTC-4` / `UTC+0`。
 * 用于在展示串后追加时区标注；默认取「当前」时刻的偏移（DST 感知）。
 *
 * 说明：`Intl` 的 `shortOffset` 输出 `GMT+8` 这类字样，这里统一归一成用户期望的
 * `UTC±H[:MM]`；`Asia/Shanghai` 无 DST，恒为 `UTC+8`，与迁移前行为一致。
 */
export function getTimeZoneOffsetLabel(tz?: string, at: Date = new Date()): string {
  const zone = resolveTimeZone(tz);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(at);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) {
      // 纯 `GMT` == UTC+0。
      return 'UTC+0';
    }
    const [, sign, hh, mm] = match;
    const hour = String(Number(hh)); // 去掉前导零，得到 `8` 而非 `08`。
    return mm && mm !== '00' ? `UTC${sign}${hour}:${mm}` : `UTC${sign}${hour}`;
  } catch {
    return 'UTC+8';
  }
}
