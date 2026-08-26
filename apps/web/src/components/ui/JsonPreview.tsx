import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './JsonPreview.module.scss';

/**
 * <JsonPreview>：安全展示一段「可能是 JSON、也可能因上游截断而不再是合法 JSON」的
 * 文本预览（当前唯一调用方：farm 遥测 beacon 详情的 body_preview，服务端已脱敏 +
 * ≤2048 字符截断，见 services/farm-orchestrator/internal/httpapi/beacon_redact.go）。
 *
 * **安全边界**：只做 JSON.parse → JSON.stringify(_, 2) 美化 + 基于正则 token 化的
 * 轻着色，全程渲染为 React 元素（永不 dangerouslySetInnerHTML / 永不拼接 HTML 字符
 * 串），任意字符串内容（包括看起来像标签的文本）只会被当纯文本节点渲染。
 *
 * **不解析请求体语义**：只做结构层面的通用处理——JSON 语法 token 分类（key/
 * string/number/boolean/null/标点）+ 识别服务端已经写死的脱敏占位符字面量
 * `***REDACTED***`（beacon_redact.go redactedPlaceholder）并渲成 pill。不认识任何
 * 业务字段名，不对字段做特殊语义解读。
 *
 * **截断诚实边界**：服务端超过 2048 字符时会在原文末尾追加字面量截断标记
 * `…(truncated)`（beacon_redact.go bodyPreviewTruncationMarker）。前端据此判断
 * truncated，而不是自己猜测；截断导致 JSON 语法被从中截断时 JSON.parse 必然失败，
 * 这时兜底展示原始文本（不崩溃、不空白），并显式提示「预览被截断」。
 */

// 与后端 beacon_redact.go 常量字面量保持一致（前端无法读取 Go 常量，此处显式复制并
// 注释来源；后端若改动这两个字面量需要同步改这里，否则截断/脱敏检测会失效）。
const TRUNCATION_MARKER = '…(truncated)';
const REDACTED_PLACEHOLDER = '***REDACTED***';

// 超过这么多行才提供折叠/展开；短内容直接完整展示，不额外套一层交互。
const COLLAPSE_LINE_THRESHOLD = 14;

type TokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'ws';

interface Token {
  type: TokenType;
  text: string;
}

// 匹配 JSON.stringify(_, null, 2) 输出里可能出现的全部 token 形态：字符串字面量
// （含转义）、数字、true/false/null、单字符标点、连续空白。valid JSON 美化输出
// 理论上应被这一组 alternation 完整覆盖、不留缝隙。
const RAW_TOKEN_RE = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+/g;

function classifyRaw(text: string): TokenType {
  if (text.startsWith('"')) return 'string'; // key/string 由上层按「后面是否紧跟冒号」二次判定
  if (text === 'true' || text === 'false') return 'boolean';
  if (text === 'null') return 'null';
  if (/^[{}[\],:]$/.test(text)) return 'punct';
  if (/^\s+$/.test(text)) return 'ws';
  return 'number';
}

/** 把美化后的 JSON 文本 token 化：字符串 token 里，若后面（跳过空白）紧跟 `:`，
 * 归类为 key，否则是 string——用于分别着色，不改变原文字符。 */
function tokenizeJson(pretty: string): Token[] {
  const raw: { text: string; type: TokenType }[] = [];
  RAW_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RAW_TOKEN_RE.exec(pretty))) {
    raw.push({ text: m[0], type: classifyRaw(m[0]) });
  }

  const tokens: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    if (cur.type === 'string') {
      let j = i + 1;
      while (j < raw.length && raw[j].type === 'ws') j++;
      const isKey = raw[j]?.type === 'punct' && raw[j].text === ':';
      tokens.push({ type: isKey ? 'key' : 'string', text: cur.text });
      continue;
    }
    tokens.push({ type: cur.type, text: cur.text });
  }
  return tokens;
}

/** string token 渲染：若值里出现服务端脱敏占位符字面量，拆出来渲成 pill；其余
 * 原样着色展示（不做任何语义解释）。key token 恒不含脱敏占位符（占位符只替换值，
 * 见 beacon_redact.go），调用方不会传 key 类型进来。 */
