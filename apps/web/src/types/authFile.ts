/**
 * 认证文件相关类型
 * 基于原项目 src/modules/auth-files.js
 */

import type { RecentRequestBucket } from '@/utils/recentRequests';

export type AuthFileType =
  | 'qwen'
  | 'kimi'
  | 'gemini'
  | 'aistudio'
  | 'claude'
  | 'codex'
  | 'antigravity'
  | 'xai'
  | 'iflow'
  | 'vertex'
  | 'empty'
  | 'unknown';

// --- 迁移自 cpa fork：认证文件状态历史 / OAuth 重新授权历史 ---

export interface AuthFileReauthHistorySummary {
  file_sha256?: string;
  size?: number;
  modtime?: string;
  provider?: string;
  email?: string;
  plan?: string;
  project_id?: string;
  label?: string;
  account_id_hash?: string;
}

export interface AuthFileReauthHistoryEntry {
  event_type?: string;
  occurred_at?: string;
  provider?: string;
  target_auth_file?: string;
  overwrote_existing?: boolean;
  before?: AuthFileReauthHistorySummary;
  after?: AuthFileReauthHistorySummary;
  error?: string;
}

export type AuthFileStatusHistoryTrigger = 'manual' | 'auto';

export interface AuthFileStatusHistoryEntry {
  event_type?: string;
  occurred_at?: string;
  auth_name?: string;
  provider?: string;
  trigger?: AuthFileStatusHistoryTrigger | string;
  previous_status?: string;
  previous_message?: string;
  status?: string;
  status_message?: string;
  error?: string;
}

export type AuthFileHeaderMap = Record<string, string>;

/**
 * 迁移自 cpa fork：单个账号的 core 管理身份投影快照。
 *
 * 反关联模型（A/B + high-water）：
 *  - A 类「固定平台身份」：`stable_identity`（OS/Arch/X-App 等跨版本钉死的字段）。
 *  - B 类「高水位软件指纹」：`versioned_capabilities`（UA / package / runtime 版本，
 *    只升不降的 high-water）。
 *  - `runtime_fingerprint`：运行时环境信号（非身份钉死项）。
 * 字段名沿用 core projection，语义重定义为「身份投影」而非旧的「自动升级策略」。
 */
export interface AuthFileManagedHeaderProjection {
  generated_at?: string;
  source?: string;
  source_url?: string;
  checked_at?: string;
  completeness?: string;
  summary_headers?: AuthFileHeaderMap;
  versioned_capabilities?: AuthFileHeaderMap;
  stable_identity?: AuthFileHeaderMap;
  runtime_fingerprint?: AuthFileHeaderMap;
}

/**
 * 迁移自 cpa fork：单条「身份变更审计」记录（重定义复用，非删除）。
 * 旧字段 `policy_version` 仅保留以兼容历史 payload，UI 不再展示它，也不再使用
 * 「自动升级策略版本」措辞；每条记录的版本依据改为来自 `next_source` / `source`。
 */
export interface AuthFileManagedHeaderHistoryEntry {
  recorded_at?: string;
  /** Compat field from older core payloads; no longer surfaced in the UI. */
  policy_version?: string;
  reason?: string;
  source?: string;
  source_url?: string;
  changed_fields?: string[];
  /** core 实际下发的来源字段（managed_header_state.history）。 */
  previous_source?: string;
  previous_source_url?: string;
  next_source?: string;
  next_source_url?: string;
  previous_summary_headers?: AuthFileHeaderMap;
  next_summary_headers?: AuthFileHeaderMap;
  previous_versioned_capabilities?: AuthFileHeaderMap;
  next_versioned_capabilities?: AuthFileHeaderMap;
  /** A 类钉死平台身份快照；diff 非空时该条目属于身份模型变更而非例行版本刷新。 */
  previous_stable_identity?: AuthFileHeaderMap;
  next_stable_identity?: AuthFileHeaderMap;
  previous_runtime_fingerprint?: AuthFileHeaderMap;
  next_runtime_fingerprint?: AuthFileHeaderMap;
  previous?: Record<string, unknown>;
  next?: Record<string, unknown>;
}

/**
 * 迁移自 cpa fork：身份投影 + 身份变更审计历史。`history` 重定义复用为
 * 「身份变更审计」视图数据源。
 */
export interface AuthFileManagedHeaderState {
  /** Compat field from older core payloads; not shown as an upgrade-policy version. */
  policy_version?: string;
  current?: AuthFileManagedHeaderProjection | null;
  history?: AuthFileManagedHeaderHistoryEntry[];
}

export interface AuthFileClientVersionObservation {
  user_agent?: string;
  version?: string;
  package_version?: string;
  runtime_version?: string;
  os?: string;
  arch?: string;
  source?: string | Record<string, unknown>;
  first_seen_at?: string;
  last_seen_at?: string;
  request_count?: number;
}

