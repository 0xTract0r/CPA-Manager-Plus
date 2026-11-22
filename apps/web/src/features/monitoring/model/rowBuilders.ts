import { formatApiKeyHashLabel } from './base';
import {
  calculateCacheHitRateFromTotals,
  getCacheHitTotals,
  isOpaqueUsageSourceId,
} from '@/utils/usage';
import {
  sanitizeApiKeyDisplayText,
  shouldPreferApiKeyAlias,
  type ApiKeyDisplayInfo,
} from './apiKeys';
import {
  buildMonitoringAccountFilterValue,
  buildAuthIndexAccountConstraintResolver,
  parseMonitoringAccountFilterValue,
  readMonitoringAccountFocusId,
  isMonitoringUnsupportedFocusFilterValue,
} from './analyticsAdapters';
import { buildMonitoringAccountRowId, normalizeMonitoringProvider } from './accountIdentity';
import { getRangeBounds } from './range';
import type {
  MonitoringAccountRow,
  MonitoringApiKeyRow,
  MonitoringCustomTimeRange,
  MonitoringEventRow,
  MonitoringRealtimeRow,
  MonitoringScopeFilters,
  MonitoringSummary,
  MonitoringTimeRange,
} from './types';
import { readEmailLike } from '@/utils/accountIdentity';

const UNKNOWN_API_KEY_GROUP_PREFIX = 'unknown-client-api-key';

const isEffectiveLabel = (value: string) => {
  const trimmed = value.trim();
  return Boolean(trimmed) && trimmed !== '-';
};

const resolveAccountDisplayName = (account: string, channels: Iterable<string>) => {
  if (readEmailLike(account)) return account;
  const channelLabels = Array.from(new Set(Array.from(channels).filter(isEffectiveLabel)));
  if (isOpaqueUsageSourceId(account) && channelLabels.length === 1) {
    return channelLabels[0];
  }
  return account || channelLabels[0] || '-';
};

export const shouldIncludeInStats = (
  row: Pick<MonitoringEventRow, 'failed' | 'inputTokens' | 'outputTokens'>
) => row.failed || row.inputTokens > 0 || row.outputTokens > 0;

export const buildRangeFilteredRows = (
  rows: MonitoringEventRow[],
  timeRange: MonitoringTimeRange,
  customTimeRange: MonitoringCustomTimeRange | null | undefined,
  searchQuery: string,
  searchApiKeyHash?: string
) => {
  const nowMs = Date.now();
  const bounds = getRangeBounds(timeRange, nowMs, customTimeRange);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const normalizedSearchApiKeyHash = String(searchApiKeyHash || '')
    .trim()
    .toLowerCase();
  if (!bounds) return [];

  return rows.filter((row) => {
    const outsideEnd =
      timeRange === 'yesterday' ? row.timestampMs >= bounds.endMs : row.timestampMs > bounds.endMs;
    if (row.timestampMs < bounds.startMs || outsideEnd) {
      return false;
    }

    if (
      normalizedQuery &&
      !row.searchText.includes(normalizedQuery) &&
      !(normalizedSearchApiKeyHash && row.apiKeyHash === normalizedSearchApiKeyHash)
    ) {
      return false;
    }

    return true;
  });
};

const isActiveScopeFilterValue = (value: string | null | undefined) =>
  Boolean(value && value.trim() && value !== 'all');

const normalizeScopeValue = (value: string | null | undefined) =>
  String(value || '')
    .trim()
    .toLowerCase();

const hasCacheActivity = (
  row: Pick<MonitoringEventRow, 'cachedTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>,
  mode: string
) => {
  const cachedTokens = row.cachedTokens || 0;
  const cacheReadTokens = row.cacheReadTokens || 0;
  const cacheCreationTokens = row.cacheCreationTokens || 0;
  if (mode === 'read') return cacheReadTokens > 0;
  if (mode === 'creation') return cacheCreationTokens > 0;
  return cachedTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0;
};