function StringTokenSpan({ text, colorClass }: { text: string; colorClass: string }) {
  const { t } = useTranslation();
  if (!text.includes(REDACTED_PLACEHOLDER)) {
    return <span className={colorClass}>{text}</span>;
  }
  const parts = text.split(REDACTED_PLACEHOLDER);
  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) nodes.push(<span key={`t-${i}`}>{part}</span>);
    if (i < parts.length - 1) {
      nodes.push(
        <span
          key={`r-${i}`}
          className={styles.redactedPill}
          data-testid="json-preview-redacted-pill"
        >
          {t('farm.telemetry.jsonPreview.redactedPill', { defaultValue: '已脱敏' })}
        </span>
      );
    }
  });
  return <span className={colorClass}>{nodes}</span>;
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'key':
        return (
          <span key={i} className={styles.tKey}>
            {token.text}
          </span>
        );
      case 'string':
        return <StringTokenSpan key={i} text={token.text} colorClass={styles.tString} />;
      case 'number':
      case 'boolean':
      case 'null':
        return (
          <span key={i} className={styles.tScalar}>
            {token.text}
          </span>
        );
      case 'punct':
        return (
          <span key={i} className={styles.tPunct}>
            {token.text}
          </span>
        );
      case 'ws':
      default:
        // 空白按原文原样输出（保留换行/缩进），不需要着色 span。
        return token.text;
    }
  });
}

export interface JsonPreviewProps {
  /** 原始预览文本（服务端已脱敏，可能因 ≤2048 字符截断而不再是合法 JSON）。 */
  value: string;
  /** 完整原始请求体大小（beacon.body_bytes），仅用于截断时「共 {{total}}」口径的
   * 展示；未提供时退化为用预览自身长度顶上（诚实地不编造未知总量）。 */
  totalBytes?: number;
  /** 供无障碍读出的区域名（如「请求体预览」），由调用方传入现有文案，不在这里
   * 新造 i18n key。 */
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

export function JsonPreview({ value, totalBytes, ariaLabel, className, testId }: JsonPreviewProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const truncated = value.endsWith(TRUNCATION_MARKER);

  // 安全美化：JSON.parse 成功才走结构化着色渲染；失败（截断致语法破损，或本来就
  // 不是 JSON）一律兜底回原文，绝不抛到调用方、绝不渲染空白。
  const parseResult = useMemo<{ ok: true; pretty: string } | { ok: false }>(() => {
    try {
      const data: unknown = JSON.parse(value);
      return { ok: true, pretty: JSON.stringify(data, null, 2) };
    } catch {
      return { ok: false };
    }
  }, [value]);

  const displayText = parseResult.ok ? parseResult.pretty : value;
  const tokens = useMemo(
    () => (parseResult.ok ? tokenizeJson(parseResult.pretty) : null),
    [parseResult]
  );

  const lineCount = displayText.split('\n').length;
  const isLong = lineCount > COLLAPSE_LINE_THRESHOLD;

  const chars = value.length;
  const sizeLine = truncated
    ? t('farm.telemetry.jsonPreview.sizeTruncated', {
        defaultValue: '预览 {{chars}} 字符 / 共 {{total}} · 已截断',
        chars,
        total: totalBytes ?? chars,
      })
    : t('farm.telemetry.jsonPreview.sizeFull', {
        defaultValue: '预览 {{chars}} 字符',
        chars,
      });

  const wrapClassName = [styles.wrap, className].filter(Boolean).join(' ');

  return (
    <div className={wrapClassName} data-testid={testId}>
      {truncated ? (
        <span
          className={`status-badge warning ${styles.truncatedBadge}`}
          data-testid="json-preview-truncated-banner"
        >
          {t('farm.telemetry.jsonPreview.truncated', { defaultValue: '预览被截断' })}
        </span>
      ) : null}

      <div
        className={styles.scrollArea}
        data-collapsed={isLong && !expanded ? 'true' : 'false'}
        tabIndex={0}
        role={ariaLabel ? 'region' : undefined}
        aria-label={ariaLabel}
        data-testid={testId ? `${testId}-scroll` : undefined}
      >
        <pre className={styles.pre}>
          <code>{tokens ? renderTokens(tokens) : displayText}</code>
        </pre>
      </div>

      <div className={styles.footer}>
        {isLong ? (
          <button
            type="button"
            className={styles.toggleBtn}
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded
              ? t('farm.telemetry.jsonPreview.collapse', { defaultValue: '折叠' })
              : t('farm.telemetry.jsonPreview.expand', { defaultValue: '展开' })}
          </button>
        ) : null}
        <span className={styles.sizeLine}>{sizeLine}</span>
      </div>
    </div>
  );
}
