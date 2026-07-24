import { type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { logsApi } from '@/services/api/logs';
import styles from '../MonitoringCenterPage.module.scss';
import { RequestLogViewer } from './RequestLogViewer';

vi.mock('@/services/api/logs', () => ({
  logsApi: {
    getRequestLogTextById: vi.fn(),
  },
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

type Harness = {
  renderer: ReactTestRenderer;
  setSearch: (value: string) => Promise<void>;
  clickNav: (label: 'Previous match' | 'Next match') => Promise<void>;
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

  return {
    renderer,
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
});