export const buildScopeFilteredRows = (
  rows: MonitoringEventRow[],
  scopeFilters?: MonitoringScopeFilters,
  options?: { acceptedFocusId?: string | null; useServerAttribution?: boolean }
): MonitoringEventRow[] => {
  if (!scopeFilters) return rows;

  // 服务端 focus token：已被本轮服务端确认则账号维度已由服务端精确过滤，本地不再按别名猜；
  // 未确认（旧服务/加载中/过期）则账号维度为空集，绝不回退成全量。
  if (isMonitoringUnsupportedFocusFilterValue(scopeFilters.account)) return [];
  const focusId = readMonitoringAccountFocusId(scopeFilters.account);
  if (focusId) {
    const accepted = String(options?.acceptedFocusId ?? '').trim() === focusId;
    if (!accepted) return [];
    return buildScopeFilteredRows(rows, { ...scopeFilters, account: 'all' }, options);
  }
  // 本地分组成员：选择器恰好由本批事件的某个列表分组产出时，按该分组真实成员过滤
  // （与 buildAccountRows 同一归属规则），不把全局 accounts/providers 交集硬套到多个索引。
  // 不匹配任何分组（旧链接/服务端已过滤子集）时保持原有口径。
  if (isActiveScopeFilterValue(scopeFilters.account)) {
    const selector = scopeFilters.account!.trim();
    const memberGroups = resolveLocalAccountGroupsBySelector(rows).get(selector);
    if (memberGroups) {
      const groupIds = resolveLocalAccountGroupIds(rows);
      const absorbed = resolveAbsorbedUnknownGroupIds(rows, groupIds, memberGroups);
      const members = rows.filter((row) => {
        const groupId = groupIds.get(row) ?? '';
        return memberGroups.has(groupId) || absorbed(row, groupId);
      });
      return buildScopeFilteredRows(members, { ...scopeFilters, account: 'all' }, options);
    }
  }

  const accountCriteria = parseMonitoringAccountFilterValue(scopeFilters.account);
  const account = normalizeScopeValue(accountCriteria.accounts[0] || scopeFilters.account);
  const accountAuthIndices = new Set(accountCriteria.authIndices.map(normalizeScopeValue));
  const accountApiKeyHashes = new Set(accountCriteria.apiKeyHashes.map(normalizeScopeValue));
  const hasAccountSourceHashFilter = accountCriteria.sourceHashes.length > 0;
  const accountProvider = normalizeScopeValue(accountCriteria.provider);
  // 共享凭据索引的 auth-account 选择器：索引 + 精确账号同时成立（与服务端 auth_indices+accounts 一致）
  const exactAccountForAuth =
    accountAuthIndices.size > 0 && accountCriteria.accounts.length > 0
      ? normalizeScopeValue(accountCriteria.accounts[0])
      : '';
  const provider = normalizeScopeValue(scopeFilters.provider);
  const authFile = normalizeScopeValue(scopeFilters.authFile);
  const projectId = normalizeScopeValue(scopeFilters.projectId);
  const requestType = normalizeScopeValue(scopeFilters.requestType);
  const model = normalizeScopeValue(scopeFilters.model);
  const channel = normalizeScopeValue(scopeFilters.channel);
  const apiKeyHash = normalizeScopeValue(scopeFilters.apiKeyHash);
  const status = scopeFilters.status;
  const minLatencyMs =
    typeof scopeFilters.minLatencyMs === 'number' && scopeFilters.minLatencyMs > 0
      ? scopeFilters.minLatencyMs
      : null;
  const cacheStatus = normalizeScopeValue(scopeFilters.cacheStatus);
  const headerTraceId = normalizeScopeValue(scopeFilters.headerTraceId);

  return rows.filter((row) => {
    // Display names can follow the current account after a provider rename.
    // Marked rows already passed the effective SQL predicates for this scope.
    const hasServerAttribution = options?.useServerAttribution && row.serverAttributionFiltered;
    if (isActiveScopeFilterValue(scopeFilters.account)) {
      // 精确凭据索引覆盖缺少 provider 快照的历史事件；其余选择器保持 provider 隔离。
      if (
        accountProvider &&
        accountAuthIndices.size === 0 &&
        normalizeScopeValue(row.providerIdentity ?? row.provider) !== accountProvider
      ) {
        return false;
      }
      if (accountAuthIndices.size > 0) {
        if (!accountAuthIndices.has(normalizeScopeValue(row.authIndex))) return false;
        if (
          exactAccountForAuth &&
          ![row.accountIdentity, row.account].map(normalizeScopeValue).includes(exactAccountForAuth)
        ) {
          return false;
        }
        // 同索引同名多已知 provider：与网络 filters.providers 同口径
        if (
          exactAccountForAuth &&
          accountProvider &&
          normalizeScopeValue(row.providerIdentity ?? row.provider) !== accountProvider
        ) {
          return false;
        }
      } else if (accountApiKeyHashes.size > 0) {
        if (!accountApiKeyHashes.has(normalizeScopeValue(row.apiKeyHash))) return false;
      } else if (hasAccountSourceHashFilter) {
        // source_hash is only available in analytics payloads, so avoid dropping rows after
        // the backend has already applied the exact source_hash filter.
      } else {
        const rowAccountValues = [
          row.accountIdentity,
          row.authLabelIdentity,
          row.sourceIdentity,
          row.account,
          row.accountMasked,
          row.authLabel,
          row.source,
          row.sourceMasked,
          row.authIndexIdentity,
          row.authIndex,
        ].map(normalizeScopeValue);
        if (!rowAccountValues.includes(account)) return false;
      }
    }

    if (
      !hasServerAttribution &&
      isActiveScopeFilterValue(scopeFilters.provider) &&
      normalizeScopeValue(row.provider) !== provider
    ) {
      return false;
    }

    if (
      isActiveScopeFilterValue(scopeFilters.authFile) &&
      normalizeScopeValue(row.source) !== authFile &&
      normalizeScopeValue(row.sourceMasked) !== authFile &&
      !normalizeScopeValue(row.searchText).includes(authFile)
    ) {
      return false;
    }

    if (
      isActiveScopeFilterValue(scopeFilters.projectId) &&
      normalizeScopeValue(row.projectId) !== projectId
    ) {
      return false;
    }

    if (
      isActiveScopeFilterValue(scopeFilters.requestType) &&
      normalizeScopeValue(row.executorType) !== requestType
    ) {
      return false;
    }

    if (isActiveScopeFilterValue(scopeFilters.model) && normalizeScopeValue(row.model) !== model) {
      return false;
    }

    if (
      !hasServerAttribution &&
      isActiveScopeFilterValue(scopeFilters.channel) &&
      normalizeScopeValue(row.channel) !== channel
    ) {
      return false;
    }

    if (
      isActiveScopeFilterValue(scopeFilters.apiKeyHash) &&
      normalizeScopeValue(row.apiKeyHash) !== apiKeyHash
    ) {
      return false;
    }

    if (status === 'failed' && !row.failed) return false;
    if (status === 'success' && row.failed) return false;
    if (minLatencyMs !== null && (row.latencyMs === null || row.latencyMs < minLatencyMs)) {
      return false;
    }
    if (cacheStatus === 'hit' && !hasCacheActivity(row, cacheStatus)) return false;
    if (cacheStatus === 'miss' && hasCacheActivity(row, cacheStatus)) return false;
    if (
      (cacheStatus === 'read' || cacheStatus === 'creation') &&
      !hasCacheActivity(row, cacheStatus)
    ) {
      return false;
    }
    if (
      isActiveScopeFilterValue(scopeFilters.headerTraceId) &&
      normalizeScopeValue(row.headerTraceId) !== headerTraceId
    ) {
      return false;
    }

    return true;
  });
};

