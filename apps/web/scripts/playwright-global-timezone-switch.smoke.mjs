/**
 * 全局时区切换 UI smoke（R5-4 回归门禁）。
 *
 * 目的：验证顶栏 TimezoneMenu 切换全局显示时区后，**无需刷新页面**，各页面可见时间戳
 * 与监控页的范围文案（account overview scope）就地更新。这是 R5-4 复核发现的「切换滞后」
 * 修复的确定性门禁：修复前，MonitoringCenterPage 的范围文案 / useMonitoringData 的时间线与
 * 分组标签被包在依赖数组不含时区的 useMemo 里，切换时区命中旧缓存、文案不更新；本 spec 用
 * DOM 断言 account overview scope 文案在切换后发生变化来卡住这个回归。
 *
 * 覆盖清单（route × 交互 × 断言）：
 *   - #/monitoring：切 UTC+8 → America/Los_Angeles，断言 account overview scope 文案(绝对
 *     起止时刻 HH:MM 走全局时区)就地变化 + 未发生页面刷新（sentinel 存活）。【硬 DOM 断言】
 *   - #/auth-files：切换全局时区，断言首个可见绝对时间戳文案就地变化。【硬 DOM 断言（有数据时）】
 *   - #/（dashboard）：切换前后各截图，作为视觉（discovery）证据。
 *   - 监控页时间线坐标轴由 echarts 渲染到 canvas，非 DOM 文本，无法做 DOM 断言，故以切换
 *     前后的时间线区域截图作为视觉证据（见 monitoring-*-timeline.png）。
 *
 * 文件命名：刻意用 `*.smoke.mjs` 而非 `*.smoke.spec.mjs`。cpamp 的 apps/web 直接跑裸
 * `vitest run`（无独立 vitest/playwright 配置、无 include/exclude 分流），vitest 默认会把
 * 文件名匹配 .spec.* 的用例收进单测集；本 Playwright 用例 import 了 @playwright/test（vitest 环境未装），
 * 若带 `.spec` 会被 `npx vitest run` 误收并报「Cannot find package '@playwright/test'」。本仓库
 * 的 Playwright smoke 一律由显式路径运行（见下方命令），文件名不需要 `.spec` 也能被 Playwright
 * 直接执行，故去掉 `.spec` 以避开 vitest 默认收集。
 *
 * 运行前置（本轮不要求运行，leader 后续在本地预览或部署后跑）：
 *   - cpamp 前端当前未安装 @playwright/test；跑前先在 apps/cpamp/apps/web 内安装：
 *       npm i -D @playwright/test && npx playwright install chromium
 *   - 起一个真实 cpamp 实例（本地 vite 预览，或部署到 201 test），并提供有效管理/admin key：
 *       MANAGEMENT_UI_BASE=http://127.0.0.1:5173 \
 *       MANAGEMENT_KEY=<admin-or-management-key> \
 *       npx playwright test scripts/playwright-global-timezone-switch.smoke.mjs
 *   - 部署形态入口用 management.html 时：
 *       MANAGEMENT_UI_BASE=http://10.1.1.201:18427/management.html
 *     （Mac 打 201 LAN IP 会被本机 Clash-TUN 黑洞，需 SSH 本地转发到 127.0.0.1，详见仓库运维记忆）
 *
 * 注意：本 app 使用 createHashRouter，路由在 `#` 之后（如 `<base>#/monitoring`）。
 */
import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

const managementUiBase = (process.env.MANAGEMENT_UI_BASE || 'http://127.0.0.1:5173').replace(
  /\/+$/,
  ''
);
const managementKey = process.env.MANAGEMENT_KEY || '';
const smokeOutDir =
  process.env.OUT_DIR ||
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../build/playwright-global-timezone-smoke'
  );
const ignoreHTTPSErrors = /^(1|true|yes|on)$/i.test(
  process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS || process.env.MANAGEMENT_UI_IGNORE_HTTPS_ERRORS || ''
);

const DEFAULT_ZONE_TESTID = 'timezone-option-Asia/Shanghai';
const SWITCH_ZONE_TESTID = 'timezone-option-America/Los_Angeles';
const NO_RELOAD_SENTINEL = '__tzSpecNoReloadSentinel__';

fs.mkdirSync(smokeOutDir, { recursive: true });

const routeUrl = (hash) => `${managementUiBase}${hash}`;
const shot = (name) => path.join(smokeOutDir, name);

/** 通过真实登录 UI 进入受保护路由；已自动恢复会话时直接跳过。 */
async function ensureAuthenticated(page) {
  await page.goto(routeUrl('#/'), { waitUntil: 'domcontentloaded' });

  // 登录页可能先走 splash（自动恢复会话），最长等待其解析。
  const passwordInput = page.locator('input[type="password"]').first();
  const dashboardReady = page.locator('[data-testid="timezone-menu-toggle"]');

  await Promise.race([
    passwordInput.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
    dashboardReady.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
  ]);

  if (await dashboardReady.isVisible().catch(() => false)) {
    return; // 已自动登录。
  }

  if (!managementKey) {
    throw new Error(
      '需要登录但未提供 MANAGEMENT_KEY；请设置 MANAGEMENT_KEY 或提供已记住会话的实例。'
    );
  }

  // 登录卡片只有一个密码输入框（admin key 或 CPA management key）。填入后回车提交
  // （LoginPage 的 handleSubmitKeyDown 在 Enter 时提交）。
  await passwordInput.fill(managementKey);
  await passwordInput.press('Enter');

  // 顶栏时区按钮只在受保护布局（MainLayout）里出现，用它作为「已进入应用」信号。
  await dashboardReady.waitFor({ state: 'visible', timeout: 30_000 });
}

