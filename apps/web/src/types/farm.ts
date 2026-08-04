/**
 * 农场编排器（Device Farm）类型定义
 *
 * 字段名照抄 services/farm-orchestrator/internal/httpapi/dto.go 与
 * internal/cpa/client.go 的 JSON 契约，不臆造字段。农场编排器是独立后端，
 * 走独立 base URL + 独立 admin key（见 farmClient.ts / useFarmStore.ts），
 * 不复用 CPA 的 /v0/management 契约。
 */

// GET /api/farm/containers 单条记录的 binding 子结构（dto.go bindingView）
export interface FarmBindingView {
  env: string;
  account: string;
  auth_index?: number;
  bound_at: string;
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
}

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
  // 反映 FARM_AUTO_PROVISION_ENABLED 灰度开关（默认 false）。关闭时 provisioning
  // 恒为空数组。
  auto_provision_enabled: boolean;
  // 每个 claude-managed 账号最近一轮自动供给判定；开关关闭或尚未跑过一轮
  // reconcile 时为空数组（后端显式回 [] 而非 null，前端可直接判空）。
  provisioning: FarmAccountProvisioningView[];
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

// **诚实边界（写进类型也写进 UI）**：beacon 是容器「自报 / 声明」的遥测内容
// （source ∈ declared/self-report，存储层把未知值归一到 unknown），只证明
// 「上报管道连通 + 容器声明了什么」，**不构成反关联证明**——它不是从真实出站
// 流量里抓到的 on-wire 值。真正的 on-wire 抓取管道尚未落地，前端展示时 on-wire
// 一列必须显式灰置标注「待抓取管道，尚未证明」，不得让界面暗示已抓到真实出站值。
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
  // 上报来源分类：declared / self-report / unknown（存储层归一后的值），
  // 前端据此提示这些值是「声明/自报」而非「抓包实测」。
  source: string;
}

// GET /api/farm/containers/{id}/beacons 响应体：裸数组（captured_at 降序）。
export type FarmContainerBeaconsResponse = FarmContainerBeaconView[];

// beacon 自洽卡的三个比对字段（declared 列现在能填，on-wire 列一律灰置待抓取）。
export const FARM_TELEMETRY_FINGERPRINT_FIELDS = [
  'device_id',
  'entrypoint',
  'api_base_url_host',
] as const;
export type FarmTelemetryFingerprintField = (typeof FARM_TELEMETRY_FINGERPRINT_FIELDS)[number];

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
