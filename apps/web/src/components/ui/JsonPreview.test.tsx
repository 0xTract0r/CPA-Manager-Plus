import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { JsonPreview } from './JsonPreview';

/**
 * <JsonPreview> 单测：覆盖父任务点名的三类核心行为——安全美化、截断兜底、脱敏
 * pill——外加折叠/展开交互的最小验证。
 *
 * t() 用带 {{var}} 插值的轻量 stub，而不是仓库其余测试常见的「t 返回 key」
 * identity mock（见 FarmTelemetryPanel.test.tsx）：这里需要断言 sizeTruncated /
 * sizeFull 这类带插值参数的拼接文案是否正确，identity mock 会把插值参数整个
 * 吞掉、测不出插值 bug。
 *
 * 断言口径提醒：`renderToStaticMarkup` 对文本节点里的 `"` 同样会转义成
 * `&quot;`（与属性值转义用同一个 escapeHtml 实现），所以校验 JSON key/value 时
 * 只断言裸字段名/字面量本身，不在断言字符串里带 JSON 的引号——避免因为转义细节
 * 误判用例本身有 bug。
 *
 * **写不跑**：本文件按父任务要求只保证语法/类型正确，不在本次改动里执行
 * `vitest run`（共享 worktree，集成阶段统一跑）。
 */
vi.mock('react-i18next', () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    const defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    if (!options) return defaultValue;
    return defaultValue.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => {
      const v = options[name];
      return v === undefined ? '' : String(v);
    });
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({ t, i18n: { language: 'en' } }),
  };
});

