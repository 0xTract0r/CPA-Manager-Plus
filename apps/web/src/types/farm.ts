/**
 * 农场编排器（Device Farm）类型定义
 *
 * 字段名照抄 services/farm-orchestrator/internal/httpapi/dto.go 与
 * internal/cpa/client.go 的 JSON 契约，不臆造字段。农场编排器是独立后端服务，
 * 默认零配置走同源 `/api/farm/*` 反代 + cpamp 会话身份，只有显式设置了高级
 * 覆盖（见 farmClient.ts / useFarmStore.ts）才会改用独立 base URL + 独立
 * admin key 直连另一个编排器实例；两种模式下响应体本身都不复用 CPA 的
 * /v0/management 契约。
 */

// GET /api/farm/containers 单条记录的 binding 子结构（dto.go bindingView）
export interface FarmBindingView {
  env: string;
  account: string;
  auth_index?: number;
  bound_at: string;
  // 绑定账号的 CPA 备注名（dto.go bindingView.Note，cpa.AuthFileEntry.Note 的
  // 容器视角投影，如 "AC11-CLAUDE-GOOGLE"）。供容器池「绑定账号」列优先展示
  // 备注名而非裸邮箱（#52）。留空表示该账号没有设置 note，或本次请求未能拉到
  // CPA 账号快照（中性回退，不是「确认没有备注」），前端回退到脱敏邮箱。
  note?: string;
}

// GET /api/farm/containers/{id}/... 时序响应共用的分桶资源快照（dto.go
// resourceSnapshotView）。P0-4 只读监测 API，供列表 latest_resource 与容器
// 详情复用；数值字段全部 omitempty——从未采集过时字段缺失，前端渲染 '—'，
// 不伪造 0。
export interface FarmResourceSnapshotView {
  ts: string;
  mem_used_bytes?: number;
  mem_pct?: number;
  cpu_pct?: number;
}

// 下一次探针估算（dto.go nextEstimateView，design.md 决策4「配置区间 + 实测
// 均值，不造假」）。min/base/max 是容器侧保活脚本默认配置区间的字面复制，
// 不是该容器 docker run 时实际生效的 env（P1 才接入 per-容器快照）；
// avg_observed_seconds_24h 是近 24h 首末非空分桶跨度推出的实测均值，样本数
// <=1 时缺失。note 固定携带随机抖动 + 非精确说明，前端应原样展示，不用自己
// 的措辞替换。
export interface FarmNextEstimateView {
  min_seconds: number;
  max_seconds: number;
  base_seconds: number;
  avg_observed_seconds_24h?: number;
  note: string;
}

// GET /api/farm/containers 单条记录（dto.go containerView）
// device_id 只暴露脱敏前 16 位，真实值不经这个只读接口回吐。
//
// **P0-4 变更**：移除恒 NULL 的死列 `token_usage`（design.md 决策2「废弃
// containers.token_usage 死列」，后端 DTO 已删除该字段，前端不再消费）；
// 新增 health_reason/latest_resource/success_rate_24h/device_id_alignment/
// next_keepalive_estimate 五个增强字段（design.md 决策4「容器列表增强」，
// tasks.md P0-4/P0-9）。
export interface FarmContainerView {
  id: string;
  device_id_masked: string;
  status: string;
  residential_ip?: string;
  last_keepalive_at?: string;
  archived_at?: string;
  created_at: string;
  updated_at: string;
  binding?: FarmBindingView;
  // 当前状态的可读判定原因（httpapi/observability.go computeHealthReason
  // 重建）；created/starting/retired/orphaned 等非 running/degraded/down
  // 状态用固定占位字符串。空串（omitempty）按未知处理，不假造 'ok'。
  health_reason?: string;
  // 最近一条缓存资源样本，覆盖 created/down 等非 running 状态的最后已知值；
  // 从未采集过时缺失。
  latest_resource?: FarmResourceSnapshotView;
  // 最近 24h keepalive 探针成功率 [0,1]，该窗口内无样本时缺失（不伪造 0%）。
  success_rate_24h?: number;
  // device_id 对齐（容器→账号方向）：container_synced/drift/unknown 三态
  // （不会取 synthetic——那是账号→容器方向 FarmAccountEntry.device_id_source
  // 专用值）；未绑定容器缺失（无账号可对齐）。
  device_id_alignment?: Extract<FarmDeviceIDSource, 'container_synced' | 'drift' | 'unknown'>;
  // 下一次探针估算，仅 running/degraded 容器给出。
  next_keepalive_estimate?: FarmNextEstimateView;
  // AccountAuthStatus/AccountAuthReason（FO2「假绿修复：健康两平面」，dto.go
  // containerView 同名字段）：账号认证态平面，与本结构体其余「容器运行态」
  // 字段（status/health_reason）完全独立推导，供前端展示两个独立维度的徽标。
  // 取值：alive（快照新鲜且账号未 disabled/auto_quarantined、token 存活）/
  // dead（新鲜快照证实账号 disabled/auto_quarantined 或 token 不活，
  // account_auth_reason 给出具体原因）/ unknown（未绑定 / 从未采集 / 快照已
  // 陈旧超过后端 AccountStateStaleThreshold(15min) / 账号态存储未装配）。
  // account_auth_reason 只在 dead 时有意义，取值
  // account_disabled/account_auto_quarantined/account_token_dead 三者之一；
  // unknown 态下可能为空串或字面 "stale"（陈旧但曾采集到过），前端不应假造
  // 其它文案。未绑定容器留空（无账号可判定）。
  account_auth_status?: string;
  account_auth_reason?: string;
  // TP-3「舰队级遥测」点亮：TR7 遥测存活三态（farmrunner.DecideTelemetryAlive）
  // 判定结果，逐字对应 dto.go containerView.TelemetryAlive（services/farm-orchestrator/
  // internal/httpapi/dto.go / observability.go computeTelemetryAlive）——判的是
  // 「该容器 device_id 是否观测到真实 on-wire 出站」，与 status/health_reason
  // （容器运行态）、account_auth_status（账号认证态）是三个完全独立的维度，不
  // 互相替代。后端该字段**恒返回**三态之一（无 omitempty），这里仍声明可选是
  // 防御式取舍——旧编排器版本/字段裁剪场景下缺失时前端不应崩溃，一律经
  // normalizeFarmTelemetryAliveState 归一到 unknown（utils/health.ts），不臆造
  // 成 alive/silent。与 FarmAccountEntry.telemetry_alive 是同一份判定结果在两个
  // DTO 上的镜像（dto.go accountView.TelemetryAlive 注释：「镜像该账号当前绑定
  // 容器的 TelemetryAlive」）；本字段独立声明是因为未绑定容器同样有值（判的是
  // 容器/device_id 本身，不依赖账号绑定）。
  telemetry_alive?: FarmTelemetryAliveState;
  // R5-2 改绑防误绑：该容器上次绑定过的账号标识（备注名 / 邮箱 / auth 文件名，
  // 编排器 containerView.LastBoundAccount 透传，与 bindingView.Account 同源脱敏
  // 口径）。**仅解绑过、当前 status=down 的容器有值**——供 UI 显示「上次绑定：X
  // （已解绑）」，让 operator 一眼看清该容器历史归属，而不是拿裸 device_id hex
  // 当账号误认。当前有绑定（binding 非空）或从未绑过时缺失（omitempty）。前端用
  // resolveBindingIdentity / maskAccountEmail 走与全站一致的脱敏展示。
  last_bound_account?: string;
  // TP「遥测静默」信号（dto.go containerView.TelemetrySilence / telemetrySilenceView）：
  // 与 telemetry_alive 是两个独立维度——telemetry_alive 只认 on-wire 采集来源；
  // telemetry_silence 不区分来源，任意一条 beacon（含自报）都刷新「最近活动时间」，
  // 回答更基础的「这个容器最近有没有产生过任何上报」。后端对 containerView 恒返回，
  // 这里仍声明可选是防御旧编排器/字段裁剪，缺失时前端按「未知」处理不臆造。
  telemetry_silence?: FarmTelemetrySilenceView;
  // 「遥测停摆四态」判定（farm-egress-resilience Change A，dto.go
  // containerView.TelemetrySilenceState / telemetrySilenceStateView）：综合最新出站
  // 探针（proxy_direct / egress_canary / redsocks 饱和）+ 既有 process_signal + 静默
  // 时长，判「代理死 / 出站黑洞 / 进程死 / 正常无请求」四态之一，取代单一「遥测旧了」；
  // 无法确证时为 indeterminate（待确认，诚实边界，绝不臆断）。后端恒返回一个 state
  // （不 omitempty），这里仍声明可选是防御旧编排器/字段裁剪——缺失时前端回退既有
  // telemetry_silence 的 is_stale 呈现，见 FarmTelemetryPanel。
  telemetry_silence_state?: FarmTelemetrySilenceStateView;
  // farm-proxy-rotation §5「指纹卡 pin」：容器的**意图身份**（编排器钉给该容器的预期
  // 指纹，dto.go fingerprintPinView / observability.go:565）。供遥测页指纹自洽卡把死掉的
  // declared 列换成「预期(pin)」逐字段对照 on-wire 实测——不一致即撞红=泄露。后端
  // containerView 恒填充（每容器创建即有 device_id），这里仍声明可选是防御旧编排器/字段
  // 裁剪，缺失时前端不渲染 pin 列。三字段语义：
  //   - device_id_masked：注册表钉死的 device_id 脱敏（**绝不明文**）。**精确格式**=前 12 字符
  //     + U+2026 省略号「…」+ 后 4 字符，须与前端 utils/identity.ts maskTelemetryFingerprint、
  //     后端 maskIdentifierMiddle 逐字节一致——pin 与 on-wire 撞红判定依赖两端产出同款脱敏串
  //     逐字比对，改任一端脱敏格式（前缀/后缀长度、省略号字符）都必须同步另一端，否则会把同一
  //     device_id 误判成撞红=泄露。与 on-wire beacon 的 reported_fields.device_id 同款脱敏口径比对。
  //   - entrypoint：常量 "cli"（真实 Claude CLI 交互态自报值）；on-wire 自报非 cli 即信号。
  //   - api_base_url_host：遥测该发的**官方端点**语义（api.anthropic.com）；on-wire 若出现
  //     自有 CPA 主机=host_leak 泄露。
  fingerprint_pin?: {
    device_id_masked: string;
    entrypoint: string;
    api_base_url_host: string;
  };
}

