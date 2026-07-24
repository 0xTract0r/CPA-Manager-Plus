import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconChevronDown, IconChevronUp, IconDownload, IconSearch } from '@/components/ui/icons';
import { logsApi } from '@/services/api/logs';
import type { NotificationType } from '@/types';
import { downloadBlob } from '@/utils/download';
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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  // 与仓库既有做法(见 DropdownMenu 的定位 effect)一致，故在此显式豁免该性能建议规则。
  useEffect(() => {
    if (!open || !requestId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRequestLog(requestId);
  }, [loadRequestLog, open, requestId]);

  const segments = useMemo(() => buildSegments(text, term), [text, term]);
  const totalMatches = useMemo(() => segments.reduce((n, seg) => n + (seg.match ? 1 : 0), 0), [
    segments,
  ]);
  const safeActiveIndex = totalMatches > 0 ? Math.min(activeIndex, totalMatches - 1) : -1;

  // 「当前命中」变化时把它滚动进可视区。仅浏览器执行；node 测试环境无 DOM，直接跳过。
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

  const handleDownload = useCallback(() => {
    if (status !== 'loaded' || !requestId) return;
    try {
      downloadBlob({
        filename: `request-${requestId}.log`,
        blob: new Blob([text], { type: 'text/plain' }),
      });
      onNotify?.(t('monitoring.request_log_download_success'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      onNotify?.(
        `${t('monitoring.request_log_download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    }
  }, [onNotify, requestId, status, t, text]);

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
          <Button onClick={handleDownload} disabled={!canDownload}>
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
        ) : (
          <pre className={styles.requestLogViewerBody} tabIndex={0}>
            {highlighted}
          </pre>
        )}
      </div>
    </Modal>
  );
}
