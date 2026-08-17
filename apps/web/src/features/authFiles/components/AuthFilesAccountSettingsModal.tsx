/**
 * 账号设置(身份隔离)弹窗。
 *
 * 迁移自旧版 fork `apps/web/src/features/authFiles/components/AuthFilesPrefixProxyEditorModal.tsx`
 * （旧版同名弹窗语义 = 结构化账号设置 + 身份隔离；与 cpamp 现有的
 * `AuthFilesPrefixProxyEditorModal.tsx`——那是「编辑整份 auth 文件原始 JSON」的
 * cpamp 原生弹窗——完全不同，二者并存，互不替代）。
 *
 * 三大分区：
 *  1. 可编辑账号设置（白名单 PATCH：proxy_url / note / disabled / refresh_enabled /
 *     extra_headers / transport_profile / tls_profile）
 *  2. 只读身份模型（synthetic_device_id / managed_header_state 当前投影 /
 *     Claude 客户端版本观测 / 运行时 TLS 身份 / warnings）
 *  3. 只读身份变更审计（managed_header_state.history，按「身份模型变更」vs
 *     「例行版本刷新」分类展示）
 */
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import { JsonView } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type {
  AccountSettingsEditorField,
  AccountSettingsEditorFieldValue,
  AccountSettingsEditorState,
} from '@/features/authFiles/hooks/useAuthFilesAccountSettings';
import type {
  AuthFileClientVersionObservation,
  AuthFileHeaderMap,
  AuthFileManagedHeaderHistoryEntry,
} from '@/types/authFile';
import { useNotificationStore, useThemeStore } from '@/stores';
import { formatInUtc8 } from '@/utils/format';
import { AccountFastImpactPanel } from './AccountFastImpactPanel';
import styles from './AuthFilesAccountSettingsModal.module.scss';

/**
 * 审计时间戳 `recorded_at` 是后端原样 UTC 串（带 T/Z）。展示时统一转换为
 * `Asia/Shanghai`（UTC+8）；无法解析时回退原串，空值显示 '-'。
 * 复用共享 `utils/format` 的 `formatInUtc8`，与旧版 `utils/datetime` 口径一致，
 * 不再在本文件内维护私有格式化逻辑。
 */
function formatAuditRecordedAt(value: string | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  return formatInUtc8(
    raw,
    { dateStyle: 'medium', timeStyle: 'medium', withZoneLabel: true },
    undefined,
    raw
  );
}

/**
 * 客户端版本观测的 `last_seen_at` / `first_seen_at` 是后端原样 UTC 串（带 T/Z）。
 * 与审计区、账号 modtime 保持同一 UTC+8 展示口径，避免同弹窗内出现裸 UTC 串与
 * UTC+8 混排；无法解析时回退原串，空值显示 '-'。
 */
function formatObservationSeenAt(value: string | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  return formatInUtc8(
    raw,
    { dateStyle: 'medium', timeStyle: 'medium', withZoneLabel: true },
    undefined,
    raw
  );
}

export type AuthFilesAccountSettingsModalProps = {
  disableControls: boolean;
  editor: AccountSettingsEditorState | null;
  updatedText: string;
  dirty: boolean;
  onClose: () => void;
  onCopyText: (text: string) => void | Promise<void>;
  onSave: () => void;
  onChange: (field: AccountSettingsEditorField, value: AccountSettingsEditorFieldValue) => void;
};

type ManagedHeaderHistoryDiffRow = {
  field: string;
  previous?: unknown;
  next?: unknown;
};

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const VERSIONED_CAPABILITIES_FIELD = 'versioned_capabilities';
const expandReadablePreview = (level: number) => level < 2;

/**
 * 纯「版本高水位」字段：这些字段单独变化属于例行 UA/版本刷新，
 * 不属于身份模型级变更。匹配时大小写不敏感并去掉 map 前缀。
 */
const ROUTINE_VERSION_FIELDS = new Set([
  'user-agent',
  'version',
  'x-stainless-package-version',
  'x-stainless-runtime-version',
  VERSIONED_CAPABILITIES_FIELD,
]);

const ROUTINE_REASONS = new Set(['managed-header-refresh', 'observed-client-profile']);

function stripHistoryFieldPrefix(field: string): string {
  return field.replace(/^(versioned_capabilities|summary_headers|managed_headers|headers)\./, '');
}

function headerMapsDiffer(
  previous: AuthFileHeaderMap | undefined,
  next: AuthFileHeaderMap | undefined
): boolean {
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if ((previous?.[key] || '').trim() !== (next?.[key] || '').trim()) {
      return true;
    }
  }
  return false;
}

type IdentityAuditClass = 'significant' | 'routine';

/**
 * 审计分类：A 类/运行时指纹快照有 diff、或 changed_fields 含非版本字段的，
 * 视为「身份模型变更」突出展示；纯 UA/版本高水位刷新归为例行流水折叠。
 */
function classifyIdentityAuditEntry(
  entry: AuthFileManagedHeaderHistoryEntry
): IdentityAuditClass {
  if (headerMapsDiffer(entry.previous_stable_identity, entry.next_stable_identity)) {
    return 'significant';
  }
  if (headerMapsDiffer(entry.previous_runtime_fingerprint, entry.next_runtime_fingerprint)) {
    return 'significant';
  }
  const changedFields = (entry.changed_fields || []).filter(Boolean);
  if (changedFields.length > 0) {
    return changedFields.every((field) =>
      ROUTINE_VERSION_FIELDS.has(stripHistoryFieldPrefix(field).toLowerCase())
    )
      ? 'routine'
      : 'significant';
  }
  // 没有字段级 diff 时按 reason 兜底：已知例行刷新归例行，未知原因突出展示。
  return ROUTINE_REASONS.has((entry.reason || '').trim().toLowerCase())
    ? 'routine'
    : 'significant';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ReadOnlyCodeViewer({
  value,
  minRows = 4,
  testId,
  label,
  onCopyText,
}: {
  value: string;
  minRows?: number;
  testId?: string;
  label: string;
  onCopyText?: (text: string) => void | Promise<void>;
}) {
  const trimmed = value.trim();
  let parsed: unknown = null;
  let isJson = false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
      isJson = Boolean(parsed) && typeof parsed === 'object';
    } catch {
      isJson = false;
    }
  }

  return (
    <div
      className={styles.readOnlyViewer}
      data-testid={testId}
      data-readonly-label={label}
      style={{ minHeight: `${Math.max(3, minRows) * 20 + 24}px` }}
      tabIndex={0}
    >
      <div className={styles.readOnlyToolbar}>
        <span className={styles.readOnlyBadge}>{label}</span>
        {isJson && (
          <span className={styles.readOnlyBadge} data-testid="account-settings-json-viewer-badge">
            JSON tree
          </span>
        )}
        {onCopyText && value && (
          <button
            type="button"
            className={styles.readOnlyCopyButton}
            data-testid="account-settings-json-viewer-copy"
            onClick={() => void onCopyText(value)}
          >
            Copy
          </button>
        )}
      </div>
      {isJson ? (
        <div className={styles.jsonTree} data-testid="account-settings-json-tree">
          <JsonView
            data={parsed as object}
            shouldExpandNode={expandReadablePreview}
            clickToExpandNode
            compactTopLevel
            style={{
              container: styles.jsonTreeContainer,
              childFieldsContainer: styles.jsonTreeChildFields,
              basicChildStyle: styles.jsonTreeChild,
              label: styles.jsonTreeLabel,
              clickableLabel: styles.jsonTreeClickableLabel,
              nullValue: styles.jsonTreeNull,
              undefinedValue: styles.jsonTreeNull,
              numberValue: styles.jsonTreeNumber,
              stringValue: styles.jsonTreeString,
              booleanValue: styles.jsonTreeBoolean,
              otherValue: styles.jsonTreeOther,
              punctuation: styles.jsonTreePunctuation,
              expandIcon: styles.jsonTreeExpandIcon,
              collapseIcon: styles.jsonTreeCollapseIcon,
              collapsedContent: styles.jsonTreeCollapsedContent,
              quotesForFieldNames: true,
              stringifyStringValues: true,
            }}
          />
        </div>
      ) : (
        <pre className={styles.readOnlyCode}>
          <code>{value || '-'}</code>
        </pre>
      )}
    </div>
  );
}

function ManagedHeadersPanel({ entries, t }: { entries: [string, string][]; t: TranslateFn }) {
  return (
    <div className="form-group">
      <label>
        {t('auth_files.account_settings_managed_headers', {
          defaultValue: 'Core-managed request headers',
        })}
      </label>
      <div className={styles.managedHeaderPanel} data-testid="account-settings-managed-headers-panel">
        <div className={styles.managedHeaderPlainHeader}>
          <span>
            {t('auth_files.account_settings_managed_headers_runtime_title', {
              defaultValue: 'Actually applied by runtime',
            })}
          </span>
          <span className={styles.managedHeaderMeta}>
            {t('auth_files.account_settings_managed_headers_count', {
              count: entries.length,
              defaultValue: '{{count}} headers',
            })}
          </span>
        </div>
        {entries.length > 0 ? (
          <table className={styles.managedHeaderTable}>
            <thead>
              <tr>
                <th>
                  {t('auth_files.account_settings_managed_headers_table_name', {
                    defaultValue: 'Header',
                  })}
                </th>
                <th>
                  {t('auth_files.account_settings_managed_headers_table_value', {
                    defaultValue: 'Runtime value',
                  })}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, value]) => (
                <tr data-testid="account-settings-managed-header-row" key={name}>
                  <th scope="row" className={styles.managedHeaderKey}>
                    {name}
                  </th>
                  <td
                    data-label={t('auth_files.account_settings_managed_headers_table_value', {
                      defaultValue: 'Runtime value',
                    })}
                  >
                    <code className={styles.managedHeaderValue} title={value}>
                      {value}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={styles.managedHeaderEmpty}>
            {t('auth_files.account_settings_managed_headers_empty', {
              defaultValue: 'No core-managed headers for this provider.',
            })}
          </div>
        )}
      </div>
      <div className="hint">
        {t('auth_files.account_settings_managed_headers_hint', {
          defaultValue:
            'Read-only. These are the headers core will merge into the runtime request. Use Extra headers only for user-owned additions.',
        })}
      </div>
    </div>
  );
}

