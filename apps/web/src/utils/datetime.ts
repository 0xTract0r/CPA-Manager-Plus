/**
 * 统一的「面向用户」时间格式化入口。
 *
 * 用户运行环境默认 UTC+8（Asia/Shanghai），但浏览器本地时区不一定是 UTC+8
 * （例如远程访问、容器、CI、不同地区的运维）。为了让用户看到的时间始终一致，
 * 这里不依赖浏览器本地时区，而是走 `utils/timezone` 的全局时区配置格式化，
 * 默认 UTC+8、可被持久化覆盖（为 TZ2 的时区开关预留）。
 *
 * 规范入口是 `formatInTimezone`（可显式指定 `tz`，缺省取全局配置）。历史上的
 * `formatInUtc8` / `*Utc8` 系列保留为薄封装：名义仍叫 Utc8，实为全局配置驱动，
 * 默认 UTC+8 行为与迁移前一致。
 *
 * 注意：本模块只负责「展示」。发往后端的查询参数（since 等 `toISOString()`）、
 * 导出文件名、导出数据时间戳、内部状态比较仍然保持 UTC / ISO，不要改用本模块。
 */

import { parseTimestamp } from './timestamp';
import {
  DEFAULT_TIME_ZONE,
  getTimeZoneOffsetLabel,
  resolveTimeZone,
} from './timezone';

/**
 * @deprecated 展示时区已由 `utils/timezone` 的全局配置驱动。保留为默认展示时区常量
 *   以兼容历史引用；需要「当前时区」请用 `getTimeZone()` / `resolveTimeZone()`。
 */
export const DISPLAY_TIME_ZONE = DEFAULT_TIME_ZONE;

/**
 * 面向用户的默认时区标注文案（UTC+8）。实际追加到展示串上的标注由
 * `getTimeZoneOffsetLabel` 按当前时区动态派生（`Asia/Shanghai` 恒为 `UTC+8`）。
 */
export const UTC8_LABEL = 'UTC+8';

/** 带括号的默认时区标注，用于图表标题/轴说明这类单点说明位。 */
export const UTC8_PAREN_LABEL = `(${UTC8_LABEL})`;

/**
 * 在已格式化的展示串后追加时区偏移标注（如 ` UTC+8`）；空串/回退串不追加，避免污染。
 * 标注按传入时区与具体时刻动态派生，切换全局时区后自动跟随（DST 感知）。
 */
function appendZoneLabel(formatted: string, tz: string, at: Date): string {
  if (!formatted) return formatted;
  return `${formatted} ${getTimeZoneOffsetLabel(tz, at)}`;
}

/**
 * 把任意可解析为时间的值转换成 Date；无法解析时返回 null。
 * 支持：Date、毫秒数（number）、ISO/RFC3339 字符串（含亚毫秒精度归一）、数字字符串。
 * 注意：此函数不处理秒/微秒/纳秒等多精度 Unix 戳，那由调用方在传入前归一化。
 */
function toDate(value: unknown): Date | null {
  return parseTimestamp(value);
}

/**
 * 规范入口：把一个时间值按指定时区（缺省取全局配置）格式化为字符串。
 * @param value 时间值（Date/number ms/ISO 字符串）
 * @param options Intl 选项（timeZone 会被强制覆盖为解析出的时区）；可选 `withZoneLabel`
 *   为 true 时在结果后追加 ` UTC±H`（绝对时间戳的面向用户展示场景用）
 * @param tz 目标时区（IANA 名）；不传/非法则取全局时区配置（默认 Asia/Shanghai）
 * @param locale 区域；不传则用运行时默认
 * @param fallback 解析失败时的占位串
 */
export function formatInTimezone(
  value: unknown,
  options?: Intl.DateTimeFormatOptions & { withZoneLabel?: boolean },
  tz?: string,
  locale?: string,
  fallback = ''
): string {
  const date = toDate(value);
  if (!date) return fallback;
  const zone = resolveTimeZone(tz);
  const { withZoneLabel, ...intlOptions } = options ?? {};
  const formatted = new Intl.DateTimeFormat(locale, {
    ...intlOptions,
    timeZone: zone,
  }).format(date);
  return withZoneLabel ? appendZoneLabel(formatted, zone, date) : formatted;
}

/**
 * 通用：把一个时间值按全局时区配置（默认 UTC+8）格式化为字符串。
 * `formatInTimezone` 的薄封装（tz 恒取全局配置），保持历史签名 `(value, options, locale, fallback)`。
 */
export function formatInUtc8(
  value: unknown,
  options?: Intl.DateTimeFormatOptions & { withZoneLabel?: boolean },
  locale?: string,
  fallback = ''
): string {
  return formatInTimezone(value, options, undefined, locale, fallback);
}

/**
 * 等价于 `date.toLocaleString()`，但走全局时区配置（默认 UTC+8）。
 * 面向用户的绝对时间戳，默认追加 ` UTC±H` 标注；传 `withZoneLabel = false` 可关闭
 * （例如紧凑/拼接场景）。
 */
