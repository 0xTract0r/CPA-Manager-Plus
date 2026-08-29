import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import {
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconFilter,
  IconInfo,
} from '@/components/ui/icons';
import {
  PaginationControls,
  RecentPattern,
} from '@/features/monitoring/components/MonitoringShared';
import { MonitoringPanel } from '@/features/monitoring/components/MonitoringPanel';
import { RequestLogViewer } from '@/features/monitoring/components/RequestLogViewer';
import { hasOverflowingContent } from '@/features/monitoring/components/contentTooltip';
import { formatPercent } from '@/features/monitoring/components/accountOverviewPresentation';
import { computeCacheHitRate } from '@/features/monitoring/model/monitoringCenterPageModel';
import { buildRealtimeSourceDisplay } from '@/features/monitoring/realtimeSourceDisplay';
import type { MonitoringEventRow } from '@/features/monitoring/hooks/useMonitoringData';
import type { AccountDisplayMode } from '@/features/monitoring/accountOverviewState';
import {
  isValidLowCacheHitRateThreshold,
  REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD_PRESETS,
} from '@/features/monitoring/monitoringCenterUiState';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { downloadBlob } from '@/utils/download';
import { maskSensitiveText, truncateText } from '@/utils/format';
import { formatInUtc8 } from '@/utils/datetime';
import { formatCompactNumber, formatUsd } from '@/utils/usage';
import {
  buildEventExportCsv,
  buildEventExportFilename,
  buildEventExportJson,
  EVENT_EXPORT_MIME,
  type EventExportFormat,
} from '@/features/monitoring/model/eventExport';
import styles from '../MonitoringCenterPage.module.scss';

type RealtimeLogRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
};

type PaginationState<T> = {
  currentPage: number;
  totalPages: number;
  pageItems: T[];
  startItem: number;
  endItem: number;
};

type RealtimeEventsPanelProps = {
  embedded?: boolean;
  rows: RealtimeLogRow[];
  pagination: PaginationState<RealtimeLogRow>;
  pageSize: number;
  scopedFailureCount: number;
  failedOnlyActive: boolean;
  lowCacheHitRateOnly: boolean;
  lowCacheHitRateThreshold: number;
  eventsHasMore: boolean;
  eventsLoadingMore: boolean;
  eventsRetentionLimited: boolean;
  eventsTotalCount: number;
  eventsLoadedCount: number;
  overallLoading: boolean;
  hasPrices: boolean;
  accountDisplayMode: AccountDisplayMode;
  locale: string;
  emptyState: ReactNode;
  t: TFunction;
  onToggleFailedOnly: () => void;
  onToggleLowCacheHitRateOnly: () => void;
  onLowCacheHitRateThresholdChange: (threshold: number) => void;
  onAccountDisplayModeChange: (mode: AccountDisplayMode) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onLoadMoreEvents: () => void;
};

export type RealtimeEventsPanelActionsProps = {
  rowCount: number;
  scopedFailureCount: number;
  failedOnlyActive: boolean;
  lowCacheHitRateOnly: boolean;
  lowCacheHitRateThreshold: number;
  accountDisplayMode: AccountDisplayMode;
  /** 当前已加载/筛选的事件行（buildRealtimeLogRows 的结果，1:1 对应事件），供客户端 CSV/JSON 导出。 */
  exportRows: MonitoringEventRow[];
  hasPrices: boolean;
  t: TFunction;
  onToggleFailedOnly: () => void;
  onToggleLowCacheHitRateOnly: () => void;
  onLowCacheHitRateThresholdChange: (threshold: number) => void;
  onAccountDisplayModeChange: (mode: AccountDisplayMode) => void;
};

const REALTIME_PAGE_SIZE_OPTIONS = [10, 50, 100, 150, 300] as const;
const FAILURE_TOOLTIP_VIEWPORT_MARGIN = 12;
const FAILURE_TOOLTIP_OFFSET = 8;
const FAILURE_TOOLTIP_MAX_WIDTH = 420;
const FAILURE_TOOLTIP_MAX_HEIGHT = 240;
const FAILURE_TOOLTIP_CLOSE_DELAY_MS = 120;
const CONTENT_TOOLTIP_OPEN_DELAY_MS = 140;
const CONTENT_TOOLTIP_CLOSE_DELAY_MS = 220;
// "强度/等级"列缺值时的中性占位：只用一个 em dash 字符，不落成裸的 "-"（在等宽字体/
// 部分渲染环境下容易被读成叉号），也不是任何需要按语言翻译的文案。effort 与 tier
// 皆缺失时，整格只显这一个占位（第 2 行不渲染）。
const REASONING_TIER_PLACEHOLDER = '—';

type FailureTooltipPlacement = 'above' | 'below';

type FailureTooltipPosition = {
  placement: FailureTooltipPlacement;
  style: CSSProperties;
};

const formatOptionalText = (value: string | null | undefined) => {
  const trimmed = String(value || '').trim();
  return trimmed || '-';
};

const formatReadableText = (value: string | null | undefined) => {
  const trimmed = String(value || '').trim();
  return trimmed && trimmed !== '-' ? trimmed : '';
};

// 强度/等级单元格的原生 title 兜底：不管 effort/tier 是否被抑制展示，hover 都能看到
// 完整的两个值（含被隐藏的 auto/default）。故意用固定英文标签而非 i18n 文案——这是
// 面向排障的原始字段名提示，不是面向最终用户的翻译文案。
const buildReasoningTierNativeTitle = (row: MonitoringEventRow) => {
  const effort = formatReadableText(row.reasoningEffort) || REASONING_TIER_PLACEHOLDER;
  const tier = formatReadableText(row.serviceTier) || REASONING_TIER_PLACEHOLDER;
  return `Effort: ${effort} · Tier: ${tier}`;
};

const shortLabel = (
  t: TFunction,
  shortKey: string,
  fallbackKey: string,
  fallbackDefault?: string
) => {
  const fallback = t(fallbackKey, fallbackDefault ? { defaultValue: fallbackDefault } : undefined);
  const label = t(shortKey, { defaultValue: fallback });
  return label === shortKey ? (fallbackDefault ?? fallback) : label;
};