function ClaudeHeaderStrategyPanel({ t }: { t: TranslateFn }) {
  const rows = [
    ['User-Agent', 'auth_files.account_settings_claude_header_strategy_client_version'],
    [
      'X-Stainless-Package-Version',
      'auth_files.account_settings_claude_header_strategy_client_version',
    ],
    [
      'X-Stainless-Runtime-Version',
      'auth_files.account_settings_claude_header_strategy_client_runtime',
    ],
    ['X-Stainless-Os / X-Stainless-Arch', 'auth_files.account_settings_claude_header_strategy_platform'],
    ['X-App', 'auth_files.account_settings_claude_header_strategy_stable'],
  ] as const;

  return (
    <div className="form-group">
      <label>
        {t('auth_files.account_settings_claude_header_strategy', {
          defaultValue: 'Claude request header strategy',
        })}
      </label>
      <div className={styles.managedHeaderPanel} data-testid="account-settings-claude-header-strategy-panel">
        <div className={styles.managedHeaderPlainHeader}>
          <span>
            {t('auth_files.account_settings_claude_header_strategy_runtime_title', {
              defaultValue: 'Resolved per incoming Claude CLI request',
            })}
          </span>
          <span className={styles.managedHeaderMeta}>Claude only</span>
        </div>
        <table className={styles.managedHeaderTable}>
          <thead>
            <tr>
              <th>
                {t('auth_files.account_settings_managed_headers_table_name', {
                  defaultValue: 'Header',
                })}
              </th>
              <th>
                {t('auth_files.account_settings_claude_header_strategy_source', {
                  defaultValue: 'Source',
                })}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, sourceKey]) => (
              <tr data-testid="account-settings-claude-header-strategy-row" key={name}>
                <th scope="row" className={styles.managedHeaderKey}>
                  {name}
                </th>
                <td
                  data-label={t('auth_files.account_settings_claude_header_strategy_source', {
                    defaultValue: 'Source',
                  })}
                >
                  <span className={styles.managedHeaderValue}>
                    {t(sourceKey, {
                      defaultValue:
                        'From the real incoming Claude CLI request; account fallback is used only before this core observes a compatible client.',
                    })}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hint">
        {t('auth_files.account_settings_claude_header_strategy_hint', {
          defaultValue:
            'Claude does not pin one managed version on the account page. Multiple clients may use the same CPA instance, so concrete versions are shown below as recent current-process observations.',
        })}
      </div>
    </div>
  );
}

function ClaudeClientVersionObservationsPanel({
  observations,
  t,
}: {
  observations: AuthFileClientVersionObservation[];
  t: TranslateFn;
}) {
  const rows = observations.slice(0, 8);
  const sourceLabel = (source: AuthFileClientVersionObservation['source']) => {
    if (typeof source === 'string') return source;
    if (source && typeof source === 'object') {
      const value = source.source;
      return typeof value === 'string' ? value : '';
    }
    return '';
  };
  const userAgentContext = (userAgent?: string) => {
    const value = userAgent?.trim() || '';
    const match = value.match(/\(([^)]+)\)\s*$/);
    return match?.[1] || '';
  };

  return (
    <div className="form-group">
      <label>
        {t('auth_files.account_settings_claude_client_observations', {
          defaultValue: 'Recent Claude client observations',
        })}
      </label>
      <div
        className={styles.managedHeaderPanel}
        data-testid="account-settings-claude-client-observations-panel"
      >
        <div className={styles.managedHeaderPlainHeader}>
          <span>
            {t('auth_files.account_settings_claude_client_observations_runtime_title', {
              defaultValue: 'Observed by the current core process',
            })}
          </span>
          <span className={styles.managedHeaderMeta}>
            {t('auth_files.account_settings_claude_client_observations_count', {
              count: rows.length,
              defaultValue: '{{count}} versions',
            })}
          </span>
        </div>
        {rows.length > 0 ? (
          <table className={`${styles.managedHeaderTable} ${styles.clientObservationTable}`}>
            <thead>
              <tr>
                <th>
                  {t('auth_files.account_settings_claude_client_version', {
                    defaultValue: 'Version',
                  })}
                </th>
                <th>
                  {t('auth_files.account_settings_claude_client_user_agent', {
                    defaultValue: 'User-Agent',
                  })}
                </th>
                <th>
                  {t('auth_files.account_settings_claude_client_last_seen', {
                    defaultValue: 'Last seen',
                  })}
                </th>
                <th>
                  {t('auth_files.account_settings_claude_client_requests', {
                    defaultValue: 'Requests',
                  })}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((observation, index) => (
                <tr
                  data-testid="account-settings-claude-client-observation-row"
                  key={`${observation.version || 'unknown'}-${observation.user_agent || index}`}
                >
                  <th scope="row" className={styles.managedHeaderKey}>
                    {observation.version || '-'}
                    <span className={styles.clientObservationSubtext}>
                      {[observation.package_version, observation.runtime_version]
                        .filter(Boolean)
                        .join(' · ') || '-'}
                    </span>
                  </th>
                  <td
                    data-label={t('auth_files.account_settings_claude_client_user_agent', {
                      defaultValue: 'User-Agent',
                    })}
                  >
                    <code
                      className={`${styles.managedHeaderValue} ${styles.clientObservationUserAgent}`}
                      data-testid="account-settings-claude-client-user-agent"
                      title={observation.user_agent}
                      aria-label={observation.user_agent || undefined}
                      tabIndex={0}
                    >
                      {observation.user_agent || '-'}
                    </code>
                    <span className={styles.clientObservationSubtext}>
                      {[
                        userAgentContext(observation.user_agent),
                        observation.os,
                        observation.arch,
                        sourceLabel(observation.source),
                      ]
                        .filter(Boolean)
                        .join(' · ') || '-'}
                    </span>
                  </td>
                  <td
                    data-label={t('auth_files.account_settings_claude_client_last_seen', {
                      defaultValue: 'Last seen',
                    })}
                  >
                    <code
                      className={styles.managedHeaderValue}
                      title={observation.last_seen_at || observation.first_seen_at}
                    >
                      {formatObservationSeenAt(
                        observation.last_seen_at || observation.first_seen_at
                      )}
                    </code>
                  </td>
                  <td
                    data-label={t('auth_files.account_settings_claude_client_requests', {
                      defaultValue: 'Requests',
                    })}
                  >
                    <code className={styles.managedHeaderValue}>
                      {String(observation.request_count || 0)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div
            className={styles.managedHeaderEmpty}
            data-testid="account-settings-claude-client-observations-empty"
          >
            {t('auth_files.account_settings_claude_client_observations_empty', {
              defaultValue:
                'No real Claude CLI request has been observed by this core process yet.',
            })}
          </div>
        )}
      </div>
      <div className="hint">
        {t('auth_files.account_settings_claude_client_observations_hint', {
          defaultValue:
            'Claude runtime resolves request version markers from real incoming Claude CLI requests first. This list is recent in-memory observation for this core process, not a fixed per-account managed version and not a complete audit log of every client.',
        })}
      </div>
    </div>
  );
}

function EditableJsonCodeField({
  value,
  placeholder,
  disabled,
  invalid,
  testId,
  theme,
  onChange,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  invalid: boolean;
  testId: string;
  theme: 'light' | 'dark';
  onChange: (value: string) => void;
}) {
  const extensions = useMemo(
    () => [json(), search(), highlightSelectionMatches(), keymap.of(searchKeymap)],
    []
  );

  return (
    <div
      className={`${styles.jsonEditor} ${invalid ? styles.jsonEditorInvalid : ''}`}
      data-testid={`${testId}-wrapper`}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={theme}
        editable={!disabled}
        placeholder={placeholder}
        minHeight="112px"
        data-testid={testId}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: true,
          crosshairCursor: false,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          searchKeymap: true,
          foldKeymap: true,
          completionKeymap: false,
          lintKeymap: true,
        }}
      />
    </div>
  );
}

function parseRecordText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : '-';
}

function readBooleanLabel(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return '-';
}