const buildRecentPattern = (rows: MonitoringEventRow[], limit = 10) =>
  rows
    .slice()
    .sort((left, right) => right.timestampMs - left.timestampMs)
    .slice(0, limit)
    .reverse()
    .map((row) => !row.failed);

export const buildMonitoringSummary = (rows: MonitoringEventRow[]): MonitoringSummary => {
  const totalCalls = rows.length;
  const failureCalls = rows.filter((row) => row.failed).length;
  const successCalls = Math.max(totalCalls - failureCalls, 0);
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const reasoningTokens = rows.reduce((sum, row) => sum + row.reasoningTokens, 0);
  const cachedTokens = rows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const cacheReadTokens = rows.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0);
  const cacheCreationTokens = rows.reduce((sum, row) => sum + (row.cacheCreationTokens ?? 0), 0);
  const cacheHitTotals = rows.reduce(
    (totals, row) => {
      const rowTotals = getCacheHitTotals({
        modelName: row.resolvedModel || row.model,
        inputTokens: row.inputTokens,
        cachedTokens: row.cachedTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      });
      totals.hitTokens += rowTotals.hitTokens;
      totals.inputTokens += rowTotals.inputTokens;
      return totals;
    },
    { hitTokens: 0, inputTokens: 0 }
  );
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);

  let latencySum = 0;
  let latencyCount = 0;
  rows.forEach((row) => {
    if (row.latencyMs === null) return;
    latencySum += row.latencyMs;
    latencyCount += 1;
  });

  const taskMap = new Map<string, boolean>();
  rows.forEach((row) => {
    const existing = taskMap.get(row.taskKey) ?? false;
    taskMap.set(row.taskKey, existing || row.failed);
  });

  const approxTasks = taskMap.size;
  const approxTaskFailures = Array.from(taskMap.values()).filter(Boolean).length;
  const zeroTokenRows = rows.filter((row) => row.totalTokens === 0);

  const activeDays = new Set(rows.map((row) => row.dayKey));
  const activeDayCount = Math.max(activeDays.size, 1);
  const nowMs = Date.now();
  const windowStart = nowMs - 30 * 60 * 1000;
  const recentRows = rows.filter(
    (row) => row.timestampMs >= windowStart && row.timestampMs <= nowMs
  );
  const recentTokens = recentRows.reduce((sum, row) => sum + row.totalTokens, 0);

  return {
    totalCalls,
    successCalls,
    failureCalls,
    successRate: totalCalls > 0 ? successCalls / totalCalls : 1,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate: calculateCacheHitRateFromTotals(
      cacheHitTotals.hitTokens,
      cacheHitTotals.inputTokens
    ),
    totalTokens,
    totalCost,
    averageLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    rpm30m: recentRows.length / 30,
    tpm30m: recentTokens / 30,
    avgDailyRequests: totalCalls / activeDayCount,
    avgDailyTokens: totalTokens / activeDayCount,
    approxTasks,
    approxTaskFailures,
    approxTaskSuccessRate:
      approxTasks > 0 ? Math.max(approxTasks - approxTaskFailures, 0) / approxTasks : 1,
    zeroTokenCalls: zeroTokenRows.length,
    zeroTokenModels: Array.from(new Set(zeroTokenRows.map((row) => row.model))).sort(),
  };
};