export interface AuthFileAccountSettingsActivation {
  summary: string;
  state?: string;
  source?: string;
  effective?: boolean;
}

/**
 * 迁移自 cpa fork：账号设置结构化视图。
 * 身份只读字段（synthetic_device_id / managed_header_state /
 * client_version_observations / stable_identity 等）不可写、不进 PATCH；
 * 可编辑字段见 `AuthFileAccountSettingsPatchRequest` 白名单。
 */
export interface AuthFileAccountSettings {
  proxy_url: string;
  note: string;
  disabled: boolean;
  managed_headers: AuthFileHeaderMap;
  extra_headers: AuthFileHeaderMap;
  refresh_enabled: boolean;
  /**
   * 迁移自 cpa fork：该账号是否启用 codex `fast`（service_tier=priority）。
   * `fast:true` = 以约 2.2x 的周额度消耗换约 1.5x 的生成速度；仅对 codex 账号有意义。
   */
  fast?: boolean;
  transport_profile: string | Record<string, unknown> | null;
  tls_profile: string | Record<string, unknown> | null;
  runtime_profile?: Record<string, unknown> | null;
  runtime_identity?: Record<string, unknown> | null;
  /**
   * 只读、脱敏的每账号合成 device_id（来自反关联身份投影）。
   * 格式为「前 16 位小写 hex + …(U+2026)」；后端 `omitempty`，auth 缺失或派生空时缺省。
   * 仅用于展示，不可写、不进 PATCH。
   */
  synthetic_device_id?: string;
  managed_header_state?: AuthFileManagedHeaderState | null;
  client_version_observations?: AuthFileClientVersionObservation[];
  activation: AuthFileAccountSettingsActivation;
  warnings: string[];
  /**
   * 农场契约字段（后端 AG1 同步实现中，见 farm accounts 端点同名字段）：
   * 该账号是否已绑定农场容器。加法式向后兼容——缺失时前端防御式回退旧的
   * 「合成假名 / 尚未派生」展示，不臆造绑定关系。
   */
  farm_bound?: boolean;
  /**
   * 农场契约字段（后端 AG1 同步实现中）：device_id 展示口径来源
   * （container_synced=已绑定容器写入真实 device_id / synthetic=未绑定用合成 /
   * drift=历史漂移 / unknown=无法判定）。缺失时前端回退旧行为。
   */
  device_id_source?: string;
  /**
   * 农场契约字段（TR1 telemetry-device-farm，core `authFileAccountSettingsView.
   * FarmEnrolled`，恒有值非 omitempty）：该账号是否已纳入农场治理（咬合门/
   * 自动供给/平台分流）。与只读的 `farm_bound`（是否已绑定容器）是两个独立
   * 概念——账号可以「已纳管但尚未绑定」（排队供给中）或「已绑定但纳管字段缺省」
   * （历史记录）。老号默认 false（免疫农场治理），operator 显式开启后才受管。
   * 可写字段，随本白名单一起 PATCH。
   */
  farm_enrolled?: boolean;
}

export interface AuthFileAccountSettingsResponse {
  name?: string;
  account_settings?: Partial<AuthFileAccountSettings> | null;
  [key: string]: unknown;
}

/**
 * PATCH `/auth-files/account-settings` 请求体：只包含白名单可编辑字段
 * （name/proxy_url/note/disabled/extra_headers/refresh_enabled/farm_enrolled/
 * transport_profile/tls_profile）。身份只读字段（synthetic_device_id 等）不
 * 在此结构中，避免被误写。
 *
 * `farm_enrolled` 后端为 `*bool`（省略即保留原值），但与既有 `refresh_enabled`
 * 同款约定一致：前端编辑器状态恒有值，每次保存都显式回传当前值，不依赖后端的
 * 省略保留语义。
 */
export interface AuthFileAccountSettingsPatchRequest {
  name: string;
  proxy_url: string | null;
  note: string | null;
  disabled: boolean;
  extra_headers: AuthFileHeaderMap;
  refresh_enabled: boolean;
  /** 该账号是否启用 codex `fast`（service_tier=priority）；仅对 codex 账号有意义。 */
  fast?: boolean;
  /**
   * 农场纳管开关；农场是 Claude 专属能力，仅对 provider=claude 账号有意义。
   * 非 claude 账号省略该字段（后端 `*bool` 指针 nil=不改），避免写入无意义值。
   */
  farm_enrolled?: boolean;
  transport_profile: string | Record<string, unknown> | null;
  tls_profile: string | Record<string, unknown> | null;
}

