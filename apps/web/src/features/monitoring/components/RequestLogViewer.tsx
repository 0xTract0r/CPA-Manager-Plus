import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconChevronDown, IconChevronUp, IconDownload, IconSearch } from '@/components/ui/icons';
import { logsApi } from '@/services/api/logs';
import type { NotificationType } from '@/types';
import { downloadBlob } from '@/utils/download';
import { VirtualLogView, type VirtualLogActiveMatch } from './VirtualLogView';
import styles from '../MonitoringCenterPage.module.scss';

export type RequestLogViewerProps = {
  open: boolean;
  requestId: string | null;
  t: TFunction;
  onClose: () => void;
  onNotify?: (message: string, type: NotificationType) => void;
};

type ViewerStatus = 'idle' | 'loading' | 'loaded' | 'error';

type TextSegment = {
  text: string;
  match: boolean;
};

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err !== 'object' || err === null || !('message' in err)) return '';
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

// D1 大日志分档阈值（可调常量）：
//   - < SMALL_MAX：沿用原生 <pre> + 整份原文一次性切 segments 高亮（原实现，未改动）。
//   - SMALL_MAX ~ VIRTUAL_MAX：按行窗口化渲染（VirtualLogView），只渲染可视窗口。
//   - >= VIRTUAL_MAX：同样窗口化，但只取前 VIRTUAL_MAX 字节 / 前 VIRTUAL_MAX_LINES 行，
//     顶部提示「内容过大，已截断」，完整内容靠下方「下载」按钮取原始文件。
const SMALL_MAX = 64 * 1024;
const VIRTUAL_MAX = 2 * 1024 * 1024;
const VIRTUAL_MAX_LINES = 50_000;

type ViewerMode = 'inline' | 'virtual';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 窗口化模式下的检索：只惰性算出「命中所在的行号」列表（文档序），不把整份原文
// map 成 segments/DOM。真正的逐字符高亮只在 VirtualLogView 里对「当前渲染窗口」
// 内的那几十行现算，成本不随文档大小增长。
const computeLineMatchIndices = (lines: string[], term: string): number[] => {
  if (!term) return [];
  const regex = new RegExp(escapeRegExp(term), 'gi');
  const indices: number[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) continue;
    regex.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = regex.exec(line)) !== null) {
      indices.push(lineIndex);
      // term 非空时不会零宽匹配，这里仍做兜底防止 lastIndex 停滞导致死循环。
      if (hit[0].length === 0) regex.lastIndex += 1;
    }
  }
  return indices;
};

// 把整份原文按检索词切成「命中/非命中」片段。刻意在整段文本上一次性切分（不是逐行），
// 这样换行符会原样留在非命中片段里，交给 <pre> 的 white-space 规则保留换行与缩进。
const buildSegments = (text: string, term: string): TextSegment[] => {
  if (!term) return [{ text, match: false }];
  const regex = new RegExp(escapeRegExp(term), 'gi');
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = regex.exec(text)) !== null) {
    if (hit.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, hit.index), match: false });
    }
    segments.push({ text: hit[0], match: true });
    lastIndex = hit.index + hit[0].length;
    // 理论上 term 非空时不会零宽匹配，这里仍做兜底防止 lastIndex 停滞导致死循环。
    if (hit[0].length === 0) regex.lastIndex += 1;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), match: false });
  }
  return segments;
};