function RuntimeTlsSummary({
  runtimeProfileText,
  runtimeIdentityText,
}: {
  runtimeProfileText: string;
  runtimeIdentityText: string;
}) {
  const runtimeProfile = parseRecordText(runtimeProfileText);
  const runtimeIdentity = parseRecordText(runtimeIdentityText);
  const identityCurrent = isRecord(runtimeIdentity?.current) ? runtimeIdentity.current : null;
  const provider = readString(runtimeProfile, 'provider');
  const tlsStatus = readString(runtimeProfile, 'tls_status');
  const transportStatus = readString(runtimeProfile, 'transport_status');
  const tlsFamily = readString(runtimeProfile, 'tls_family');
  const transportKind = readString(runtimeProfile, 'transport_kind');
  const isClaude = provider.toLowerCase() === 'claude';
  const isCodex = provider.toLowerCase() === 'codex';

  if (!runtimeProfile && !identityCurrent) {
    return null;
  }

  return (
    <div className={styles.runtimeTlsSummaryPanel} data-testid="account-settings-tls-summary-panel">
      <div className={styles.runtimeTlsSummaryHeader}>
        <strong>Current runtime identity</strong>
        <div className={styles.runtimeTlsSummaryBadges}>
          {runtimeProfile?.core_managed === true && <span>Core managed</span>}
          <span>{readString(runtimeProfile, 'profile_id')}</span>
          <span>{readString(runtimeProfile, 'tls_profile_id')}</span>
          {transportKind !== '-' && <span>{transportKind}</span>}
          {tlsFamily !== '-' && <span>{tlsFamily}</span>}
        </div>
      </div>
      <div className={styles.runtimeTlsSummaryGrid}>
        <div>
          <span>Provider</span>
          <strong>{provider}</strong>
        </div>
        <div>
          <span>Identity revision</span>
          <strong>{String(identityCurrent?.revision ?? '-')}</strong>
        </div>
        <div>
          <span>Host</span>
          <strong>{readString(identityCurrent, 'base_url_host')}</strong>
        </div>
        <div>
          <span>Source</span>
          <strong>{readString(runtimeProfile, 'source')}</strong>
        </div>
        <div>
          <span>TLS family</span>
          <strong>{readString(runtimeProfile, 'tls_family')}</strong>
        </div>
        <div>
          <span>Runtime enforced</span>
          <strong>{readBooleanLabel(runtimeProfile, 'tls_configured')}</strong>
        </div>
      </div>
      <div className={styles.runtimeTlsSummaryText}>
        {isClaude && (
          <p>
            Claude default TLS is <strong>claude_cli_clienthello_v1</strong>: a uTLS HelloCustom
            replicating the real claude-cli Node/OpenSSL ClientHello (target JA3 e97f5146, ALPN
            http/1.1 only). Legacy reqwest/rustls and Chrome-like uTLS aliases are explicit opt-in
            only.
          </p>
        )}
        {isCodex && (
          <p>
            Codex default TLS is <strong>codex_rustls_native_v1</strong>: a uTLS profile replicating
            the real codex-rs rustls ClientHello (target JA3 e4d448cd), with core-managed headers and
            account-isolated transport.
          </p>
        )}
        <p>{tlsStatus}</p>
        <p>{transportStatus}</p>
      </div>
    </div>
  );
}

function formatHistoryValue(value: unknown): string {
  if (value === undefined) return '-';
  if (value === null) return 'null';
  if (typeof value === 'string') return value || '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getHistoryMapValue(
  map: Record<string, unknown> | undefined,
  field: string
): unknown {
  if (!map) return undefined;

  const fieldVariants = [
    field,
    stripHistoryFieldPrefix(field),
    field.replace(/^stable_identity\./, ''),
    field.replace(/^runtime_fingerprint\./, ''),
  ];

  for (const variant of fieldVariants) {
    if (Object.prototype.hasOwnProperty.call(map, variant)) {
      return map[variant];
    }
  }

  return undefined;
}

function historySideMaps(
  entry: AuthFileManagedHeaderHistoryEntry,
  side: 'previous' | 'next'
): (AuthFileHeaderMap | undefined)[] {
  return side === 'previous'
    ? [
        entry.previous_versioned_capabilities,
        entry.previous_stable_identity,
        entry.previous_runtime_fingerprint,
        entry.previous_summary_headers,
      ]
    : [
        entry.next_versioned_capabilities,
        entry.next_stable_identity,
        entry.next_runtime_fingerprint,
        entry.next_summary_headers,
      ];
}

function getHistoryValue(
  entry: AuthFileManagedHeaderHistoryEntry,
  field: string,
  side: 'previous' | 'next'
): unknown {
  for (const map of historySideMaps(entry, side)) {
    const value = getHistoryMapValue(map, field);
    if (value !== undefined) return value;
  }

  const genericMap = entry[side];
  return getHistoryMapValue(isRecord(genericMap) ? genericMap : undefined, field);
}

function buildHistoryDiffRows(
  entry: AuthFileManagedHeaderHistoryEntry
): ManagedHeaderHistoryDiffRow[] {
  const mapBackedFields = [
    ...historySideMaps(entry, 'previous'),
    ...historySideMaps(entry, 'next'),
  ].flatMap((map) => Object.keys(map || {}));
  const changedFields = entry.changed_fields || [];
  const shouldPreferMapFields =
    mapBackedFields.length > 0 &&
    changedFields.some((field) => field === VERSIONED_CAPABILITIES_FIELD);
  const fields = Array.from(
    new Set(
      [
        ...mapBackedFields,
        ...changedFields.filter(
          (field) => !(shouldPreferMapFields && field === VERSIONED_CAPABILITIES_FIELD)
        ),
      ].filter(Boolean)
    )
  ).sort();

  return fields
    .map((field) => ({
      field,
      previous: getHistoryValue(entry, field, 'previous'),
      next: getHistoryValue(entry, field, 'next'),
    }))
    .filter(
      (row) =>
        (row.previous !== undefined || row.next !== undefined) &&
        formatHistoryValue(row.previous) !== formatHistoryValue(row.next)
    );
}

function identityAuditReasonLabel(reason: string | undefined, t: TranslateFn): string {
  switch ((reason || '').trim().toLowerCase()) {
    case 'managed-header-refresh':
      return t('auth_files.account_settings_identity_audit_reason_managed_refresh', {
        defaultValue: 'Managed header refresh',
      });
    case 'observed-client-profile':
      return t('auth_files.account_settings_identity_audit_reason_observed', {
        defaultValue: 'Observed client profile',
      });
    case 'runtime-identity-refresh':
      return t('auth_files.account_settings_identity_audit_reason_runtime_identity', {
        defaultValue: 'Runtime identity refresh',
      });
    default:
      return reason || 'identity-change';
  }
}

/**
 * 版本来源（core `managed_header_state` 的 Source）人类可读标签。
 * core 取值：
 *  - `observed:first_party` 真实客户端请求观测
 *  - `online:npm`           在线 npm 最新版本
 *  - `community:codex-proxy` 社区 codex-proxy 策略
 *  - `default`              内置默认基线
 */
function identityAuditSourceLabel(source: string | undefined, t: TranslateFn): string {
  const normalized = (source || '').trim().toLowerCase();
  switch (normalized) {
    case 'observed:first_party':
      return t('auth_files.account_settings_identity_audit_source_observed', {
        defaultValue: 'Real client observed',
      });
    case 'online:npm':
      return t('auth_files.account_settings_identity_audit_source_online_npm', {
        defaultValue: 'Online npm',
      });
    case 'community:codex-proxy':
      return t('auth_files.account_settings_identity_audit_source_codex_proxy', {
        defaultValue: 'Community codex-proxy',
      });
    case 'default':
      return t('auth_files.account_settings_identity_audit_source_default', {
        defaultValue: 'Default baseline',
      });
    default:
      return source?.trim() || '';
  }
}

/**
 * 选取该条审计记录「当前版本依据」的 Source 原始值。
 * 优先 `next_source`（这版变更后的来源），回退 `source`，再回退 `previous_source`。
 */
function identityAuditEntrySource(entry: AuthFileManagedHeaderHistoryEntry): string {
  return (
    (entry.next_source || '').trim() ||
    (entry.source || '').trim() ||
    (entry.previous_source || '').trim()
  );
}

