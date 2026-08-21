/**
 * 农场编排器（Device Farm）API
 *
 * 端点契约照抄 services/farm-orchestrator/internal/httpapi/{dto.go,handlers.go,
 * observability.go}：
 * - GET    /api/farm/containers?status=<all|具体状态>（不传=默认活跃视图，排除 retired/orphaned）
 * - POST   /api/farm/containers          body: { id }
 * - DELETE /api/farm/containers/{id}?delete_volume=<true|false>
 * - GET    /api/farm/accounts?env=<env>
 * - POST   /api/farm/bindings            body: { container_id, account_id, env, auth_index? }
 * - DELETE /api/farm/bindings/{container_id}
 * - GET    /api/farm/usage?env=<env>
 * - GET    /api/farm/resources
 * - GET    /api/farm/overview（P0-4，design.md 决策4 KPI 聚合）
 * - GET    /api/farm/containers/{id}                    聚合详情
 * - GET    /api/farm/containers/{id}/keepalive?window=&step=   心跳时序 step 分桶
 * - GET    /api/farm/containers/{id}/resources?window=&step=   资源时序 step 分桶
 * - GET    /api/farm/containers/{id}/events              当前 firing 事件（非完整历史）
 * - GET    /api/farm/alerts?window=&status=              跨容器告警 feed（P0-5，
 *          已注册并测试通过，见下方 getAlerts 注释）
 * - POST   /api/farm/onboard body: { account_id, env, proxy_url?, container_id? }
 *          半自动 onboard（design.md 决策5，P0-10）。后端 P0-6 已落地并注册
 *          路由，成功体 = bindingResponse + container_created；失败体是独立
 *          形状 onboardErrorResponse{ error, code }，机器码在 code 字段。
 * - GET    /api/farm/account-state?env=<env>            账号认证态快照（FO1，
 *          env 可选，不传返回跨 test/prod 全量）
 * - GET    /api/farm/containers/{id}/probe-cadence?window=&limit=
 *          探针到达间隔（用户④「请求间隔 DTO」，与 .../usage 分栏口径）
 */

import { farmClient } from './farmClient';
import type {
  FarmAccountEntry,
  FarmAccountStateListResponse,
  FarmAlertsResponse,
  FarmBindingResponse,
  FarmCapacityResponse,
  FarmConfigResponse,
  FarmConfigUpdateRequest,
  FarmContainerBeaconsResponse,
  FarmContainerDetailView,
  FarmContainerEventsResponse,
  FarmContainerView,
  FarmCreateBindingRequest,
  FarmCreateContainerRequest,
  FarmEnv,
  FarmKeepaliveSeriesResponse,
  FarmOnboardRequest,
  FarmOnboardResponse,
  FarmOverviewResponse,
  FarmProbeCadenceView,
  FarmResourceResponse,
  FarmResourceSeriesResponse,
  FarmRetireContainerResponse,
  FarmUnbindResponse,
  FarmUsageResponse,
} from '@/types/farm';

// GET .../keepalive、.../resources 共用的 window/step 查询参数（httpapi
// parseWindowAndStep：Go duration 字符串 "24h"/"30m"/"90s" + 扩展 "d" 后缀，
// 不传时后端默认 window=24h/step=1h）。
export interface FarmSeriesQuery {
  window?: string;
  step?: string;
}

// GET /api/farm/alerts 查询参数（design.md 决策4「window/status，
// firing/resolved」）；P0-5 后端契约细节待核实，见 farmApi.getAlerts 注释。
export interface FarmAlertsQuery {
  window?: string;
  status?: 'firing' | 'resolved' | 'all';
}

// GET .../probe-cadence 查询参数（观察窗口 + 原始样本条数上限，httpapi
// handleGetContainerProbeCadence：window 复用 parseDurationParam 的
// "24h"/"7d" 语法，默认 24h、上限 30d；limit 默认 200、上限 1000）。
export interface FarmProbeCadenceQuery {
  window?: string;
  limit?: number;
}

// GET .../beacons 查询参数（用户⑤「每容器遥测内容抓取」，telemetry_beacon.go
// handleListContainerBeacons：limit 默认 50、上限 500，非法 limit 返回 400）。
export interface FarmContainerBeaconsQuery {
  limit?: number;
}

// handleListContainers 的 status 语义：不传=默认活跃视图（后端排除 retired/
// orphaned）；'all'=含归档全量；具体状态值=只筛该状态（含 retired/orphaned）。
// 前端这里不重复这套判定逻辑，原样透传 query 字符串给后端。
export type FarmListContainersStatus = 'all' | string;