// 与 Manager 的 credentialSnapshotIndex 一致：索引需要至少一条完整快照，且所有已知字段相容。
// 掩码只代表未记录原值，不按邮箱前缀、域名或其他显示文字匹配账号。
function accountSnapshotsByCredential(rows: MonitoringEventRow[]) {
  type Evidence = { provider: string; account: string; complete?: MonitoringEventRow };
  const evidence = new Map<string, Evidence | null>();
  for (const row of rows) {
    const index = (row.authIndexIdentity ?? row.authIndex).trim();
    if (!index || index === '-') continue;
    const previous = evidence.get(index);
    if (previous === null) continue;
    const sourceProvider = normalizeMonitoringProvider(
      row.authProviderSnapshot ?? row.providerIdentity
    );
    const provider = sourceProvider === 'unknown' || sourceProvider === '-' ? '' : sourceProvider;
    const sourceAccount = (row.accountIdentity ?? '').trim();
    const account = sourceAccount === '-' || sourceAccount.includes('*') ? '' : sourceAccount;
    if (
      (provider && previous?.provider && previous.provider !== provider) ||
      (account && previous?.account && previous.account !== account)
    ) {
      evidence.set(index, null);
      continue;
    }
    evidence.set(index, {
      provider: provider || previous?.provider || '',
      account: account || previous?.account || '',
      complete: previous?.complete ?? (provider && account ? row : undefined),
    });
  }
  return evidence;
}

/** 列表分组与详情过滤共用的归属规则：事件 -> 本地分组 ID。 */
const resolveLocalAccountGroupKey = (
  row: MonitoringEventRow,
  snapshots: ReturnType<typeof accountSnapshotsByCredential>
) => {
  const index = (row.authIndexIdentity ?? row.authIndex).trim();
  const owner = snapshots.get(index)?.complete ?? row;
  const provider = normalizeMonitoringProvider(owner.providerIdentity ?? owner.provider);
  return {
    owner,
    provider,
    accountKey: buildMonitoringAccountRowId({
      provider,
      account: owner.accountIdentity ?? owner.account,
      authLabel: row.authLabelIdentity ?? row.authLabel,
      source: row.sourceIdentity ?? row.source,
      authIndex: row.authIndexIdentity ?? row.authIndex,
      sourceHash: row.sourceHashIdentity,
    }),
  };
};