function IdentityAuditEntry({
  entry,
  variant,
  formatFieldList,
  t,
}: {
  entry: AuthFileManagedHeaderHistoryEntry;
  variant: IdentityAuditClass;
  formatFieldList: (fields: string[]) => string;
  t: TranslateFn;
}) {
  const diffRows = buildHistoryDiffRows(entry);
  const entryClassName =
    variant === 'significant'
      ? `${styles.managedHeaderHistoryEntry} ${styles.identityAuditEntrySignificant}`
      : styles.managedHeaderHistoryEntry;

  const rawSource = identityAuditEntrySource(entry);
  const sourceLabel = identityAuditSourceLabel(rawSource, t);
  const sourceUrl = (entry.next_source_url || entry.source_url || '').trim();

  return (
    <div className={entryClassName} data-testid={`account-settings-identity-audit-entry-${variant}`}>
      <div className={styles.managedHeaderHistorySummary}>
        <div className={styles.managedHeaderHistoryMeta}>
          <strong>{formatAuditRecordedAt(entry.recorded_at)}</strong>
          <span>{identityAuditReasonLabel(entry.reason, t)}</span>
          {sourceLabel && (
            <span
              className={styles.identityAuditSourceTag}
              data-testid="account-settings-identity-audit-source"
              title={sourceUrl || rawSource}
            >
              {t('auth_files.account_settings_identity_audit_source_inline', {
                defaultValue: 'Source: {{source}}',
                source: sourceLabel,
              })}
            </span>
          )}
        </div>
        <div className={styles.managedHeaderChips}>
          <span
            className={
              variant === 'significant'
                ? `${styles.managedHeaderChip} ${styles.identityAuditChipSignificant}`
                : `${styles.managedHeaderChip} ${styles.identityAuditChipRoutine}`
            }
          >
            {variant === 'significant'
              ? t('auth_files.account_settings_identity_audit_significant_chip', {
                  defaultValue: 'Identity model change',
                })
              : t('auth_files.account_settings_identity_audit_routine_chip', {
                  defaultValue: 'UA/version refresh',
                })}
          </span>
          {(entry.changed_fields || []).length > 0 ? (
            (entry.changed_fields || []).map((field) => (
              <span className={styles.managedHeaderChip} key={field} title={field}>
                {field}
              </span>
            ))
          ) : (
            <span className={styles.managedHeaderChip}>
              {t('auth_files.account_settings_managed_header_history_no_diff', {
                defaultValue: 'No field-level diff recorded',
              })}
            </span>
          )}
        </div>
      </div>
      <details
        className={styles.managedHeaderHistoryDetails}
        data-testid="account-settings-identity-audit-details"
      >
        <summary
          className={styles.managedHeaderHistoryToggle}
          data-testid="account-settings-identity-audit-details-toggle"
        >
          {t('auth_files.account_settings_managed_header_history_view_changes', {
            defaultValue: 'View changes',
          })}
        </summary>
        <div className={styles.managedHeaderHistoryDetailGrid}>
          <div className={styles.managedHeaderHistoryDetailItem}>
            <span>
              {t('auth_files.account_settings_managed_header_history_recorded_at', {
                defaultValue: 'Recorded at',
              })}
            </span>
            <strong>{formatAuditRecordedAt(entry.recorded_at)}</strong>
          </div>
          <div className={styles.managedHeaderHistoryDetailItem}>
            <span>
              {t('auth_files.account_settings_managed_header_history_reason', {
                defaultValue: 'Reason',
              })}
            </span>
            <strong>{entry.reason || 'identity-change'}</strong>
          </div>
          <div className={styles.managedHeaderHistoryDetailItem}>
            <span>
              {t('auth_files.account_settings_identity_audit_source_basis', {
                defaultValue: 'Version source',
              })}
            </span>
            <strong>{sourceLabel || '-'}</strong>
          </div>
          <div className={styles.managedHeaderHistoryDetailItem}>
            <span>
              {t('auth_files.account_settings_managed_header_history_source', {
                defaultValue: 'Source',
              })}
            </span>
            <strong>{[rawSource, sourceUrl].filter(Boolean).join(' · ') || '-'}</strong>
          </div>
          <div
            className={`${styles.managedHeaderHistoryDetailItem} ${styles.managedHeaderHistoryDetailItemWide}`}
          >
            <span>
              {t('auth_files.account_settings_managed_header_history_changed_fields', {
                defaultValue: 'Changed fields',
              })}
            </span>
            <strong>{formatFieldList(entry.changed_fields || [])}</strong>
          </div>
        </div>
        {diffRows.length > 0 ? (
          <div
            className={styles.managedHeaderHistoryDiffTable}
            data-testid="account-settings-identity-audit-diff-table"
          >
            <div className={styles.managedHeaderHistoryDiffHead}>
              {t('auth_files.account_settings_managed_header_history_field', {
                defaultValue: 'Field',
              })}
            </div>
            <div className={styles.managedHeaderHistoryDiffHead}>
              {t('auth_files.account_settings_managed_header_history_previous', {
                defaultValue: 'Previous',
              })}
            </div>
            <div className={styles.managedHeaderHistoryDiffHead}>
              {t('auth_files.account_settings_managed_header_history_next', {
                defaultValue: 'Next',
              })}
            </div>
            {diffRows.map((row) => (
              <div className={styles.managedHeaderHistoryDiffRow} key={row.field}>
                <span>{row.field}</span>
                <code title={formatHistoryValue(row.previous)}>
                  {formatHistoryValue(row.previous)}
                </code>
                <code title={formatHistoryValue(row.next)}>{formatHistoryValue(row.next)}</code>
              </div>
            ))}
          </div>
        ) : (
          <div
            className={styles.managedHeaderHistoryNoDiff}
            data-testid="account-settings-identity-audit-no-diff"
          >
            {t('auth_files.account_settings_managed_header_history_no_diff', {
              defaultValue: 'No field-level diff recorded',
            })}
          </div>
        )}
      </details>
    </div>
  );
}