export function RequestLogViewer({ open, requestId, t, onClose, onNotify }: RequestLogViewerProps) {
  const [status, setStatus] = useState<ViewerStatus>('idle');
  const [text, setText] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [term, setTerm] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const activeMatchRef = useRef<HTMLElement | null>(null);
  // 记录「当前最新请求」，await 回来后若已切走则丢弃过期结果，避免快速切换 request_id 时旧响应覆盖新内容。
  const activeRequestRef = useRef<string | null>(null);

  // 取数集中在一个 async 回调里（与仓库既有 fetch effect 惯例一致，避免在 effect 主体同步 setState）。
  // 命中同一 /request-log-by-id/{id} 端点，文本形式返回。404 / 文件缺失 / 过保留期落到 error 态，
  // 只在查看器内报错，绝不登出（404 非 401，不会触发 client.ts 的 unauthorized 事件）。
  const loadRequestLog = useCallback(async (id: string) => {
    activeRequestRef.current = id;
    setStatus('loading');
    setText('');
    setErrorMessage('');
    setTerm('');
    setActiveIndex(0);
    try {
      const raw = await logsApi.getRequestLogTextById(id);
      if (activeRequestRef.current !== id) return;
      setText(raw);
      setStatus('loaded');
    } catch (err: unknown) {
      if (activeRequestRef.current !== id) return;
      setErrorMessage(getErrorMessage(err));
      setStatus('error');
    }
  }, []);

  // 打开或切换 request_id 时重新取数。这是「用外部数据源同步 React 状态」的正当 effect：
  // 触发一次拉取并把 loading/text/error 落到本地态；同步 setState 只发生在被调用的 async 回调里，
  // 与仓库既有做法(见 DropdownMenu 的定位 effect)一致。
  useEffect(() => {
    if (!open || !requestId) return;
    void loadRequestLog(requestId);
  }, [loadRequestLog, open, requestId]);

  // D1 分档：< SMALL_MAX 走原生 <pre> 整份高亮（inline）；否则走窗口化渲染（virtual）。
  const mode: ViewerMode = text.length < SMALL_MAX ? 'inline' : 'virtual';

  // inline 模式：与改动前完全一致的整份原文 segments 高亮。virtual 模式下不构建
  // segments（避免把整份大文本一次性 map 成 span 数组），直接给空数组。
  const segments = useMemo(() => (mode === 'inline' ? buildSegments(text, term) : []), [
    mode,
    text,
    term,
  ]);
  const inlineTotalMatches = useMemo(
    () => segments.reduce((n, seg) => n + (seg.match ? 1 : 0), 0),
    [segments]
  );

  // virtual 模式：只在 >= VIRTUAL_MAX 时截断（按字节数、再按行数兜底），避免单行
  // 极短导致行数爆炸；不截断时按原文直接切行，渲染仍是窗口化的，不受行数影响。
  const isSizeTruncated = mode === 'virtual' && text.length > VIRTUAL_MAX;
  const virtualBaseText = useMemo(() => {
    if (mode !== 'virtual') return '';
    return isSizeTruncated ? text.slice(0, VIRTUAL_MAX) : text;
  }, [mode, isSizeTruncated, text]);
  const virtualLinesResult = useMemo(() => {
    if (mode !== 'virtual') return { lines: [] as string[], lineTruncated: false };
    const allLines = virtualBaseText.split('\n');
    if (allLines.length > VIRTUAL_MAX_LINES) {
      return { lines: allLines.slice(0, VIRTUAL_MAX_LINES), lineTruncated: true };
    }
    return { lines: allLines, lineTruncated: false };
  }, [mode, virtualBaseText]);
  const virtualLines = virtualLinesResult.lines;
  const isTruncated = isSizeTruncated || virtualLinesResult.lineTruncated;

  const virtualMatchLineIndices = useMemo(
    () => (mode === 'virtual' ? computeLineMatchIndices(virtualLines, term) : []),
    [mode, virtualLines, term]
  );

  const totalMatches = mode === 'inline' ? inlineTotalMatches : virtualMatchLineIndices.length;
  const safeActiveIndex = totalMatches > 0 ? Math.min(activeIndex, totalMatches - 1) : -1;

  // virtual 模式下「当前命中」定位：先找到它落在第几行，再算它是该行内第几个命中
  // （用于让 VirtualLogView 只把这一行内对应的那个 <mark> 标成 active，其余原样高亮）。
  const activeVirtualLineIndex =
    mode === 'virtual' && safeActiveIndex >= 0 ? virtualMatchLineIndices[safeActiveIndex] : null;
  const activeVirtualOccurrenceInLine = useMemo(() => {
    if (activeVirtualLineIndex === null) return 0;
    let count = 0;
    for (
      let i = safeActiveIndex - 1;
      i >= 0 && virtualMatchLineIndices[i] === activeVirtualLineIndex;
      i -= 1
    ) {
      count += 1;
    }
    return count;
  }, [virtualMatchLineIndices, safeActiveIndex, activeVirtualLineIndex]);
  // 用 useMemo 稳定对象引用：VirtualLogView 只在「目标行/命中序号」真正变化时才
  // 重新滚动定位，不会因父组件无关重渲染（引用变了但值没变）而意外跳动。
  const activeVirtualMatch = useMemo<VirtualLogActiveMatch | null>(() => {
    if (activeVirtualLineIndex === null) return null;
    return { lineIndex: activeVirtualLineIndex, occurrenceInLine: activeVirtualOccurrenceInLine };
  }, [activeVirtualLineIndex, activeVirtualOccurrenceInLine]);

  // 「当前命中」变化时把它滚动进可视区。只对 inline 模式的 <mark ref> 生效；
  // 仅浏览器执行，node 测试环境无 DOM，直接跳过。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = activeMatchRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [safeActiveIndex, term, text]);

  const goToPrev = useCallback(() => {
    if (totalMatches === 0) return;
    setActiveIndex((current) => {
      const base = current < 0 ? 0 : current;
      return (base - 1 + totalMatches) % totalMatches;
    });
  }, [totalMatches]);

  const goToNext = useCallback(() => {
    if (totalMatches === 0) return;
    setActiveIndex((current) => {
      const base = current < 0 ? 0 : current;
      return (base + 1) % totalMatches;
    });
  }, [totalMatches]);

  // 下载「完整原始请求」：始终打 /request-log-by-id/{id} 的 blob 端点重新取一份完整
  // 字节，不是把（可能已被 D1 截断展示的）已加载 text 状态重新编码成 Blob——这样无论
  // 查看器里显示的是 <64KB 全量、64KB~2MB 窗口化、还是 >=2MB 截断预览，下载到的都是
  // 服务端原始完整内容，与 LogsPage 的 downloadErrorLog 走同一取数模式。
  const handleDownload = useCallback(async () => {
    if (status !== 'loaded' || !requestId) return;
    setDownloading(true);
    try {
      const response = await logsApi.downloadRequestLogById(requestId);
      const blob =
        response.data instanceof Blob
          ? response.data
          : new Blob([response.data], { type: 'text/plain' });
      downloadBlob({ filename: `request-${requestId}.log`, blob });
      onNotify?.(t('monitoring.request_log_download_success'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      onNotify?.(
        `${t('monitoring.request_log_download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setDownloading(false);
    }
  }, [onNotify, requestId, status, t]);

  const highlighted = useMemo<ReactNode>(() => {
    if (!term) return text;
    let matchCursor = -1;
    return segments.map((segment, index) => {
      if (!segment.match) {
        return <span key={index}>{segment.text}</span>;
      }
      matchCursor += 1;
      const isActive = matchCursor === safeActiveIndex;
      return (
        <mark
          key={index}
          ref={isActive ? activeMatchRef : undefined}
          data-active={isActive ? 'true' : undefined}
          className={[
            styles.requestLogViewerMatch,
            isActive ? styles.requestLogViewerMatchActive : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {segment.text}
        </mark>
      );
    });
  }, [safeActiveIndex, segments, term, text]);

  const matchStatusLabel =
    totalMatches > 0
      ? t('monitoring.request_log_viewer_match_count', {
          current: safeActiveIndex + 1,
          total: totalMatches,
        })
      : term
        ? t('monitoring.request_log_viewer_no_match')
        : '';

  const canNavigate = status === 'loaded' && totalMatches > 0;
  const canDownload = status === 'loaded';
  const isEmptyLog = status === 'loaded' && text.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={880}
      className={styles.requestLogViewerModal}
      title={
        requestId
          ? t('monitoring.request_log_viewer_title', { id: requestId })
          : t('monitoring.request_log_download_title')
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button onClick={handleDownload} disabled={!canDownload} loading={downloading}>
            <span className={styles.requestLogViewerDownloadLabel}>
              <IconDownload size={15} aria-hidden="true" />
              {t('monitoring.request_log_viewer_download')}
            </span>
          </Button>
        </>
      }
    >
      <div className={styles.requestLogViewer}>
        <div className={styles.requestLogViewerToolbar}>
          <span className={styles.requestLogViewerSearch}>
            <IconSearch size={15} aria-hidden="true" className={styles.requestLogViewerSearchIcon} />
            <input
              type="search"
              className={styles.requestLogViewerSearchInput}
              placeholder={t('monitoring.request_log_viewer_search_placeholder')}
              value={term}
              disabled={status !== 'loaded'}
              onChange={(event) => {
                // 改变检索词时把「当前命中」跳回第一处；在事件处理里做，避免 effect 内同步 setState。
                setTerm(event.target.value);
                setActiveIndex(0);
              }}
              aria-label={t('monitoring.request_log_viewer_search_placeholder')}
            />
          </span>
          <span
            className={styles.requestLogViewerMatchStatus}
            aria-live="polite"
            role="status"
          >
            {matchStatusLabel}
          </span>
          <span className={styles.requestLogViewerNav}>
            <button
              type="button"
              className={styles.requestLogViewerNavButton}
              onClick={goToPrev}
              disabled={!canNavigate}
              title={t('monitoring.request_log_viewer_prev')}
              aria-label={t('monitoring.request_log_viewer_prev')}
            >
              <IconChevronUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.requestLogViewerNavButton}
              onClick={goToNext}
              disabled={!canNavigate}
              title={t('monitoring.request_log_viewer_next')}
              aria-label={t('monitoring.request_log_viewer_next')}
            >
              <IconChevronDown size={15} aria-hidden="true" />
            </button>
          </span>
        </div>
        {status === 'loading' || status === 'idle' ? (
          <p className={styles.requestLogViewerState}>
            {t('monitoring.request_log_viewer_loading')}
          </p>
        ) : status === 'error' ? (
          <p className={styles.requestLogViewerError} role="alert">
            {`${t('monitoring.request_log_download_failed')}${
              errorMessage ? `: ${errorMessage}` : ''
            }`}
          </p>
        ) : isEmptyLog ? (
          <p className={styles.requestLogViewerState}>
            {t('monitoring.request_log_viewer_empty')}
          </p>
        ) : mode === 'inline' ? (
          <pre className={styles.requestLogViewerBody} tabIndex={0}>
            {highlighted}
          </pre>
        ) : (
          <>
            {isTruncated ? (
              <p className={styles.requestLogViewerTruncatedNotice} role="note">
                {t('monitoring.request_log_viewer_truncated_notice', {
                  lines: virtualLines.length,
                })}
              </p>
            ) : null}
            <VirtualLogView lines={virtualLines} term={term} activeMatch={activeVirtualMatch} />
          </>
        )}
      </div>
    </Modal>
  );
}