const formatShortHash = (value: string | null | undefined) => {
  const trimmed = formatReadableText(value);
  return trimmed ? `#${trimmed.slice(0, 8)}` : '';
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const resolveFailureTooltipPosition = (anchor: HTMLElement): FailureTooltipPosition | null => {
  if (typeof window === 'undefined') return null;

  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxWidth = Math.max(
    220,
    Math.min(
      FAILURE_TOOLTIP_MAX_WIDTH,
      Math.max(0, viewportWidth - FAILURE_TOOLTIP_VIEWPORT_MARGIN * 2)
    )
  );
  const left = clampNumber(
    rect.left,
    FAILURE_TOOLTIP_VIEWPORT_MARGIN,
    Math.max(
      FAILURE_TOOLTIP_VIEWPORT_MARGIN,
      viewportWidth - maxWidth - FAILURE_TOOLTIP_VIEWPORT_MARGIN
    )
  );
  const spaceBelow =
    viewportHeight - rect.bottom - FAILURE_TOOLTIP_VIEWPORT_MARGIN - FAILURE_TOOLTIP_OFFSET;
  const spaceAbove = rect.top - FAILURE_TOOLTIP_VIEWPORT_MARGIN - FAILURE_TOOLTIP_OFFSET;
  const placement: FailureTooltipPlacement =
    spaceBelow >= FAILURE_TOOLTIP_MAX_HEIGHT || spaceBelow >= spaceAbove ? 'below' : 'above';
  const availableHeight = Math.max(0, placement === 'below' ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(FAILURE_TOOLTIP_MAX_HEIGHT, availableHeight);
  const baseStyle: CSSProperties = {
    left,
    maxHeight,
    maxWidth,
  };

  return placement === 'below'
    ? {
        placement,
        style: {
          ...baseStyle,
          top: rect.bottom + FAILURE_TOOLTIP_OFFSET,
        },
      }
    : {
        placement,
        style: {
          ...baseStyle,
          bottom: viewportHeight - rect.top + FAILURE_TOOLTIP_OFFSET,
        },
      };
};

const buildRealtimeApiKeyDisplay = (row: MonitoringEventRow, t: TFunction) => {
  const label = formatReadableText(row.apiKeyLabel);
  const masked = formatReadableText(row.apiKeyMasked);
  const hash = formatReadableText(row.apiKeyHash);
  const shortHash = formatShortHash(hash);
  const display = label || masked || shortHash;

  if (!display) {
    return null;
  }

  const titleParts = [
    `${t('monitoring.realtime_api_key_label')}: ${display}`,
    masked && masked !== display ? `${t('monitoring.realtime_api_key_masked')}: ${masked}` : '',
    hash ? `${t('monitoring.realtime_api_key_hash')}: ${hash}` : '',
    formatReadableText(row.executorType)
      ? `${shortLabel(t, 'monitoring.executor_type_short', 'monitoring.executor_type')}: ${formatReadableText(row.executorType)}`
      : '',
  ].filter(Boolean);

  return {
    display,
    title: titleParts.join('\n'),
    titleParts,
  };
};

const formatTokensPerSecond = (value: number | null | undefined, locale: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '--';

  const absValue = Math.abs(value);
  const maximumFractionDigits = absValue < 1 ? 2 : absValue < 10 ? 1 : 0;
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return value.toFixed(maximumFractionDigits);
  }
};

const formatRealtimeCompactDuration = (value: number | null | undefined, locale: string) => {
  if (value === null || value === undefined) return '--';

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return '--';

  const formatNumber = (numberValue: number, maximumFractionDigits: number) => {
    try {
      return new Intl.NumberFormat(locale, {
        maximumFractionDigits,
        minimumFractionDigits: 0,
      }).format(numberValue);
    } catch {
      return numberValue.toFixed(maximumFractionDigits);
    }
  };

  if (parsed < 1000) return `${formatNumber(Math.round(parsed), 0)} ms`;

  const seconds = parsed / 1000;
  return `${formatNumber(seconds, seconds < 10 ? 2 : 1)} s`;
};

const getRealtimeDurationToneClass = (value: number | null | undefined) => {
  if (value === null || value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  if (parsed >= 30000) return styles.badText;
  if (parsed >= 15000) return styles.warnText;
  return styles.goodText;
};

const formatRealtimeDateParts = (timestampMs: number, locale: string) => ({
  // 标准数字格式 + 全局时区（date=YYYY-MM-DD，time=HH:mm:ss）；分列展示故不带时区标注。
  date: formatInUtc8(timestampMs, { dateStyle: 'medium' }, locale),
  time: formatInUtc8(timestampMs, { timeStyle: 'medium' }, locale),
});

const formatHeaderRecoverAt = (value: number | null | undefined, locale: string) => {
  if (!value || !Number.isFinite(value)) return '';
  return formatInUtc8(
    value,
    {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    locale
  );
};

const buildHeaderDiagnosticParts = (
  row: MonitoringEventRow,
  t: TFunction,
  locale: string
): string[] => {
  const parts: string[] = [];
  const compactSignal = (label: string, value: string | number | null | undefined, limit = 42) => {
    const normalized =
      typeof value === 'number'
        ? Number.isFinite(value)
          ? String(value)
          : ''
        : formatReadableText(value);
    return normalized ? `${label} ${truncateText(normalized, limit)}` : '';
  };
  const errorCode = row.headerErrorCode || row.responseMetadata?.errors?.code || '';
  const errorKind = row.headerErrorKind || row.responseMetadata?.errors?.kind || '';
  if (errorCode || errorKind) {
    parts.push(
      `${t('monitoring.header_error')}: ${[errorKind, errorCode].filter(Boolean).join(' / ')}`
    );
  }
  const traceId = row.headerTraceId || row.responseMetadata?.trace?.primary_trace_id || '';
  if (traceId) {
    parts.push(`${t('monitoring.header_trace')}: ${truncateText(traceId, 42)}`);
  }
  const quotaParts: string[] = [];
  const planType =
    row.headerQuotaPlanType ||
    row.responseMetadata?.quota?.plan_type ||
    row.responseMetadata?.quota?.active_limit ||
    '';
  if (planType) quotaParts.push(planType);
  const usedPercent =
    row.headerQuotaUsedPercent ?? row.responseMetadata?.quota?.used_percent ?? null;
  if (typeof usedPercent === 'number' && Number.isFinite(usedPercent)) {
    quotaParts.push(formatPercent(usedPercent / 100));
  }
  const recoverAt = formatHeaderRecoverAt(
    row.headerQuotaRecoverAtMs ?? row.responseMetadata?.quota?.recover_at_ms,
    locale
  );
  if (recoverAt) {
    quotaParts.push(`${t('monitoring.header_recover_at')} ${recoverAt}`);
  }
  if (quotaParts.length > 0) {
    parts.push(`${t('monitoring.header_quota')}: ${quotaParts.join(' · ')}`);
  }
  const routing = row.responseMetadata?.routing;
  const routingParts = [
    compactSignal('server', routing?.server),
    compactSignal('via', routing?.via),
    compactSignal('cf', routing?.cf_cache_status),
    compactSignal('site', routing?.site_cache_status),
    compactSignal('mife', routing?.mife_upstream_status),
  ].filter(Boolean);
  if (routingParts.length > 0) {
    parts.push(
      `${t('monitoring.header_routing', { defaultValue: 'Routing' })}: ${routingParts.join(' · ')}`
    );
  }
  const providers = row.responseMetadata?.providers;
  const providerParts = [
    compactSignal('antigravity', providers?.antigravity_trace_id),
    compactSignal('oneapi', providers?.oneapi_request_id),
    compactSignal('cf-ray', providers?.cloudflare_ray),
    compactSignal('cf-cache', providers?.cloudflare_cache_status),
  ].filter(Boolean);
  if (providerParts.length > 0) {
    parts.push(
      `${t('monitoring.header_provider', { defaultValue: 'Provider' })}: ${providerParts.join(' · ')}`
    );
  }
  const response = row.responseMetadata?.response;
  const contentType = response?.content_type || '';
  const responseParts = [
    row.failed && contentType && !contentType.includes('event-stream')
      ? truncateText(contentType, 48)
      : '',
    compactSignal('len', response?.content_length, 16),
    compactSignal('timing', response?.server_timing, 64),
  ].filter(Boolean);
  if (responseParts.length > 0) {
    parts.push(`${t('monitoring.header_response')}: ${responseParts.join(' · ')}`);
  }
  return parts;
};

const buildFailureMetaText = (row: MonitoringEventRow, t: TFunction, locale: string) => {
  if (!row.failed) return '';
  const parts: string[] = [];
  if (row.failStatusCode) {
    parts.push(
      `${shortLabel(t, 'monitoring.fail_status_code_short', 'monitoring.fail_status_code')} ${row.failStatusCode}`
    );
  }
  const body = maskSensitiveText(row.failSummary || '');
  if (body) {
    parts.push(truncateText(body, 96));
  }
  parts.push(...buildHeaderDiagnosticParts(row, t, locale).map((part) => truncateText(part, 96)));
  return parts.join(' · ');
};

const buildFailureDetails = (row: MonitoringEventRow, t: TFunction, locale: string) => {
  if (!row.failed) return null;
  const summary = maskSensitiveText(row.failSummary || '');
  const diagnostics = buildHeaderDiagnosticParts(row, t, locale);
  if (!row.failStatusCode && !summary && diagnostics.length === 0) return null;
  const statusText = row.failStatusCode
    ? `${shortLabel(t, 'monitoring.fail_status_code_short', 'monitoring.fail_status_code')} ${row.failStatusCode}`
    : '';
  return {
    statusCode: row.failStatusCode,
    statusText,
    summary,
    diagnostics,
    label: buildFailureMetaText(row, t, locale),
    copyText: [statusText, summary, ...diagnostics].filter(Boolean).join('\n'),
  };
};

type RealtimeFailureDetails = NonNullable<ReturnType<typeof buildFailureDetails>>;

type RealtimeFailureStatusProps = {
  details: RealtimeFailureDetails;
  tooltipId: string;
  t: TFunction;
  onCopy: (text: string) => void;
};

const isNodeInside = (element: HTMLElement | null, target: EventTarget | null) => {
  if (!element || typeof Node === 'undefined' || !(target instanceof Node)) return false;
  return element.contains(target);
};

type ContentTooltipOptions = {
  requireOverflow?: boolean;
  contentKey?: string;
};

// 内容型浮层共享状态机：时间/模型/来源仅在真实 overflow 或 line-clamp 后开放；鼠标使用
// 很短的 intent delay，避免扫表时闪烁，键盘聚焦仍立即打开。浮层与 trigger 之间保留关闭
// 缓冲，并在鼠标进入 portal 浮层后取消关闭，使长邮箱/模型名可以滚动、选中和复制。
// API Key 传 requireOverflow=false：它还承载掩码、哈希、executor 等单元格外补充信息。
function useContentTooltip<T extends HTMLElement>({
  requireOverflow = true,
  contentKey = '',
}: ContentTooltipOptions = {}) {
  const triggerRef = useRef<T | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const tooltipHoveredRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FailureTooltipPosition | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const canShow = useCallback(() => {
    if (!triggerRef.current) return false;
    return !requireOverflow || hasOverflowingContent(triggerRef.current);
  }, [requireOverflow]);

  const refreshAvailability = useCallback(() => {
    const nextAvailable = canShow();
    triggerRef.current?.setAttribute('tabindex', nextAvailable ? '0' : '-1');
    return nextAvailable;
  }, [canShow]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const nextPosition = resolveFailureTooltipPosition(triggerRef.current);
    if (nextPosition) setPosition(nextPosition);
  }, []);

  const schedulePositionUpdate = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  const hideNow = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(false);
  }, [clearCloseTimer, clearOpenTimer]);

  const showImmediately = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (!refreshAvailability()) {
      setOpen(false);
      return;
    }
    updatePosition();
    setOpen(true);
  }, [clearCloseTimer, clearOpenTimer, refreshAvailability, updatePosition]);

  const show = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (!refreshAvailability()) {
      setOpen(false);
      return;
    }
    if (typeof window === 'undefined') {
      showImmediately();
      return;
    }
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      showImmediately();
    }, CONTENT_TOOLTIP_OPEN_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, refreshAvailability, showImmediately]);

  const requestHide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (typeof window === 'undefined') {
      setOpen(false);
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (!tooltipHoveredRef.current) setOpen(false);
    }, CONTENT_TOOLTIP_CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (isNodeInside(triggerRef.current, event.relatedTarget) || tooltipHoveredRef.current)
        return;
      requestHide();
    },
    [requestHide]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      hideNow();
    },
    [hideNow]
  );

  const handleTooltipMouseEnter = useCallback(() => {
    tooltipHoveredRef.current = true;
    clearCloseTimer();
  }, [clearCloseTimer]);

  const handleTooltipMouseLeave = useCallback(() => {
    tooltipHoveredRef.current = false;
    requestHide();
  }, [requestHide]);

  const handleTooltipMouseDown = useCallback(() => {
    tooltipHoveredRef.current = true;
    clearCloseTimer();
  }, [clearCloseTimer]);

  useLayoutEffect(() => {
    refreshAvailability();
  }, [contentKey, refreshAvailability]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
      if (rafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    [clearCloseTimer, clearOpenTimer]
  );

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    const handleResize = () => {
      if (!refreshAvailability()) {
        hideNow();
        return;
      }
      schedulePositionUpdate();
    };
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') hideNow();
    };

    schedulePositionUpdate();
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', schedulePositionUpdate, true);
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', schedulePositionUpdate, true);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [hideNow, open, refreshAvailability, schedulePositionUpdate]);

  return {
    triggerRef,
    open,
    initialTabIndex: requireOverflow ? -1 : 0,
    position,
    show,
    showImmediately,
    requestHide,
    handleBlur,
    handleKeyDown,
    handleTooltipMouseEnter,
    handleTooltipMouseLeave,
    handleTooltipMouseDown,
  };
}