export function formatDateTimeUtc8(
  value: unknown,
  locale?: string,
  fallback = '',
  withZoneLabel = true
): string {
  return formatInUtc8(
    value,
    { dateStyle: 'medium', timeStyle: 'medium', withZoneLabel },
    locale,
    fallback
  );
}

/**
 * 仅日期，走全局时区配置（默认 UTC+8）。等价于 `toLocaleDateString()`。
 * 纯日期默认不带时区标注（无时刻，时区标注意义不大）；需要时传 `withZoneLabel = true`。
 */
export function formatDateUtc8(
  value: unknown,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
  fallback = '',
  withZoneLabel = false
): string {
  return formatInUtc8(
    value,
    { ...(options ?? { dateStyle: 'medium' }), withZoneLabel },
    locale,
    fallback
  );
}

/**
 * 仅时间，走全局时区配置（默认 UTC+8）。等价于 `toLocaleTimeString()`。
 * 面向用户的时刻默认追加时区标注；传 `withZoneLabel = false` 可关闭。
 */
export function formatTimeUtc8(
  value: unknown,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
  fallback = '',
  withZoneLabel = true
): string {
  return formatInUtc8(
    value,
    { ...(options ?? { hour: '2-digit', minute: '2-digit' }), withZoneLabel },
    locale,
    fallback
  );
}

/**
 * 短时间戳：MM/DD HH:mm（24 小时制），走全局时区配置（默认 UTC+8）。
 * 用于替换手工 `getMonth()/getDate()/getHours()` 拼接（那些读浏览器本地时区）。
 */
export function formatMonthDayTimeUtc8(value: unknown, fallback = ''): string {
  return formatInUtc8(
    value,
    {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    undefined,
    fallback
  );
}

/**
 * 取全局时区（默认 UTC+8）下的时间字段（月/日/时/分），用于需要逐字段稳定拼接的场景。
 * 替换调用方手工 `getMonth()/getDate()/getHours()/getMinutes()`（读浏览器本地时区）。
 */
export function getUtc8Parts(value: unknown): {
  month: string;
  day: string;
  hour: string;
  minute: string;
} | null {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimeZone(),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return { month: get('month'), day: get('day'), hour, minute: get('minute') };
}

/**
 * `MM/DD HH:mm`（24 小时制），走全局时区配置（默认 UTC+8）。用于替换手工 getMonth/getDate 拼接。
 */
export function formatSlashDateTimeUtc8(value: unknown, fallback = ''): string {
  const parts = getUtc8Parts(value);
  if (!parts) return fallback;
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 短时分：HH:mm（24 小时制），走全局时区配置（默认 UTC+8）。
 */
export function formatShortClockUtc8(value: unknown, fallback = ''): string {
  return formatInUtc8(
    value,
    { hour: '2-digit', minute: '2-digit', hour12: false },
    undefined,
    fallback
  );
}

/**
 * 从「年/月/日 时:分」各字段构造的纯展示串，用于图表横轴这类需要稳定格式的场景。
 * 按全局时区配置（默认 UTC+8）渲染，返回 `MM-DD HH:00`。
 */
export function formatHourAxisUtc8(value: unknown, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimeZone(),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month');
  const day = get('day');
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${month}-${day} ${hour}:00`;
}

// 相对时间分段：从秒逐级向上归并到年。amount 为「进位到下一单位」的阈值。
const RELATIVE_TIME_DIVISIONS: ReadonlyArray<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> =
  [
    { amount: 60, unit: 'second' },
    { amount: 60, unit: 'minute' },
    { amount: 24, unit: 'hour' },
    { amount: 7, unit: 'day' },
    { amount: 4.34524, unit: 'week' },
    { amount: 12, unit: 'month' },
    { amount: Number.POSITIVE_INFINITY, unit: 'year' },
  ];

/**
 * 相对时间（「2 分钟前」/「yesterday」/「через 3 часа」），走 `Intl.RelativeTimeFormat`
 * 原生本地化（en / zh / ru 均支持），用于表格等高频时间戳的紧凑展示——绝对值应由
 * 调用方放进 `title` 悬浮（用 `formatDateTimeUtc8` 保持全局时区一致）。相对时间本身
 * 与时区无关，只依赖两个时刻之差。
 *
 * @param nowMs 当前时刻（毫秒）；由调用方的稳定时钟（如每分钟 tick 的 state）提供，
 *   避免在 render 期直接读 `Date.now()` 破坏 render 纯度。
 */
export function formatRelativeFromNow(
  value: unknown,
  nowMs: number,
  locale?: string,
  fallback = ''
): string {
  const date = toDate(value);
  if (!date) return fallback;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  let duration = (date.getTime() - nowMs) / 1000; // 秒；负数=过去，正数=将来
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return fallback;
}

/**
 * 日期横轴：YYYY-MM-DD，走全局时区配置（默认 UTC+8）。
 */
export function formatDayAxisUtc8(value: unknown, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  // en-CA 在 'YYYY-MM-DD' 顺序上稳定。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