/** 打一个不受时区切换影响的 sentinel；页面刷新会清掉它，用于反证「未刷新」。 */
async function markNoReloadSentinel(page) {
  await page.evaluate((key) => {
    window[key] = 'alive';
  }, NO_RELOAD_SENTINEL);
}

async function assertNoReload(page) {
  const alive = await page.evaluate((key) => window[key], NO_RELOAD_SENTINEL);
  expect(alive, '切换全局时区不应触发页面刷新（sentinel 应存活）').toBe('alive');
}

/** 打开顶栏 TimezoneMenu 并选择目标时区。 */
async function selectTimezone(page, optionTestId) {
  await page.getByTestId('timezone-menu-toggle').click();
  const option = page.getByTestId(optionTestId);
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.click();
}

test.use({ ignoreHTTPSErrors, viewport: { width: 1440, height: 900 } });

test.describe('全局时区切换即时更新（R5-4）', () => {
  test.beforeEach(async ({ page }) => {
    await ensureAuthenticated(page);
    // 每个用例从默认 UTC+8 开始，避免上一次持久化到 localStorage 的时区污染基线。
    await selectTimezone(page, DEFAULT_ZONE_TESTID);
  });

  test('监控页：切换时区后 account overview 范围文案就地更新且不刷新', async ({ page }) => {
    await page.goto(routeUrl('#/monitoring'), { waitUntil: 'domcontentloaded' });

    // account overview 范围文案由 formatStatusWindowLabel 渲染绝对起止时刻（HH:MM 走全局时区），
    // 是 R5-4「切换滞后」修复的确定性 DOM 断言点。CSS Module 类名带 hash，用前缀匹配定位。
    const scopeText = page.locator('[class*="accountScopeText"]').first();
    await scopeText.waitFor({ state: 'visible', timeout: 30_000 });
    const before = (await scopeText.innerText()).trim();
    expect(before, 'account overview 范围文案应为非空绝对时间窗').not.toHaveLength(0);

    await markNoReloadSentinel(page);
    await page.screenshot({ path: shot('monitoring-01-utc8.png'), fullPage: true });

    await selectTimezone(page, SWITCH_ZONE_TESTID);

    // 硬断言：切到 America/Los_Angeles（UTC-7/-8，与 UTC+8 相差 15/16 小时）后，范围文案里的
    // 绝对时刻必须就地变化。修复前 useMemo 依赖缺 timeZone 会命中旧缓存 → 文案不变 → 断言失败。
    await expect(scopeText, '切换时区后 account overview 范围文案应就地更新').not.toHaveText(
      before,
      { timeout: 15_000 }
    );

    await assertNoReload(page);
    await page.screenshot({ path: shot('monitoring-02-losangeles.png'), fullPage: true });

    // 时间线坐标轴由 echarts 渲染到 canvas，非 DOM 文本；保留区域截图作为轴标签更新的视觉证据。
    const timelineCard = page.locator('canvas').first();
    if (await timelineCard.isVisible().catch(() => false)) {
      await timelineCard.screenshot({ path: shot('monitoring-03-timeline-losangeles.png') });
    }
  });

  test('auth-files：切换时区后首个可见绝对时间戳就地更新', async ({ page }) => {
    await page.goto(routeUrl('#/auth-files'), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // 定位首个「日期+时间」样式的绝对时间戳文本（YYYY/一位或两位月/日 HH:MM），auth 文件的
    // 修改/最近使用时间走全局时区格式化。无此类数据时降级为纯截图证据（不误判为通过）。
    const timestamp = page
      .locator('text=/\\d{1,4}[/-]\\d{1,2}[/-]\\d{1,2}.*\\d{1,2}:\\d{2}/')
      .first();
    const hasTimestamp = await timestamp
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    await markNoReloadSentinel(page);
    await page.screenshot({ path: shot('authfiles-01-utc8.png'), fullPage: true });

    await selectTimezone(page, SWITCH_ZONE_TESTID);

    if (hasTimestamp) {
      const before = (await timestamp.innerText()).trim();
      await selectTimezone(page, DEFAULT_ZONE_TESTID);
      await expect(timestamp, '默认时区下时间戳应与 UTC+8 基线一致').toHaveText(before, {
        timeout: 10_000,
      });
      await selectTimezone(page, SWITCH_ZONE_TESTID);
      await expect(
        timestamp,
        '切换到 America/Los_Angeles 后可见绝对时间戳应就地更新'
      ).not.toHaveText(before, { timeout: 15_000 });
    } else {
      test.info().annotations.push({
        type: 'note',
        description:
          'auth-files 无可断言的绝对时间戳（可能无 auth 文件数据）；仅保留截图作为视觉证据。',
      });
    }

    await assertNoReload(page);
    await page.screenshot({ path: shot('authfiles-02-losangeles.png'), fullPage: true });
  });

  test('dashboard：切换时区前后保留视觉证据', async ({ page }) => {
    await page.goto(routeUrl('#/'), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    await markNoReloadSentinel(page);
    await page.screenshot({ path: shot('dashboard-01-utc8.png'), fullPage: true });

    await selectTimezone(page, SWITCH_ZONE_TESTID);
    await assertNoReload(page);
    await page.screenshot({ path: shot('dashboard-02-losangeles.png'), fullPage: true });
  });
});