export const resolveLocalAccountGroupIds = (rows: MonitoringEventRow[]) => {
  const snapshots = accountSnapshotsByCredential(rows);
  return new Map(rows.map((row) => [row, resolveLocalAccountGroupKey(row, snapshots).accountKey]));
};

const isUnknownProvider = (provider: string) =>
  !provider || provider === 'unknown' || provider === '-';

/**
 * 已知 provider 分组的详情可吸收“同凭据索引 + 同原始账号 + 无 provider”的事件，
 * 但仅当该 (索引, 账号) 只被一个已知 provider 占有时（与服务端/网络口径一致）；
 * 掩码账号不参与匹配，无 provider 分组自身的详情不吸收任何其他分组。
 */
const resolveAbsorbedUnknownGroupIds = (
  rows: MonitoringEventRow[],
  groupIds: Map<MonitoringEventRow, string>,
  targetGroups: Set<string>
) => {
  const keyOf = (row: MonitoringEventRow) => {
    const account = normalizeScopeValue(row.accountIdentity ?? row.account);
    const index = normalizeScopeValue(row.authIndexIdentity ?? row.authIndex);
    if (!account || account === '-' || account.includes('*') || !index || index === '-') return '';
    return `${index}\u0000${account}`;
  };
  const providerOf = (row: MonitoringEventRow) =>
    normalizeMonitoringProvider(row.providerIdentity ?? row.provider);
  const knownProviders = new Map<string, Set<string>>();
  const targetKeys = new Set<string>();
  rows.forEach((row) => {
    const key = keyOf(row);
    const provider = providerOf(row);
    if (!key || isUnknownProvider(provider)) return;
    const set = knownProviders.get(key) ?? new Set<string>();
    set.add(provider);
    knownProviders.set(key, set);
    if (targetGroups.has(groupIds.get(row) ?? '')) targetKeys.add(key);
  });
  return (row: MonitoringEventRow, _groupId: string) => {
    if (!isUnknownProvider(providerOf(row))) return false;
    const key = keyOf(row);
    return Boolean(key) && targetKeys.has(key) && (knownProviders.get(key)?.size ?? 0) === 1;
  };
};

/** 选择器 -> 产出该选择器的本地分组 ID 集合（与列表 buildAccountRows 完全同源）。 */
const resolveLocalAccountGroupsBySelector = (rows: MonitoringEventRow[]) => {
  const map = new Map<string, Set<string>>();
  buildAccountRows(rows).forEach((row) => {
    const key = (row.filterValue || row.account).trim();
    const ids = map.get(key) ?? new Set<string>();
    ids.add(row.id);
    map.set(key, ids);
  });
  return map;
};