// telemetry_silence 对外形状（dto.go telemetrySilenceView，字段名严格对齐、不要改名）。
export interface FarmTelemetrySilenceView {
  // 最近一条 beacon 距今是否已超过 threshold_minutes。
  is_stale: boolean;
  // 距最近一条 beacon 的分钟数；**哨兵值 -1 表示从未观测到任何 beacon**（没有基线可
  // 比），不是「刚好 0 分钟前」——消费方必须识别这个哨兵值，不能直接格式化成
  // 「-1 分钟前」展示（见 FarmTelemetryPanel 新鲜度区）。
  minutes_since_last: number;
  // 判定 is_stale 的门槛（分钟）。
  threshold_minutes: number;
}

// 「遥测停摆四态」字面值（farm-egress-resilience Change A，与后端
// farmrunner.SilenceState* 常量逐字对齐、不要改名；判定纯函数见
// services/farm-orchestrator/internal/farmrunner/telemetrysilencestate.go）：
//  - active           遥测仍在流动（非停摆）——诚实基线值，不属四态诊断。
//  - proxy_dead       代理死（proxy_direct 探针失败）→ 换代理。
//  - egress_blackhole 出站黑洞 / redsocks 饱和（代理活但 canary 失败或连接表饱和）
//                     → 疏通 / 重置 redsocks（换代理无用）。
//  - process_dead     进程死（最近一条 beacon 携带进程终止信号）→ 查进程。
//  - idle_no_request  正常无请求（探针全通证明网络通、无进程死信号）→ 无需处理。
//  - indeterminate    待确认（证据不足：缺新鲜探针又无进程死信号，无法区分黑洞与
//                     正常没请求）——诚实边界，绝不臆断。
// 归一化/兜底逻辑见 features/farm/utils/health.ts normalizeFarmTelemetrySilenceState
// （非枚举值一律回退 indeterminate，绝不臆断成乐观结论）。
export const FARM_TELEMETRY_SILENCE_STATES = [
  'active',
  'proxy_dead',
  'egress_blackhole',
  'process_dead',
  'idle_no_request',
  'indeterminate',
] as const;
export type FarmTelemetrySilenceState = (typeof FARM_TELEMETRY_SILENCE_STATES)[number];

// 单个出站 canary 目标探测结果（dto.go egressCanaryTargetView，字段名严格对齐）。
export interface FarmEgressCanaryTargetView {
  host: string;
  ok: boolean;
  latency_ms: number;
  err?: string;
}

// 最新出站探针快照（dto.go egressProbeView，字段名严格对齐、不要改名）：驱动四态
// 网络层判据，供前端排障展示原始探针结论。stale=true 表示探针距今超过新鲜度窗口、
// 四态判定已不信任它描述「当下」。**不带任何真实账号 token**（探针本就只探连通性，
// 见 spec「探针不带 token」）。
export interface FarmEgressProbeView {
  checked_at: string;
  stale: boolean;
  proxy_direct_ok: boolean;
  proxy_direct_err?: string;
  egress_canary_ok: boolean;
  egress_canary_targets: FarmEgressCanaryTargetView[];
  redsocks_recv_q: number;
  redsocks_backlog: number;
  redsocks_close_wait: number;
  redsocks_saturated: boolean;
}

// 「遥测停摆四态」对外形状（dto.go telemetrySilenceStateView，字段名严格对齐）。
export interface FarmTelemetrySilenceStateView {
  // state 取 FARM_TELEMETRY_SILENCE_STATES 之一；诚实边界：无法确证时为
  // indeterminate（待确认），不臆断。后端恒返回，前端经
  // normalizeFarmTelemetrySilenceState 兜底非枚举值到 indeterminate。
  state: string;
  // 后端给出的建议动作（中文单串，仅供排障参考）；前端主展示走 i18n 按 state
  // 派生的本地化文案（4 语言），不直接依赖这个中文串，故声明可选。active 无动作。
  recommended_action?: string;
  // 最近一条 beacon 是否携带进程终止信号（既有 process_signal 投影）。
  process_terminated: boolean;
  // 驱动网络层判据的最新探针快照；从未收到探针 / 探针存储未装配时为 null
  // （此时 state 只能落 process_dead 或 indeterminate，绝不臆断黑洞 / idle）。
  probe: FarmEgressProbeView | null;
}

// 容器状态取值（store.Status* 常量，供前端徽标着色用；未知值按 fallback 灰色处理）
// retired = 已退役（软删归档，容器与卷按 delete_volume 参数决定是否清）；
// orphaned = 幽灵态（注册表存在但对应容器/绑定关系异常，等待 operator 收敛为 retired）。
// 两者都属于 store.IsArchivedStatus，默认容器列表视图会排除，见 handleListContainers。
export const FARM_CONTAINER_STATUSES = [
  'created',
  'starting',
  'running',
  'degraded',
  'down',
  'retired',
  'orphaned',
] as const;
export type FarmContainerStatus = (typeof FARM_CONTAINER_STATUSES)[number];

// 环境枚举（store.IsValidEnv 只认 test / prod）
export const FARM_ENVS = ['test', 'prod'] as const;
export type FarmEnv = (typeof FARM_ENVS)[number];

// POST /api/farm/containers 请求体（dto.go createContainerRequest）
export interface FarmCreateContainerRequest {
  id: string;
}

// POST /api/farm/bindings 请求体（dto.go createBindingRequest）
export interface FarmCreateBindingRequest {
  container_id: string;
  account_id: string;
  env: FarmEnv;
  auth_index?: number;
}

// POST /api/farm/bindings 响应体（dto.go bindingResponse）
export interface FarmBindingResponse {
  container_id: string;
  account_id: string;
  env: string;
  auth_index?: number;
  bound_at: string;
  device_write: 'ok' | 'pending' | 'failed';
  detail?: string;
}

