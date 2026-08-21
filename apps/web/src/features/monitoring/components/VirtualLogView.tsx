import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from '../MonitoringCenterPage.module.scss';

// 大文件溯源日志的轻量窗口化渲染：只用于 RequestLogViewer 的中/大文件分档
// （64KB~2MB 直接渲染、>2MB 截断后渲染），绝不把整份原文一次性 map 成 DOM 节点。
// 仓库未引入 react-window / react-virtuoso / @tanstack/react-virtual 等依赖，
// 这里按固定行高手写一个够用的窗口化方案：
//   - 按 "\n" 切行，只渲染「可视行 + 上下 overscan」，用 padding 撑出正确的
//     总滚动高度（比 position:absolute 逐行定位实现更简单，足够满足本场景）。
//   - 检索命中只在「当前渲染窗口」内建 <mark>，命中总数/命中行索引由调用方
//     惰性预计算好后通过 activeMatch 传入；本组件只负责渲染与「滚到目标行」。

export type VirtualLogActiveMatch = {
  lineIndex: number;
  occurrenceInLine: number;
};

export type VirtualLogViewProps = {
  lines: string[];
  term: string;
  activeMatch: VirtualLogActiveMatch | null;
};

type LineSegment = { text: string; match: boolean };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 单行内检索高亮切分：与 RequestLogViewer 里给整份原文用的 buildSegments 同一思路，
// 但只作用于「一行」（至多几百字符），成本随可视行数而非文档总大小增长。
const buildLineSegments = (line: string, term: string): LineSegment[] => {
  if (!term) return [{ text: line, match: false }];
  const regex = new RegExp(escapeRegExp(term), 'gi');
  const segments: LineSegment[] = [];
  let lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = regex.exec(line)) !== null) {
    if (hit.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, hit.index), match: false });
    }
    segments.push({ text: hit[0], match: true });
    lastIndex = hit.index + hit[0].length;
    // term 非空时不会零宽匹配，这里仍做兜底防止 lastIndex 停滞导致死循环。
    if (hit[0].length === 0) regex.lastIndex += 1;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), match: false });
  }
  return segments;
};

// 给「命中片段」按行内出现顺序编号（0-based，非命中片段记 -1），用于和 activeOccurrence
// 比对定位「当前命中」。提取成组件外的纯函数（在此处用局部可变计数器），避免在
// 组件渲染体内对外层变量做可变计数——那种写法会被 react-hooks/immutability 规则拦截。
const buildMatchIndices = (segments: LineSegment[]): number[] => {
  let cursor = -1;
  return segments.map((segment) => {
    if (!segment.match) return -1;
    cursor += 1;
    return cursor;
  });
};

// 固定行高：虚拟滚动的总高度/窗口计算都依赖它，唯一真源在这个 JS 常量上——
// 每行的 height/line-height 都通过内联 style 用它来赋值，SCSS 侧不重复一份数字，
// 避免两处漂移不同步。也因为固定行高，虚拟滚动区不能像小文件那样自动换行
// （white-space: pre-wrap 会让一行占据不确定的视觉行数），改为不换行 + 容器整体
// 横向滚动，是大文件性能与「和小文件一致的自动换行阅读体验」之间的取舍。
const ROW_HEIGHT = 20;
const OVERSCAN_ROWS = 20;

type LineRowProps = {
  line: string;
  term: string;
  activeOccurrence: number; // -1 表示本行没有「当前命中」
};

function LineRow({ line, term, activeOccurrence }: LineRowProps) {
  const rowStyle = { height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` };
  const segments = useMemo(() => buildLineSegments(line, term), [line, term]);
  const matchIndices = useMemo(() => buildMatchIndices(segments), [segments]);

  if (!term) {
    return (
      <div className={styles.requestLogViewerVirtualRow} style={rowStyle}>
        {line.length ? line : ' '}
      </div>
    );
  }

  return (
    <div className={styles.requestLogViewerVirtualRow} style={rowStyle}>
      {segments.map((segment, index) => {
        if (!segment.match) {
          return <span key={index}>{segment.text}</span>;
        }
        const isActive = matchIndices[index] === activeOccurrence;
        return (
          <mark
            key={index}
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
      })}
    </div>
  );
}

export function VirtualLogView({ lines, term, activeMatch }: VirtualLogViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // 用真实渲染高度算每屏能放几行；no-op fallback（OVERSCAN_ROWS*2 行）只在
  // ResizeObserver 还没上报第一次测量结果前短暂生效。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const updateHeight = () => setViewportHeight(el.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // 命中导航：只把「当前命中」所在行滚动进可视区（不在视区内才滚，已可见则不动），
  // 不重排整份内容。activeMatch 由调用方 useMemo 稳定引用，只有目标行真正变化时才
  // 触发，避免父组件无关重渲染导致意外跳动。
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeMatch) return;
    const targetTop = activeMatch.lineIndex * ROW_HEIGHT;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    if (targetTop < viewTop || targetTop + ROW_HEIGHT > viewBottom) {
      el.scrollTop = Math.max(0, targetTop - el.clientHeight / 2);
    }
  }, [activeMatch]);

  const totalHeight = lines.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const visibleCount =
    viewportHeight > 0
      ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2
      : OVERSCAN_ROWS * 2;
  const endIndex = Math.min(lines.length, startIndex + visibleCount);
  const paddingTop = startIndex * ROW_HEIGHT;
  const paddingBottom = Math.max(0, totalHeight - endIndex * ROW_HEIGHT);
  const visibleLines = lines.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className={styles.requestLogViewerVirtual}
      onScroll={handleScroll}
      tabIndex={0}
    >
      <div style={{ paddingTop, paddingBottom }}>
        {visibleLines.map((line, offset) => {
          const lineIndex = startIndex + offset;
          const isActiveLine = activeMatch?.lineIndex === lineIndex;
          return (
            <LineRow
              key={lineIndex}
              line={line}
              term={term}
              activeOccurrence={isActiveLine ? activeMatch!.occurrenceInLine : -1}
            />
          );
        })}
      </div>
    </div>
  );
}