// 表头悬浮说明：与 RealtimeModelCell 同一套 portal + fixed 定位即时浮层手法，取代原生
// title=（浏览器原生 tooltip 延迟约 0.5-1s 且不可控，触屏点击也不触发）。浮层视觉复用
// .realtimeModelTooltip 系列样式（信息类提示，非失败态红色描边），不新增一套孤立类。
function TableHeaderInfo({ label, info }: { label: ReactNode; info: string }) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<FailureTooltipPosition | null>(null);
  const isBrowser = typeof document !== 'undefined';

  const updateTooltipPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const nextPosition = resolveFailureTooltipPosition(triggerRef.current);
    if (nextPosition) setTooltipPosition(nextPosition);
  }, []);

  const showTooltip = useCallback(() => {
    updateTooltipPosition();
    setOpen(true);
  }, [updateTooltipPosition]);

  const hideTooltip = useCallback(() => setOpen(false), []);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (isNodeInside(triggerRef.current, event.relatedTarget)) return;
      hideTooltip();
    },
    [hideTooltip]
  );

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    updateTooltipPosition();
    window.addEventListener('resize', updateTooltipPosition);
    window.addEventListener('scroll', updateTooltipPosition, true);
    return () => {
      window.removeEventListener('resize', updateTooltipPosition);
      window.removeEventListener('scroll', updateTooltipPosition, true);
    };
  }, [open, updateTooltipPosition]);

  const placement = tooltipPosition?.placement ?? 'below';
  const tooltipClassName = [
    styles.realtimeModelTooltip,
    placement === 'above' ? styles.realtimeModelTooltipAbove : styles.realtimeModelTooltipBelow,
    open ? styles.realtimeModelTooltipOpen : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tooltip = (
    <span
      id={tooltipId}
      role="tooltip"
      className={tooltipClassName}
      style={isBrowser ? tooltipPosition?.style : undefined}
    >
      {info}
    </span>
  );

  return (
    <span className={styles.tableHeaderWithInfo}>
      <span>{label}</span>
      <span
        ref={triggerRef}
        tabIndex={0}
        className={styles.tableHeaderInfoTrigger}
        aria-describedby={tooltipId}
        aria-label={info}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={handleBlur}
      >
        <IconInfo size={13} className={styles.tableHeaderInfoIcon} />
      </span>
      {!isBrowser ? tooltip : null}
      {isBrowser && open ? createPortal(tooltip, document.body) : null}
    </span>
  );
}

function RealtimeFailureStatus({ details, tooltipId, t, onCopy }: RealtimeFailureStatusProps) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<FailureTooltipPosition | null>(null);
  const isBrowser = typeof document !== 'undefined';

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const updateTooltipPosition = useCallback(() => {
    if (!triggerRef.current) return;
    const nextPosition = resolveFailureTooltipPosition(triggerRef.current);
    if (nextPosition) {
      setTooltipPosition(nextPosition);
    }
  }, []);

  const scheduleTooltipPositionUpdate = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      updateTooltipPosition();
    });
  }, [updateTooltipPosition]);

  const showTooltip = useCallback(() => {
    clearCloseTimer();
    updateTooltipPosition();
    setOpen(true);
  }, [clearCloseTimer, updateTooltipPosition]);

  const requestHideTooltip = useCallback(() => {
    clearCloseTimer();
    if (typeof window === 'undefined') {
      setOpen(false);
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, FAILURE_TOOLTIP_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        isNodeInside(triggerRef.current, nextTarget) ||
        isNodeInside(tooltipRef.current, nextTarget)
      ) {
        return;
      }
      requestHideTooltip();
    },
    [requestHideTooltip]
  );

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      clearCloseTimer();
      if (rafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;

    scheduleTooltipPositionUpdate();
    window.addEventListener('resize', scheduleTooltipPositionUpdate);
    window.addEventListener('scroll', scheduleTooltipPositionUpdate, true);

    return () => {
      window.removeEventListener('resize', scheduleTooltipPositionUpdate);
      window.removeEventListener('scroll', scheduleTooltipPositionUpdate, true);
    };
  }, [open, scheduleTooltipPositionUpdate]);

  const placement = tooltipPosition?.placement ?? 'below';
  const tooltipClassName = [
    styles.realtimeFailureTooltip,
    placement === 'above' ? styles.realtimeFailureTooltipAbove : styles.realtimeFailureTooltipBelow,
    open ? styles.realtimeFailureTooltipOpen : '',
  ]
    .filter(Boolean)
    .join(' ');
  const tooltip = (
    <span
      id={tooltipId}
      ref={tooltipRef}
      role="tooltip"
      className={tooltipClassName}
      style={isBrowser ? tooltipPosition?.style : undefined}
      onMouseEnter={clearCloseTimer}
      onMouseLeave={requestHideTooltip}
      onFocus={showTooltip}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className={styles.realtimeFailureCopyButton}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy(details.copyText);
        }}
        title={t('common.copy')}
        aria-label={t('common.copy')}
      >
        <IconCopy size={13} />
      </button>
      {details.statusCode ? (
        <span className={styles.realtimeFailureTooltipStatus}>{details.statusText}</span>
      ) : null}
      {details.summary ? (
        <span className={styles.realtimeFailureTooltipBody}>{details.summary}</span>
      ) : null}
      {details.diagnostics.map((item) => (
        <span key={item} className={styles.realtimeFailureTooltipBody}>
          {item}
        </span>
      ))}
    </span>
  );

  return (
    <span
      ref={triggerRef}
      className={styles.realtimeFailureStatus}
      tabIndex={0}
      aria-describedby={tooltipId}
      aria-label={details.label}
      onMouseEnter={showTooltip}
      onMouseLeave={requestHideTooltip}
      onFocus={showTooltip}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <span className={`${styles.realtimeRequestStatus} ${styles.realtimeRequestStatusBad}`}>
        {t('monitoring.result_failed')}
      </span>
      {!isBrowser ? tooltip : null}
      {isBrowser && open ? createPortal(tooltip, document.body) : null}
    </span>
  );
}