export interface AuthFileItem {
  name: string;
  type?: AuthFileType | string;
  provider?: string;
  size?: number;
  authIndex?: string | number | null;
  runtimeOnly?: boolean | string;
  disabled?: boolean;
  unavailable?: boolean;
  status?: string;
  statusMessage?: string;
  lastRefresh?: string | number;
  modified?: number;
  note?: string;
  proxy_url?: string;
  headers?: AuthFileHeaderMap;
  account_settings?: AuthFileAccountSettings;
  accountSettings?: AuthFileAccountSettings;
  reauth_history?: AuthFileReauthHistoryEntry[];
  status_history?: AuthFileStatusHistoryEntry[];
  cyber_policy_flag_count?: number;
  last_cyber_policy_at?: string;
  /**
   * 账号是否被 core 自动隔离（终态认证失败等不可重试错误触发，见 core
   * sdk/cliproxy/auth/conductor.go markAutoQuarantine）。core 恒下发该字段
   * （无条件写入），是判定「已隔离」的唯一权威字段，优先级高于
   * unavailable/status/status_message 等健康态判定（同款迁移自 apps/web
   * telemetry-farm-ux-hardening T3：清隔离锁与 status 落库非原子，可能短暂
   * 不一致，隔离态一律优先信这个布尔）。
   */
  auto_quarantined?: boolean;
  /** 隔离原因（仅 auto_quarantined=true 时存在），当前固定值 "terminal_auth_failure"。 */
  quarantine_reason?: string;
  /** 隔离发生时间，RFC3339（仅 auto_quarantined=true 时存在）。 */
  quarantined_at?: string;
  /** 重新认证入口 URL（部分 provider，如 anthropic/claude，才会下发）。 */
  reauth_url?: string;
  /**
   * 需重新认证标记（纵深防御信号）：core 顶层或 metadata 可能下发此布尔；即便
   * reauth_url 缺失、unavailable 尚未置 true，只要为真也应判为异常（见
   * constants.ts isAuthFileReauthRequired）。
   */
  reauth_required?: boolean;
  success?: unknown;
  failed?: unknown;
  project_id?: string;
  projectId?: string;
  gemini_virtual_project?: string;
  geminiVirtualProject?: string;
  recent_requests?: RecentRequestBucket[];
  recentRequests?: RecentRequestBucket[];
  /**
   * P7：账号会话计数 + 细粒度订阅等级只读投影，见 AuthFileAccountScheduling
   * 类型注释。core 恒下发该顶层 key（即便个别嵌套值为 null），但跨版本/过渡
   * 期部署仍可能整体缺失该 key（部署的 core 落后于本次改动，仓库里已有先例——
   * 见 farm_enrolled/telemetry_alive 同款"编排器透传未落地前恒缺省"约定）。
   * 前端消费方必须把 undefined/null 当作"暂不可用"处理，不得当 0 或"未知"
   * 展示——那是两种不同的降级语义（数据源缺失 vs 数据源确认无法识别）。
   *
   * 字段历史：core 侧原名 `adaptive_scheduling`，已随 §8.5 命名空间统一改名为
   * `account_scheduling`（见 core
   * internal/api/handlers/management/auth_files.go / auth_files_adaptive_scheduling.go
   * buildAccountSchedulingView）；前端同步跟改，子字段形状不变。
   */
  account_scheduling?: AuthFileAccountScheduling | null;
  [key: string]: unknown;
}

export interface AuthFilesResponse {
  files: AuthFileItem[];
  total?: number;
}

/**
 * P7（account-session-count-display）：账号维度会话计数 + 细粒度订阅等级只读
 * 投影（core `entry["account_scheduling"]`（原名 `adaptive_scheduling`，见 core
 * internal/api/handlers/management/auth_files_adaptive_scheduling.go
 * buildAccountSchedulingView）。additive、namespaced，core 恒下发该顶层 key。
 *
 * 本期前端只消费 subscription_tier + sessions_{total,active,closed} 四个字段
 * 用于渲染；tier_source / rate_scale 本期只补类型（契约同步），暂不接入任何
 * UI 渲染逻辑。该投影下还有 quota_utilization / first_production_at / warmup
 * 等更多字段，本期不消费，用 `[key: string]: unknown` 兜底透传，避免类型收窄
 * 丢数据。
 */