// DELETE /api/farm/bindings/{id} 响应体（handlers.go handleDeleteBinding）
export interface FarmUnbindResponse {
  device_write: string;
  detail: string;
}

// POST /api/farm/onboard 请求体（design.md 决策5「半自动 onboard」，P0-6 后端
// 已落地并注册路由，字段名照抄 dto.go onboardRequest）。account_id/env 必填，
// proxy_url/container_id 可选（不传 proxy_url 由编排器按 env 现取可用住宅
// 代理；不传 container_id 由编排器内部按「无空闲容器则建容器→绑定→起容器」
// 原子链路处理）。
export interface FarmOnboardRequest {
  account_id: string;
  env: FarmEnv;
  proxy_url?: string;
  container_id?: string;
}

// POST /api/farm/onboard 成功响应体（dto.go onboardResponse）：内嵌
// bindingResponse 全部字段，额外附加 container_created 标注本次是否内部新建
// 了容器（未提供 container_id 且没有空闲容器可复用时为 true）。
export interface FarmOnboardResponse {
  container_id: string;
  account_id: string;
  env: string;
  auth_index?: number;
  bound_at: string;
  device_write: 'ok' | 'pending' | 'failed';
  detail?: string;
  container_created: boolean;
}

// POST /api/farm/onboard 失败态机器码（design.md 决策5，dto.go
// onboardCodeNoAvailableProxy / onboardCodeCapacityExhausted）：
// no_available_proxy=该 env 无可用住宅代理；farm_capacity_exhausted=触达
// MaxActiveContainers 软上限。失败响应体是独立形状
// onboardErrorResponse{ error(自由文本，给人看), code(机器码，独立字段) }，
// 机器码不在 error 文本里——前端必须从响应体的 code 字段读取（farmClient 解析
// 进 FarmApiError.businessCode），按精确匹配分支，不能对 error 文本做子串
// 匹配（那是给人看的说明文字，不保证包含机器码原文）。
export const FARM_ONBOARD_ERROR_CODES = ['no_available_proxy', 'farm_capacity_exhausted'] as const;
export type FarmOnboardErrorCode = (typeof FARM_ONBOARD_ERROR_CODES)[number];

// DELETE /api/farm/containers/{id}?delete_volume= 响应体（dto.go retireContainerResponse）
export interface FarmRetireContainerResponse {
  id: string;
  status: string; // 恒为 store.StatusRetired
  already_retired?: boolean;
  volume_deleted: boolean;
  detail?: string;
}

// device_id 溯源标注取值（dto.go deviceSource* 常量，spec「device_id 展示口径全站对齐」）：
//   - container_synced：农场绑定 + 注册表钉值与 CPA 当前 synthetic 前缀一致，真实容器同步。
//   - drift：农场绑定但 CPA 当前值与钉值前缀不一致，poller 下一轮会兜回，仍是农场真实来源。
//   - synthetic：非农场绑定账号，CPA 按账号派生 synthetic，标合成是准确的。
//   - unknown：后端无法确定绑定关系（注册表查询失败等）→ 中性回退，不谎称合成也不谎称真实容器同步。
export const FARM_DEVICE_ID_SOURCES = ['container_synced', 'drift', 'synthetic', 'unknown'] as const;
export type FarmDeviceIDSource = (typeof FARM_DEVICE_ID_SOURCES)[number];

// telemetry_alive 三态字面值（TR7「编排器遥测存活投影」契约，与
// FarmAccountEntry.telemetry_alive 逐字对应；归一化/兜底逻辑见
// utils/health.ts normalizeFarmTelemetryAliveState）。
export const FARM_TELEMETRY_ALIVE_STATES = ['alive', 'silent', 'unknown'] as const;
export type FarmTelemetryAliveState = (typeof FARM_TELEMETRY_ALIVE_STATES)[number];

// GET /api/farm/accounts?env=<env> 单条记录（cpa/client.go AuthFileEntry，
// 编排器透传 CPA GET /auth-files 账号健康列表，字段是骨架，未来可能扩充）
// 农场绑定溯源字段（dto.go accountView 内嵌 cpa.AuthFileEntry + 以下字段）：
// farm_bound / device_id_source 后端恒返回；farm_container_id / farm_env /
// farm_container_status / pinned_device_id_masked 只在 farm_bound=true 时存在
// （Go 侧 omitempty），非农场账号不出现这几个字段。
export interface FarmAccountEntry {
  name: string;
  // Account 是 CPA 侧的邮箱账号（cpa.AuthFileEntry.Account，如
  // "acct1@example.com"），区别于 name（auth 文件名，如
  // "claude-acct1@example.com.json"）。仅在 CPA 返回时才有值，声明
  // omitempty 对齐字段可选。
  account?: string;
  // Note 是账号备注（P7-2，cpa.AuthFileEntry.Note，如 "AC04"/"GC08"），
  // synthesizer 从 auth 文件 JSON 的 "note" 字段派生或回退读
  // Metadata["note"]，仅在非空时才出现。前端账号行主行优先展示该字段，
  // 空时回退显示 account/name（P7-2 备注展示口径）。
  note?: string;
  // "quarantined" 是新增可能值（T3 telemetry-farm-ux-hardening，core 自动隔离），
  // 与既有 active/error/disabled 等值并列；core 侧复核指出该字符串可能与
  // auto_quarantined 短暂不一致（清隔离锁与 status 落库非原子），前端判定
  // 隔离态一律优先信 auto_quarantined 布尔，不单独按此字符串分支。
  status: string;
  disabled: boolean;
  last_refresh?: string;
  reauth_url?: string;
  // 账号卡时间字段（#50，编排器 accountView 内嵌 cpa.AuthFileEntry 透传）：
  //  - created_at：core 侧该 auth 记录首次装载时间的近似值（RFC3339），**不是**
  //    Anthropic profile 的账号注册时间（真源需 quota snapshots 端点，编排器未
  //    接入，见 dto.go 诚实边界注释），前端展示不应称其为「账号注册时间」。
  //  - first_identity_at：首次登录/接入时间（源自
  //    account_settings.runtime_identity.current.created_at，RFC3339），是 #50
  //    描述「首次登录」的等价字段。
  // 两者均 omitempty，缺失时前端展示 '—'，不伪造。
  created_at?: string;
  first_identity_at?: string;
  // R5-1（AC11）新增账号级时间字段（编排器 accountView 透传，Wave1 起补齐）：
  //  - account_registered_at：Anthropic profile 的**真实注册时间**（RFC3339），
  //    区别于 created_at（core 装载近似值）。「创建」列优先展示此字段，缺失才
  //    降级到 created_at 并标注「装载近似」。omitempty，缺失时按 created_at 兜底。
  //  - refresh_disabled_at：**真实封禁时刻**（RFC3339，账号级）。是 refresh 被
  //    core 关停/账号被禁用的时刻，供「封禁」列展示与存活终点钉值（见
  //    utils/accountTime.ts deriveFarmAccountTimeLabels）。omitempty，未封禁或
  //    后端未投影时缺失，前端显 '—'（不再是 #57 的"永远待补"占位）。
  account_registered_at?: string;
  refresh_disabled_at?: string;
  proxy_url?: string;
  device_id?: string;
  success?: number;
  failed?: number;
  recent_requests?: number;
  auth_index?: number;
  // 账号是否被 core 自动隔离（终态认证失败等不可重试错误触发，见
  // sdk/cliproxy/auth/conductor.go markAutoQuarantine）。恒有值（core 侧
  // entry["auto_quarantined"] 无条件写入），前端判定隔离态的唯一权威字段。
  auto_quarantined: boolean;
  // 隔离原因（仅 auto_quarantined=true 时存在），当前固定值
  // "terminal_auth_failure"，未来可能扩充其它原因。
  quarantine_reason?: string;
  // 隔离发生时间，RFC3339（仅 auto_quarantined=true 时存在）。
  quarantined_at?: string;
  // 该账号在本 env 下是否有农场容器绑定。
  farm_bound: boolean;
  // 绑定的容器 ID（仅 farm_bound=true 时存在）。
  farm_container_id?: string;
  // 绑定所在环境（仅 farm_bound=true 时存在，理论上与请求的 env 一致）。
  farm_env?: string;
  // 绑定容器在注册表的当前状态（running/degraded/orphaned…，仅 farm_bound=true 时存在）。
  farm_container_status?: string;
  // 注册表钉死的 device_id 脱敏前 16 位（农场真源，仅 farm_bound=true 时存在）。
  pinned_device_id_masked?: string;
  // device_id 展示口径来源标注，恒有值。
  device_id_source: FarmDeviceIDSource;
  // 该账号最近一轮「认证即自动供」判定派生态（P2-A5，dto.go accountView.
  // ProvisioningState，复用 GET /api/farm/capacity 的 provisioning[] 同一份
  // 内存态）。取值见 FARM_PROVISIONING_STATES：eligible（供给候选）/
  // pending_no_proxy（等住宅代理）/ pending_capacity_exhausted（等容量）/
  // provisioned（已自动接入）。仅在自动供给开启且该账号被最近一轮 reconcile
  // 观察到、判定出非空态时出现（omitempty）；开关关闭 / 从未 reconcile / 不在
  // 判定范围内时缺失。前端据此让「供给中·等住宅代理/容量」对 operator 可见，
  // 对冲「以为新建不了容器」的误解——真相往往是正在排队供给。
  provisioning_state?: string;
  // TR8「农场纳管开关 + 出站平台 + 遥测存活」契约字段（编排器透传 CPA
  // GET /auth-files 顶层投影 `entry["farm_enrolled"]`，core 侧 TR1 已实现，
  // 见 core `authFileAccountSettingsView.FarmEnrolled`）。截至本次交付，
  // 编排器 `internal/cpa/client.go` 的 `AuthFileEntry` struct 尚未透传这个
  // 字段（透传是独立后端改动，不在 apps/cpamp 范围内）——因此当前恒为
  // undefined，前端必须防御式兜底（不展示/不臆造，等编排器补上再自然生效）。
  farm_enrolled?: boolean;
  // TR7「编排器遥测存活投影」契约字段（accounts DTO 新增，尚未在编排器落地，
  // 同上恒为 undefined 的过渡态）。三态：alive=遥测在报/silent=遥测静默（曾
  // 采集到过，近期无上报）/unknown=从未采集或采集平面 TR6 未落时的正常态。
  // 前端不得把 undefined 误判为 silent（那是"确认曾活过现在没声"的更强结论），
  // 一律归一到 unknown 展示，见 utils/health.ts
  // normalizeFarmTelemetryAliveState。
  telemetry_alive?: FarmTelemetryAliveState;
}

