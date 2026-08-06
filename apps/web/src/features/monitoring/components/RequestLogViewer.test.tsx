import { type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AxiosResponse } from 'axios';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { logsApi } from '@/services/api/logs';
import { downloadBlob } from '@/utils/download';
import styles from '../MonitoringCenterPage.module.scss';
import { RequestLogViewer } from './RequestLogViewer';

vi.mock('@/services/api/logs', () => ({
  logsApi: {
    getRequestLogTextById: vi.fn(),
    downloadRequestLogById: vi.fn(),
  },
}));

// 下载走独立的 blob 端点重取原始字节，与页内展示用的 text 状态完全解耦。真正的
// downloadBlob 会摸 window.URL.createObjectURL / document.createElement，这里的 vitest
// 环境是纯 Node（无 jsdom），mock 掉它只验证"被正确调用"，不执行真实的浏览器侧下载副作用。
vi.mock('@/utils/download', () => ({
  downloadBlob: vi.fn(),
}));

// 用简易容器替换 Modal，避免 react-test-renderer(无 DOM)碰到 createPortal / document。
vi.mock('@/components/ui/Modal', () => ({
  Modal: (props: { open: boolean; children: ReactNode; footer?: ReactNode; title?: ReactNode }) =>
    props.open ? (
      <div>
        <div>{props.title}</div>
        <div>{props.children}</div>
        <div>{props.footer}</div>
      </div>
    ) : null,
}));

const getTextMock = vi.mocked(logsApi.getRequestLogTextById);
const downloadMock = vi.mocked(logsApi.downloadRequestLogById);
const downloadBlobMock = vi.mocked(downloadBlob);

const t = ((key: string, options?: Record<string, unknown>) => {
  const messages: Record<string, string> = {
    'common.close': 'Close',
    'monitoring.request_log_download_title': 'View raw request',
    'monitoring.request_log_download_failed': 'Failed to fetch the raw request',
    'monitoring.request_log_download_success': 'Raw request log downloaded',
    'monitoring.request_log_viewer_title': 'Raw request · {{id}}',
    'monitoring.request_log_viewer_search_placeholder': 'Search within the raw text',
    'monitoring.request_log_viewer_match_count': '{{current}} / {{total}}',
    'monitoring.request_log_viewer_no_match': 'No matches',
    'monitoring.request_log_viewer_prev': 'Previous match',
    'monitoring.request_log_viewer_next': 'Next match',
    'monitoring.request_log_viewer_loading': 'Loading the raw request',
    'monitoring.request_log_viewer_empty': 'The raw request log is empty.',
    'monitoring.request_log_viewer_download': 'Download',
    // 真实文案取自 src/i18n/locales/en.json；这里必须映射到真实翻译（而非缺省回退到原始
    // key），用来回归守护"截断提示误渲染成原始 i18n key 字面量"的问题。
    'monitoring.request_log_viewer_truncated_notice':
      'Content too large — showing the first {{lines}} lines. Download the full request below.',
  };
  let message = messages[key] ?? key;
  if (options) {
    message = message.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String((options as Record<string, unknown>)[name] ?? '')
    );
  }
  return message;
}) as unknown as TFunction;

const sampleText = [
  'POST /v1/messages',
  '{"role":"user","content":"needle in body"}',
  'status: 200',
  'needle appears twice: needle',
  'Case check: Needle',
].join('\n');

// D1 大日志分档阈值的测试侧镜像（64KB / 2MB，与 RequestLogViewer.tsx 顶部注释一致）。
// 不从组件反向 import 内部常量，只用同样的数值构造跨越阈值的样本文本，保持测试与实现
// 解耦——阈值本身是产品需求的一部分，变了理应连带更新这份用例。
const SMALL_MAX_BYTES = 64 * 1024;
const VIRTUAL_MAX_BYTES = 2 * 1024 * 1024;

const buildLines = (count: number, template: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => template(index)).join('\n');