export function AuthFilesAccountSettingsModal(props: AuthFilesAccountSettingsModalProps) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const { disableControls, editor, updatedText, dirty, onClose, onCopyText, onSave, onChange } =
    props;

  const managedHeaderState = editor?.managedHeaderState || null;
  // 旧 payload 仍可能带 policy_version；仅用于推断 provider，不再作为「自动升级策略版本」展示。
  const managedHeaderPolicy = managedHeaderState?.policy_version || '';
  const managedHeaderPolicyMatch = managedHeaderPolicy.match(/^([a-z0-9_-]+)-managed\/v(\d+)$/i);
  const managedHeaderPolicyProvider = (managedHeaderPolicyMatch?.[1] || '').toLowerCase();
  const editorProvider = (editor?.provider || '').toLowerCase();
  const isClaudeProvider = editorProvider === 'claude' || managedHeaderPolicyProvider === 'claude';
  const isCodexProvider = editorProvider === 'codex' || managedHeaderPolicyProvider === 'codex';
  // codex `fast` 开关：关→开有额度权衡（约 2.2x 周额度换约 1.5x 速度），复用全局
  // 确认弹窗（useNotificationStore.showConfirmation），确认后才真正写入 fast=true；
  // 关闭不需要确认，直接写 fast=false。
  const handleFastToggle = (nextEnabled: boolean) => {
    if (!nextEnabled) {
      onChange('fast', false);
      return;
    }
    if (editor?.fast) return;
    showConfirmation({
      title: t('auth_files.account_settings_fast_confirm_title', {
        defaultValue: 'Enable fast mode?',
      }),
      message: t('auth_files.account_settings_fast_confirm_message', {
        defaultValue:
          'Enabling fast mode consumes this account’s weekly quota about 2.2x faster in exchange for about 1.5x faster generation and quicker first-token response. Enable it?',
      }),
      confirmText: t('auth_files.account_settings_fast_confirm_ok', {
        defaultValue: 'Enable fast mode',
      }),
      cancelText: t('common.cancel'),
      variant: 'primary',
      onConfirm: () => onChange('fast', true),
    });
  };
  const isClaudeManagedPolicy =
    isClaudeProvider || (editor?.clientVersionObservations || []).length > 0;
  // 农场契约字段消费（后端 AG1 同步实现中）：device_id 卡按绑定态区分展示——
  // 已绑定容器显「容器同步」而非「合成假名」；未绑定 Claude 显红警「未绑定·不可
  // 出站」；字段缺失（undefined）时防御式回退旧的「合成假名 / 尚未派生」展示。
  const farmBound = editor?.farmBound;
  const deviceIdSource = editor?.deviceIdSource;
  const isFarmContainerSynced = farmBound === true || deviceIdSource === 'container_synced';
  const isFarmUnprovisionedClaude = farmBound === false && isClaudeProvider;
  const identityModelStrategy = isClaudeManagedPolicy
    ? t('auth_files.account_settings_identity_strategy_claude', {
        defaultValue: 'Claude per-account identity binding',
      })
    : isCodexProvider
      ? t('auth_files.account_settings_identity_strategy_codex', {
          defaultValue: 'Codex per-account identity binding',
        })
      : t('auth_files.account_settings_identity_strategy_generic', {
          defaultValue: 'Per-account identity binding',
        });
  const identityModelRule = isClaudeManagedPolicy
    ? t('auth_files.account_settings_identity_rule_claude', {
        defaultValue:
          'Class A (platform OS/Arch/X-App) is pinned per account; Class B (CLI/package/runtime version) tracks a high-water mark resolved from real incoming Claude CLI requests and never downgrades.',
      })
    : isCodexProvider
      ? t('auth_files.account_settings_identity_rule_codex', {
          defaultValue:
            'Class A platform identity is pinned per account; Class B version markers use a source-backed high-water mark and never downgrade.',
        })
      : t('auth_files.account_settings_identity_rule_generic', {
          defaultValue:
            'Class A stable identity fields are pinned per account; Class B version-sensitive fields use a high-water mark that only moves forward.',
        });
  const pickProviderText = (
    claudeKey: string,
    claudeDefault: string,
    codexKey: string,
    codexDefault: string,
    genericKey: string,
    genericDefault: string
  ): string => {
    if (isCodexProvider) {
      return t(codexKey, { defaultValue: codexDefault });
    }
    if (isClaudeProvider) {
      return t(claudeKey, { defaultValue: claudeDefault });
    }
    return t(genericKey, { defaultValue: genericDefault });
  };
  const transportProfilePlaceholder = isCodexProvider
    ? 'Leave empty for core default transport.\nCodex example:\n{\n  "preset": "codex_rustls_native_v1"\n}'
    : isClaudeProvider
      ? 'Leave empty for core default transport.\nClaude CLI example:\n{\n  "preset": "claude_cli_clienthello_v1"\n}'
      : 'Leave empty for core default transport.';
  const tlsProfilePlaceholder = isCodexProvider
    ? 'Leave empty for core default TLS.\nCodex example:\n{\n  "preset": "codex_rustls_native_v1"\n}'
    : isClaudeProvider
      ? 'Leave empty for core default TLS.\nClaude CLI example:\n{\n  "preset": "claude_cli_clienthello_v1"\n}'
      : 'Leave empty for core default TLS.';
  const transportProfileHint = pickProviderText(
    'auth_files.account_settings_transport_profile_hint_claude',
    'Leave empty for the core default transport. Claude defaults to claude_cli_clienthello_v1, replicating the real claude-cli Node/OpenSSL ClientHello (target JA3 e97f5146, ALPN http/1.1 only); legacy reqwest/rustls and Chrome-like uTLS presets such as claude_utls_chrome_133 are explicit opt-in only.',
    'auth_files.account_settings_transport_profile_hint_codex',
    'Leave empty for the core default transport. Codex defaults to codex_rustls_native_v1, a uTLS replica of the real codex-rs rustls ClientHello (target JA3 e4d448cd), with core-managed headers and account-isolated transport.',
    'auth_files.account_settings_transport_profile_hint_generic',
    'Leave empty for the core default transport. The core resolves the transport profile for this account.'
  );
  const tlsProfileHint = pickProviderText(
    'auth_files.account_settings_tls_profile_hint_claude',
    'Leave empty for the core default TLS behavior. Claude default TLS is claude_cli_clienthello_v1, a uTLS HelloCustom replicating the real claude-cli Node/OpenSSL ClientHello (target JA3 e97f5146, ALPN http/1.1 only); legacy reqwest/rustls and old Chrome-like aliases remain explicit opt-in only.',
    'auth_files.account_settings_tls_profile_hint_codex',
    'Leave empty for the core default TLS behavior. Codex default TLS is codex_rustls_native_v1, a uTLS replica of the real codex-rs rustls ClientHello (target JA3 e4d448cd), with core-managed headers and account-isolated transport.',
    'auth_files.account_settings_tls_profile_hint_generic',
    'Leave empty for the core default TLS behavior. The core resolves the TLS profile for this account.'
  );
  const runtimeProfileHint = pickProviderText(
    'auth_files.account_settings_runtime_profile_hint_claude',
    'Resolved by the core for this account. Claude defaults to claude_cli_clienthello_v1 (real claude-cli Node/OpenSSL ClientHello, ALPN http/1.1 only); legacy reqwest/rustls and Chrome-like uTLS remain explicit opt-in only.',
    'auth_files.account_settings_runtime_profile_hint_codex',
    'Resolved by the core for this account. Codex defaults to codex_rustls_native_v1, a uTLS replica of the real codex-rs rustls ClientHello (target JA3 e4d448cd), with core-managed headers and account-isolated transport.',
    'auth_files.account_settings_runtime_profile_hint_generic',
    'Resolved by the core for this account.'
  );
  const managedHeaderEntries = Object.entries(editor?.managedHeaders || {}).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  const managedHeaderCurrent = managedHeaderState?.current || null;
  const managedHeaderGeneratedAt = managedHeaderState?.current?.generated_at || '';
  const managedHeaderSource = managedHeaderCurrent?.source || '';
  const managedHeaderSourceUrl = managedHeaderCurrent?.source_url || '';
  const managedHeaderCheckedAt = managedHeaderCurrent?.checked_at || '';
  const managedHeaderCompleteness = managedHeaderCurrent?.completeness || '';
  const managedHeaderSourceLabel = (() => {
    if (
      managedHeaderSource === 'community:codex-proxy' &&
      managedHeaderCompleteness === 'online-coherent-bundle'
    ) {
      return t('auth_files.account_settings_managed_header_source_codex_proxy_online', {
        defaultValue: 'Online coherent bundle from codex-proxy',
      });
    }
    if (managedHeaderSource === 'community:codex-proxy') {
      return t('auth_files.account_settings_managed_header_source_codex_proxy', {
        defaultValue: 'Community codex-proxy strategy',
      });
    }
    if (
      managedHeaderSource === 'online:npm' &&
      managedHeaderCompleteness === 'partial-cli-version-only'
    ) {
      return t('auth_files.account_settings_managed_header_source_online_npm_partial', {
        defaultValue: 'Online npm version only',
      });
    }
    if (managedHeaderSource === 'online:npm') {
      return t('auth_files.account_settings_managed_header_source_online_npm', {
        defaultValue: 'Online verified via npm registry',
      });
    }
    if (managedHeaderSource === 'observed:first_party') {
      return t('auth_files.account_settings_managed_header_source_observed', {
        defaultValue: 'Observed from a real client request',
      });
    }
    if (managedHeaderSource === 'default') {
      return t('auth_files.account_settings_managed_header_source_default', {
        defaultValue: 'Default strategy, not online-verified',
      });
    }
    return managedHeaderSource || '-';
  })();
  const managedVersionedFields = Object.keys(
    managedHeaderState?.current?.versioned_capabilities || {}
  ).sort();
  const managedStableFields = Object.keys(
    managedHeaderState?.current?.stable_identity || {}
  ).sort();
  const managedRuntimeFields = Object.keys(
    managedHeaderState?.current?.runtime_fingerprint || {}
  ).sort();
  const managedStableEntries = Object.entries(
    managedHeaderState?.current?.stable_identity || {}
  ).sort(([left], [right]) => left.localeCompare(right));
  const managedVersionedEntries = Object.entries(
    managedHeaderState?.current?.versioned_capabilities || {}
  ).sort(([left], [right]) => left.localeCompare(right));
  const hasIdentityProjection =
    managedStableEntries.length > 0 ||
    managedVersionedEntries.length > 0 ||
    managedRuntimeFields.length > 0;
  // 审计数据源：managed_header_state.history。按 reason/changed_fields 分类，
  // 例行 UA/版本刷新折叠为次要流水，身份模型级变更突出展示；最新在前。
  const managedHistory = managedHeaderState?.history || [];
  const classifiedHistory = managedHistory
    .map((entry, index) => ({
      entry,
      index,
      auditClass: classifyIdentityAuditEntry(entry),
    }))
    .reverse();
  const significantHistory = classifiedHistory.filter(
    (item) => item.auditClass === 'significant'
  );
  const routineHistory = classifiedHistory.filter((item) => item.auditClass === 'routine');
  const formatFieldList = (fields: string[]) =>
    fields.length > 0
      ? fields.join(', ')
      : t('auth_files.account_settings_managed_header_none', {
          defaultValue: 'None',
        });
  const readonlyBadge = t('common.readonly', { defaultValue: 'Read only' });

  // 代理状态行：只消费已有结构化信号，不在前端做 status_message 自由文本匹配。
  //  - core 账号视图 warnings 里命中 proxy_url 关键字（machine 真源）→ unavailable
  //  - 现有 proxy_url 校验：empty → missing，invalid → unavailable
  //  - 否则视为 healthy
  const proxyWarningFromCore = (editor?.warnings || []).some((warning) =>
    typeof warning === 'string' ? warning.toLowerCase().includes('proxy_url') : false
  );
  const proxyStatus: 'missing' | 'unavailable' | 'healthy' = (() => {
    if (editor?.proxyUrlError === 'empty') return 'missing';
    if (editor?.proxyUrlError === 'invalid') return 'unavailable';
    if (proxyWarningFromCore) return 'unavailable';
    return 'healthy';
  })();
  const proxyStatusLabel =
    proxyStatus === 'missing'
      ? t('auth_files.account_settings_proxy_status_missing', {
          defaultValue: 'Missing proxy_url',
        })
      : proxyStatus === 'unavailable'
        ? t('auth_files.account_settings_proxy_status_unavailable', {
            defaultValue: 'Proxy unavailable',
          })
        : t('auth_files.account_settings_proxy_status_healthy', {
            defaultValue: 'Proxy configured',
          });

  return (
    <Modal
      open={Boolean(editor)}
      onClose={onClose}
      closeDisabled={editor?.saving === true}
      // 加宽桌面态弹窗（P1）：身份模型 / TLS / 审计三区信息密集，840px 过窄会把
      // 关键区挤到折叠线以下并触发超长内部滚动。用 min(1080px, 96vw) 让桌面更宽、
      // 窄屏仍受 96vw + Modal 自带 maxWidth:100% 约束不溢出。
      width="min(1080px, 96vw)"
      className={styles.accountSettingsModal}
      title={
        editor?.fileName
          ? t('auth_files.account_settings_modal_title', {
              name: editor.fileName,
              defaultValue: `Account settings · ${editor.fileName}`,
            })
          : t('auth_files.account_settings_button', { defaultValue: 'Account settings' })
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={editor?.saving === true}>
            {dirty ? t('common.cancel') : t('common.close')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (!updatedText) return;
              void onCopyText(updatedText);
            }}
            disabled={editor?.saving === true || !updatedText}
          >
            {t('common.copy')}
          </Button>
          <Button
            onClick={onSave}
            loading={editor?.saving === true}
            disabled={
              disableControls ||
              editor?.saving === true ||
              !dirty ||
              Boolean(editor?.proxyUrlError) ||
              Boolean(editor?.extraHeadersError) ||
              Boolean(editor?.transportProfileError) ||
              Boolean(editor?.tlsProfileError)
            }
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {editor && (
        <div className={styles.accountSettingsEditor}>
          {editor.loading ? (
            <div className={styles.accountSettingsLoading}>
              <LoadingSpinner size={14} />
              <span>
                {t('auth_files.prefix_proxy_loading', {
                  defaultValue: 'Loading account settings…',
                })}
              </span>
            </div>
          ) : (
            <>
              {editor.error && <div className={styles.accountSettingsError}>{editor.error}</div>}

              {/* 第 1 区：可编辑账号设置（proxy_url / note / disabled / refresh / 3 个 JSON 覆盖） */}
              <section
                className={`${styles.section} ${styles.sectionEditable}`}
                data-testid="account-settings-section-editable"
              >
                <header className={styles.sectionHeader}>
                  <div>
                    <strong>
                      {t('auth_files.account_settings_section_editable', {
                        defaultValue: 'Editable account settings',
                      })}
                    </strong>
                    <p>
                      {t('auth_files.account_settings_section_editable_desc', {
                        defaultValue:
                          'Only the fields in this section are written by Save (per-account PATCH).',
                      })}
                    </p>
                  </div>
                  <span className={styles.sectionBadge}>
                    {t('auth_files.account_settings_section_editable_badge', {
                      defaultValue: 'Editable',
                    })}
                  </span>
                </header>

                <div className={styles.toggleGrid}>
                  <div className={styles.toggleCard}>
                    <div className={styles.toggleCardTop}>
                      <label>
                        {t('auth_files.status_toggle_label', { defaultValue: 'Enabled' })}
                      </label>
                      <ToggleSwitch
                        checked={!editor.disabled}
                        disabled={disableControls || editor.saving}
                        ariaLabel={t('auth_files.status_toggle_label', {
                          defaultValue: 'Enabled',
                        })}
                        onChange={(enabled) => onChange('disabled', !enabled)}
                      />
                    </div>
                    <div className="hint">
                      {t('auth_files.account_settings_enabled_hint', {
                        defaultValue:
                          'On means this account can be selected by runtime. Turning it off writes disabled=true without deleting data.',
                      })}
                    </div>
                  </div>

                  <div className={styles.toggleCard}>
                    <div className={styles.toggleCardTop}>
                      <label>
                        {t('auth_files.account_settings_refresh_enabled', {
                          defaultValue: 'Automatic token refresh',
                        })}
                      </label>
                      <ToggleSwitch
                        checked={editor.refreshEnabled}
                        disabled={disableControls || editor.saving}
                        ariaLabel={t('auth_files.account_settings_refresh_enabled', {
                          defaultValue: 'Automatic token refresh',
                        })}
                        onChange={(value) => onChange('refreshEnabled', value)}
                      />
                    </div>
                    <div className="hint">
                      {t('auth_files.account_settings_refresh_enabled_hint', {
                        defaultValue:
                          'Keep enabled for normal accounts. Turn it off only for access-token-only testing or controlled migration so this core will not use a refresh token held by another runtime.',
                      })}
                    </div>
                  </div>

                  {/* codex `fast`（service_tier=priority）开关：仅对 codex 账号渲染。 */}
                  {isCodexProvider && (
                    <>
                      <div className={styles.toggleCard} data-testid="account-settings-fast-card">
                        <div className={styles.toggleCardTop}>
                          <label>
                            {t('auth_files.account_settings_fast_label', {
                              defaultValue: 'Fast mode',
                            })}
                          </label>
                          <ToggleSwitch
                            checked={editor.fast}
                            disabled={disableControls || editor.saving}
                            ariaLabel={t('auth_files.account_settings_fast_label', {
                              defaultValue: 'Fast mode',
                            })}
                            onChange={handleFastToggle}
                          />
                        </div>
                        <div className="hint">
                          {t('auth_files.account_settings_fast_hint', {
                            defaultValue:
                              'Codex fast mode (service_tier=priority) trades roughly 2.2x weekly quota consumption for roughly 1.5x faster generation and quicker first-token response. Leave off unless this account can afford the higher burn.',
                          })}
                        </div>
                      </div>
                      {/* Phase 3：fast vs default 前后对比 + 配额 runway + TTFT 切换点
                          sparkline。就摆在决策点（fast 开关）旁；仅 codex、弹窗打开且
                          非加载态时挂载并一次性拉取数据。 */}
                      <AccountFastImpactPanel
                        accountName={editor.fileName}
                        authIndex={editor.authIndex}
                        enabled={!editor.loading}
                      />
                    </>
                  )}

                  {/* TR8：账号级农场纳管开关（farm_enrolled）。老号默认 false（未纳管·
                      免疫农场治理，不受咬合门/自动供给/平台分流管辖），operator 显式
                      开启后才纳入管辖。仿 refreshEnabled 同款 PATCH account-settings
                      调用，不新增独立保存路径。 */}
                  <div
                    className={`${styles.toggleCard} ${styles.toggleCardWide}`}
                    data-testid="account-settings-farm-enrolled-card"
                  >
                    <div className={styles.toggleCardTop}>
                      <label>
                        {t('auth_files.account_settings_farm_enrolled', {
                          defaultValue: 'Farm enrollment',
                        })}
                      </label>
                      <ToggleSwitch
                        checked={editor.farmEnrolled}
                        disabled={disableControls || editor.saving}
                        ariaLabel={t('auth_files.account_settings_farm_enrolled', {
                          defaultValue: 'Farm enrollment',
                        })}
                        onChange={(value) => onChange('farmEnrolled', value)}
                      />
                    </div>
                    <div
                      className={styles.farmEnrolledStatusRow}
                      data-testid="account-settings-farm-enrolled-status"
                    >
                      <span
                        className={`status-badge ${editor.farmEnrolled ? 'success' : 'muted'}`}
                        data-testid="account-settings-farm-enrolled-status-badge"
                      >
                        {editor.farmEnrolled
                          ? t('auth_files.account_settings_farm_enrolled_on_badge', {
                              defaultValue: 'Enrolled',
                            })
                          : t('auth_files.account_settings_farm_enrolled_off_badge', {
                              defaultValue: 'Not enrolled · immune to farm governance',
                            })}
                      </span>
                    </div>
                    <div className="hint">
                      {t('auth_files.account_settings_farm_enrolled_hint', {
                        defaultValue:
                          'Legacy accounts default to not enrolled and stay immune to farm governance (bite gate, auto-provisioning, platform routing). Turning this on subjects the account to those rules.',
                      })}
                    </div>
                  </div>
                </div>

                <Input
                  label={t('auth_files.proxy_url_required_label', {
                    defaultValue: 'Proxy URL (proxy_url) *',
                  })}
                  value={editor.proxyUrl}
                  placeholder={t('auth_files.proxy_url_placeholder')}
                  hint={t('auth_files.proxy_url_required_hint', {
                    defaultValue:
                      'Required. Each account must route outbound traffic through its own residential proxy (http/https/socks5). Leaving it empty would expose your real IP, so core rejects empty/invalid proxy_url.',
                  })}
                  error={
                    editor.proxyUrlError
                      ? editor.proxyUrlError === 'empty'
                        ? t('auth_files.proxy_url_required_error', {
                            defaultValue: 'Proxy URL is required. Enter a residential proxy URL.',
                          })
                        : t('auth_files.proxy_url_invalid_error', {
                            defaultValue:
                              'Invalid proxy URL. Use a full URL such as socks5://user:pass@host:port.',
                          })
                      : undefined
                  }
                  disabled={disableControls || editor.saving}
                  data-testid="account-settings-proxy-url-input"
                  onChange={(e) => onChange('proxyUrl', e.target.value)}
                />

                {/* 代理状态行：紧贴 Proxy URL 之后，留在可编辑区内。 */}
                <div
                  className={styles.proxyStatusRow}
                  data-testid="account-settings-proxy-status-row"
                >
                  <span className={styles.proxyStatusLabel}>
                    {t('auth_files.account_settings_proxy_status_label', {
                      defaultValue: 'Proxy status',
                    })}
                  </span>
                  <span
                    className={`${styles.proxyStatusPill} ${
                      proxyStatus === 'healthy' ? styles.proxyStatusHealthy : styles.proxyStatusWarning
                    }`}
                    data-testid="account-settings-proxy-status-pill"
                    data-proxy-status={proxyStatus}
                  >
                    {proxyStatusLabel}
                  </span>
                </div>

                <Input
                  label={t('auth_files.note_label')}
                  value={editor.note}
                  placeholder={t('auth_files.note_placeholder')}
                  hint={t('auth_files.note_hint')}
                  disabled={disableControls || editor.saving}
                  data-testid="account-settings-note-input"
                  onChange={(e) => onChange('note', e.target.value)}
                />

                <details
                  className={styles.advancedDetails}
                  data-testid="account-settings-editable-advanced-details"
                >
                  <summary>
                    {t('auth_files.account_settings_editable_advanced', {
                      defaultValue: 'Advanced overrides (JSON)',
                    })}
                  </summary>
                  <div className={styles.advancedBody}>
                    <div className="hint">
                      {t('auth_files.account_settings_editable_advanced_hint', {
                        defaultValue:
                          'Optional power-user overrides. Most accounts only need Enabled, Automatic token refresh, Proxy URL and Note above; leave these collapsed unless you know you need them.',
                      })}
                    </div>

                    <div className="form-group">
                      <label>
                        {t('auth_files.account_settings_extra_headers', {
                          defaultValue: 'Extra headers (advanced)',
                        })}
                      </label>
                      <EditableJsonCodeField
                        value={editor.extraHeadersText}
                        placeholder={`{\n  "X-Team": "core"\n}`}
                        invalid={Boolean(editor.extraHeadersError)}
                        disabled={disableControls || editor.saving}
                        testId="account-settings-extra-headers-editor"
                        theme={resolvedTheme}
                        onChange={(value) => onChange('extraHeadersText', value)}
                      />
                      {editor.extraHeadersError && (
                        <div className="error-box">{editor.extraHeadersError}</div>
                      )}
                      <div
                        className={styles.jsonExample}
                        data-testid="account-settings-extra-headers-example"
                      >
                        <span>
                          {t('auth_files.account_settings_extra_headers_example_label', {
                            defaultValue: 'Example',
                          })}
                        </span>
                        <code>{'{ "X-Team": "core" }'}</code>
                      </div>
                      <div className="hint">
                        {t('auth_files.account_settings_extra_headers_hint', {
                          defaultValue:
                            'Editable JSON for user-owned additive headers only. Do not copy core-managed provider/version headers here; conflicts with managed or protocol-reserved headers are rejected by the core API.',
                        })}
                      </div>
                    </div>

                    <div className="form-group">
                      <label>
                        {t('auth_files.account_settings_transport_profile', {
                          defaultValue: 'Transport profile',
                        })}
                      </label>
                      <EditableJsonCodeField
                        value={editor.transportProfileText}
                        placeholder={transportProfilePlaceholder}
                        invalid={Boolean(editor.transportProfileError)}
                        disabled={disableControls || editor.saving}
                        testId="account-settings-transport-profile-editor"
                        theme={resolvedTheme}
                        onChange={(value) => onChange('transportProfileText', value)}
                      />
                      {editor.transportProfileError && (
                        <div className="error-box">{editor.transportProfileError}</div>
                      )}
                      <div className="hint">{transportProfileHint}</div>
                    </div>

                    <div className="form-group">
                      <label>
                        {t('auth_files.account_settings_tls_profile', {
                          defaultValue: 'TLS profile',
                        })}
                      </label>
                      <EditableJsonCodeField
                        value={editor.tlsProfileText}
                        placeholder={tlsProfilePlaceholder}
                        invalid={Boolean(editor.tlsProfileError)}
                        disabled={disableControls || editor.saving}
                        testId="account-settings-tls-profile-editor"
                        theme={resolvedTheme}
                        onChange={(value) => onChange('tlsProfileText', value)}
                      />
                      {editor.tlsProfileError && (
                        <div className="error-box">{editor.tlsProfileError}</div>
                      )}
                      <div className="hint">{tlsProfileHint}</div>
                    </div>
                  </div>
                </details>
              </section>

              {/* 第 2 区：只读身份模型（device_id、A/B 投影、header 策略、运行时身份） */}
              <section
                className={styles.section}
                data-testid="account-settings-section-identity"
              >
                <header className={styles.sectionHeader}>
                  <div>
                    <strong>
                      {t('auth_files.account_settings_section_identity', {
                        defaultValue: 'Identity model',
                      })}
                    </strong>
                    <p>
                      {t('auth_files.account_settings_section_identity_desc', {
                        defaultValue:
                          'Core-derived per-account identity: pinned platform identity (Class A), high-water software fingerprint (Class B) and runtime TLS identity. Not editable.',
                      })}
                    </p>
                  </div>
                  <span className={`${styles.sectionBadge} ${styles.sectionBadgeReadonly}`}>
                    {readonlyBadge}
                  </span>
                </header>

                {isClaudeManagedPolicy && (
                  <div className="form-group">
                    <label>
                      {t('auth_files.account_settings_synthetic_device_id', {
                        defaultValue: 'Synthetic device ID',
                      })}
                    </label>
                    <div
                      className={styles.managedHeaderPanel}
                      data-testid="account-settings-synthetic-device-id-panel"
                    >
                      <div className={styles.managedHeaderPolicyGrid}>
                        <div
                          className={`${styles.managedHeaderPolicyItem} ${styles.managedHeaderPolicyItemWide}`}
                          data-testid="account-settings-synthetic-device-id-value"
                        >
                          <span>
                            {t('auth_files.account_settings_synthetic_device_id_masked', {
                              defaultValue: 'Masked device ID',
                            })}
                          </span>
                          {editor.syntheticDeviceId ? (
                            <strong>
                              <code className={styles.managedHeaderValue} title={editor.syntheticDeviceId}>
                                {editor.syntheticDeviceId}
                              </code>{' '}
                              {isFarmContainerSynced ? (
                                // 已绑定容器：device_id 是容器写入的真实值，标「容器同步」而非合成。
                                <span
                                  className="status-badge success"
                                  data-testid="account-settings-device-id-container-synced-badge"
                                >
                                  {t('auth_files.account_settings_device_id_source_container_synced', {
                                    defaultValue: 'Container-synced',
                                  })}
                                </span>
                              ) : (
                                <span className={styles.managedHeaderChip}>
                                  {t('auth_files.account_settings_synthetic_device_id_synthetic_badge', {
                                    defaultValue: 'Synthetic pseudonym',
                                  })}
                                </span>
                              )}
                            </strong>
                          ) : (
                            <strong data-testid="account-settings-synthetic-device-id-placeholder">
                              {t('auth_files.account_settings_synthetic_device_id_pending', {
                                defaultValue: 'Not derived yet',
                              })}
                            </strong>
                          )}
                        </div>
                      </div>
                      {isFarmUnprovisionedClaude ? (
                        // 未绑定容器的 Claude 账号：不可出站，红警（用户拍板「绑定+健康才正常」）。
                        <div
                          className={`status-badge error ${styles.deviceIdUnprovisionedWarning}`}
                          data-testid="account-settings-device-id-unprovisioned-warning"
                          role="alert"
                        >
                          {t('auth_files.account_settings_device_id_unprovisioned_warning', {
                            defaultValue: '未绑定容器·不可出站——接入农场后才能经住宅代理请求',
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="hint">
                      {t('auth_files.account_settings_synthetic_device_id_hint', {
                        defaultValue:
                          'Read-only. A stable per-account synthetic pseudonym derived by core; only the first 16 hex characters are shown and the real value is never exposed. Empty means core has not derived one yet.',
                      })}
                    </div>
                  </div>
                )}

                {hasIdentityProjection && (
                  <div className="form-group">
                    <label>
                      {t('auth_files.account_settings_identity_model', {
                        defaultValue: 'Per-account identity model',
                      })}
                    </label>
                    <div
                      className={styles.managedHeaderPanel}
                      data-testid="account-settings-identity-model-panel"
                    >
                      <div className={styles.managedHeaderPolicyGrid}>
                        <div className={styles.managedHeaderPolicyItem}>
                          <span>
                            {t('auth_files.account_settings_identity_strategy_label', {
                              defaultValue: 'Identity binding',
                            })}
                          </span>
                          <strong>{identityModelStrategy}</strong>
                        </div>
                        {managedHeaderGeneratedAt ? (
                          <div className={styles.managedHeaderPolicyItem}>
                            <span>
                              {t('auth_files.account_settings_managed_header_generated_at', {
                                defaultValue: 'Generated at',
                              })}
                            </span>
                            <strong>{managedHeaderGeneratedAt}</strong>
                          </div>
                        ) : (
                          <div className={styles.managedHeaderPolicyItem}>
                            <span>
                              {t('auth_files.account_settings_identity_audit_count', {
                                defaultValue: 'Recorded identity changes',
                              })}
                            </span>
                            <strong>
                              {t('auth_files.account_settings_identity_audit_count_value', {
                                count: managedHistory.length,
                                defaultValue: '{{count}} entries',
                              })}
                            </strong>
                          </div>
                        )}
                        <div
                          className={`${styles.managedHeaderPolicyItem} ${styles.managedHeaderPolicyItemWide}`}
                          data-testid="account-settings-identity-rule"
                        >
                          <span>
                            {t('auth_files.account_settings_identity_rule', {
                              defaultValue: 'How identity is resolved',
                            })}
                          </span>
                          <strong>{identityModelRule}</strong>
                        </div>
                        <div
                          className={`${styles.managedHeaderPolicyItem} ${styles.managedHeaderPolicyItemWide} ${styles.identityClassCard}`}
                          data-testid="account-settings-identity-class-a"
                        >
                          <span>
                            {t('auth_files.account_settings_identity_class_a', {
                              defaultValue: 'Class A · pinned platform identity',
                            })}
                          </span>
                          {managedStableEntries.length > 0 ? (
                            <div className={styles.identityClassEntries}>
                              {managedStableEntries.map(([name, value]) => (
                                <div className={styles.identityClassEntry} key={name}>
                                  <span title={name}>{name}</span>
                                  <code title={value}>{value}</code>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <strong>{formatFieldList(managedStableFields)}</strong>
                          )}
                        </div>
                        <div
                          className={`${styles.managedHeaderPolicyItem} ${styles.managedHeaderPolicyItemWide} ${styles.identityClassCard}`}
                          data-testid="account-settings-identity-class-b"
                        >
                          <span>
                            {t('auth_files.account_settings_identity_class_b', {
                              defaultValue: 'Class B · high-water software fingerprint',
                            })}
                          </span>
                          {managedVersionedEntries.length > 0 ? (
                            <div className={styles.identityClassEntries}>
                              {managedVersionedEntries.map(([name, value]) => (
                                <div className={styles.identityClassEntry} key={name}>
                                  <span title={name}>{name}</span>
                                  <code title={value}>{value}</code>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <strong>{formatFieldList(managedVersionedFields)}</strong>
                          )}
                        </div>
                        <div className={styles.managedHeaderPolicyItem}>
                          <span>
                            {t('auth_files.account_settings_managed_header_runtime', {
                              defaultValue: 'Runtime environment signals',
                            })}
                          </span>
                          <strong>{formatFieldList(managedRuntimeFields)}</strong>
                        </div>
                        {(managedHeaderSource ||
                          managedHeaderCheckedAt ||
                          managedHeaderSourceUrl ||
                          managedHeaderCompleteness) && (
                          <div
                            className={styles.managedHeaderPolicyItem}
                            data-testid="account-settings-managed-source"
                          >
                            <span>
                              {t('auth_files.account_settings_managed_header_source', {
                                defaultValue: 'Version source',
                              })}
                            </span>
                            <strong>
                              {[
                                managedHeaderSourceLabel,
                                managedHeaderCheckedAt
                                  ? t(
                                      'auth_files.account_settings_managed_header_source_checked_at',
                                      {
                                        checkedAt: managedHeaderCheckedAt,
                                        defaultValue: 'checked {{checkedAt}}',
                                      }
                                    )
                                  : '',
                                managedHeaderCompleteness
                                  ? t(
                                      'auth_files.account_settings_managed_header_source_completeness',
                                      {
                                        completeness: managedHeaderCompleteness,
                                        defaultValue: 'completeness {{completeness}}',
                                      }
                                    )
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                              {managedHeaderSourceUrl ? ` · ${managedHeaderSourceUrl}` : ''}
                            </strong>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="hint">
                      {t('auth_files.account_settings_identity_model_hint', {
                        defaultValue:
                          'Read-only. Class A platform identity is pinned per account; Class B version markers only move forward (high-water). This is the anti-correlation identity binding, not an editable header list.',
                      })}
                    </div>
                  </div>
                )}

                {isClaudeManagedPolicy ? (
                  <ClaudeHeaderStrategyPanel t={t} />
                ) : (
                  <ManagedHeadersPanel entries={managedHeaderEntries} t={t} />
                )}

                {isClaudeManagedPolicy && (
                  <ClaudeClientVersionObservationsPanel
                    observations={editor.clientVersionObservations}
                    t={t}
                  />
                )}

                {(editor.runtimeProfileText || editor.runtimeIdentityText) && (
                  <RuntimeTlsSummary
                    runtimeProfileText={editor.runtimeProfileText}
                    runtimeIdentityText={editor.runtimeIdentityText}
                  />
                )}

                {editor.runtimeProfileText && (
                  <div className="form-group">
                    <label>
                      {t('auth_files.account_settings_runtime_profile', {
                        defaultValue: 'Runtime profile summary',
                      })}
                    </label>
                    <ReadOnlyCodeViewer
                      value={editor.runtimeProfileText}
                      minRows={8}
                      testId="account-settings-runtime-profile-viewer"
                      label={readonlyBadge}
                      onCopyText={onCopyText}
                    />
                    <div className="hint">{runtimeProfileHint}</div>
                  </div>
                )}

                {editor.runtimeIdentityText && (
                  <div className="form-group">
                    <label>
                      {t('auth_files.account_settings_runtime_identity', {
                        defaultValue: 'Core-generated account TLS identity',
                      })}
                    </label>
                    <ReadOnlyCodeViewer
                      value={editor.runtimeIdentityText}
                      minRows={10}
                      testId="account-settings-runtime-identity-viewer"
                      label={readonlyBadge}
                      onCopyText={onCopyText}
                    />
                    <div className="hint">
                      {t('auth_files.account_settings_runtime_identity_hint', {
                        defaultValue:
                          'Read-only account identity generated and versioned by the core. It stores stable identity hashes, profile source, revision, and history so users do not manually create TLS identities.',
                      })}
                    </div>
                  </div>
                )}

                {editor.warnings.length > 0 && (
                  <div className="form-group">
                    <label>
                      {t('auth_files.account_settings_warnings', {
                        defaultValue: 'Warnings',
                      })}
                    </label>
                    <ReadOnlyCodeViewer
                      value={editor.warnings.join('\n')}
                      minRows={Math.max(3, editor.warnings.length + 1)}
                      testId="account-settings-warnings-viewer"
                      label={readonlyBadge}
                      onCopyText={onCopyText}
                    />
                  </div>
                )}
              </section>

              {/* 第 3 区：身份变更审计（managed_header_state.history，按变更类型分类） */}
              <section
                className={styles.section}
                data-testid="account-settings-section-audit"
              >
                <header className={styles.sectionHeader}>
                  <div>
                    <strong>
                      {t('auth_files.account_settings_identity_audit', {
                        defaultValue: 'Identity change audit',
                      })}
                    </strong>
                    <p>
                      {t('auth_files.account_settings_identity_audit_hint', {
                        defaultValue:
                          'Append-only, read-only audit of per-account identity changes. It records when Class B high-water version markers moved forward and which fields changed; it is not user editable.',
                      })}
                    </p>
                  </div>
                  <span className={`${styles.sectionBadge} ${styles.sectionBadgeReadonly}`}>
                    {readonlyBadge}
                  </span>
                </header>

                <div
                  className={styles.managedHeaderPanel}
                  data-testid="account-settings-identity-audit-panel"
                >
                  {managedHistory.length === 0 ? (
                    <div
                      className={styles.identityAuditEmpty}
                      data-testid="account-settings-identity-audit-empty"
                    >
                      {t('auth_files.account_settings_identity_audit_empty', {
                        defaultValue:
                          'No identity changes have been recorded for this account yet. Entries appear once core refreshes the high-water fingerprint or the identity model changes.',
                      })}
                    </div>
                  ) : (
                    <>
                      <div className={styles.identityAuditGroupHeader}>
                        <span>
                          {t('auth_files.account_settings_identity_audit_significant', {
                            defaultValue: 'Identity model changes',
                          })}
                        </span>
                        <span className={styles.managedHeaderMeta}>
                          {t('auth_files.account_settings_identity_audit_count_value', {
                            count: significantHistory.length,
                            defaultValue: '{{count}} entries',
                          })}
                        </span>
                      </div>
                      {significantHistory.length > 0 ? (
                        <div className={styles.managedHeaderHistoryList}>
                          {significantHistory.map(({ entry, index }) => (
                            <IdentityAuditEntry
                              entry={entry}
                              variant="significant"
                              formatFieldList={formatFieldList}
                              t={t}
                              key={`significant-${entry.recorded_at || index}-${index}`}
                            />
                          ))}
                        </div>
                      ) : (
                        <div
                          className={styles.identityAuditEmpty}
                          data-testid="account-settings-identity-audit-significant-empty"
                        >
                          {t('auth_files.account_settings_identity_audit_significant_empty', {
                            defaultValue:
                              'No identity-model-level changes recorded. Pinned platform identity, device pseudonym, and TLS profile have stayed stable.',
                          })}
                        </div>
                      )}

                      {routineHistory.length > 0 && (
                        <details
                          className={styles.identityAuditRoutineGroup}
                          data-testid="account-settings-identity-audit-routine-group"
                        >
                          <summary className={styles.identityAuditRoutineSummary}>
                            <span>
                              {t('auth_files.account_settings_identity_audit_routine', {
                                defaultValue: 'Routine version refreshes',
                              })}
                            </span>
                            <span className={styles.managedHeaderMeta}>
                              {t('auth_files.account_settings_identity_audit_count_value', {
                                count: routineHistory.length,
                                defaultValue: '{{count}} entries',
                              })}
                            </span>
                          </summary>
                          <div className={styles.identityAuditRoutineBody}>
                            <div className="hint">
                              {t('auth_files.account_settings_identity_audit_routine_hint', {
                                defaultValue:
                                  'Pure User-Agent / version high-water refreshes. They are collapsed here because they do not change the pinned platform identity.',
                              })}
                            </div>
                            <div className={styles.managedHeaderHistoryList}>
                              {routineHistory.map(({ entry, index }) => (
                                <IdentityAuditEntry
                                  entry={entry}
                                  variant="routine"
                                  formatFieldList={formatFieldList}
                                  t={t}
                                  key={`routine-${entry.recorded_at || index}-${index}`}
                                />
                              ))}
                            </div>
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </div>
              </section>

              {/* 保存摘要：仅在 dirty 时展示「本次将保存」轻量预览，靠近底部 Save 区。 */}
              {dirty && (
                <div
                  className={styles.savePreview}
                  data-testid="account-settings-save-summary"
                >
                  <div className={styles.savePreviewHeader}>
                    <strong>
                      {t('auth_files.account_settings_save_summary_label', {
                        defaultValue: 'Will be saved',
                      })}
                    </strong>
                    <span className={styles.managedHeaderMeta}>
                      {t('auth_files.account_settings_save_summary_hint', {
                        defaultValue:
                          'Preview of the per-account PATCH that Save will send right now.',
                      })}
                    </span>
                  </div>
                  <ReadOnlyCodeViewer
                    value={updatedText}
                    minRows={6}
                    testId="account-settings-save-summary-viewer"
                    label={readonlyBadge}
                    onCopyText={onCopyText}
                  />
                </div>
              )}

              {/* 末区：高级原始 JSON 预览（debug 用途，折叠） */}
              <details
                className={styles.advancedDetails}
                data-testid="account-settings-raw-json-details"
              >
                <summary>
                  {t('auth_files.account_settings_raw_json_details', {
                    defaultValue: 'Advanced raw JSON preview',
                  })}
                </summary>
                <div className={styles.advancedBody}>
                  <div className={styles.jsonWrapper}>
                    <label className={styles.fieldLabel}>
                      {t('auth_files.prefix_proxy_info_label', {
                        defaultValue: 'Auth file summary',
                      })}
                    </label>
                    <ReadOnlyCodeViewer
                      value={editor.fileInfoText}
                      minRows={6}
                      testId="account-settings-auth-file-info-viewer"
                      label={readonlyBadge}
                      onCopyText={onCopyText}
                    />
                    <div className="hint">
                      {t('auth_files.prefix_proxy_info_hint', {
                        defaultValue:
                          'Read-only snapshot of the auth file metadata. Edit account settings above.',
                      })}
                    </div>
                  </div>

                  <div className={styles.jsonWrapper}>
                    <label className={styles.fieldLabel}>
                      {t('auth_files.prefix_proxy_source_label', {
                        defaultValue: 'Save payload preview',
                      })}
                    </label>
                    <ReadOnlyCodeViewer
                      value={updatedText}
                      minRows={8}
                      testId="account-settings-save-payload-preview"
                      label={readonlyBadge}
                      onCopyText={onCopyText}
                    />
                    <div className="hint">
                      {t('auth_files.prefix_proxy_source_hint', {
                        defaultValue:
                          'Read-only preview of the payload that Save will send. Editable fields are labeled above.',
                      })}
                    </div>
                  </div>
                </div>
              </details>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