// accountView.provisioning_state 取值（handlers.go provisioningState* 常量）。
// eligible=已认证合格但尚未接入的供给候选；pending_no_proxy=候选但缺可用住宅
// 代理，fail-closed 不建容器（防真实 IP 泄露），proxy 就绪后自动接入；
// pending_capacity_exhausted=proxy 就绪但活跃容器/内存护栏当前不满足，容量释放
// 后自动接入；provisioned=本进程运行期间已由自动供给成功接入过。未知值前端按
// 中性回退处理，不臆造语义。
export const FARM_PROVISIONING_STATES = [
  'eligible',
  'pending_no_proxy',
  'pending_capacity_exhausted',
  'provisioned',
] as const;
export type FarmProvisioningState = (typeof FARM_PROVISIONING_STATES)[number];

// GET /api/farm/usage 单条记录（services/farm-orchestrator 新增 usage 端点：
// 按容器/账号聚合 CPA GET /v0/management/usage?include_details=true 的
// details[]，只保留农场绑定账号；数据是 CPA 自上次重启起的内存态计数，不持久）
// 字段按 201 实测订正：无 cache_creation，改为 reasoning + billable（billable
// 是 CPA 计费口径下的实际计费 token 数，不等同于 total）。
export interface FarmUsageTokens {
  input: number;
  output: number;
  cache_read: number;
  reasoning: number;
  total: number;
  billable: number;
}

export interface FarmUsageItem {
  container_id: string;
  account_id: string;
  // 绑定账号邮箱（CPA AuthFileEntry 透传），非农场绑定或账号无邮箱信息时可能
  // 是空字符串，前端按空值不渲染处理，不臆造占位邮箱。
  account_email: string;
  // 账号备注/别名（P2-A5，usageItemView.account_note，源自 CPA auth-files 的
  // cpa.AuthFileEntry.Note，如「农场容器 c1 专用」/「AC04」）。仅在该账号确有
  // note 时出现（后端 omitempty），走邮箱兜底路径或无 note 时缺失，前端按空值
  // 回退显示 account_id/email，不伪造。运营者通常只记备注不记邮箱，用量明细
  // 主行优先展示该字段（P2-C6）。
  account_note?: string;
  env: FarmEnv;
  auth_index: number;
  tokens: FarmUsageTokens;
  cost_usd: number;
  requests: number;
}

// GET /api/farm/usage 响应体。note 固定携带口径说明（"自 CPA 上次重启起
// (内存态)"），前端应原样展示，不要另造措辞。scope 固定为 "cpa_account_
// cumulative"（用户④「请求间隔 DTO」分栏要求，dto.go usageScope 常量），
// 供前端程序化区分「账号 CPA 累计用量」与容器详情「探针保活节奏」
// （FarmProbeCadenceView.scope="farm_probe_cadence"）两个口径，不需要解析
// note 中文文案。
export interface FarmUsageResponse {
  items: FarmUsageItem[];
  note: string;
  scope: string;
}

// GET /api/farm/resources 单条容器资源记录（对已绑定且 running 的农场容器执行
// docker stats --no-stream 解析得到；取不到时数值字段回退 0，不臆造）
export interface FarmResourceContainer {
  container_id: string;
  account_id: string;
  mem_used_bytes: number;
  mem_limit_bytes: number;
  mem_pct: number;
  cpu_pct: number;
}

// GET /api/farm/resources host 字段：整机资源快照（/proc/meminfo + /proc/loadavg +
// runtime.NumCPU()），note 固定携带"整机含非农场进程"口径说明，前端应原样展示。
export interface FarmResourceHost {
  mem_used_bytes: number;
  mem_total_bytes: number;
  mem_pct: number;
  load1: number;
  cpu_count: number;
  note: string;
}

// GET /api/farm/resources 响应体。
export interface FarmResourceResponse {
  containers: FarmResourceContainer[];
  host: FarmResourceHost;
}

// httpapi errorResponse
export interface FarmErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// GET /api/farm/capacity（用户③「容量正名」独立只读端点 + 「认证即自动供」扩展）。
// 字段名照抄 services/farm-orchestrator/internal/httpapi/handlers.go 的
// capacitySummaryView / capacityResponse / accountProvisioningView：容量摘要经
// 内嵌 capacitySummaryView 扁平化提升为顶层字段（不破坏既有消费方），再叠加
// 「认证即自动供」的顶层灰度开关与 per-account 供给状态列表。
// ---------------------------------------------------------------------------

// 自动供给 pending 原因机器码（provisioning[].pending_reason 取值，机器可读，
// 供前端按精确匹配分支，不解析中文文案）：
//   - no_proxy：候选账号未配置可用住宅代理，fail-closed 不建容器（防真实 IP
//     泄露）；proxy 就绪后下一轮自动接入。
//   - capacity_exhausted：proxy 就绪，但 checkStartCapacity 两条护栏（活跃容器
//     数上限 / 宿主内存水位）当前不满足，暂缓供给；容量释放后下一轮自动接入。
// null（无 pending）由 pending_reason 字段的 JSON null 表达（后端刻意用 *string，
// 让「无 pending」序列化成 null 而非省略字段，前端无需区分「字段缺失」与「明确
// 无 pending」）。
export const FARM_PROVISION_PENDING_REASONS = ['no_proxy', 'capacity_exhausted'] as const;
export type FarmProvisionPendingReason = (typeof FARM_PROVISION_PENDING_REASONS)[number];