export interface AuthFileAccountScheduling {
  /**
   * 细粒度订阅档位：
   *  - Claude: "max_20x" | "max_5x" | "pro" | "unknown"
   *  - Codex: "pro" | "plus" | "unknown"
   *  - 其它 provider：core 恒回退 "unknown"（未覆盖 provider）。
   * core 对无法识别的原始档位值一律落 "unknown"，绝不臆造成任一已知档位；
   * 前端消费同样遵守这一契约——非 max_20x/max_5x/pro/plus 的任何值都当
   * 「未知」展示，不做模糊匹配。
   */
  subscription_tier?: string;
  /**
   * subscription_tier 的来源（core §8.4）：'auto' 表示由 rate_limit_tier /
   * chatgpt_plan_type 自动探测得出；'override' 表示由账号级手工 tier_override
   * 驱动。本期只加类型，不接入 UI 渲染。
   */
  tier_source?: 'auto' | 'override';
  /**
   * 该账号有效的速率乘子（core §8.3，AccountRateScale）：作用于派生出的速率
   * 上限（rpm/burst/concurrency/daily budget），不影响调度权重；缺省时 core
   * 恒回退 1.0（无效果）。本期只加类型，不接入 UI 渲染。
   */
  rate_scale?: number;
  /**
   * 账号养号（warm-up）状态投影（core
   * internal/api/handlers/management/auth_files_adaptive_scheduling.go，取自
   * sdk/cliproxy/auth.AccountWarmupStatusFor）。`mature` 是权威布尔（是否已走出
   * 养号曲线进入成熟档），`stage` 是当前阶段名（合成态 "cold"/"mature" 或
   * 配置曲线里的自定义阶段名），`age_days` 是账号年龄（未锚定 first_production_at
   * 时为 null）。前端只按 `mature === false` 判定「养号中」，不臆造其它阶段语义。
   */
  warmup?: AuthFileAccountWarmup | null;
  /**
   * 该账号索引下观测到的去重 SessionID 总数（P6，core
   * internal/usage.SessionAggregateForAuthIndex，按空闲窗口分桶）。
   * 恒为非负整数；0 是「确有其事的 0」（真的没有会话），不是「未知」——
   * core 侧「无采集/无会话」两种情况都报 0，不像 quota_utilization 那样
   * 用 null 区分「缺快照」。前端展示 0 时必须用「暂无会话数据」文案，不能
   * 直接渲染数字 0（容易被误读成「刚发生过 0 次」而非「压根没数据」）。
   */
  sessions_total?: number;
  /** 按空闲窗口判定仍活跃的会话数（<= sessions_total）。 */
  sessions_active?: number;
  /** 按空闲窗口判定已关闭（超时）的会话数（<= sessions_total）。 */
  sessions_closed?: number;
  [key: string]: unknown;
}

/**
 * account_scheduling.warmup 子投影（core auth_files_adaptive_scheduling.go
 * warmupView）。additive、只读；跨版本部署可能整体缺失（老 core 未投影 warmup），
 * 消费方必须把缺失/非布尔的 `mature` 当作「不可判定」（不展示养号标注），只有
 * `mature === false` 才明确判定为养号中。
 */
export interface AuthFileAccountWarmup {
  /** 当前养号阶段名（合成态 "cold"/"mature"，或配置曲线自定义阶段名）。 */
  stage?: string;
  /** 是否已走出养号曲线进入成熟档（权威布尔；false = 养号中）。 */
  mature?: boolean;
  /** 账号年龄（天）；未锚定 first_production_at 时 core 下发 null。 */
  age_days?: number | null;
  [key: string]: unknown;
}

/**
 * claude 账号级 tier_override 合法值（core `coreauth.LegalTierOverrideValues('claude')`）。
 * 「清除覆盖」在请求体里用 `null` 表示，不属于该联合。
 */
export type AuthFileAccountSchedulingTierOverride = 'max_20x' | 'max_5x' | 'pro';

/**
 * PATCH `/auth-files/account-scheduling` 请求体（core §8.3/§8.4/§8.5，是与
 * `/auth-files/account-settings` 白名单完全独立的调度旋钮端点）：设置 / 清除
 * 账号级 tier_override 与 rate_scale。契约：
 *  - `name` 必填；`auth_index` 可选（多 auth 同名文件消歧）。
 *  - `tier_override`：max_20x|max_5x|pro 强制档位；`null` 清除（回退 auto 探测）。
 *  - `rate_scale`：> 0 覆盖速率乘子；`null` 清除（回退 core 默认 1.0）。
 *  - `tier_override` / `rate_scale` 至少给一个（core 侧校验；缺失回 400）。
 */
export interface AuthFileAccountSchedulingPatchRequest {
  name: string;
  auth_index?: string | number;
  tier_override?: AuthFileAccountSchedulingTierOverride | null;
  rate_scale?: number | null;
}

/**
 * PATCH `/auth-files/account-scheduling` 成功响应（200）：core 回显归一化后的
 * `account_scheduling` 只读投影（合法值归一化 / tier_source 回退语义都以此为准，
 * 前端据此重渲染，不乐观地把提交的表单值当新状态）。
 */
export interface AuthFileAccountSchedulingResponse {
  name?: string;
  account_scheduling: AuthFileAccountScheduling;
}