export const farmApi = {
  listContainers: (status?: FarmListContainersStatus) =>
    farmClient.get<FarmContainerView[]>('/api/farm/containers', {
      params: status ? { status } : undefined,
    }),

  createContainer: (request: FarmCreateContainerRequest) =>
    farmClient.post<FarmContainerView>('/api/farm/containers', request),

  // 退役容器（软删归档）：默认保留专属卷（含 machineID/claude 状态，误删不可
  // 逆），deleteVolume=true 才连卷一起删。已绑定容器后端会拒绝（409，需先解绑）。
  retireContainer: (containerId: string, options?: { deleteVolume?: boolean }) =>
    farmClient.delete<FarmRetireContainerResponse>(
      `/api/farm/containers/${encodeURIComponent(containerId)}`,
      { params: { delete_volume: options?.deleteVolume ? 'true' : 'false' } }
    ),

  listAccounts: (env: FarmEnv) =>
    farmClient.get<FarmAccountEntry[]>('/api/farm/accounts', { params: { env } }),

  // 账号认证态快照（FO1「账号态单一采集源」，dto.go accountStateListResponse）：
  // 供两维徽标的账号认证态平面补 as-of 时间戳 + 陈旧标记（见
  // features/farm/hooks/useFarmAccountState）。env 可选，不传返回跨
  // test/prod 全量；未装配时后端优雅退化为空列表，不 500。
  listAccountState: (env?: FarmEnv) =>
    farmClient.get<FarmAccountStateListResponse>('/api/farm/account-state', {
      params: env ? { env } : undefined,
    }),

  createBinding: (request: FarmCreateBindingRequest) =>
    farmClient.post<FarmBindingResponse>('/api/farm/bindings', request),

  deleteBinding: (containerId: string) =>
    farmClient.delete<FarmUnbindResponse>(`/api/farm/bindings/${encodeURIComponent(containerId)}`),

  // 半自动 onboard（P0-10，design.md 决策5）：对「已认证但未接入农场」账号
  // 一键接入，编排器内部按「无空闲容器则建容器→绑定→起容器」原子链路处理，
  // 前端不重复 createContainer + createBinding 两步（那两步仍保留在
  // FarmContainerTable 作为高级/兜底路径）。proxy_url/container_id 可选，
  // 不传交由后端按 env 自行判定。失败态机器码在响应体独立 code 字段（不在
  // error 文本里），farmClient 解析进 FarmApiError.businessCode，调用方
  // （useFarmOnboard）按 businessCode 精确匹配，不做文本子串匹配。
  onboardAccount: (accountId: string, env: FarmEnv, options?: { proxy_url?: string; container_id?: string }) =>
    farmClient.post<FarmOnboardResponse>('/api/farm/onboard', {
      account_id: accountId,
      env,
      ...(options?.proxy_url ? { proxy_url: options.proxy_url } : {}),
      ...(options?.container_id ? { container_id: options.container_id } : {}),
    } satisfies FarmOnboardRequest),

  // Token 用量按容器/账号聚合，口径见 FarmUsageResponse.note（CPA 自上次重启起
  // 的内存态计数，不持久）。env 可选：不传时后端聚合全部已绑定 env。
  getUsage: (env?: FarmEnv) =>
    farmClient.get<FarmUsageResponse>('/api/farm/usage', {
      params: env ? { env } : undefined,
    }),

  // 容器 + 整机资源快照（mem/cpu），host.note 固定携带"整机含非农场进程"口径。
  getResources: () => farmClient.get<FarmResourceResponse>('/api/farm/resources'),

  // 容量就绪度 + 「认证即自动供」状态（用户③「容量正名」独立只读端点，
  // handlers.go handleGetCapacity）：容量摘要扁平字段（active_containers/
  // max_active_containers、mem_available_bytes vs mem_available_threshold_bytes、
  // host_metrics_available、has_headroom）+ 顶层 auto_provision_enabled 灰度
  // 开关 + per-account provisioning 列表。auth-gated，与其它 /api/farm/* 同鉴权；
  // 自动供给关闭时 provisioning 恒为空数组（非 null），前端可直接判空。
  getCapacity: () => farmClient.get<FarmCapacityResponse>('/api/farm/capacity'),

  // 运行时翻转「认证即自动供」灰度开关（PATCH /api/farm/config，handlers.go
  // handleUpdateConfig）：行为变更端点（开=新认证账号自动建容器接入农场），与其它
  // 写端点同 farm mgmt-key 中间件鉴权。请求体只带 auto_provision_enabled，成功
  // 200 回显设置后的真值（RWMutex 保护）。调用方（useFarmAutoProvision）先弹二次
  // 确认再调用，成功后按响应值/重拉 capacity 刷新，失败保持原值并 toast 报错。
  // 重启后回落部署侧默认（compose/workflow 注入的 FARM_AUTO_PROVISION_ENABLED），
  // 该运行时覆盖不持久。
  updateConfig: (request: FarmConfigUpdateRequest) =>
    farmClient.patch<FarmConfigResponse>('/api/farm/config', request),

  // ---------------------------------------------------------------------
  // P0-9：概览 + 下钻 + 告警消费的只读监测 API（P0-4 已交付，P0-5 见下方注释）
  // ---------------------------------------------------------------------

  // KPI 聚合：各状态容器数 / 活跃告警数 / 心跳陈旧数 / device_id 漂移数（占位0）
  // / 探针 cost（占位 undefined）/ 响应生成时间。
  getOverview: () => farmClient.get<FarmOverviewResponse>('/api/farm/overview'),

  // 单容器聚合详情（containerView 全部字段 + 当前 firing 事件）。
  getContainerDetail: (containerId: string) =>
    farmClient.get<FarmContainerDetailView>(
      `/api/farm/containers/${encodeURIComponent(containerId)}`
    ),

  // 心跳时序 step 分桶（成功率、avg/p95 latency）。空窗口返回空 buckets 而非
  // error（spec「容器详情时序」Scenario）。
  getContainerKeepalive: (containerId: string, query?: FarmSeriesQuery) =>
    farmClient.get<FarmKeepaliveSeriesResponse>(
      `/api/farm/containers/${encodeURIComponent(containerId)}/keepalive`,
      { params: query }
    ),

  // 资源时序 step 分桶（avg/max mem、avg/max cpu）。
  getContainerResources: (containerId: string, query?: FarmSeriesQuery) =>
    farmClient.get<FarmResourceSeriesResponse>(
      `/api/farm/containers/${encodeURIComponent(containerId)}/resources`,
      { params: query }
    ),

  // 当前 firing 中的事件（非完整历史时间线，见 FarmEventView.resolved_at 注释）。
  getContainerEvents: (containerId: string) =>
    farmClient.get<FarmContainerEventsResponse>(
      `/api/farm/containers/${encodeURIComponent(containerId)}/events`
    ),

  // 跨容器告警 feed（design.md 决策4）。P0-5 已交付：
  // services/farm-orchestrator/internal/httpapi/server.go 注册
  // `GET /api/farm/alerts`（handleGetAlerts），dto.go 定义响应体
  // `alertsResponse{ window, status, alerts: []eventView }`，与
  // types/farm.ts FarmAlertsResponse（`{ alerts: FarmAlertEntry[] }`）对齐。
  // 请求失败时走 farmClient 既有错误处理，<FarmAlertsPanel> 的 AsyncPanel
  // error 态如实呈现，不会伪造成功响应。
  getAlerts: (query?: FarmAlertsQuery) =>
    farmClient.get<FarmAlertsResponse>('/api/farm/alerts', { params: query }),

  // 探针到达间隔（用户④「请求间隔 DTO」）：与 getUsage 刻意分成两个独立
  // 端点/字段，前端不应把两者相加或互相替代，见 FarmProbeCadenceView 顶部
  // 注释。?window=（默认 24h，上限 30d）与 ?limit=（默认 200，上限 1000）
  // 均可选。
  getContainerProbeCadence: (containerId: string, query?: FarmProbeCadenceQuery) =>
    farmClient.get<FarmProbeCadenceView>(
      `/api/farm/containers/${encodeURIComponent(containerId)}/probe-cadence`,
      { params: query }
    ),

  // 每容器遥测内容 beacon（用户⑤，telemetry_beacon.go）：返回值是**裸 JSON
  // 数组**（captured_at 降序），不是包裹对象——调用方直接拿到
  // FarmContainerBeaconView[]。空容器返回 []（非 null）；未知容器 404；非法
  // limit 400，均走 farmClient 既有错误处理由调用方就地呈现。诚实边界见
  // types/farm.ts FarmContainerBeaconView 顶部注释：这些是「自报/声明」值，
  // 只证明上报管道连通，不构成反关联 on-wire 证明。
  getContainerBeacons: (containerId: string, query?: FarmContainerBeaconsQuery) =>
    farmClient.get<FarmContainerBeaconsResponse>(
      `/api/farm/containers/${encodeURIComponent(containerId)}/beacons`,
      { params: query }
    ),
};