const findVirtualContainer = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) => node.type === 'div' && node.props.className === styles.requestLogViewerVirtual
  );

const findVirtualRows = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) => node.type === 'div' && node.props.className === styles.requestLogViewerVirtualRow
  );

const findTruncationNotice = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => Boolean(node.props) && node.props.role === 'note');

type Harness = {
  renderer: ReactTestRenderer;
  onNotify: ReturnType<typeof vi.fn>;
  setSearch: (value: string) => Promise<void>;
  clickNav: (label: 'Previous match' | 'Next match') => Promise<void>;
  clickDownload: () => Promise<void>;
  matchStatus: () => string;
  activeMatchIndex: () => number;
  markTexts: () => string[];
  downloadDisabled: () => boolean | undefined;
  json: () => string;
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const mount = async (open = true, requestId: string | null = 'req-1'): Promise<Harness> => {
  let renderer!: ReactTestRenderer;
  const onClose = vi.fn();
  const onNotify = vi.fn();
  await act(async () => {
    renderer = create(
      <RequestLogViewer
        open={open}
        requestId={requestId}
        t={t}
        onClose={onClose}
        onNotify={onNotify}
      />
    );
  });
  await flush();

  const findNav = (label: string) =>
    renderer.root.find(
      (node) =>
        node.type === 'button' &&
        typeof node.props.className === 'string' &&
        node.props.className.includes(styles.requestLogViewerNavButton) &&
        node.props['aria-label'] === label
    );

  const findDownloadButton = () =>
    renderer.root
      .findAllByType(Button)
      .find((button) => typeof button.props.children !== 'string');

  return {
    renderer,
    onNotify,
    setSearch: async (value: string) => {
      const input = renderer.root.findByType('input');
      await act(async () => {
        input.props.onChange({ target: { value } });
      });
      await flush();
    },
    clickNav: async (label) => {
      const button = findNav(label);
      await act(async () => {
        button.props.onClick();
      });
      await flush();
    },
    clickDownload: async () => {
      const button = findDownloadButton();
      await act(async () => {
        button?.props.onClick();
      });
      await flush();
    },
    matchStatus: () => {
      const status = renderer.root.find(
        (node) => Boolean(node.props) && node.props.role === 'status'
      );
      return String(status.props.children ?? '');
    },
    activeMatchIndex: () =>
      renderer.root
        .findAllByType('mark')
        .findIndex((mark) => mark.props['data-active'] === 'true'),
    markTexts: () =>
      renderer.root.findAllByType('mark').map((mark) => String(mark.props.children ?? '')),
    downloadDisabled: () => {
      const downloadButton = renderer.root
        .findAllByType(Button)
        .find((button) => typeof button.props.children !== 'string');
      return downloadButton?.props.disabled;
    },
    json: () => JSON.stringify(renderer.toJSON()),
  };
};

describe('RequestLogViewer', () => {
  beforeEach(() => {
    getTextMock.mockReset();
    downloadMock.mockReset();
    downloadBlobMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and renders the raw request text in a monospace body', async () => {
    getTextMock.mockResolvedValueOnce(sampleText);
    const harness = await mount();

    expect(getTextMock).toHaveBeenCalledTimes(1);
    expect(getTextMock).toHaveBeenCalledWith('req-1');
    const pre = harness.renderer.root.findByType('pre');
    // 无检索词时正文原样渲染为单一字符串，保留换行交给 <pre> 处理。
    expect(pre.props.children).toBe(sampleText);
    expect(pre.props.className).toContain(styles.requestLogViewerBody);
    // 下载按钮在加载成功后可用。
    expect(harness.downloadDisabled()).toBe(false);
  });

  it('shows a loading placeholder before the fetch resolves', async () => {
    let resolveText: (value: string) => void = () => undefined;
    getTextMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveText = resolve;
        })
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <RequestLogViewer open requestId="req-1" t={t} onClose={vi.fn()} onNotify={vi.fn()} />
      );
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('Loading the raw request');
    expect(renderer.root.findAllByType('pre')).toHaveLength(0);

    await act(async () => {
      resolveText(sampleText);
      await Promise.resolve();
    });
  });

  it('highlights case-insensitive matches and reports the match count', async () => {
    getTextMock.mockResolvedValueOnce(sampleText);
    const harness = await mount();

    await harness.setSearch('needle');

    const marks = harness.markTexts();
    // 命中：body 里 1 处 + 第 4 行 2 处 + 第 5 行 "Needle"(大小写不敏感) 1 处 = 4 处。
    expect(marks).toHaveLength(4);
    expect(marks).toContain('Needle');
    expect(harness.matchStatus()).toBe('1 / 4');
    // 首个命中默认为当前命中(索引 0)。
    expect(harness.activeMatchIndex()).toBe(0);
    harness.renderer.root
      .findAllByType('mark')
      .forEach((mark) => expect(mark.props.className).toContain(styles.requestLogViewerMatch));
  });

  it('navigates between matches with next/previous and wraps around', async () => {
    getTextMock.mockResolvedValueOnce(sampleText);
    const harness = await mount();
    await harness.setSearch('needle');

    await harness.clickNav('Next match');
    expect(harness.matchStatus()).toBe('2 / 4');
    expect(harness.activeMatchIndex()).toBe(1);

    await harness.clickNav('Previous match');
    expect(harness.matchStatus()).toBe('1 / 4');
    expect(harness.activeMatchIndex()).toBe(0);

    // 从第 1 处再上一处应回环到最后一处。
    await harness.clickNav('Previous match');
    expect(harness.matchStatus()).toBe('4 / 4');
    expect(harness.activeMatchIndex()).toBe(3);
  });

  it('reports no matches when the search term is absent from the text', async () => {
    getTextMock.mockResolvedValueOnce(sampleText);
    const harness = await mount();

    await harness.setSearch('this-token-is-not-present');

    expect(harness.markTexts()).toHaveLength(0);
    expect(harness.matchStatus()).toBe('No matches');
  });

  it('surfaces a 404 in the viewer without logging out and disables download', async () => {
    getTextMock.mockRejectedValueOnce(new Error('Request failed with status code 404'));
    const harness = await mount();

    const json = harness.json();
    expect(json).toContain('Failed to fetch the raw request');
    expect(json).toContain('404');
    // 错误态不渲染正文，也不提供可用下载。
    expect(harness.renderer.root.findAllByType('pre')).toHaveLength(0);
    expect(harness.downloadDisabled()).toBe(true);
  });

  it('shows an empty-state message when the raw log is empty', async () => {
    getTextMock.mockResolvedValueOnce('');
    const harness = await mount();

    expect(harness.json()).toContain('The raw request log is empty.');
    expect(harness.renderer.root.findAllByType('pre')).toHaveLength(0);
  });

  describe('D1 大日志分档：内联 / 虚拟窗口化 / 截断 / 下载', () => {
    it('renders inline via <pre> for logs just under the 64KB virtualization threshold', async () => {
      // 65436 字节 < 分档阈值 64*1024=65536，应仍走原生 <pre> 整份高亮，而不是虚拟窗口化。
      const nearBoundaryText = 'x'.repeat(SMALL_MAX_BYTES - 100);
      getTextMock.mockResolvedValueOnce(nearBoundaryText);
      const harness = await mount();

      const pre = harness.renderer.root.findByType('pre');
      expect(pre.props.children).toBe(nearBoundaryText);
      expect(findVirtualContainer(harness.renderer)).toHaveLength(0);
      expect(findTruncationNotice(harness.renderer)).toHaveLength(0);
    });

    it('virtualizes rendering for logs at/above the 64KB threshold, only rendering a windowed subset of lines', async () => {
      const lineCount = 3000;
      const mediumText = buildLines(
        lineCount,
        (index) => `virtualized log line number ${index} with payload data to pad the width`
      );
      // 断言样本确实跨过了 64KB 阈值且远低于 2MB 截断阈值，避免样本本身漂移导致误判分档。
      expect(mediumText.length).toBeGreaterThanOrEqual(SMALL_MAX_BYTES);
      expect(mediumText.length).toBeLessThan(VIRTUAL_MAX_BYTES);

      getTextMock.mockResolvedValueOnce(mediumText);
      const harness = await mount();

      // 走虚拟窗口化：不再渲染整份 <pre>，改为渲染 VirtualLogView 容器。
      expect(harness.renderer.root.findAllByType('pre')).toHaveLength(0);
      expect(findVirtualContainer(harness.renderer)).toHaveLength(1);
      // 未超过 2MB / 5 万行截断阈值，不应出现截断提示。
      expect(findTruncationNotice(harness.renderer)).toHaveLength(0);

      // 只渲染「可视窗口 + overscan」这一小部分行，远少于全部 3000 行——测试环境没有
      // ResizeObserver，视口高度取不到时回退到固定大小的 overscan 窗口，不会随文档大小增长。
      const renderedRows = findVirtualRows(harness.renderer);
      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows.length).toBeLessThan(100);
      expect(renderedRows.length).toBeLessThan(lineCount);
    });

    it('shows a truncation notice with the real localized copy (not the raw i18n key) for logs over 2MB', async () => {
      const hugeLine = 'x'.repeat(100);
      const hugeText = buildLines(22000, () => hugeLine);
      // 断言样本确实超过 2MB 截断阈值（按字节截断，而非按 5 万行截断——行数远低于 5 万）。
      expect(hugeText.length).toBeGreaterThan(VIRTUAL_MAX_BYTES);

      getTextMock.mockResolvedValueOnce(hugeText);
      const harness = await mount();

      expect(harness.renderer.root.findAllByType('pre')).toHaveLength(0);

      const notices = findTruncationNotice(harness.renderer);
      expect(notices).toHaveLength(1);
      expect(notices[0].props.className).toBe(styles.requestLogViewerTruncatedNotice);

      const noticeText = String(notices[0].props.children ?? '');
      // 关键回归断言：渲染的必须是真实文案（带插值行数），而不是缺 key 时兜底显示的
      // 原始 i18n key 字面量 "monitoring.request_log_viewer_truncated_notice"。
      expect(noticeText).toMatch(
        /^Content too large — showing the first \d+ lines\. Download the full request below\.$/
      );
      expect(noticeText).not.toContain('monitoring.request_log_viewer_truncated_notice');

      // 截断后仍走虚拟窗口化渲染，只出一小部分行，不是把截断后的内容一次性全部渲染。
      const renderedRows = findVirtualRows(harness.renderer);
      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows.length).toBeLessThan(100);
    });

    it('downloads the raw request via the blob endpoint when the download button is clicked', async () => {
      getTextMock.mockResolvedValueOnce(sampleText);
      downloadMock.mockResolvedValueOnce({
        data: 'raw bytes from the blob endpoint',
      } as AxiosResponse);
      const harness = await mount();

      expect(harness.downloadDisabled()).toBe(false);
      await harness.clickDownload();

      // 下载永远重新打 /request-log-by-id/{id} 的 blob 端点取完整原始字节，不是把（可能已被
      // D1 截断展示的）已加载 text 状态重新编码成 Blob。
      expect(downloadMock).toHaveBeenCalledTimes(1);
      expect(downloadMock).toHaveBeenCalledWith('req-1');
      expect(downloadBlobMock).toHaveBeenCalledTimes(1);
      expect(downloadBlobMock.mock.calls[0][0]).toMatchObject({ filename: 'request-req-1.log' });
      expect(harness.onNotify).toHaveBeenCalledWith('Raw request log downloaded', 'success');
    });
  });
});