export const buildAccountRows = (rows: MonitoringEventRow[]): MonitoringAccountRow[] => {
  const snapshots = accountSnapshotsByCredential(rows);
  const grouped = new Map<
    string,
    {
      id: string;
      account: string;
      filterAccount: string;
      provider: string;
      accountMasked: string;
      accountNotes: Set<string>;
      authLabels: Set<string>;
      authIndices: Set<string>;
      sourceKeys: Set<string>;
      sourceHashes: Set<string>;
      apiKeyHashes: Set<string>;
      channels: Set<string>;
      planTypes: Set<string>;
      modelMap: Map<
        string,
        {
          model: string;
          totalCalls: number;
          successCalls: number;
          failureCalls: number;
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          totalTokens: number;
          totalCost: number;
          lastSeenAt: number;
        }
      >;
      rows: MonitoringEventRow[];
      totalCalls: number;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const { owner, provider, accountKey } = resolveLocalAccountGroupKey(row, snapshots);
    const filterAccount =
      [owner.accountIdentity, row.authLabelIdentity, row.sourceIdentity, owner.account].find(
        (value) => Boolean(value && isEffectiveLabel(value))
      ) || '';
    const existing = grouped.get(accountKey) ?? {
      id: accountKey,
      account: owner.account,
      filterAccount,
      provider,
      accountMasked: owner.accountMasked,
      accountNotes: new Set<string>(),
      authLabels: new Set<string>(),
      authIndices: new Set<string>(),
      sourceKeys: new Set<string>(),
      sourceHashes: new Set<string>(),
      apiKeyHashes: new Set<string>(),
      channels: new Set<string>(),
      planTypes: new Set<string>(),
      modelMap: new Map(),
      rows: [] as MonitoringEventRow[],
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };

    existing.rows.push(row);
    existing.authLabels.add(row.authLabel);
    if (row.accountNote) existing.accountNotes.add(row.accountNote);
    existing.authIndices.add(row.authIndexIdentity ?? row.authIndex);
    if (row.sourceKey) {
      existing.sourceKeys.add(row.sourceKey);
    }
    existing.sourceHashes.add(row.sourceHashIdentity ?? '');
    existing.apiKeyHashes.add(row.apiKeyHash);
    existing.channels.add(row.channel);
    if (row.planType && row.planType !== '-') {
      existing.planTypes.add(row.planType);
    }
    existing.totalCalls += 1;
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheCreationTokens += row.cacheCreationTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    const modelEntry = existing.modelMap.get(row.model) ?? {
      model: row.model,
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      lastSeenAt: 0,
    };

    modelEntry.totalCalls += 1;
    modelEntry.successCalls += row.failed ? 0 : 1;
    modelEntry.failureCalls += row.failed ? 1 : 0;
    modelEntry.inputTokens += row.inputTokens;
    modelEntry.outputTokens += row.outputTokens;
    modelEntry.cachedTokens += row.cachedTokens;
    modelEntry.cacheReadTokens += row.cacheReadTokens;
    modelEntry.cacheCreationTokens += row.cacheCreationTokens;
    modelEntry.totalTokens += row.totalTokens;
    modelEntry.totalCost += row.totalCost;
    modelEntry.lastSeenAt = Math.max(modelEntry.lastSeenAt, row.timestampMs);
    existing.modelMap.set(row.model, modelEntry);

    grouped.set(accountKey, existing);
  });

  const resolveAuthIndexConstraint = buildAuthIndexAccountConstraintResolver(
    Array.from(grouped.values()).map((item) => ({
      provider: item.provider,
      account: item.account,
      authIndices: item.authIndices,
    }))
  );
  return Array.from(grouped.values())
    .map((item) => {
      const channels = Array.from(item.channels).sort();
      const authIndices = Array.from(item.authIndices).sort();
      const sourceKeys = Array.from(item.sourceKeys).sort();
      const sourceHashes = Array.from(item.sourceHashes).sort();
      const apiKeyHashes = Array.from(item.apiKeyHashes).sort();
      const authLabels = Array.from(item.authLabels).filter(Boolean).sort();
      const accountLabel =
        Array.from(item.accountNotes).find(Boolean) ||
        resolveAccountDisplayName(item.account, channels);
      const legacyFilterValue =
        buildMonitoringAccountFilterValue({
          account: item.filterAccount,
          provider: item.provider,
          authIndices,
          sourceHashes,
          apiKeyHashes,
          ...resolveAuthIndexConstraint({
            provider: item.provider,
            account: item.account,
            authIndices,
          }),
        }) || item.account;
      return {
        id: item.id,
        account: item.account,
        provider: item.provider,
        filterValue: legacyFilterValue,
        displayAccount: accountLabel,
        accountMasked: item.accountMasked,
        authLabels,
        authIndices,
        sourceKeys,
        channels,
        planTypes: Array.from(item.planTypes).sort(),
        totalCalls: item.totalCalls,
        successCalls: item.successCalls,
        failureCalls: item.failureCalls,
        successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedTokens: item.cachedTokens,
        cacheReadTokens: item.cacheReadTokens,
        cacheCreationTokens: item.cacheCreationTokens,
        totalTokens: item.totalTokens,
        totalCost: item.totalCost,
        averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
        lastSeenAt: item.lastSeenAt,
        recentPattern: buildRecentPattern(item.rows),
        models: Array.from(item.modelMap.values())
          .map((model) => ({
            ...model,
            successRate: model.totalCalls > 0 ? model.successCalls / model.totalCalls : 1,
          }))
          .sort(
            (left, right) => right.totalCost - left.totalCost || right.totalCalls - left.totalCalls
          ),
      };
    })
    .sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        right.totalCalls - left.totalCalls ||
        right.totalCost - left.totalCost
    );
};