// GET /api/farm/capacity 里单个账号的自动供给状态（handlers.go
// accountProvisioningView）。
export interface FarmAccountProvisioningView {
  // 与 FarmAccountEntry.name（auth 文件名）同源（后端 accountIDForProvision
  // 优先取 e.Name），前端据此把供给状态 join 回账号列表。
  account_id: string;
  env: string; // "test" | "prod"
  // 是自动供给候选（已认证 claude、未 farm-bound、未 disabled/auto_quarantined）。
  eligible: boolean;
  // 候选账号本轮未能供给的原因；null=无 pending（已成功接入 / 已绑 / 不合格 /
  // 退避中）。
  pending_reason: FarmProvisionPendingReason | null;
  // 本编排器进程运行期间曾由自动供给成功接入过。
  auto_provisioned: boolean;
}

// 「还能接入 N 个」被哪条护栏封顶的机器码（capacityResponse.bottleneck 取值，
// 与后端 capacityBottleneck* 一一对应）：
//   - containers：活跃容器数上限（max_active_containers）当前更紧。
//   - memory：宿主可用内存水位当前更紧。
// 两条护栏都无法判定（remaining_slots 同时为 null）时后端回空串并 omitempty，
// 前端表现为字段缺失（undefined）。
export const FARM_CAPACITY_BOTTLENECKS = ['containers', 'memory'] as const;
export type FarmCapacityBottleneck = (typeof FARM_CAPACITY_BOTTLENECKS)[number];

// claude-managed 账号的住宅代理配置覆盖率快照（capacityResponse.proxy_coverage，
// handlers.go proxyCoverageView）。configured_accounts <= total_accounts，差值即
// 「还没配 proxy_url、无法 fail-closed 接入农场」的账号数。所有 env 的 auth-files
// 都拉取失败时后端回 null（诚实「未知」，不谎称 0/0），前端据此判空。
export interface FarmProxyCoverageView {
  // 有非空 proxy_url 的 claude-managed 账号数。
  configured_accounts: number;
  // claude-managed 账号总数（跨成功读到的 env 聚合）。
  total_accounts: number;
}

// GET /api/farm/capacity 响应体（handlers.go capacityResponse）。
export interface FarmCapacityResponse {
  // 当前 docker 层真正在跑（starting/running/degraded）的容器数；注册表读取
  // 失败时为 0（诚实空态，不伪造）。
  active_containers: number;
  // 活跃容器数上限（0 = 不限）。
  max_active_containers: number;
  // 宿主当前可用内存与生效阈值（字节）。host_metrics_available=false 时这两个
  // 字段不可信（宿主指标读取失败或 hostReader 未装配），前端不得当真实数值展示。
  mem_available_bytes: number;
  mem_available_threshold_bytes: number;
  // 本次是否真的拿到宿主内存快照（诚实边界，false 时上面两个内存字段无意义）。
  host_metrics_available: boolean;
  // 是否有余量：true 表示下一次真正起容器大概率通过两条护栏（非强保证，只是
  // 查询那一刻的快照）。
  has_headroom: boolean;
  // 把 has_headroom 的布尔升级成「还能再接入多少个容器」的具体数字 =
  // min(容器槽位余量, 内存槽位余量) 两条护栏里更紧的那条。两条护栏都无法判定
  // （未配 max 且宿主内存信号不可用）时为 null——诚实「未知」，前端不得把它当 0
  // （会误读成「满了」）或大数（会误读成「随便接」）展示。
  remaining_slots: number | null;
  // remaining_slots 由哪条护栏封顶；两条都无法判定时后端 omitempty 省略字段，
  // 前端表现为 undefined。
  bottleneck?: FarmCapacityBottleneck;
  // 反映 FARM_AUTO_PROVISION_ENABLED 灰度开关（默认 false）。关闭时 provisioning
  // 恒为空数组。
  auto_provision_enabled: boolean;
  // 每个 claude-managed 账号最近一轮自动供给判定；开关关闭或尚未跑过一轮
  // reconcile 时为空数组（后端显式回 [] 而非 null，前端可直接判空）。
  provisioning: FarmAccountProvisioningView[];
  // claude-managed 账号住宅代理配置覆盖率（configured M / total N）；所有 env 的
  // auth-files 都拉取失败时后端回 null，前端据此判「未知」不谎称 0/0。
  proxy_coverage: FarmProxyCoverageView | null;
}

// PATCH /api/farm/config 请求体（handlers.go handleUpdateConfig）：运行时翻转
// 「认证即自动供」灰度开关。当前只暴露 auto_provision_enabled 一个可写字段。
export interface FarmConfigUpdateRequest {
  auto_provision_enabled: boolean;
}

// PATCH /api/farm/config 成功响应体（200）：回显设置后的开关真值。前端以此为准
// 更新展示，而不是乐观假设一定成功（RWMutex 保护，后端设置后的值即返回值）。
export interface FarmConfigResponse {
  auto_provision_enabled: boolean;
}

// ---------------------------------------------------------------------------
// P0-9 前端·概览 + 下钻 + 告警（design.md 决策6，字段名照抄
// services/farm-orchestrator/internal/httpapi/dto.go 的 P0-4 只读监测 API 段）
// ---------------------------------------------------------------------------

// GET /api/farm/overview 响应体（dto.go overviewResponse）。
export interface FarmOverviewResponse {
  // 按 status 分组计数，含归档状态（retired/orphaned）。
  containers_by_status: Record<string, number>;
  total_containers: number;
  active_alerts: number;
  // **本轮固定占位 0**：真正的漂移历史需要 P1 container_deviceid_checks 迁移，
  // 当前编排器只有 best-effort 即时重写，没有可查询历史。前端不得把 0 渲染成
  // "无漂移"的确定性结论，应标注"—/待P1"。
  device_id_drift_unresolved: number;
  // **本轮恒为 undefined（后端 omitempty + 值本身 nil）**：WindowedKeepaliveStats
  // 目前不聚合 tokens_total，没有可用的聚合读取路径能诚实拼出这个数字。前端
  // 必须显示"—/待P1"而非 0，见 dto.go overviewResponse.ProbeTokenCostTotal24h
  // 注释。
  probe_token_cost_total_24h?: number;
  stale_keepalive_count: number;
  // 这是「本次 API 响应生成时间」（handleGetOverview 内 time.Now()），不是
  // Poller 真实最近一轮巡检时间戳（编排器没有对外暴露后者）。前端展示时应
  // 诚实标注为"数据截至"而非"最近轮询于"，避免暗示比实际更精确的巡检时效。
  generated_at: string;
}

// container_status_events 一行的对外形状（dto.go eventView），供容器详情
// OpenEvents 与跨容器告警 feed（.../alerts，P0-5）共用同一形状。
export interface FarmEventView {
  id: number;
  container_id: string;
  ts: string;
  from_status?: string;
  to_status: string;
  reason: string;
  severity: 'info' | 'warning' | 'critical';
  detail?: Record<string, unknown>;
  last_seen: string;
  // 未 resolved（仍 firing）时缺失；(*Server).listOpenEvents 目前只能探测
  // 「当前仍 firing」的事件（按已知 reason 枚举逐个探测），不是完整历史时间
  // 线——resolved 事件对这条只读路径不可见，见 observability.go 顶部注释。
  resolved_at?: string;
}

// GET /api/farm/containers/{id} 响应体（dto.go containerDetailView）：
// containerView 全部字段 + 当前 firing 中的事件列表。
export interface FarmContainerDetailView extends FarmContainerView {
  open_events: FarmEventView[];
}

// GET .../keepalive 与 .../resources 共用的 step 分桶时序响应形状
// （dto.go keepaliveBucketView / resourceBucketView）。
export interface FarmKeepaliveBucketView {
  bucket_start: string;
  sample_count: number;
  success_count: number;
  success_rate: number;
  avg_latency_ms?: number;
  p95_latency_ms?: number;
}

export interface FarmKeepaliveSeriesResponse {
  container_id: string;
  since: string;
  until: string;
  step_seconds: number;
  buckets: FarmKeepaliveBucketView[];
}

export interface FarmResourceBucketView {
  bucket_start: string;
  sample_count: number;
  avg_mem_bytes?: number;
  max_mem_bytes?: number;
  avg_cpu_pct?: number;
  max_cpu_pct?: number;
}

export interface FarmResourceSeriesResponse {
  container_id: string;
  since: string;
  until: string;
  step_seconds: number;
  buckets: FarmResourceBucketView[];
}