describe('JsonPreview', () => {
  it('安全美化：合法 JSON 缩进换行渲染，危险文本只当纯文本节点、不被解释成标签', () => {
    const value = JSON.stringify({
      channel: 'event_logging',
      note: '<img src=x onerror=alert(1)>',
      count: 3,
    });

    const markup = renderToStaticMarkup(<JsonPreview value={value} />);

    // JSON.stringify(_, null, 2) 的产物带换行缩进，不是原始单行 —— 证明走了「美化」
    // 分支而不是原文兜底分支。
    expect(markup).toContain('\n');
    expect(markup).toContain('channel');
    expect(markup).toContain('event_logging');
    expect(markup).toContain('count');

    // 危险文本被 React 转义成纯文本（永不 dangerouslySetInnerHTML）：真实 <img
    // 标签永远不会出现，只会看到转义后的 &lt;img ...&gt;。
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // 没有服务端截断标记时，不应该出现「预览被截断」banner。
    expect(markup).not.toContain('json-preview-truncated-banner');
  });

  it('截断兜底：2048 截断导致 JSON 语法破损时不崩溃、原样回退原文 + 提示已截断', () => {
    // 模拟服务端在 2048 字符处硬切、字符串值被从中间切断（beacon_redact.go
    // bodyPreviewTruncationMarker 恒追加在末尾）。
    const value = '{"channel":"event_logging","note":"abc…(truncated)';
    expect(value.endsWith('…(truncated)')).toBe(true);
    expect(() => JSON.parse(value)).toThrow();

    const markup = renderToStaticMarkup(<JsonPreview value={value} totalBytes={5000} />);

    expect(markup).toContain('data-testid="json-preview-truncated-banner"');
    expect(markup).toContain('预览被截断');
    // 兜底展示原文本身（不是空白、不是「无法解析」占位符）。
    expect(markup).toContain('abc…(truncated)');
    // sizeTruncated 口径：chars 用预览自身长度，total 用调用方传入的 body_bytes。
    expect(markup).toContain(`预览 ${value.length} 字符 / 共 5000 · 已截断`);
  });

  it('截断兜底：非法但未截断的普通文本同样安全回退，且不误报「已截断」', () => {
    const value = 'not json at all, just plain text body';

    const markup = renderToStaticMarkup(<JsonPreview value={value} />);

    expect(markup).not.toContain('json-preview-truncated-banner');
    expect(markup).toContain('not json at all, just plain text body');
    expect(markup).toContain(`预览 ${value.length} 字符`);
  });

  it('脱敏 pill：整段被服务端替换为 ***REDACTED*** 的字段值渲成琥珀「已脱敏」pill，不再原样吐出占位符', () => {
    const value = JSON.stringify({
      authorization: '***REDACTED***',
      channel: 'control',
    });

    const markup = renderToStaticMarkup(<JsonPreview value={value} />);

    expect(markup).toContain('data-testid="json-preview-redacted-pill"');
    expect(markup).toContain('已脱敏');
    // 原始占位符字面量不应该在渲染输出里原样出现——已经被 pill 整体替换掉。
    expect(markup).not.toContain('***REDACTED***');
    // 未命中脱敏规则的字段照常展示。
    expect(markup).toContain('channel');
    expect(markup).toContain('control');
  });

  it('脱敏 pill：占位符出现在更长字符串值中间时只挖出占位符本身，两侧原文保留', () => {
    // 对应 beacon_redact.go bearerTokenPattern：只替换命中的 "bearer <token>" 片段，
    // 不会清空整个字符串值。
    const value = JSON.stringify({ note: 'sent bearer ***REDACTED*** to relay' });

    const markup = renderToStaticMarkup(<JsonPreview value={value} />);

    expect(markup).toContain('data-testid="json-preview-redacted-pill"');
    expect(markup).toContain('已脱敏');
    expect(markup).toContain('sent bearer');
    expect(markup).toContain('to relay');
    expect(markup).not.toContain('***REDACTED***');
  });

  it('脱敏 pill（截断/解析失败兜底态）：parse 失败回退原文时 ***REDACTED*** 同样渲成「已脱敏」pill，不泄字面量', () => {
    // 服务端在 2048 处硬切让 JSON 语法破损（JSON.parse 必失败 → 走兜底原文分支），
    // 但被截断前已把敏感值替换成 ***REDACTED***：兜底路径也必须把占位符挖成 pill，
    // 绝不能把 ***REDACTED*** 字面量泄到界面（对应组件里兜底分支同样过 StringTokenSpan）。
    const value = '{"authorization":"***REDACTED***","note":"abc…(truncated)';
    expect(() => JSON.parse(value)).toThrow();
    expect(value.endsWith('…(truncated)')).toBe(true);

    const markup = renderToStaticMarkup(<JsonPreview value={value} totalBytes={4096} />);

    // 兜底态（parse 失败）仍把占位符渲成琥珀「已脱敏」pill：
    expect(markup).toContain('data-testid="json-preview-redacted-pill"');
    expect(markup).toContain('已脱敏');
    // 占位符字面量不得原样出现——已被 pill 整体替换：
    expect(markup).not.toContain('***REDACTED***');
    // 且确实走的是截断兜底分支（截断 banner 在、占位符两侧原文保留）：
    expect(markup).toContain('data-testid="json-preview-truncated-banner"');
    expect(markup).toContain('abc…(truncated)');
  });

  it('折叠/展开：短预览不出现折叠按钮，直接完整展示', () => {
    const value = JSON.stringify({ a: 1 });
    const markup = renderToStaticMarkup(<JsonPreview value={value} />);
    expect(markup).not.toContain('aria-expanded');
  });

  it('折叠/展开：长预览默认折叠，点击后切到展开态（aria-expanded 翻转）', () => {
    const longObj: Record<string, number> = {};
    for (let i = 0; i < 30; i++) longObj[`field_${i}`] = i;
    const value = JSON.stringify(longObj);

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<JsonPreview value={value} testId="jp" />);
    });

    const collapsedToggle = renderer.root.findByProps({ 'aria-expanded': false });
    expect(collapsedToggle).toBeTruthy();

    act(() => {
      collapsedToggle.props.onClick();
    });

    expect(renderer.root.findByProps({ 'aria-expanded': true })).toBeTruthy();
  });
});