export const buildApiKeyRows = (
  rows: MonitoringEventRow[],
  apiKeyDisplayMap?: ReadonlyMap<string, ApiKeyDisplayInfo>
): MonitoringApiKeyRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      apiKeyHash: string;
      apiKeyLabel: string;
      apiKeyMasked: string;
      apiKeyCopyValue?: string;
      isUnknown: boolean;
      authLabels: Set<string>;
      sourceLabels: Set<string>;
      channels: Set<string>;
      modelMap: Map<
        string,
        {
          model: string;
          totalCalls: number;
          successCalls: number;
          failureCalls: number;
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          totalTokens: number;
          totalCost: number;
          lastSeenAt: number;
        }
      >;
      totalCalls: number;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const hasKnownApiKey = Boolean(
      row.apiKeyHash ||
      (row.apiKeyLabel && row.apiKeyLabel !== '-') ||
      (row.apiKeyMasked && row.apiKeyMasked !== '-')
    );
    const apiKeyGroupKey = hasKnownApiKey
      ? row.apiKeyHash || row.apiKeyLabel || row.apiKeyMasked
      : `${UNKNOWN_API_KEY_GROUP_PREFIX}:${row.sourceKey}:${row.authIndex || row.authLabel || '-'}:${row.channel || '-'}:${row.provider || '-'}`;
    const existing = grouped.get(apiKeyGroupKey) ?? {
      id: apiKeyGroupKey,
      apiKeyHash: row.apiKeyHash,
      apiKeyLabel: sanitizeApiKeyDisplayText(row.apiKeyLabel),
      apiKeyMasked: sanitizeApiKeyDisplayText(row.apiKeyMasked),
      apiKeyCopyValue: row.apiKeyHash
        ? apiKeyDisplayMap?.get(row.apiKeyHash.toLowerCase())?.copyValue
        : undefined,
      isUnknown: !hasKnownApiKey,
      authLabels: new Set<string>(),
      sourceLabels: new Set<string>(),
      channels: new Set<string>(),
      modelMap: new Map(),
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      lastSeenAt: 0,
    };

    if (!existing.apiKeyHash && row.apiKeyHash) {
      existing.apiKeyHash = row.apiKeyHash;
    }
    if (!existing.apiKeyCopyValue && existing.apiKeyHash) {
      existing.apiKeyCopyValue = apiKeyDisplayMap?.get(
        existing.apiKeyHash.toLowerCase()
      )?.copyValue;
    }
    if (!existing.apiKeyMasked && row.apiKeyMasked) {
      existing.apiKeyMasked = sanitizeApiKeyDisplayText(row.apiKeyMasked);
    }
    if (
      shouldPreferApiKeyAlias(row.apiKeyLabel, row.apiKeyMasked) &&
      !shouldPreferApiKeyAlias(existing.apiKeyLabel, existing.apiKeyMasked)
    ) {
      existing.apiKeyLabel = sanitizeApiKeyDisplayText(row.apiKeyLabel, existing.apiKeyLabel);
    }
    existing.authLabels.add(row.authLabel);
    existing.sourceLabels.add(row.sourceMasked || row.source);
    existing.channels.add(row.channel);

    existing.totalCalls += 1;
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheCreationTokens += row.cacheCreationTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.timestampMs);

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    const modelEntry = existing.modelMap.get(row.model) ?? {
      model: row.model,
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      lastSeenAt: 0,
    };

    modelEntry.totalCalls += 1;
    modelEntry.successCalls += row.failed ? 0 : 1;
    modelEntry.failureCalls += row.failed ? 1 : 0;
    modelEntry.inputTokens += row.inputTokens;
    modelEntry.outputTokens += row.outputTokens;
    modelEntry.cachedTokens += row.cachedTokens;
    modelEntry.cacheReadTokens += row.cacheReadTokens;
    modelEntry.cacheCreationTokens += row.cacheCreationTokens;
    modelEntry.totalTokens += row.totalTokens;
    modelEntry.totalCost += row.totalCost;
    modelEntry.lastSeenAt = Math.max(modelEntry.lastSeenAt, row.timestampMs);
    existing.modelMap.set(row.model, modelEntry);

    grouped.set(apiKeyGroupKey, existing);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      id: item.id,
      apiKeyHash: item.apiKeyHash,
      apiKeyLabel: item.apiKeyLabel || item.apiKeyMasked || formatApiKeyHashLabel(item.apiKeyHash),
      apiKeyMasked: item.apiKeyMasked || item.apiKeyLabel || formatApiKeyHashLabel(item.apiKeyHash),
      apiKeyCopyValue: item.apiKeyCopyValue,
      isUnknown: item.isUnknown,
      authLabels: Array.from(item.authLabels).filter(Boolean).sort(),
      sourceLabels: Array.from(item.sourceLabels).filter(Boolean).sort(),
      channels: Array.from(item.channels).filter(Boolean).sort(),
      totalCalls: item.totalCalls,
      successCalls: item.successCalls,
      failureCalls: item.failureCalls,
      successRate: item.totalCalls > 0 ? item.successCalls / item.totalCalls : 1,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cachedTokens: item.cachedTokens,
      cacheReadTokens: item.cacheReadTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      totalTokens: item.totalTokens,
      totalCost: item.totalCost,
      averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
      lastSeenAt: item.lastSeenAt,
      models: Array.from(item.modelMap.values())
        .map((model) => ({
          ...model,
          successRate: model.totalCalls > 0 ? model.successCalls / model.totalCalls : 1,
        }))
        .sort(
          (left, right) => right.totalCost - left.totalCost || right.totalCalls - left.totalCalls
        ),
    }))
    .sort(
      (left, right) =>
        right.lastSeenAt - left.lastSeenAt ||
        right.totalCalls - left.totalCalls ||
        right.totalCost - left.totalCost
    );
};