// GET /api/farm/containers/{id}/events 响应体：与 containerDetailView.open_events
// 同形状的独立端点（httpapi handleGetContainerEvents），供详情抽屉单独刷新
// 事件时间线而不重拉整条 detail。
export type FarmContainerEventsResponse = FarmEventView[];

// GET /api/farm/alerts（design.md 决策4「跨容器告警 feed（window/status，
// firing/resolved）」，tasks.md P0-5）。
//
// P0-5 后端已交付：services/farm-orchestrator/internal/httpapi/server.go 注册
// `GET /api/farm/alerts`（handleGetAlerts），dto.go alertsResponse 定义响应体
// `{ window, status, alerts: []eventView }`，与下面的类型形状一致（包裹在
// `alerts` 字段，条目形状与 FarmEventView 对齐；不分页）。
export type FarmAlertEntry = FarmEventView;

export interface FarmAlertsResponse {
  alerts: FarmAlertEntry[];
}

// ---------------------------------------------------------------------------
// FO1「账号态单一采集源」：GET /api/farm/account-state（dto.go
// accountStateView / accountStateListResponse）
// ---------------------------------------------------------------------------

// accountStateView 是 account_state 表一行的只读投影（farmrunner.
// AccountStateCollector 周期采集落库），供前端核对「后端到底采到了什么」，
// 以及本轮 P7 用它的 observed_at 给两维徽标补「as-of 时间戳 + 陈旧标记」
// （见 features/farm/utils/health.ts decideAccountAuthPlane 对
// farmrunner.DecideAccountAuthPlane 的前端复刻）。
export interface FarmAccountStateView {
  account_id: string;
  env: string;
  status?: string;
  disabled: boolean;
  auto_quarantined: boolean;
  quarantine_reason?: string;
  quarantined_at?: string;
  last_refresh?: string;
  reauth_url?: string;
  // token_alive 见 store.AccountState.TokenAlive 文档：采集时刻派生
  // （reauth_url 为空时为 true），不是本端点新发明的健康算法。
  token_alive: boolean;
  observed_at: string;
}

// GET /api/farm/account-state 响应体。env 回显请求的 ?env= 过滤值，未传时
// 为空串（表示跨 test/prod 不限）。
export interface FarmAccountStateListResponse {
  env?: string;
  accounts: FarmAccountStateView[];
}

// ---------------------------------------------------------------------------
// 用户④「请求间隔 DTO」：GET /api/farm/containers/{id}/probe-cadence
// （dto.go probeCadenceView）
// ---------------------------------------------------------------------------

// probeCadenceView 是「探针节奏」维度的对外形状，与 FarmUsageItem（账号 CPA
// 累计用量维度）刻意分成两个独立端点/两套字段，不合并计数——避免
// sorrygml40「一绑定就163次」把 usageItemView.Requests 误当成"绑定后触发了
// 163 次探针"的口径混淆（见 scope 字段注释）。
export interface FarmProbeCadenceView {
  container_id: string;
  // 相邻探针到达时间的间隔（inter-arrival，单位秒），按时间升序排列，长度
  // = sample_count-1（sample_count<=1 时为空数组，不是 undefined，对齐
  // FarmKeepaliveBucketView 同款「空窗口返回空序列」口径）。不区分 ok/
  // fail——探针节奏统计「到达」这个事实本身。
  intervals_seconds: number[];
  // 本次用于推导 intervals_seconds 的原始样本数（?window= 窗口内最近至多
  // ?limit= 条）。
  sample_count: number;
  // 窗口内最近一次探针到达时间；从未有样本或窗口内无样本时缺失。
  last_fired_at?: string;
  // 复用既有「下次探针估算」口径（FarmNextEstimateView），显式标注随机
  // 抖动、非精确唤醒时间；这里的 avg_observed_seconds_24h 直接由
  // intervals_seconds 求平均得出（不是分桶近似），比容器列表/详情里的桶
  // 近似版本更精确。只对 running/degraded 容器给出，其余状态缺失（不会
  // 再有下一次探针）。
  next_expected_window?: FarmNextEstimateView;
  // 固定为 "farm_probe_cadence"，供前端程序化区分口径（对照
  // FarmUsageResponse.scope="cpa_account_cumulative"）。
  scope: string;
  // 固定携带口径说明，不能省略——这个端点存在的唯一理由就是把「探针节奏」
  // 和「账号累计用量」两个容易被混淆的数字显式分开标注。
  note: string;
}

// ---------------------------------------------------------------------------
// 用户⑤「每容器遥测内容抓取」：GET /api/farm/containers/{id}/beacons
// （services/farm-orchestrator/internal/httpapi/telemetry_beacon.go）
// ---------------------------------------------------------------------------

// **来源边界（写进类型也写进 UI，逐条标注不笼统）**：beacon 列表混合两类来源，
// 由后端 source_kind 分区（store.TelemetrySourceKind）：
//   - declared：容器「自报 / 声明」（存储层 source=unknown 折叠），只证明「上报
//     管道连通 + 容器声明了什么」，**不是**从真实出站流量抓到的 on-wire 值；
//   - on_wire：mitmproxy / ebpf 在容器出站链路真实抓取（存储层 source=mitmproxy/ebpf）。
// 展示层必须**逐条按 source_kind 标注**（declared 行标 declared、on_wire 行标
// on-wire·来源），不得对整列笼统 claim on-wire；即便 on_wire 行也只证明该容器确实
// 发出过这些请求，不构成跨账号反关联证明。另一件相关的事：指纹自洽卡的「出站实测
// (on-wire)」一列是把 beacon **逐字段派生**进自洽比对——TP-1 已接入：取「最近一条
// source_kind=on_wire 的 beacon」自身已由后端 ParseBeacon 抽取好的
// device_id/api_base_url_host/entrypoint 字段展示（前端不解析原始 body，字段抽取
// 全在服务端完成，见 telemetry_beacon.go handleIngestBeacons）；从未观测到任何
// on_wire beacon 时该列仍是中性占位（真占位，不是「尚未接入」），与「原始 on_wire
// beacon 是否已实时采集」这件独立的事共用同一个信号（见 FarmTelemetryPanel.tsx
// onWireCaptured）。
//
// GET /api/farm/containers/{id}/beacons?limit=<默认50，上限500> 响应体是**裸 JSON
// 数组**（不是包裹对象），按 captured_at 降序；空容器返回 []（非 null）；
// 404=未知容器；400=非法 limit。字段名照抄后端 telemetry_beacon.go 的
// beaconRowView。device_id 在这个只读接口是**全量不脱敏**（与容器列表
// device_id_masked 的只暴露前 16 位不同——beacon 读取是运维核对自洽性用的
// 内部视图）。
export interface FarmContainerBeaconView {
  // 服务端记录的采集时间（RFC3339）。
  captured_at: string;
  // 服务端自算的通道分类（ClassifyChannel，不信任客户端上报的 source 分类）。
  channel: string;
  // 出站目标 host（自报值）。
  host: string;
  // 出站请求路径（自报值）。
  path: string;
  // 原始请求体字节数（服务端按存储的 body 计长）。
  body_bytes: number;
  // 自报 device_id（**全量**，不脱敏；见结构体顶部注释）。
  device_id: string;
  // 自报 API base URL 的 host 部分（ParseBeacon 抽取）。
  api_base_url_host: string;
  // 自报入口标识（entrypoint，ParseBeacon 抽取）。
  entrypoint: string;
  // 细粒度上报来源（存储层归一后的值）：unknown（declared 折叠）/ mitmproxy /
  // ebpf。前端优先用 source_kind 分区标注，raw source 仅作细粒度补充展示。
  source: string;
  // 读路径分区维度（telemetry_beacon.go beaconView.SourceKind）：declared（source=
  // unknown 折叠）/ on_wire（source=mitmproxy/ebpf 真实出站抓取）。后端恒返回；旧
  // 后端缺该字段时前端从 source 兜底派生（见 resolveBeaconSourceKind），故声明可选。
  source_kind?: FarmTelemetrySourceKind;

