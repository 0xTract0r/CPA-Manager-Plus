import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AccountSessionSummary } from './AccountSessionSummary';
import type { AuthFileAccountScheduling } from '@/types';

// 复用仓库既有 i18n mock 口径：有 defaultValue 时展开 {{opt}} 插值，否则回原 key。
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.defaultValue === 'string') {
        return Object.entries(options).reduce(
          (acc, [optionKey, optionValue]) =>
            optionKey === 'defaultValue'
              ? acc
              : acc.split(`{{${optionKey}}}`).join(String(optionValue)),
          options.defaultValue as string
        );
      }
      return key;
    },
  }),
}));

function renderJson(props: Parameters<typeof AccountSessionSummary>[0]): string {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<AccountSessionSummary {...props} />);
  });
  return JSON.stringify(renderer.toJSON());
}

describe('AccountSessionSummary 四态', () => {
  it('loading 态：显示 Counting…，不渲染计数网格', () => {
    const json = renderJson({ accountScheduling: undefined, loading: true });
    expect(json).toContain('Counting');
    expect(json).not.toContain('account-session-total');
  });

  it('unavailable 态（account_scheduling 缺失/null）：显式"数据不可用"文案，绝不渲染成 0', () => {
    for (const value of [undefined, null] as const) {
      const json = renderJson({ accountScheduling: value });
      expect(json).toContain('Session data unavailable');
      // 硬断言：不可用态绝不能包含一个孤立的渲染出来的 "0"（防止被误判成"确有其事的 0"）。
      expect(json).not.toContain('account-session-total');
    }
  });

  it('empty 态（sessions_total===0）：显式"暂无会话数据"，不是数字 0', () => {
    const accountScheduling: AuthFileAccountScheduling = {
      subscription_tier: 'pro',
      sessions_total: 0,
      sessions_active: 0,
      sessions_closed: 0,
    };
    const json = renderJson({ accountScheduling });
    expect(json).toContain('No session data yet');
    expect(json).not.toContain('account-session-total');
  });

  it('ok 态：渲染总计/活跃/已关闭三个真实计数', () => {
    const accountScheduling: AuthFileAccountScheduling = {
      subscription_tier: 'max_20x',
      sessions_total: 7,
      sessions_active: 3,
      sessions_closed: 4,
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AccountSessionSummary accountScheduling={accountScheduling} />);
    });
    const root = renderer.root;

    // 每个统计项包一层 label+value 双 span，直接对整棵子树拼接文本再断言，
    // 避免依赖 react-test-renderer 的 children 数组只含字符串这一假设。
    const flattenText = (node: ReturnType<typeof root.findByProps>): string =>
      node
        .findAll((n) => typeof n.type !== 'function' && n.children.some((c) => typeof c === 'string'))
        .flatMap((n) => n.children.filter((c): c is string => typeof c === 'string'))
        .join('');

    const totalNode = root.findByProps({ 'data-testid': 'account-session-total' });
    expect(flattenText(totalNode)).toContain('7');

    const activeNode = root.findByProps({ 'data-testid': 'account-session-active' });
    expect(flattenText(activeNode)).toContain('3');

    const closedNode = root.findByProps({ 'data-testid': 'account-session-closed' });
    expect(flattenText(closedNode)).toContain('4');

    const container = root.findByProps({ 'data-testid': 'account-session-summary' });
    expect(container.props['data-account-session-status']).toBe('ok');
  });

  it('loading 优先级高于 unavailable/empty：即便 accountScheduling 缺失，loading=true 仍显示统计中', () => {
    const json = renderJson({ accountScheduling: undefined, loading: true });
    expect(json).toContain('Counting');
    expect(json).not.toContain('unavailable');
  });
});