type RealtimeModelCellProps = {
  model: string;
  resolvedModel?: string;
  tooltipId: string;
};

// 模型名单元格：portal + fixed 定位用来逃出 overflow 裁切祖先；是否开放浮层由
// useContentTooltip 对主行 line-clamp 和副行 ellipsis 做真实尺寸判断。
function RealtimeModelCell({ model, resolvedModel, tooltipId }: RealtimeModelCellProps) {
  const {
    triggerRef,
    open,
    position,
    show,
    showImmediately,
    requestHide,
    handleBlur,
    handleKeyDown,
    handleTooltipMouseEnter,
    handleTooltipMouseLeave,
    handleTooltipMouseDown,
    initialTabIndex,
  } = useContentTooltip<HTMLDivElement>({ contentKey: `${model}\u0000${resolvedModel ?? ''}` });
  const isBrowser = typeof document !== 'undefined';

  const placement = position?.placement ?? 'below';
  const tooltipClassName = [
    styles.realtimeModelTooltip,
    placement === 'above' ? styles.realtimeModelTooltipAbove : styles.realtimeModelTooltipBelow,
    open ? styles.realtimeModelTooltipOpen : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tooltip = (
    <span
      id={tooltipId}
      role="tooltip"
      className={tooltipClassName}
      style={isBrowser ? position?.style : undefined}
      onMouseEnter={handleTooltipMouseEnter}
      onMouseLeave={handleTooltipMouseLeave}
      onMouseDown={handleTooltipMouseDown}
    >
      <span className={`${styles.realtimeModelTooltipPrimary} ${styles.monoCell}`}>{model}</span>
      {resolvedModel ? (
        <span className={`${styles.realtimeModelTooltipSecondary} ${styles.monoCell}`}>
          {resolvedModel}
        </span>
      ) : null}
    </span>
  );

  return (
    <div
      ref={triggerRef}
      className={`${styles.primaryCell} ${styles.realtimeModelCell}`}
      data-overflow-tooltip="model"
      tabIndex={initialTabIndex}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={show}
      onMouseLeave={requestHide}
      onFocus={showImmediately}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {/* 主行 2 行限行换行(line-clamp)，取代旧的单行硬省略；副行(resolved model)继续沿用
          单行 nowrap 省略号，不受影响。超过 2 行/仍截断时由溢出感知浮层兜底看全名。 */}
      <span
        className={`${styles.monoCell} ${styles.realtimeModelText} ${styles.realtimeModelTextClamp}`}
        data-overflow-content="true"
      >
        {model}
      </span>
      {resolvedModel ? (
        <small
          className={`${styles.monoCell} ${styles.realtimeModelText}`}
          data-overflow-content="true"
        >
          {resolvedModel}
        </small>
      ) : null}
      {!isBrowser ? tooltip : null}
      {isBrowser && open ? createPortal(tooltip, document.body) : null}
    </div>
  );
}

type RealtimeTimeCellProps = {
  dateText: string;
  timeText: string;
  tooltipId: string;
};

// 时间列只有 date/time 任一行真实出现省略号时才开放浮层；完整时间不再制造重复提示。
function RealtimeTimeCell({ dateText, timeText, tooltipId }: RealtimeTimeCellProps) {
  const {
    triggerRef,
    open,
    position,
    show,
    showImmediately,
    requestHide,
    handleBlur,
    handleKeyDown,
    handleTooltipMouseEnter,
    handleTooltipMouseLeave,
    handleTooltipMouseDown,
    initialTabIndex,
  } = useContentTooltip<HTMLDivElement>({ contentKey: `${dateText}\u0000${timeText}` });
  const isBrowser = typeof document !== 'undefined';

  const placement = position?.placement ?? 'below';
  const tooltipClassName = [
    styles.realtimeModelTooltip,
    placement === 'above' ? styles.realtimeModelTooltipAbove : styles.realtimeModelTooltipBelow,
    open ? styles.realtimeModelTooltipOpen : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tooltip = (
    <span
      id={tooltipId}
      role="tooltip"
      className={tooltipClassName}
      style={isBrowser ? position?.style : undefined}
      onMouseEnter={handleTooltipMouseEnter}
      onMouseLeave={handleTooltipMouseLeave}
      onMouseDown={handleTooltipMouseDown}
    >
      <span className={`${styles.realtimeModelTooltipPrimary} ${styles.monoCell}`}>
        {`${dateText} ${timeText}`}
      </span>
    </span>
  );

  return (
    <div
      ref={triggerRef}
      className={styles.realtimeTimeCell}
      data-overflow-tooltip="time"
      tabIndex={initialTabIndex}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={show}
      onMouseLeave={requestHide}
      onFocus={showImmediately}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <span className={styles.realtimeTimeLine} data-overflow-content="true">
        {dateText}
      </span>
      <span className={styles.realtimeTimeLine} data-overflow-content="true">
        {timeText}
      </span>
      {!isBrowser ? tooltip : null}
      {isBrowser && open ? createPortal(tooltip, document.body) : null}
    </div>
  );
}

type RealtimeTooltipBubbleProps = {
  tooltipId: string;
  placement: FailureTooltipPlacement;
  open: boolean;
  style?: CSSProperties;
  lines: string[];
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onMouseDown: () => void;
};

// 浮层气泡本体：来源主名 / API Key 值两处新增单元格共用，样式沿用 RealtimeModelCell 的
// .realtimeModelTooltip 系列 class（信息类提示，非失败态红色描边），不新增一套孤立样式。
// 首行走加粗主色（对应可见但被裁切的文案本身，未截断版本），其余行走弱化灰色（对应原先
// 塞进原生 title= 的补充信息，如掩码值/哈希/执行器类型），呈现方式与 RealtimeModelCell 的
// primary/secondary 两行一致。
function RealtimeTooltipBubble({
  tooltipId,
  placement,
  open,
  style,
  lines,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
}: RealtimeTooltipBubbleProps) {
  const tooltipClassName = [
    styles.realtimeModelTooltip,
    placement === 'above' ? styles.realtimeModelTooltipAbove : styles.realtimeModelTooltipBelow,
    open ? styles.realtimeModelTooltipOpen : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      id={tooltipId}
      role="tooltip"
      className={tooltipClassName}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
    >
      {lines.map((line, index) => (
        <span
          key={`${tooltipId}-line-${index}`}
          className={
            index === 0 ? styles.realtimeModelTooltipPrimary : styles.realtimeModelTooltipSecondary
          }
        >
          {line}
        </span>
      ))}
    </span>
  );
}

type RealtimeSourceNameCellProps = {
  text: string;
  tooltipId: string;
};

// 来源第 1 行溢出感知浮层：与 RealtimeModelCell/RealtimeTimeCell 同一套 portal + fixed
// 定位手法（见 useContentTooltip）。可见文案仍由 `.realtimeTable .logTypeCell
// .primaryCell > span` 的省略号裁切（未改动该 CSS），这里 hover/focus 用未裁切的完整
// 来源名按意图延迟展开；显式 title="" 覆盖祖先 .primaryCell 上的原生 title=(该 title 承载来源
// 单元格整体的补充信息，用于兜底 hover 到本组件未覆盖的空白/元数据区域)，避免 hover 到
// 本触发元素时浏览器原生 tooltip 与本组件的 portal tooltip 同时出现。
function RealtimeSourceNameCell({ text, tooltipId }: RealtimeSourceNameCellProps) {
  const {
    triggerRef,
    open,
    position,
    show,
    showImmediately,
    requestHide,
    handleBlur,
    handleKeyDown,
    handleTooltipMouseEnter,
    handleTooltipMouseLeave,
    handleTooltipMouseDown,
    initialTabIndex,
  } = useContentTooltip<HTMLSpanElement>({ contentKey: text });
  const isBrowser = typeof document !== 'undefined';

  const bubble = (
    <RealtimeTooltipBubble
      tooltipId={tooltipId}
      placement={position?.placement ?? 'below'}
      open={open}
      style={isBrowser ? position?.style : undefined}
      lines={[text]}
      onMouseEnter={handleTooltipMouseEnter}
      onMouseLeave={handleTooltipMouseLeave}
      onMouseDown={handleTooltipMouseDown}
    />
  );

  return (
    <span
      ref={triggerRef}
      title=""
      data-overflow-tooltip="source"
      data-overflow-content="true"
      tabIndex={initialTabIndex}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={show}
      onMouseLeave={requestHide}
      onFocus={showImmediately}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <span>{text}</span>
      {!isBrowser ? bubble : null}
      {isBrowser && open ? createPortal(bubble, document.body) : null}
    </span>
  );
}

type RealtimeApiKeyValueCellProps = {
  text: string;
  tooltipLines: string[];
  tooltipId: string;
};

// API Key 值补充信息浮层：原先把掩码值/哈希/执行器类型塞进这一行自带的原生 title=，这里改用
// 同款意图延迟 portal 浮层展示同等信息，不再依赖浏览器原生 tooltip 的不可控延迟；首行是
// 可见文案本身（未截断），其余行是原来 title= 里的补充信息。显式 title="" 覆盖祖先
// .primaryCell 上的原生 title，理由同 RealtimeSourceNameCell。
function RealtimeApiKeyValueCell({ text, tooltipLines, tooltipId }: RealtimeApiKeyValueCellProps) {
  const {
    triggerRef,
    open,
    position,
    show,
    showImmediately,
    requestHide,
    handleBlur,
    handleKeyDown,
    handleTooltipMouseEnter,
    handleTooltipMouseLeave,
    handleTooltipMouseDown,
    initialTabIndex,
  } = useContentTooltip<HTMLElement>({
    requireOverflow: false,
    contentKey: `${text}\u0000${tooltipLines.join('\u0000')}`,
  });
  const isBrowser = typeof document !== 'undefined';

  const bubble = (
    <RealtimeTooltipBubble
      tooltipId={tooltipId}
      placement={position?.placement ?? 'below'}
      open={open}
      style={isBrowser ? position?.style : undefined}
      lines={tooltipLines}
      onMouseEnter={handleTooltipMouseEnter}
      onMouseLeave={handleTooltipMouseLeave}
      onMouseDown={handleTooltipMouseDown}
    />
  );

  return (
    <small
      ref={triggerRef}
      className={styles.realtimeApiKeyLine}
      title=""
      data-overflow-tooltip="api-key"
      data-overflow-content="true"
      tabIndex={initialTabIndex}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={show}
      onMouseLeave={requestHide}
      onFocus={showImmediately}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {text}
      {!isBrowser ? bubble : null}
      {isBrowser && open ? createPortal(bubble, document.body) : null}
    </small>
  );
}

// 每个 "标签 数值" 段必须作为不可断整体渲染（见下方 realtimeUsageSegment 样式），
// 否则窄列 + word-break:break-word 会把紧凑数字（如 "200.0K"）从中间断行。
// 段落之间允许换行，换行点落在相邻两个 .realtimeUsageSegment（inline-block）之间。
//
// 走查迭代：段间分隔点曾在"后缀"（行尾悬挂 "·"）与"前缀"（换行时点落到下一行段首，
// 如缓存明细行首 "· 缓存读取 140"）之间反复——二者都是"一行点串 + 换行"的固有毛病。
// 定稿：核心 token（I/O）保持 inline-block + 前缀点分隔、同排一行；明细段（推理 R /
// 缓存创建 / 缓存读取）改为各自独立成行、行首不带点（见 realtimeUsageDetailLine），
// 从根上避免换行处露出前导/悬挂点。
const buildRealtimeTokenSummary = (row: MonitoringEventRow, t: TFunction): ReactNode => {
  // 核心 token：输入/输出，inline-block、段间用前缀点连一行（窄用量列也放得下这两段）。
  const inlineParts = [
    `I ${formatCompactNumber(row.inputTokens)}`,
    `O ${formatCompactNumber(row.outputTokens)}`,
  ];
  // 明细段（推理/缓存）：各自独立成行、行首不带分隔点。走查确认核心诉求是"换行处不露点"——
  // 一行点串在窄用量列必然换行、把前缀点甩到行首（推理 R、缓存明细都会），故次要明细一律逐行、无点。
  const detailLines: string[] = [];
  if (row.reasoningTokens > 0) {
    detailLines.push(`R ${formatCompactNumber(row.reasoningTokens)}`);
  }
  // 细分缓存字段（读/写）齐全时，裸 "C"（legacy CompatibleCachedTokens）语义空洞且常为 0，不再展示；
  // 只有细分字段全为 0 而 legacy cachedTokens > 0（旧数据未拆分）时才用 "缓存 X" 兜底，避免信息丢失。
  const hasCacheBreakdown = row.cacheCreationTokens > 0 || row.cacheReadTokens > 0;
  if (!hasCacheBreakdown && row.cachedTokens > 0) {
    detailLines.push(
      `${shortLabel(t, 'monitoring.cached_tokens_short', 'monitoring.cached_tokens', 'Cached')} ${formatCompactNumber(row.cachedTokens)}`
    );
  }
  if (row.cacheCreationTokens > 0) {
    detailLines.push(
      `${shortLabel(t, 'monitoring.cache_creation_tokens_short', 'monitoring.cache_creation_tokens', 'Cache create')} ${formatCompactNumber(row.cacheCreationTokens)}`
    );
  }
  if (row.cacheReadTokens > 0) {
    detailLines.push(
      `${shortLabel(t, 'monitoring.cache_read_tokens_short', 'monitoring.cache_read_tokens', 'Cache read')} ${formatCompactNumber(row.cacheReadTokens)}`
    );
  }
  // 分隔符前导字符用不换行空格（U+00A0），而非普通空格：普通空格恰好落在
  // 本段（.realtimeUsageSegment，inline-block）自身内容的最前面，会被当成该
  // inline-block 自身内部的行首空白，被 CSS 空白折叠规则裁掉（真机走查坐实会
  // 渲染成无间距的 "620\u00b7 O 210"）；U+00A0 不参与折叠，原样保留可见间距。
  const usageSegmentSeparator = '\u00A0\u00B7 ';

  return (
    <>
      {inlineParts.map((part, index) => (
        <span key={`inline-${index}-${part}`} className={styles.realtimeUsageSegment}>
          {`${index > 0 ? usageSegmentSeparator : ''}${part}`}
        </span>
      ))}
      {detailLines.map((line, index) => (
        <span key={`detail-${index}-${line}`} className={styles.realtimeUsageDetailLine}>
          {line}
        </span>
      ))}
    </>
  );
};

// 单请求缓存命中率染色阈值：与成功率三档样式复用同一套 goodText/warnText/badText，
// 但阈值口径独立（缓存命中率天然低于成功率，不能共用 95%/85% 判定）。
// 注意：这套染色阈值(黄/红分界)与下方"仅显示低命中率" chip 的筛选阈值已解耦——
// 筛选阈值现在由用户可配置(见 lowCacheHitRateThreshold prop)，染色阈值保持固定，
// 避免用户改筛选档位时表格单元格颜色跟着意外重染色。
const REALTIME_CACHE_HIT_RATE_GOOD_THRESHOLD = 0.6;
const REALTIME_CACHE_HIT_RATE_WARN_THRESHOLD = 0.3;

const getRealtimeCacheHitRateToneClass = (rate: number | null) => {
  if (rate === null) return undefined;
  if (rate >= REALTIME_CACHE_HIT_RATE_GOOD_THRESHOLD) return styles.goodText;
  if (rate >= REALTIME_CACHE_HIT_RATE_WARN_THRESHOLD) return styles.warnText;
  return styles.badText;
};

// 阈值 0.3 -> "30%"，仅用于 UI 展示，不参与计算精度。
const formatThresholdPercentLabel = (threshold: number) => `${Math.round(threshold * 100)}%`;

type LowCacheHitRateFilterControlProps = {
  active: boolean;
  threshold: number;
  t: TFunction;
  onToggleActive: () => void;
  onThresholdChange: (threshold: number) => void;
};

// "仅显示低命中率" 筛选控件：chip 主体点击=开关筛选；chip 右侧 caret 打开阈值菜单，
// 让用户在预设档位(<50%/<30%/<10%)之间切换，或输入 0-100 之间的自定义百分比。
// 阈值本身可见（chip 文案带当前阈值），解决"不知道低于多少算低命中率"的问题。
function LowCacheHitRateFilterControl({
  active,
  threshold,
  t,
  onToggleActive,
  onThresholdChange,
}: LowCacheHitRateFilterControlProps) {
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [customError, setCustomError] = useState(false);
  const isPreset = (REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD_PRESETS as readonly number[]).includes(
    threshold
  );

  const lowCacheHitRateLabel = shortLabel(
    t,
    'monitoring.filter_low_cache_hit_rate_short',
    'monitoring.filter_low_cache_hit_rate'
  );
  const chipLabel = `${lowCacheHitRateLabel} <${formatThresholdPercentLabel(threshold)}`;
  const menuLabel = t('monitoring.filter_low_cache_hit_rate_threshold_menu_label');

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setCustomError(false);
  }, []);

  useEffect(() => {
    if (!menuOpen || typeof document === 'undefined') return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, menuOpen]);

  const handleToggleMenu = () => {
    setMenuOpen((previous) => {
      const next = !previous;
      if (next) {
        setCustomDraft(isPreset ? '' : formatThresholdPercentLabel(threshold).replace('%', ''));
        setCustomError(false);
      }
      return next;
    });
  };

  const handleSelectPreset = (preset: number) => {
    onThresholdChange(preset);
    closeMenu();
  };

  const handleCustomSubmit = () => {
    const parsedFraction = Number(customDraft) / 100;
    if (!isValidLowCacheHitRateThreshold(parsedFraction)) {
      setCustomError(true);
      return;
    }
    onThresholdChange(parsedFraction);
    closeMenu();
  };

  return (
    <div className={styles.lowCacheHitRateFilterControl} ref={containerRef}>
      <button
        type="button"
        className={[styles.filterToggleChip, active ? styles.filterToggleChipActive : '']
          .filter(Boolean)
          .join(' ')}
        onClick={onToggleActive}
        title={t('monitoring.filter_low_cache_hit_rate_hint', {
          threshold: formatThresholdPercentLabel(threshold),
        })}
      >
        <IconFilter size={14} aria-hidden="true" />
        {chipLabel}
      </button>
      <button
        type="button"
        className={[
          styles.lowCacheHitRateThresholdTrigger,
          active ? styles.filterToggleChipActive : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={handleToggleMenu}
        title={menuLabel}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
      >
        <IconChevronDown size={13} aria-hidden="true" />
      </button>
      {menuOpen ? (
        <div id={menuId} role="menu" className={styles.lowCacheHitRateThresholdMenu}>
          {REALTIME_LOW_CACHE_HIT_RATE_THRESHOLD_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="menuitemradio"
              aria-checked={preset === threshold}
              className={[
                styles.lowCacheHitRateThresholdMenuItem,
                preset === threshold ? styles.lowCacheHitRateThresholdMenuItemActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleSelectPreset(preset)}
            >
              {`<${formatThresholdPercentLabel(preset)}`}
            </button>
          ))}
          <div className={styles.lowCacheHitRateThresholdMenuCustom}>
            <label htmlFor={`${menuId}-custom`}>
              {t('monitoring.filter_low_cache_hit_rate_threshold_custom')}
            </label>
            <div className={styles.lowCacheHitRateThresholdMenuCustomInputRow}>
              <input
                id={`${menuId}-custom`}
                type="number"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                value={customDraft}
                placeholder="30"
                className={[
                  styles.lowCacheHitRateThresholdMenuCustomInput,
                  customError ? styles.lowCacheHitRateThresholdMenuCustomInputError : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onChange={(event) => {
                  setCustomDraft(event.target.value);
                  setCustomError(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleCustomSubmit();
                  }
                }}
              />
              <span>%</span>
              <button
                type="button"
                className={styles.lowCacheHitRateThresholdMenuCustomApply}
                onClick={handleCustomSubmit}
              >
                {t('common.confirm')}
              </button>
            </div>
            {customError ? (
              <span className={styles.lowCacheHitRateThresholdMenuCustomError}>
                {t('monitoring.filter_low_cache_hit_rate_threshold_custom_invalid')}
              </span>
            ) : null}
          </div>
          <p className={styles.lowCacheHitRateThresholdMenuHint}>
            {t('monitoring.filter_low_cache_hit_rate_scope_hint')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function RealtimeEventsPanelActions({
  rowCount,
  scopedFailureCount,
  failedOnlyActive,
  lowCacheHitRateOnly,
  lowCacheHitRateThreshold,
  accountDisplayMode,
  exportRows,
  hasPrices,
  t,
  onToggleFailedOnly,
  onToggleLowCacheHitRateOnly,
  onLowCacheHitRateThresholdChange,
  onAccountDisplayModeChange,
}: RealtimeEventsPanelActionsProps) {
  // 客户端导出「当前已加载/筛选的事件行」：纯前端生成 CSV/JSON Blob 后触发下载，不打服务端。
  // 说明：failedOnly 等筛选走服务端已落进 exportRows；实时表内「仅显示低命中率」是页内当前页视觉
  // 过滤，不改变 exportRows，因此导出的是完整筛选/加载结果（与旧版导出 filteredRows 全集口径一致）。
  const handleExport = (format: EventExportFormat) => {
    if (exportRows.length === 0) return;
    const content =
      format === 'csv'
        ? buildEventExportCsv(exportRows, { hasPrices })
        : buildEventExportJson(exportRows, { hasPrices });
    downloadBlob({
      filename: buildEventExportFilename(format),
      blob: new Blob([content], { type: EVENT_EXPORT_MIME[format] }),
    });
  };
  const exportDisabled = exportRows.length === 0;
  const nextAccountDisplayMode: AccountDisplayMode =
    accountDisplayMode === 'masked' ? 'full' : 'masked';
  const AccountDisplayIcon = accountDisplayMode === 'masked' ? IconEyeOff : IconEye;
  const logRowsLabel = shortLabel(t, 'monitoring.log_rows_short', 'monitoring.log_rows');
  const recentFailuresLabel = shortLabel(
    t,
    'monitoring.recent_failures_short',
    'monitoring.recent_failures'
  );
  const failedOnlyLabel = shortLabel(
    t,
    'monitoring.filter_status_failed_short',
    'monitoring.filter_status_failed'
  );
  const accountDisplayHint = t(
    accountDisplayMode === 'masked'
      ? 'monitoring.account_overview_show_full_accounts_hint'
      : 'monitoring.account_overview_show_masked_accounts_hint'
  );

  return (
    <div className={`${styles.inlineMetrics} ${styles.realtimeHeaderActions}`}>
      <span title={t('monitoring.log_rows')}>{`${logRowsLabel}: ${rowCount}`}</span>
      <span title={t('monitoring.recent_failures')}>
        {`${recentFailuresLabel}: ${scopedFailureCount}`}
      </span>
      <button
        type="button"
        className={[
          styles.accountOverviewToolButton,
          accountDisplayMode === 'full' ? styles.accountDisplayModeButtonActive : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onAccountDisplayModeChange(nextAccountDisplayMode)}
        title={accountDisplayHint}
        aria-label={accountDisplayHint}
      >
        <AccountDisplayIcon size={15} aria-hidden="true" />
        <span>
          {t(
            accountDisplayMode === 'masked'
              ? 'monitoring.account_overview_account_display_masked'
              : 'monitoring.account_overview_account_display_full'
          )}
        </span>
      </button>
      <button
        type="button"
        className={[
          styles.filterToggleChip,
          failedOnlyActive ? styles.filterToggleChipDangerActive : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={onToggleFailedOnly}
        title={t('monitoring.filter_status_failed')}
      >
        <IconFilter size={14} aria-hidden="true" />
        {failedOnlyLabel}
      </button>
      {/* "仅显示低命中率" chip 与 "仅显示失败" chip 并排在同一 inlineMetrics 行内。
          筛选状态提升到页面级(MonitoringCenterPage)统一持有，两处 chip 共享同一状态；
          阈值本身也提升到页面级并持久化，chip 旁的 caret 打开菜单可切换预设/自定义阈值。 */}
      <LowCacheHitRateFilterControl
        active={lowCacheHitRateOnly}
        threshold={lowCacheHitRateThreshold}
        t={t}
        onToggleActive={onToggleLowCacheHitRateOnly}
        onThresholdChange={onLowCacheHitRateThresholdChange}
      />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => handleExport('csv')}
        disabled={exportDisabled}
      >
        <IconDownload size={14} aria-hidden="true" />
        {t('usage_stats.export_csv')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => handleExport('json')}
        disabled={exportDisabled}
      >
        <IconDownload size={14} aria-hidden="true" />
        {t('usage_stats.export_json')}
      </Button>
    </div>
  );
}

export function RealtimeEventsPanel({
  embedded = false,
  rows,
  pagination,
  pageSize,
  scopedFailureCount,
  failedOnlyActive,
  lowCacheHitRateOnly,
  lowCacheHitRateThreshold,
  eventsHasMore,
  eventsLoadingMore,
  eventsRetentionLimited,
  eventsTotalCount,
  eventsLoadedCount,
  overallLoading,
  hasPrices,
  accountDisplayMode,
  locale,
  emptyState,
  t,
  onToggleFailedOnly,
  onToggleLowCacheHitRateOnly,
  onLowCacheHitRateThresholdChange,
  onAccountDisplayModeChange,
  onPageChange,
  onPageSizeChange,
  onLoadMoreEvents,
}: RealtimeEventsPanelProps) {
  const tooltipIdPrefix = useId();
  const showNotification = useNotificationStore((state) => state.showNotification);
  // 「查看原始请求」：以行的 core request_id 打开页内查看器 RequestLogViewer，
  // 由查看器命中 GET /request-log-by-id/{id} 取回原始 .log 文本并在网页端直接渲染 + 检索，
  // 顶部提供关键词高亮与上一处/下一处导航，底部保留「下载」。三态：无 request_id→不显示按钮
  // (下方 fallback 显示「不可溯源」)；加载中→占位；404/缺失/过保留期→查看器内报错且不登出。
  const [requestLogId, setRequestLogId] = useState<string | null>(null);
  const closeRequestLogViewer = useCallback(() => {
    setRequestLogId(null);
  }, []);
  // 精确复刻上游默认列头文案「来源 / API Key」：不再走 shortLabel 缩短成「来源」
  // （缩短是本 fork 之前为窄列让宽做的改动，现来源列宽度已还回，改回上游默认全称）。
  const sourceApiKeyLabel = t('monitoring.column_source_api_key');
  // 精确复刻上游 seakee 默认：列头文案从"强度"改为"推理/服务"（i18n key 与上游一致，
  // 不走 shortLabel 兜底——上游同样直接 t()，因为这个 key 我们已在 4 个 locale 全部补齐）；
  // 但保留 fork 特有的 TableHeaderInfo 即时浮层（上游没有，用户要求保留）。
  const reasoningServiceLabel = t('monitoring.reasoning_service_short');
  // 单元格两行各自的标签（"思考" / "服务"），同样照抄上游 key 名与文案，用于拼出
  // "{标签}: {值}" 格式的恒显文本（见下方 tbody 渲染）。
  const realtimeReasoningLabel = t('monitoring.realtime_reasoning_label');
  const realtimeServiceLabel = t('monitoring.realtime_service_label');
  const recentStatusLabel = shortLabel(
    t,
    'monitoring.recent_status_short',
    'monitoring.recent_status'
  );
  const requestStatusLabel = shortLabel(
    t,
    'monitoring.request_status_short',
    'monitoring.request_status'
  );
  const successRateLabel = shortLabel(
    t,
    'monitoring.column_success_rate_short',
    'monitoring.column_success_rate'
  );
  const totalCallsLabel = shortLabel(
    t,
    'monitoring.total_calls_short',
    'monitoring.total_calls',
    'Calls'
  );
  const usageLabel = shortLabel(
    t,
    'monitoring.this_call_usage_short',
    'monitoring.this_call_usage'
  );
  const costLabel = shortLabel(t, 'monitoring.this_call_cost_short', 'monitoring.this_call_cost');
  const cacheHitRateLabel = shortLabel(
    t,
    'monitoring.column_cache_hit_rate_short',
    'monitoring.column_cache_hit_rate'
  );
  const handleCopyFailureDetails = async (text: string) => {
    const copied = await copyToClipboard(text);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };
  // "仅显示低命中率" 筛选状态与阈值都由页面级(MonitoringCenterPage)统一持有，经 props 传入，
  // 与 "仅显示失败" chip 并排在同一行的 masthead 工具条；此处只按用户所选阈值做纯前端本地过滤，
  // 只作用于当前已加载并分页展示的行，不影响上层分页/加载更多状态（跨分页全量筛选是后续 G2b 范围）。
  const displayedRows = lowCacheHitRateOnly
    ? pagination.pageItems.filter((row) => {
        const rate = computeCacheHitRate(row);
        return rate !== null && rate < lowCacheHitRateThreshold;
      })
    : pagination.pageItems;
  const actions = (
    <RealtimeEventsPanelActions
      rowCount={rows.length}
      scopedFailureCount={scopedFailureCount}
      failedOnlyActive={failedOnlyActive}
      lowCacheHitRateOnly={lowCacheHitRateOnly}
      lowCacheHitRateThreshold={lowCacheHitRateThreshold}
      accountDisplayMode={accountDisplayMode}
      exportRows={rows}
      hasPrices={hasPrices}
      t={t}
      onToggleFailedOnly={onToggleFailedOnly}
      onToggleLowCacheHitRateOnly={onToggleLowCacheHitRateOnly}
      onLowCacheHitRateThresholdChange={onLowCacheHitRateThresholdChange}
      onAccountDisplayModeChange={onAccountDisplayModeChange}
    />
  );
  const content = (
    <>
      {/* 筛选 chip("仅显示失败" + "仅显示低命中率")统一由 masthead 工具条承载：
          embedded 模式下 MonitoringCenterPage 在页面级 masthead 渲染 RealtimeEventsPanelActions；
          非 embedded 模式(下方 MonitoringPanel)通过 `extra={actions}` 渲染同一份工具条。
          content 内不再单独放工具条，避免与 masthead 重复。 */}
      <div className={styles.tableWrapper}>
        <table className={`${styles.table} ${styles.realtimeTable}`}>
          <colgroup>
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              {/* 时间列前移到最左第 1 位（原第 10 位），列宽映射见
                  MonitoringCenterPage.module.scss 的 .realtimeTable col:nth-child(n)。 */}
              <th>{t('monitoring.column_time')}</th>
              <th>{sourceApiKeyLabel}</th>
              <th>{t('monitoring.column_model')}</th>
              <th>
                <TableHeaderInfo
                  label={reasoningServiceLabel}
                  info={t('monitoring.reasoning_tier_hint')}
                />
              </th>
              <th>{recentStatusLabel}</th>
              <th>{requestStatusLabel}</th>
              {/* 数字列(成功率/调用/TPS/缓存命中率/花费)统一右对齐，配合 tabular-nums；
                  "首字｜耗时"是成对布局，保持居中(唯一例外，见 .realtimeLatencyColumn)。 */}
              <th className={styles.realtimeNumericColumn}>
                <TableHeaderInfo
                  label={successRateLabel}
                  info={t('monitoring.realtime_success_rate_hint')}
                />
              </th>
              <th className={styles.realtimeNumericColumn}>{totalCallsLabel}</th>
              <th className={styles.realtimeNumericColumn}>{t('monitoring.column_output_tps')}</th>
              <th className={styles.realtimeLatencyColumn}>
                <span className={styles.realtimeLatencyHeader}>
                  <span className={styles.realtimeMetricLeft}>{t('monitoring.ttft_short')}</span>
                  <span className={styles.realtimeMetricSeparator}>｜</span>
                  <span className={styles.realtimeMetricRight}>
                    {t('monitoring.elapsed_short')}
                  </span>
                </span>
              </th>
              <th>
                <TableHeaderInfo label={usageLabel} info={t('monitoring.realtime_usage_hint')} />
              </th>
              {/* 缓存命中率紧跟"本次用量"列：命中率由该列 token 派生，相邻语义最贴近。 */}
              <th className={styles.realtimeNumericColumn}>
                <TableHeaderInfo
                  label={cacheHitRateLabel}
                  info={t('monitoring.realtime_cache_hit_rate_hint')}
                />
              </th>
              {/* 花费列（最后一列）走查修复：单独挂 realtimeCostCell 收窄 padding，
                  与下方 <td> 保持右缘对齐（同列共享的 .realtimeNumericColumn 右对齐），
                  见 RealtimeEventsPanel 走查记录 / .realtimeCostCell 样式注释。 */}
              <th className={`${styles.realtimeNumericColumn} ${styles.realtimeCostCell}`}>
                {costLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((row) => {
              const sourceDisplay = buildRealtimeSourceDisplay(row, t, accountDisplayMode);
              const apiKeyDisplay = buildRealtimeApiKeyDisplay(row, t);
              const showResolvedModel =
                row.resolvedModel &&
                row.resolvedModel.trim() &&
                row.resolvedModel.trim() !== row.model;
              const reasoningEffort = formatOptionalText(row.reasoningEffort);
              const serviceTier = formatOptionalText(row.serviceTier);
              const failureDetails = buildFailureDetails(row, t, locale);
              const failureTooltipId = failureDetails
                ? `${tooltipIdPrefix}-failure-tooltip-${row.id}`
                : undefined;
              const timeParts = formatRealtimeDateParts(row.timestampMs, locale);
              const hasTtftMs = row.ttftMs !== null && row.ttftMs !== undefined;
              const ttftToneClass = getRealtimeDurationToneClass(row.ttftMs);
              const latencyToneClass = getRealtimeDurationToneClass(row.latencyMs);
              const cacheHitRate = computeCacheHitRate(row);
              const cacheHitRateToneClass = getRealtimeCacheHitRateToneClass(cacheHitRate);
              return (
                <tr key={row.id} className={row.failed ? styles.logRowFailed : undefined}>
                  {/* 时间列前移到最左第 1 位（原第 10 位，紧跟在"首字｜耗时"列之后）。列窄时
                      date/time 各自省略号截断，hover/focus 用溢出感知浮层看完整时间戳
                      （见 RealtimeTimeCell，同 RealtimeModelCell 的 portal 手法）。 */}
                  <td>
                    <RealtimeTimeCell
                      dateText={timeParts.date}
                      timeText={timeParts.time}
                      tooltipId={`${tooltipIdPrefix}-time-tooltip-${row.id}`}
                    />
                  </td>
                  <td>
                    <div className={styles.logTypeCell}>
                      <div className={styles.primaryCell} title={sourceDisplay.title}>
                        <RealtimeSourceNameCell
                          text={sourceDisplay.primary}
                          tooltipId={`${tooltipIdPrefix}-source-tooltip-${row.id}`}
                        />
                        {sourceDisplay.meta ? <small>{sourceDisplay.meta}</small> : null}
                        {apiKeyDisplay ? (
                          <RealtimeApiKeyValueCell
                            text={`${t('monitoring.realtime_api_key_label')}: ${apiKeyDisplay.display}`}
                            tooltipLines={apiKeyDisplay.titleParts}
                            tooltipId={`${tooltipIdPrefix}-apikey-tooltip-${row.id}`}
                          />
                        ) : null}
                        {row.requestId ? (
                          <button
                            type="button"
                            className={styles.realtimeRequestLogTrigger}
                            onClick={() => setRequestLogId(row.requestId ?? null)}
                            title={t('monitoring.realtime_request_log_action_hint', {
                              id: row.requestId,
                            })}
                          >
                            <IconFileText size={12} aria-hidden="true" />
                            <span>{t('monitoring.realtime_request_log_action')}</span>
                          </button>
                        ) : (
                          <small
                            className={styles.realtimeRequestLogUntraceable}
                            title={t('monitoring.realtime_request_log_untraceable_hint')}
                          >
                            {t('monitoring.realtime_request_log_untraceable')}
                          </small>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    {/* 模型名较长时被 .realtimeModelText 的 12% 列宽 nowrap 省略号截断；
                        全名展示改走溢出感知浮层(见 RealtimeModelCell)，不再用原生 title=
                        (浏览器原生 tooltip 有 ~0.5-1s 不可控延迟)。 */}
                    <RealtimeModelCell
                      model={row.model}
                      resolvedModel={showResolvedModel ? row.resolvedModel : undefined}
                      tooltipId={`${tooltipIdPrefix}-model-tooltip-${row.id}`}
                    />
                  </td>
                  <td title={buildReasoningTierNativeTitle(row)}>
                    {/* 精确复刻上游 seakee 默认的"推理/服务"合并列：两行都带标签、都恒显
                        (仿上游 formatOptionalText，缺失显中性占位 —，不再像旧版那样只在
                        service_tier 存在时才渲染第 2 行)。第 1 行 "{思考标签}: {effort}"，
                        第 2 行 "{服务标签}: {tier}"；字号/字重与上游一致（12px/400），仅
                        颜色区分——第 1 行走强调色，第 2 行走弱化灰色（见 SCSS 的
                        .realtimeReasoningValue / .realtimeServiceValue），不再靠字号缩小
                        把第 2 行做成 <small>。左对齐与其它列一致。 */}
                    <div className={styles.primaryCell}>
                      <span className={styles.realtimeReasoningValue}>
                        {`${realtimeReasoningLabel}: ${reasoningEffort !== '-' ? reasoningEffort : REASONING_TIER_PLACEHOLDER}`}
                      </span>
                      <span className={styles.realtimeServiceValue}>
                        {`${realtimeServiceLabel}: ${serviceTier !== '-' ? serviceTier : REASONING_TIER_PLACEHOLDER}`}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className={styles.recentStatusCell}>
                      <RecentPattern pattern={row.recentPattern} variant="plain" />
                    </div>
                  </td>
                  <td>
                    <div className={styles.primaryCell}>
                      {failureDetails ? (
                        <RealtimeFailureStatus
                          details={failureDetails}
                          tooltipId={failureTooltipId ?? `${tooltipIdPrefix}-failure-tooltip`}
                          t={t}
                          onCopy={handleCopyFailureDetails}
                        />
                      ) : (
                        <span
                          className={[
                            styles.realtimeRequestStatus,
                            row.failed
                              ? styles.realtimeRequestStatusBad
                              : styles.realtimeRequestStatusGood,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {row.failed
                            ? t('monitoring.result_failed')
                            : t('monitoring.result_success')}
                        </span>
                      )}
                    </div>
                  </td>
                  {/* 数字列(成功率/调用/TPS/缓存命中率/花费)统一右对齐，见表头同款
                      .realtimeNumericColumn；"首字｜耗时"是成对布局，保持居中(唯一例外)。 */}
                  <td
                    className={[
                      styles.realtimeNumericColumn,
                      row.successRate >= 0.95
                        ? styles.goodText
                        : row.successRate >= 0.85
                          ? styles.warnText
                          : styles.badText,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {formatPercent(row.successRate)}
                  </td>
                  <td className={styles.realtimeNumericColumn}>
                    {formatCompactNumber(row.requestCount)}
                  </td>
                  <td className={styles.realtimeNumericColumn}>
                    <span className={styles.realtimeTpsCell}>
                      {formatTokensPerSecond(row.tokensPerSecond, locale)}
                    </span>
                  </td>
                  <td className={styles.realtimeLatencyColumn}>
                    <div className={styles.realtimeMetricCell}>
                      <span
                        className={[
                          styles.realtimeMetricText,
                          styles.realtimeMetricLeft,
                          ttftToneClass,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {hasTtftMs ? formatRealtimeCompactDuration(row.ttftMs, locale) : '--'}
                      </span>
                      <span className={styles.realtimeMetricSeparator}>｜</span>
                      <span
                        className={[
                          styles.realtimeMetricText,
                          styles.realtimeMetricRight,
                          latencyToneClass,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {formatRealtimeCompactDuration(row.latencyMs, locale)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className={styles.primaryCell}>
                      <span>{formatCompactNumber(row.totalTokens)}</span>
                      <small>{buildRealtimeTokenSummary(row, t)}</small>
                    </div>
                  </td>
                  <td
                    className={[styles.realtimeNumericColumn, cacheHitRateToneClass]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {cacheHitRate === null ? '--' : formatPercent(cacheHitRate)}
                  </td>
                  {/* 花费列走查修复：该列 4%(48px)是所有数字列中最窄的一列，"$0.00" 级
                      取值在共享 16px 继承字号下实测已超出内容区、又恰好是最后一列，会
                      顶着 .table.realtimeTable tbody td 的 overflow:visible 画出行卡片
                      右侧圆角边界外（窄屏横滚到底更会把该行可滚动范围额外撑宽几像素，
                      滚到底后露出圆角外一小段面板底色）。realtimeCostCell 收窄字号/
                      padding 腾出内容区（真机验证覆盖到两位数美元 $99.99 不截断），
                      极端大额走省略号 + title 兜底可见完整值。 */}
                  <td
                    className={`${styles.realtimeNumericColumn} ${styles.realtimeCostCell}`}
                    title={hasPrices ? formatUsd(row.totalCost) : undefined}
                  >
                    {hasPrices ? formatUsd(row.totalCost) : '--'}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={13}>{emptyState}</td>
              </tr>
            ) : null}
            {rows.length > 0 && displayedRows.length === 0 ? (
              <tr>
                <td colSpan={13}>{emptyState}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <PaginationControls
        count={rows.length}
        currentPage={pagination.currentPage}
        totalPages={pagination.totalPages}
        startItem={pagination.startItem}
        endItem={pagination.endItem}
        pageSize={pageSize}
        pageSizeOptions={REALTIME_PAGE_SIZE_OPTIONS}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        t={t}
      />
      {rows.length > 0 ? (
        <div className={styles.loadMoreEventsBar}>
          <span className={styles.loadMoreEventsSummary}>
            {eventsRetentionLimited
              ? t('monitoring.events_retention_limited', {
                  loaded: eventsLoadedCount,
                  total: eventsTotalCount,
                })
              : eventsHasMore
                ? t('monitoring.events_loaded_summary', {
                    loaded: eventsLoadedCount,
                    total: eventsTotalCount,
                  })
                : t('monitoring.events_all_loaded', { total: eventsTotalCount })}
          </span>
          {eventsHasMore ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onLoadMoreEvents}
              disabled={eventsLoadingMore || overallLoading}
            >
              {eventsLoadingMore ? t('common.loading') : t('monitoring.load_more_events')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <RequestLogViewer
        open={Boolean(requestLogId)}
        requestId={requestLogId}
        t={t}
        onClose={closeRequestLogViewer}
        onNotify={showNotification}
      />
    </>
  );

  if (embedded) {
    return content;
  }

  return (
    <MonitoringPanel
      title={t('monitoring.realtime_table_title')}
      subtitle={t('monitoring.realtime_table_desc')}
      className={styles.realtimePanel}
      extra={actions}
    >
      {content}
    </MonitoringPanel>
  );
}