  // ---------------------------------------------------------------------------
  // TP「每条 beacon 到底上报了什么」（**后端已序列化**，见 telemetry_beacon.go
  // beaconView / reportedFieldsView / processSignalView）。此前这里是「前瞻声明、
  // 恒缺失」的占位注释——已失真并更正：GET /api/farm/containers/{id}/beacons 现在
  // 会返回下面这批字段，前端据此渲染每条 beacon 的完整上报内容（脱敏）。为兼容旧
  // 编排器仍声明可选，缺失时按存在性门控处理（不渲染、不臆造）。
  //
  // 已删除的 flat 前瞻字段 session_id?/app_version?/user_type?：后端从未把它们放在
  // beacon 顶层，真正的位置是 reported_fields.session_id / reported_fields.sdk_version
  // （user_type 后端无对应字段，一并去除，不再挂永不点亮的空声明）。
  // ---------------------------------------------------------------------------
  /** 该 beacon 携带的事件名列表（telemetry_beacon.go beaconView.EventNames，仅
   * event_logging/datadog_logs 通道非空）。后端恒返回数组（无则空数组）；旧编排器
   * 缺该字段时为 undefined，渲染层 `?? []` 兜底。 */
  event_names?: string[];
  /** 脱敏后的结构化上报字段（telemetry_beacon.go reportedFieldsView）。device_id/
   * session_id 已由服务端脱敏（前 12 + 后 4），其余为低敏元数据原样透传；字段缺失
   * 为空串。旧编排器缺该对象时为 undefined，访问前用 `?.` 兜底。 */
  reported_fields?: FarmBeaconReportedFields;
  /** 原始上报体的脱敏预览（≤2048 字符，密钥类模式已 ***REDACTED***，见后端
   * beacon_redact.go）。旧编排器缺失时为 undefined。 */
  body_preview?: string;
  /** 从上报体解析到的进程退出信号（telemetry_beacon.go processSignalView）。
   * **是遥测最后一次观测到的信号，不是实时进程探测**——不代表进程当前还活着/已
   * 退出。当前唯一来源是 datadog_logs 的 terminated 事件，其余情况后端恒返回 null
   * （诚实默认态，不是缺陷）。旧编排器缺该字段时为 undefined。 */
  process_signal?: FarmBeaconProcessSignal | null;
}

// reported_fields 对外形状（telemetry_beacon.go reportedFieldsView，键名严格对齐、
// 不要改名）。device_id/session_id 已由服务端脱敏（前 12 + 后 4）；其余为低敏元数据
// （部署环境 / SDK 版本 / 写死常量 hostname / 通道分类），原样透传。字段缺失为空串。
export interface FarmBeaconReportedFields {
  device_id: string;
  session_id: string;
  api_base_url_host: string;
  deployment_environment: string;
  sdk_version: string;
  hostname: string;
  channel: string;
}

// process_signal 对外形状（telemetry_beacon.go processSignalView，键名严格对齐）。
export interface FarmBeaconProcessSignal {
  // 可空整数（后端 *int）：null 表示这条终止信号没带退出码。
  last_exit_code: number | null;
  terminated: boolean;
  // 进程终止时的运行阶段（真实样本恒为 "draining_commands"，omitempty）；缺失留空。
  run_phase?: string;
  // 该信号从哪个通道抽取（排障用）。
  source: string;
  // 观测到该信号的时间（RFC3339 字符串）。
  observed_at: string;
}

// GET /api/farm/containers/{id}/beacons 响应体：裸数组（captured_at 降序）。
export type FarmContainerBeaconsResponse = FarmContainerBeaconView[];

// beacon 读路径分区维度（store.TelemetrySourceKind / telemetry_beacon.go
// beaconView.SourceKind）：declared=容器自报/声明；on_wire=mitmproxy/ebpf 真实
// 出站抓取。前端据此逐条准确标注来源，不对整列笼统 claim on-wire。
export const FARM_TELEMETRY_SOURCE_KINDS = ['declared', 'on_wire'] as const;
export type FarmTelemetrySourceKind = (typeof FARM_TELEMETRY_SOURCE_KINDS)[number];

// 对应 source_kind=on_wire 的细粒度 source 值集合（真实出站抓取管道产物）。
const FARM_ON_WIRE_BEACON_SOURCES: ReadonlySet<string> = new Set(['mitmproxy', 'ebpf']);

/**
 * 归一某条 beacon 的读路径分区：优先信后端 source_kind；缺失（旧后端）时从细粒度
 * source 兜底派生（mitmproxy/ebpf → on_wire，其余含 unknown → declared）。供
 * FarmTelemetryPanel 逐条准确标注来源用。
 */
export function resolveBeaconSourceKind(
  beacon: Pick<FarmContainerBeaconView, 'source' | 'source_kind'>
): FarmTelemetrySourceKind {
  if (beacon.source_kind === 'declared' || beacon.source_kind === 'on_wire') {
    return beacon.source_kind;
  }
  return FARM_ON_WIRE_BEACON_SOURCES.has(beacon.source) ? 'on_wire' : 'declared';
}

// beacon 指纹自洽卡的三个比对字段：declared 列与 on-wire 列各自在自己来源分区内，
// 逐字段取「最近一条真正带该字段值」的 beacon（见下方 pickLatestBeaconFieldValue 与
// FarmTelemetryPanel.tsx）。指纹字段分通道上报、最近一条 beacon 常不带某字段，所以不能
// 整列只读「最近一条 beacon」，必须逐字段回退到最近带值那条；两列都是「该来源最近一次
// 自报/实测到的值」，不是同一条 beacon 的两个视角，declared 与 on-wire 天然可能来自不同请求。
export const FARM_TELEMETRY_FINGERPRINT_FIELDS = [
  'device_id',
  'entrypoint',
  'api_base_url_host',
] as const;
export type FarmTelemetryFingerprintField = (typeof FARM_TELEMETRY_FINGERPRINT_FIELDS)[number];

/**
 * 指纹自洽卡逐字段选值（纯函数，被单测锁定）：从**已按 captured_at 降序**的 beacon
 * 列表里，为某个指纹字段挑「最近一条真正带值」的值。
 *
 * 为什么不能只读最近一条（本次修复的横线根因）：指纹字段分通道上报，最近那条 beacon
 * 常常不带某个字段（如 datadog_logs 通道天然没有 device_id），只读最近一条会让该字段
 * 误显横线「—」、看起来像「没采到」；实际上更早一条 beacon 已带过该值。这里逐字段回退
 * 到「最近一条带该值」的 beacon，只有窗口内**所有** beacon 都不带该字段时才返回空串
 * （调用方据此回退占位）。
 *
 * 入参 beacons 应已是同一来源（declared 或 on_wire）过滤 + captured_at 降序的子列表；
 * 过滤与排序在调用方完成，本函数只做「按顺序找第一条非空」，保持单一职责、易测。
 */
export function pickLatestBeaconFieldValue(
  beacons: readonly FarmContainerBeaconView[],
  field: FarmTelemetryFingerprintField
): string {
  for (const beacon of beacons) {
    const value = beacon[field];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return '';
}

// beacon 遥测自洽评估器产出、经既有 GET /api/farm/alerts 点亮的新 reason 码
// （services/farm-orchestrator/internal/farmrunner/beaconanomaly.go）。severity
// 由后端 eventView.severity 决定（drift/host_leak/entrypoint_mismatch=warning，
// collision=critical，silence=info 且默认不写成 firing 告警），前端不重推严重度，
// 只用这个集合把「遥测自洽类」告警与「容器运行态」告警在 UI 上区分标注。
export const FARM_TELEMETRY_ALERT_REASONS = [
  'telemetry_devid_drift',
  'telemetry_devid_collision',
  'telemetry_host_leak',
  'telemetry_silence',
  'telemetry_entrypoint_mismatch',
] as const;
export type FarmTelemetryAlertReason = (typeof FARM_TELEMETRY_ALERT_REASONS)[number];

const FARM_TELEMETRY_ALERT_REASON_SET: ReadonlySet<string> = new Set(FARM_TELEMETRY_ALERT_REASONS);

/** 判定某个 alert.reason 是否属于「遥测自洽类」（供 UI 分类标注，不改严重度）。 */
export function isFarmTelemetryAlertReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && FARM_TELEMETRY_ALERT_REASON_SET.has(reason);
}