export const buildRealtimeMonitorRows = (rows: MonitoringEventRow[]): MonitoringRealtimeRow[] => {
  const grouped = new Map<
    string,
    {
      id: string;
      account: string;
      accountMasked: string;
      authLabel: string;
      authIndexMasked: string;
      provider: string;
      requestType: string;
      model: string;
      channel: string;
      rows: MonitoringEventRow[];
      latestFailed: boolean;
      successCalls: number;
      failureCalls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      totalTokens: number;
      totalCost: number;
      latencySum: number;
      latencyCount: number;
      latestLatencyMs: number | null;
      lastSeenAt: number;
    }
  >();

  rows.forEach((row) => {
    const requestType = `${row.endpointMethod} ${row.endpointPath}`.trim();
    const key = [
      row.account || row.authLabel || row.source,
      row.authIndexMasked,
      row.provider,
      row.model,
      row.channel,
      requestType,
    ].join('::');

    const existing = grouped.get(key) ?? {
      id: key,
      account: row.account,
      accountMasked: row.accountMasked,
      authLabel: row.authLabel,
      authIndexMasked: row.authIndexMasked,
      provider: row.provider,
      requestType,
      model: row.model,
      channel: row.channel,
      rows: [] as MonitoringEventRow[],
      latestFailed: row.failed,
      successCalls: 0,
      failureCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      latencySum: 0,
      latencyCount: 0,
      latestLatencyMs: null,
      lastSeenAt: 0,
    };

    existing.rows.push(row);
    existing.successCalls += row.failed ? 0 : 1;
    existing.failureCalls += row.failed ? 1 : 0;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheCreationTokens += row.cacheCreationTokens;
    existing.totalTokens += row.totalTokens;
    existing.totalCost += row.totalCost;

    if (row.timestampMs >= existing.lastSeenAt) {
      existing.lastSeenAt = row.timestampMs;
      existing.latestFailed = row.failed;
      existing.latestLatencyMs = row.latencyMs;
    }

    if (row.latencyMs !== null) {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }

    grouped.set(key, existing);
  });

  return Array.from(grouped.values())
    .map((item) => {
      const totalCalls = item.successCalls + item.failureCalls;
      return {
        id: item.id,
        account: item.account,
        accountMasked: item.accountMasked,
        authLabel: item.authLabel,
        authIndexMasked: item.authIndexMasked,
        provider: item.provider,
        requestType: item.requestType,
        model: item.model,
        channel: item.channel,
        latestFailed: item.latestFailed,
        successRate: totalCalls > 0 ? item.successCalls / totalCalls : 1,
        totalCalls,
        successCalls: item.successCalls,
        failureCalls: item.failureCalls,
        averageLatencyMs: item.latencyCount > 0 ? item.latencySum / item.latencyCount : null,
        latestLatencyMs: item.latestLatencyMs,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedTokens: item.cachedTokens,
        cacheReadTokens: item.cacheReadTokens,
        cacheCreationTokens: item.cacheCreationTokens,
        totalTokens: item.totalTokens,
        totalCost: item.totalCost,
        lastSeenAt: item.lastSeenAt,
        recentPattern: buildRecentPattern(item.rows),
      };
    })
    .sort(
      (left, right) => right.lastSeenAt - left.lastSeenAt || right.totalCalls - left.totalCalls
    );
};
