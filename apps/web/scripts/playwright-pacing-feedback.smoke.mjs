/** 本地 CPAMP 推荐方案卡 UI gate；内存 mock，禁止非本地或 API 外联。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4186';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const out = path.resolve(process.env.OUT_DIR || '.tmp-pacing-guided-ux');
await fs.mkdir(out, { recursive: true });
const capturedFile = new URL('../src/features/demo/pacingProductionSnapshot.json', import.meta.url);
const capturedRaw = await fs.readFile(capturedFile); const captured = JSON.parse(capturedRaw);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'zh-CN' });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage(); page.setDefaultTimeout(12000);
const consoleErrors = [], networkFailures = [], apiAttempts = [], checks = [], evidence = {};
let failure;
page.on('pageerror', e => consoleErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('requestfailed', r => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') networkFailures.push({ path: new URL(r.url()).pathname, error: r.failure()?.errorText }); });
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(base).origin || /\/v[01]\//.test(url.pathname) || /^\/api\//.test(url.pathname)) {
    apiAttempts.push({ origin: url.origin, path: url.pathname });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  return route.continue();
});
const modulePath = '/src/features/demo/pacingFeedbackDemo.ts';
const open = async (scenario = '') => {
  await page.goto('about:blank');
  await page.goto(`${base}/?pacing-feedback=1${scenario ? `&pacing-scenario=${scenario}` : ''}#/demo/auth-files`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByTestId('auth-file-pacing-local-account-3.json').waitFor({ timeout: 45000 });
};
const detail = () => page.getByTestId('warmup-pacing-detail');
const policy = () => page.getByTestId('account-limit-policy');
const preview = () => page.getByTestId('limit-plan-preview');
const apply = () => page.getByTestId('apply-account-limits');
const close = async () => {
  await page.keyboard.press('Escape'); await page.waitForTimeout(450);
  const discard = page.getByRole('button', { name: '放弃并返回', exact: true });
  if (await discard.isVisible()) await discard.click();
  // 真事件触发 live refresh；不修改 document.hidden，覆盖关闭动画期间重新渲染。
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 1800 });
};
const show = async id => { await page.getByTestId(`auth-file-pacing-${id}.json`).click(); await detail().waitFor(); };
const edit = async () => { await page.getByRole('button', { name: '调度与上限', exact: true }).click(); await policy().waitFor(); await page.getByTestId('limit-scenario-disclosure').locator(':scope > summary').click(); };
const returnAfterSave = async () => {
  await page.getByRole('status').filter({ hasText: '已保存，仅对此账号生效。' }).waitFor();
  await page.getByRole('button', { name: '返回配速详情', exact: true }).click();
  await detail().waitFor();
};
const top = async () => { await page.locator('.modal-body').evaluate(e => { e.scrollTop = 0; }); };
const shot = async name => { if (await page.locator('.modal-body').count()) await top(); await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
const state = async id => page.evaluate(async ({ modulePath, id }) => {
  const loaded = performance.getEntriesByType('resource').map(x => x.name).filter(url => new URL(url).pathname === modulePath);
  const moduleUrl = loaded.find(url => new URL(url).searchParams.has('t')) ?? loaded[0];
  if (!moduleUrl) throw new Error('Application demo module not loaded');
  const m = await import(moduleUrl); const f = m.getPacingFeedbackFiles().files.find(x => x.name === `${id}.json`);
  return f?.account_scheduling;
}, { modulePath, id });
const effective = async (id, groups, concurrency, rpm = 5, daily = 500) => {
  await page.getByTestId('pacing-groups').filter({ hasText: `/ ${groups}` }).waitFor();
  const view = await state(id); const p = view.warmup_traffic_pacing;
  assert.equal(p.max_active_binding_groups, groups); assert.equal(p.concurrency_limit, concurrency);
  assert.equal(p.rpm_limit, rpm); assert.equal(p.daily_request_budget, daily);
  assert.match(await page.getByTestId('pacing-inflight').innerText(), new RegExp(`/ ${concurrency}`));
  assert.match(await page.getByTestId('pacing-rpm_occupancy').innerText(), new RegExp(`/ ${rpm}`));
  assert.match(await page.getByTestId('pacing-daily').innerText(), new RegExp(`/ ${daily}`));
  return view;
};
const inModalViewport = async locator => {
  const box = await locator.boundingBox(); const bounds = await page.locator('.modal-body').boundingBox();
  assert(box && bounds && box.y >= bounds.y - 1 && box.y + box.height <= bounds.y + bounds.height + 1, 'primary action/summary outside modal viewport');
};
const fits = async locator => {
  const box = await locator.boundingBox(); assert(box && box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1, 'outside viewport');
  assert(await locator.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'horizontal overflow');
};
const scenarioIds = ['local-account-1', 'local-account-2', 'local-account-3', 'local-account-4', 'local-simulation', 'local-queue', 'local-temporary', 'local-empty'];
try {
  if (!['remaining', 'expiry'].includes(process.env.CPAMP_UI_CASE)) {
  await open(); assert.match(await page.getByTestId('pacing-preview-notice').innerText(), /可编辑上限.*模拟/);
  for (const id of scenarioIds) assert.equal(await page.getByTestId(`auth-file-card-${id}.json`).count(), 1);
  assert.equal(await page.getByTestId('auth-file-pacing-local-account-1.json').count(), 0);
  await shot('eight-local-scenarios'); checks.push('eight-visible-cards-and-source-notice');

  await show('local-account-3'); await edit();
  assert.equal(await policy().locator('input[type="number"]:visible').count(), 0);
  assert.equal(await policy().locator('details[open]').count(), 1);
  assert.equal(await policy().getByRole('radio').count(), 3);
  assert.equal(await apply().isDisabled(), true); await shot('ac13-initial-recommendation-cards');
  await page.getByTestId('limit-preset-agents').check();
  assert.equal(await page.getByRole('radio', { name: /15 分钟.*建议/ }).isChecked(), true);
  assert.match(await preview().innerText(), /会话位置\s*1\s*→\s*2/);
  assert.equal(await preview().locator('dl > div').count(), 1);
  assert.match(await apply().innerText(), /应用 15 分钟/);
  await inModalViewport(apply()); await inModalViewport(policy().locator('[class*="actionSummary"]'));
  await shot('ac13-agents-selected'); checks.push('desktop-first-screen-action-and-change-summary-visible');
  await apply().click(); await returnAfterSave();
  const agents = await effective('local-account-3', 2, 1);
  assert.equal(agents.limit_policy.temporary_status, 'active');
  assert.equal((Date.parse(agents.limit_policy.temporary_expires_at) - Date.parse(agents.limit_policy.temporary_issued_at)) / 60000, 15);
  await shot('ac13-temporary-authoritative'); checks.push('ac13-two-action-agents-15min-authoritative-unchanged-rpm-day-concurrency');

  await edit(); await page.getByRole('button', { name: '提前结束临时覆盖', exact: true }).click(); await returnAfterSave();
  assert.equal((await effective('local-account-3', 1, 1)).limit_policy.temporary_status, 'ended');
  await edit(); await page.getByTestId('limit-preset-parallel').check();
  assert.match(await preview().innerText(), /同时处理\s*1\s*→\s*2/); assert.match(await preview().innerText(), /会话位置\s*1\s*→\s*4/);
  assert.equal(await preview().locator('dl > div').count(), 2);
  await page.getByRole('radio', { name: '一直生效', exact: true }).check(); assert.match(await apply().innerText(), /应用长期设置/);
  await shot('parallel-fixed-preview'); await apply().click(); await returnAfterSave();
  const fixed = await effective('local-account-3', 4, 2); assert.equal(fixed.limit_policy.fields.concurrency.source, 'fixed');
  await edit(); await page.getByTestId('limit-preset-baseline').check(); await apply().click(); await returnAfterSave();
  const restored = await effective('local-account-3', 1, 1); assert(Object.values(restored.limit_policy.fields).every(x => x.source === 'baseline'));
  checks.push('early-end-parallel-fixed-and-restore-auto');

  await edit(); await policy().locator('summary').filter({ hasText: /^高级：单独调整数值/ }).click();
  await page.getByRole('combobox', { name: '短时发送上限（次/分钟） 覆盖方式', exact: true }).selectOption('fixed');
  await page.locator('#limit-rpm').fill('0'); assert.equal(await page.locator('#limit-rpm').getAttribute('aria-invalid'), 'true');
  assert.equal(await apply().isDisabled(), true); assert.match(await preview().innerText(), /允许范围内的整数/);
  await shot('advanced-invalid'); await close(); checks.push('invalid-advanced-value-blocks-submit');

  } else { await open(); }
  if (process.env.CPAMP_UI_CASE !== 'expiry') {
  await show('local-account-3'); await close(); await page.waitForTimeout(5200);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await show('local-account-3'); await page.locator('.modal-close-floating').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checks.push('escape-refresh-close-no-reopen-after5s-and-normal-x');
  evidence.histories = [];
  for (const id of scenarioIds.slice(1)) {
    await show(id);
    if (id === 'local-account-2') assert.match(await detail().innerText(), /账号已停用/);
    if (id === 'local-queue') { assert.match(await detail().innerText(), /等待队列: 3/); await shot('queued-detail'); }
    if (id === 'local-empty') assert(Number((await page.getByTestId('pacing-balance').innerText()).split('/')[0].trim()) < 4);
    await page.getByText('最近请求（最多5条）', { exact: true }).click();
    const expectedHistory = await page.evaluate(async ({ modulePath, id }) => {
      const loaded = performance.getEntriesByType('resource').map(x => x.name).filter(url => new URL(url).pathname === modulePath);
  const moduleUrl = loaded.find(url => new URL(url).searchParams.has('t')) ?? loaded[0];
  if (!moduleUrl) throw new Error('Application demo module not loaded');
  const m = await import(moduleUrl); const file = m.getPacingFeedbackFiles().files.find(f => f.name === `${id}.json`);
      return m.getPacingFeedbackAnalytics({ filters: { auth_indices: [String(file.auth_index)] } }).events.items.length;
    }, { modulePath, id });
    const historyRows = page.getByRole('dialog').locator('[class*="historyRows"] > [class*="historyRow"]');
    if (expectedHistory) await historyRows.first().waitFor();
    else await page.getByText('暂无请求记录', { exact: true }).waitFor();
    const rowCount = await historyRows.count();
    evidence.histories.push({ id, rowCount }); assert.equal(rowCount, expectedHistory, `${id} history count`);
    if (id === 'local-account-3') assert.match(await page.getByRole('dialog').innerText(), /缓存读: 420452 · 缓存写: 330/);
    if (id === 'local-queue') assert.match(await page.getByRole('dialog').innerText(), /失败 · 429/);
    if (id === 'local-temporary') { await edit(); assert.match(await policy().innerText(), /临时设置正在生效/); const v = await state(id); const remaining = Date.parse(v.limit_policy.temporary_expires_at) - Date.now(); assert(remaining > 8 * 60000 && remaining <= 10 * 60000); await shot('preloaded-temporary-active'); }
    await close();
  }
  const sourceStats = await page.evaluate(async modulePath => {
    const loaded = performance.getEntriesByType('resource').map(x => x.name).filter(url => new URL(url).pathname === modulePath);
  const moduleUrl = loaded.find(url => new URL(url).searchParams.has('t')) ?? loaded[0];
  if (!moduleUrl) throw new Error('Application demo module not loaded');
  const m = await import(moduleUrl); const files = m.getPacingFeedbackFiles().files;
    return files.map(f => ({ id: String(f.auth_index), synthetic: ['local-simulation','local-queue','local-temporary','local-empty'].includes(String(f.auth_index)), count: m.getPacingFeedbackAnalytics({ filters: { auth_indices: [String(f.auth_index)] } }).events.items.length }));
  }, modulePath);
  assert.equal(captured.events.length, 15); assert.equal(sourceStats.filter(x => x.synthetic && x.id !== 'local-simulation').reduce((n, x) => n + x.count, 0), 12);
  assert.equal(sourceStats.filter(x => !x.synthetic).reduce((n, x) => n + x.count, 0), 15); evidence.sourceHistoryCounts = { captured: 15, staticSynthetic: 12, dynamic: sourceStats.find(x => x.id === 'local-simulation')?.count };
  checks.push('seven-pacing-details-history-eight-cards-captured15-plus-static12-and-dynamic');

  for (const theme of ['羊毛纸', '黑夜']) {
    await page.getByRole('button', { name: '主题', exact: true }).click(); await page.getByRole('menuitemradio', { name: theme, exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 }); await show('local-account-3'); await edit();
      await fits(page.getByRole('dialog')); await fits(policy()); await fits(policy().locator('fieldset').first());
      assert.equal(await policy().locator('input[type="number"]:visible').count(), 0);
      await page.getByTestId('limit-preset-agents').check(); await top();
      await inModalViewport(apply()); await inModalViewport(policy().locator('[class*="actionSummary"]'));
      await shot(`${theme}-${width}-guided-top`); await close();
      const card = page.getByTestId('auth-file-card-local-account-3.json');
      const badges = [card.getByText(/^Max\s*5x$/), page.getByTestId('auth-file-warmup-badge-local-account-3.json'), page.getByTestId('auth-file-pacing-local-account-3.json')];
      for (const badge of badges) {
        const size = await badge.evaluate(e => ({ height: e.getBoundingClientRect().height, font: getComputedStyle(e).fontSize }));
        assert.equal(size.height, 17); assert.equal(size.font, '10px');
      }
    }
  }
  checks.push('wool-dark-desktop390-no-overflow-and-17px10px-badges');

  await open('save-error'); await show('local-account-3'); await edit(); await page.getByTestId('limit-preset-agents').check();
  await apply().click(); await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /保存失败/);
  assert.equal(await page.getByTestId('limit-preset-agents').isChecked(), true); assert.match(await preview().innerText(), /会话位置\s*1\s*→\s*2/);
  assert.equal((await state('local-account-3')).limit_policy.fields.max_active_bindings.effective, 1);
  assert.equal(await apply().isDisabled(), false); await shot('save-error-retains-draft'); await close(); checks.push('save-error-retains-draft-and-authoritative-baseline');
  await open('error'); await show('local-simulation'); await page.getByText('刷新失败，保留上次数据', { exact: false }).first().waitFor(); await shot('refresh-error'); await close(); checks.push('refresh-error-retains-panel');

  }
  await page.clock.install(); await open(); await show('local-account-4'); await edit(); await page.getByTestId('limit-preset-agents').check(); await apply().click(); await returnAfterSave();
  // fake browser clock replaces performance; use actual rendered authority, not module-cache inspection.
  await page.getByTestId('pacing-groups').filter({ hasText: '/ 2' }).waitFor();
  await page.clock.fastForward(16 * 60000); await close(); await show('local-account-4');
  await page.getByTestId('pacing-groups').filter({ hasText: '/ 1' }).waitFor();
  assert.match(await page.getByTestId('pacing-inflight').innerText(), /\/ 1/);
  assert.match(await page.getByTestId('pacing-rpm_occupancy').innerText(), /\/ 5/);
  assert.match(await page.getByTestId('pacing-daily').innerText(), /\/ 500/);
  await edit(); assert.equal(await page.getByRole('button', { name: '提前结束临时覆盖', exact: true }).count(), 0);
  await policy().locator('summary').filter({ hasText: /^高级：单独调整数值/ }).click();
  assert.equal(await page.getByRole('combobox', { name: '活跃独立会话组上限（组） 覆盖方式', exact: true }).inputValue(), 'inherit');
  await shot('simulated-clock-expired-restored'); checks.push('browser-clock-expiry-restores-auto');
  assert.equal(createHash('sha256').update(await fs.readFile(capturedFile)).digest('hex'), createHash('sha256').update(capturedRaw).digest('hex'));
  assert.equal(consoleErrors.length, 0); assert.equal(networkFailures.length, 0); assert.equal(apiAttempts.length, 0); checks.push('zero-external-api-requests-console-errors-captured-source-unchanged'); checks.push('escape-close-survives-live-refresh-during-animation');
} catch (error) { failure = error; try { await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {} }
finally {
  await context.tracing.stop({ path: path.join(out, 'trace.zip') }); await browser.close();
  await fs.writeFile(path.join(out, 'console-network.json'), JSON.stringify({ consoleErrors, networkFailures, apiAttempts }, null, 2));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ passed: !failure, scope: process.env.CPAMP_UI_CASE || 'full', checks, evidence, error: failure?.message, stack: failure?.stack }, null, 2));
}
if (failure) throw failure; console.log(JSON.stringify({ passed: true, checks, evidence, out }));