// ---------------------------------------------------------------------------
// farm-proxy-rotation §1「代理轮换」：POST /api/farm/rotate-proxy（rotation.go
// rotateProxyRequest / rotateProxyResponse）+ §1 半自动触发建议（GET
// /api/farm/rotation-suggestions）。字段名照抄后端结构体 JSON tag。
// ---------------------------------------------------------------------------

// 轮换原因（store IdentityLineageReason* 里可作为**请求 reason** 的子集；provisioned
// 是初始绑定进入原因，不作为轮换请求 reason，后端 normalizeRotationReason 会 400）。
//   - manual_rotation：operator 主动换代理（前端换代理时已把新代理写进 CPA，现取即新代理，
//     故无需显式传 proxy_url）。
//   - proxy_failure：半自动——探测到代理死、operator 确认后轮换（后端要求显式传新 proxy_url，
//     否则 proxy_change_required：只能取到旧代理，换 device_id 不换出口=白换）。
//   - ip_drift：住宅出口 IP 漂移触发的轮换（同 proxy_failure，要求显式传新 proxy_url）。
export const FARM_ROTATION_REASONS = ['manual_rotation', 'proxy_failure', 'ip_drift'] as const;
export type FarmRotationReason = (typeof FARM_ROTATION_REASONS)[number];

// POST /api/farm/rotate-proxy 请求体（rotation.go rotateProxyRequest）。
export interface FarmRotateProxyRequest {
  account_id: string;
  env: FarmEnv;
  // 可选：给了直接用作新容器代理；不给则后端从 CPA 现取该账号当前 proxy_url（前端换代理
  // 时已把新代理写进 CPA，现取即新代理）。取不到一律 fail-closed（no_available_proxy）。
  // reason=proxy_failure / ip_drift 时后端强制要求显式传（否则 proxy_change_required）。
  proxy_url?: string;
  // 轮换原因，缺省=manual_rotation（后端 normalizeRotationReason）。
  reason?: FarmRotationReason;
  // 操作人（落身份谱系 operator 列），可选。
  operator?: string;
  // **必须为 true**：后端把「绝不未确认自动换」（O1）硬编码到端点边界，false/缺省一律 400。
  // 前端二次确认弹窗点「确认轮换」后才带 confirm=true 发起。
  confirm: boolean;
}

// POST /api/farm/rotate-proxy 成功响应体（rotation.go rotateProxyResponse）。
export interface FarmRotateProxyResponse {
  account: string;
  env: string;
  old_container_id: string;
  new_container_id: string;
  // 新容器 device_id 脱敏（前12+后4，绝不明文）。
  new_device_id_masked: string;
  reason: string;
  // true=旧容器已归档退役、end_reason=superseded（区别死号 dead/disabled）；false=新容器已
  // 切上但旧容器退役失败（留 down 空壳可人工退役，谱系仍已标 superseded），见 detail。
  superseded: boolean;
  detail?: string;
}

// 轮换 gate / 契约守卫机器可读拒绝码（rotation.go rotationCode* 常量，供前端按 code 分支，
// 不解析中文 message）。fail-closed 无可用代理时后端复用 onboard 的 no_available_proxy
// （见 FARM_ONBOARD_ERROR_CODES），故轮换错误处理需同时覆盖该码。
//   - not_farm_account：账号无 active 农场容器绑定（未纳入农场）。
//   - not_claude_provider：账号 provider 明确非 Claude（codex/其它 provider 不触发容器动作）。
//   - provider_unverifiable：无法核验 provider（auth-files 读失败 / 查无此号）。
//   - proxy_change_required：reason=proxy_failure/ip_drift 但未显式传新 proxy_url。
//   - proxy_unchanged：新代理与旧容器当前 epoch 出口 proxy_hash 相同（换 device_id 不换出口）。
export const FARM_ROTATION_ERROR_CODES = [
  'not_farm_account',
  'not_claude_provider',
  'provider_unverifiable',
  'proxy_change_required',
  'proxy_unchanged',
] as const;
export type FarmRotationErrorCode = (typeof FARM_ROTATION_ERROR_CODES)[number];

// GET /api/farm/rotation-suggestions?env= 单条「建议更换代理」提示（rotation.go
// rotationSuggestionView）。复用 Change A 每账号代理直连探针，只列判为 proxy_dead 的
// Claude 农场号；**只产建议、绝不自动换**（O1）。
export interface FarmRotationSuggestionView {
  account: string;
  container_id: string;
  device_id_masked?: string;
  // 恒 "proxy_dead"（本端点只列代理死）。
  state: string;
  reason: string;
  recommended_action: string;
  // 探针判定时间（RFC3339）；探针缺失时省略。
  probe_checked_at?: string;
}

// GET /api/farm/rotation-suggestions 响应体（rotation.go rotationSuggestionsResponse）。
export interface FarmRotationSuggestionsResponse {
  env: string;
  suggestions: FarmRotationSuggestionView[];
  // 恒 false——固化「绝不自动换、需 operator 一键确认」契约到 DTO（O1）。
  auto_rotate: boolean;
}

// ---------------------------------------------------------------------------
// farm-proxy-rotation SURV1「持久化身份谱系 / 更换记录」：GET
// /api/farm/identity-lineage?account=&env=（identity_lineage.go
// identityLineageEpochView / identityLineageResponse）。append-only 审计账本，
// device_id / 代理只以稳定哈希 + 脱敏串落库，绝不明文（D4）。
// ---------------------------------------------------------------------------

// 身份 epoch **进入**原因（store IdentityLineageReason*，含仅用于初始绑定的 provisioned）。
export const FARM_IDENTITY_LINEAGE_REASONS = [
  'provisioned',
  'manual_rotation',
  'proxy_failure',
  'ip_drift',
] as const;
export type FarmIdentityLineageReason = (typeof FARM_IDENTITY_LINEAGE_REASONS)[number];

// 身份 epoch **离场**原因（store IdentityLineageEndReason*）。
//   - superseded：被代理轮换取代（区别 dead/disabled 死号退役）。
//   - retired：普通退役（死号 / 人工退役 / 幽灵收敛）。
//   - reopened：容器 reauth 重绑前收口旧 epoch（防重复未结束行）。
export const FARM_IDENTITY_LINEAGE_END_REASONS = ['superseded', 'retired', 'reopened'] as const;
export type FarmIdentityLineageEndReason = (typeof FARM_IDENTITY_LINEAGE_END_REASONS)[number];

// 身份谱系单个 epoch 的对外形状（identity_lineage.go identityLineageEpochView，脱敏，
// 不含明文）。每条 = 账号→容器→device_id→代理→出口 IP 的一段时间区间。
export interface FarmIdentityLineageRecord {
  container_id: string;
  // device_id 脱敏（前12+后4）。
  device_id_masked: string;
  // 稳定哈希（hex(SHA256)，**非明文**）：供前端/审计跨 epoch 比对「是否同一 device_id」。
  device_id_hash: string;
  // proxy_url 脱敏（redact userinfo，保留 scheme://host:port）；无代理时省略。
  proxy_masked?: string;
  // 观测到的住宅出口 IP（明文留存，审计对象）；未观测到时省略。
  egress_ip?: string;
  reason: string;
  operator?: string;
  // epoch 开始时间（RFC3339）。
  start_at: string;
  // epoch 结束时间（RFC3339）；未结束（current=true）时省略。
  end_at?: string;
  end_reason?: string;
  // true=当前仍在生效的 epoch（end_at 为 NULL）。
  current: boolean;
}

// GET /api/farm/identity-lineage 响应体（identity_lineage.go identityLineageResponse）。
export interface FarmIdentityLineageResponse {
  account: string;
  env?: string;
  // 按 start_at 降序（最近在前）。
  epochs: FarmIdentityLineageRecord[];
  // true=审计发现**同一 device_id 曾出现在两个不同住宅出口**（反关联不变量被破坏的信号）。
  // 正常系统恒 false（D1 每次换 IP 必换 device_id）。
  cross_ip_reuse_detected: boolean;
}
