/**
 * 统一的「面向用户」时间格式化入口。
 *
 * 用户运行环境固定为 UTC+8（Asia/Shanghai），但浏览器本地时区不一定是 UTC+8
 * （例如远程访问、容器、CI、不同地区的运维）。为了让用户看到的时间始终一致，
 * 这里强制使用 `Asia/Shanghai` 命名时区格式化，而不是依赖浏览器本地时区。
 *
 * 注意：本模块只负责「展示」。发往后端的查询参数（since 等 `toISOString()`）、
 * 导出文件名、导出数据时间戳、内部状态比较仍然保持 UTC / ISO，不要改用本模块。
 */

/** 强制的展示时区。用户环境固定 UTC+8。 */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

/**
 * 面向用户的时区标注文案。用户环境固定 UTC+8（Asia/Shanghai）。
 *
 * Intl 的 `timeZoneName: 'shortOffset'` 会输出 `GMT+8`，与用户期望的 `UTC+8`
 * 字样不一致，因此这里统一用手工常量在格式化结果后追加，保证用户在界面上看到
 * 的就是 `UTC+8`。内部状态、查询参数（since）、导出仍是 UTC，不使用本标注。
 */
export const UTC8_LABEL = 'UTC+8';

/** 带括号的时区标注，用于图表标题/轴说明这类单点说明位。 */
export const UTC8_PAREN_LABEL = `(${UTC8_LABEL})`;

/** 在已格式化的展示串后追加 ` UTC+8`；空串/解析失败回退串不追加，避免污染。 */
function appendUtc8Label(formatted: string): string {
  if (!formatted) return formatted;
  return `${formatted} ${UTC8_LABEL}`;
}

/**
 * 把任意可解析为时间的值转换成 Date；无法解析时返回 null。
 * 支持：Date、毫秒数（number）、ISO/RFC3339 字符串、数字字符串。
 * 注意：此函数不处理秒/微秒/纳秒等多精度 Unix 戳，那由调用方在传入前归一化。
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 在所有「面向用户」格式化里强制注入展示时区。 */
function withDisplayTimeZone(
  options?: Intl.DateTimeFormatOptions
): Intl.DateTimeFormatOptions {
  return { ...options, timeZone: DISPLAY_TIME_ZONE };
}

/**
 * 通用：把一个时间值按 UTC+8 格式化为字符串。
 * @param value 时间值（Date/number ms/ISO 字符串）
 * @param options Intl 选项（timeZone 会被强制覆盖为 Asia/Shanghai）；可选 `withZoneLabel`
 *   为 true 时在结果后追加 ` UTC+8` 标注（绝对时间戳的面向用户展示场景用）
 * @param locale 区域；不传则用运行时默认
 * @param fallback 解析失败时的占位串
 */
export function formatInUtc8(
  value: unknown,
  options?: Intl.DateTimeFormatOptions & { withZoneLabel?: boolean },
  locale?: string,
  fallback = ''
): string {
  const date = toDate(value);
  if (!date) return fallback;
  const { withZoneLabel, ...intlOptions } = options ?? {};
  const formatted = new Intl.DateTimeFormat(
    locale,
    withDisplayTimeZone(intlOptions)
  ).format(date);
  return withZoneLabel ? appendUtc8Label(formatted) : formatted;
}

/**
 * 等价于 `date.toLocaleString()`，但强制 UTC+8。
 * 面向用户的绝对时间戳，默认追加 ` UTC+8` 标注；传 `withZoneLabel = false` 可关闭
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
 * 仅日期，强制 UTC+8。等价于 `toLocaleDateString()`。
 * 纯日期默认不带 ` UTC+8`（无时刻，时区标注意义不大）；需要时传 `withZoneLabel = true`。
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
 * 仅时间，强制 UTC+8。等价于 `toLocaleTimeString()`。
 * 面向用户的时刻默认追加 ` UTC+8` 标注；传 `withZoneLabel = false` 可关闭。
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
 * 短时间戳：MM/DD HH:mm（24 小时制），强制 UTC+8。
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
 * 取 UTC+8 下的时间字段（月/日/时/分），用于需要逐字段稳定拼接的场景。
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
    timeZone: DISPLAY_TIME_ZONE,
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
 * `MM/DD HH:mm`（24 小时制），强制 UTC+8。用于替换手工 getMonth/getDate 拼接。
 */
export function formatSlashDateTimeUtc8(value: unknown, fallback = ''): string {
  const parts = getUtc8Parts(value);
  if (!parts) return fallback;
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 短时分：HH:mm（24 小时制），强制 UTC+8。
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
 * 始终按 UTC+8 渲染，返回 `MM-DD HH:00`。
 */
export function formatHourAxisUtc8(value: unknown, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
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

/**
 * 日期横轴：YYYY-MM-DD，强制 UTC+8。
 */
export function formatDayAxisUtc8(value: unknown, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  // en-CA 在 'YYYY-MM-DD' 顺序上稳定。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
