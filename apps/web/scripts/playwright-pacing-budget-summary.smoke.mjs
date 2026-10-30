/** 本地预算摘要定点 gate；仅 DOM + 既有只读 mock，不导入 Vite 内部模块。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CPAMP_UI_BASE || 'http://127.0.0.1:4186';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const out = path.resolve(process.env.OUT_DIR || '.tmp-pacing-budget-summary'); await fs.mkdir(out,{recursive:true});
const fixture = JSON.parse(await fs.readFile(new URL('../src/features/demo/pacingBudgetPolicySnapshot.json',import.meta.url),'utf8'));
const total = Math.max(...fixture.warmup_curve.map(s => s['max-age-days']));
const browser = await chromium.launch(); const context = await browser.newContext({viewport:{width:1440,height:1200},locale:'zh-CN'});
await context.addInitScript(()=>localStorage.setItem('cli-proxy-theme',JSON.stringify({state:{theme:'wool'},version:0})));
await context.tracing.start({screenshots:true,snapshots:true,sources:true});
const page = await context.newPage(); page.setDefaultTimeout(12000);
const checks=[],consoleErrors=[],networkFailures=[],apiAttempts=[],observations={curveTotal:total,curveSource:'read-only pacingBudgetPolicySnapshot.json; AccountWarmupSummary reads config store.raw/account-scheduling'};let failure;
page.on('pageerror',e=>consoleErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
page.on('requestfailed',r=>{if(r.failure()?.errorText!=='net::ERR_ABORTED')networkFailures.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText});});
await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==new URL(base).origin||/\/v[01]\//.test(u.pathname)||/^\/api\//.test(u.pathname)){apiAttempts.push({origin:u.origin,path:u.pathname});return route.fulfill({status:200,contentType:'application/json',body:'{}'});}return route.continue();});
const dialog=()=>page.getByRole('dialog');const panel=()=>page.getByTestId('account-limit-policy');const summary=()=>page.getByTestId('warmup-policy-summary');
const legacy=()=>page.getByTestId('legacy-scheduling-advanced');const footer=()=>panel().locator('[class*="policyActions"]');
const show=async id=>{await page.getByTestId(`auth-file-pacing-${id}.json`).click();await page.getByTestId('warmup-pacing-detail').waitFor();await page.getByRole('button',{name:'调度与上限',exact:true}).click();await summary().waitFor();await summary().locator(':scope > summary').click();await page.waitForTimeout(400);};
const close=async()=>{await page.locator('.modal-close-floating').click();await dialog().waitFor({state:'hidden'});};
const shot=async name=>{await page.waitForTimeout(200);await page.screenshot({path:path.join(out,`${name}.png`)});};
const top=()=>page.locator('.modal-body').evaluate(e=>{e.scrollTop=0;});
const assertFits=async locator=>{const b=await locator.boundingBox();assert(b&&b.x>=-1&&b.x+b.width<=page.viewportSize().width+1,'outside viewport');assert(await locator.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'horizontal overflow');};
const opacityAndContrast=async()=>{
  const values=await dialog().evaluate(e=>{
    const style=getComputedStyle(e),bar=e.querySelector('[class*="policyActions"]'),text=e.querySelector('[data-testid="warmup-policy-summary"] strong');
    const cv=document.createElement('canvas').getContext('2d');const normalized=x=>{cv.fillStyle=x;return cv.fillStyle;};
    const color=c=>{const n=c.match(/[\d.]+/g).map(Number);return {rgb:n.slice(0,3),alpha:n.length>3?n[3]:1};};
    const luminance=rgb=>rgb.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);
    const bg=color(style.backgroundColor),fg=color(getComputedStyle(text).color),a=luminance(bg.rgb),b=luminance(fg.rgb);
    return {modalBackground:style.backgroundColor,footerBackground:getComputedStyle(bar).backgroundColor,alpha:bg.alpha,footerAlpha:color(getComputedStyle(bar).backgroundColor).alpha,themeSurface:normalized(style.getPropertyValue('--app-surface-strong').trim()),modalNormalized:normalized(style.backgroundColor),footerNormalized:normalized(getComputedStyle(bar).backgroundColor),textContrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  });
  assert.equal(values.alpha,1);assert.equal(values.footerAlpha,1);assert.equal(values.modalNormalized,values.themeSurface);assert.equal(values.footerNormalized,values.themeSurface);assert(values.textContrast>=4.5,'primary text contrast');return values;
};
const advanced=async label=>{
  const numeric=panel().locator('details').filter({has:page.getByText('高级：单独调整数值',{exact:true})});
  await numeric.locator('summary').click();await legacy().locator('summary').click();
  const order=await panel().evaluate(e=>{const actions=e.querySelector('[class*="policyActions"]');return [...e.querySelectorAll('details')].filter(d=>d.querySelector('summary')?.textContent?.startsWith('高级')).map(d=>Boolean(d.compareDocumentPosition(actions)&Node.DOCUMENT_POSITION_FOLLOWING));});
  assert.equal(order.length,2);assert(order.every(Boolean));
  assert.equal(await legacy().locator('summary').evaluate(e=>getComputedStyle(e).fontSize),'12px');
  const hints=await legacy().locator('.hint').evaluateAll(es=>es.map(e=>({font:getComputedStyle(e).fontSize,text:e.textContent.slice(0,35)})));
  assert(hints.length>=3,'missing field hints');assert(hints.every(x=>x.font==='12px'),'legacy field hint font');
  await assertFits(dialog());await assertFits(panel());await assertFits(legacy());
  const grids=await legacy().locator('[class*="controlsGrid"]').evaluateAll(es=>es.map(e=>({columns:getComputedStyle(e).gridTemplateColumns,width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})));
  if(page.viewportSize().width===390){assert(grids.length>0);assert(grids.every(g=>g.columns.trim().split(/\s+/).length===1),'narrow container must have one column');}
  observations[label]={hints,grids,order};
  await page.locator('.modal-body').evaluate(e=>{const target=e.querySelector('[data-testid="legacy-scheduling-advanced"]');e.scrollTop+=target.getBoundingClientRect().top-e.getBoundingClientRect().top-12;});
  await shot(label);
};
try{
  await page.goto(`${base}/?pacing-feedback=1#/demo/auth-files`,{waitUntil:'domcontentloaded',timeout:45000});await page.getByTestId('auth-file-pacing-local-account-3.json').waitFor({timeout:45000});
  for(const [id,alias] of [['local-account-3','AC-13'],['local-account-4','AC-16']]){
    await show(id);const account=fixture.accounts.find(x=>x.alias===alias);
    await summary().getByRole('progressbar').filter({hasNotText:'unmatchable'}).waitFor();
    await page.waitForFunction(({age,total})=>{const b=document.querySelector('[data-testid="warmup-policy-summary"] [role="progressbar"]');return b?.getAttribute('aria-valuenow')===String(age)&&b?.getAttribute('aria-valuemax')===String(total);},{age:account.age_days,total});
    assert.match(await summary().innerText(),new RegExp(`${account.age_days} / ${total} 天`));
    assert.match(await page.getByTestId('warmup-token-budget').innerText(),/未启用本地上限/);assert.equal(await page.getByTestId('warmup-token-budget').getAttribute('data-enabled'),'false');
    assert.match(await page.getByTestId('warmup-request-budget').innerText(),/^500/);
    assert.match(await summary().innerText(),/不代表 Claude 订阅额度无限/);assert.match(await page.getByTestId('subscription-percent-gap').innerText(),/每日订阅百分比硬保护：尚未实现/);
    await summary().getByText('查看各阶段与订阅窗口',{exact:true}).click();assert.equal(await summary().locator('ol > li').count(),fixture.warmup_curve.length);
    await summary().getByText('查看各阶段与订阅窗口',{exact:true}).click();
    if(alias==='AC-13'){
      observations.wool=await opacityAndContrast();await top();await shot('wool-desktop-budget-overview');
      await advanced('wool-desktop-legacy-expanded');
      await page.getByTestId('limit-scenario-disclosure').locator(':scope > summary').click();await page.getByTestId('limit-preset-agents').check();await page.getByTestId('apply-account-limits').click();await page.getByRole('status').filter({hasText:'已保存，仅对此账号生效。'}).waitFor();await page.getByRole('button',{name:'返回配速详情',exact:true}).click();
      await page.getByTestId('pacing-groups').filter({hasText:'/ 2'}).waitFor();assert.match(await page.getByTestId('pacing-inflight').innerText(),/\/ 1/);assert.match(await page.getByTestId('pacing-rpm_occupancy').innerText(),/\/ 5/);assert.match(await page.getByTestId('pacing-daily').innerText(),/\/ 500/);
    }
    await close();
  }
  await page.waitForTimeout(5200);assert.equal(await dialog().count(),0);checks.push('configured-age8and11-total60-stage5-tokenoff-request500-honest-gap');checks.push('advanced-before-main-save-and-agent-apply-close-stable');
  await show('local-temporary');assert.match(await page.getByTestId('warmup-token-budget').innerText(),/200,?000/);assert.equal(await page.getByTestId('warmup-token-budget').getAttribute('data-enabled'),'true');
  await summary().getByText('查看各阶段与订阅窗口',{exact:true}).click();assert.match(await summary().innerText(),/5小时窗口已用：38%/);assert.match(await summary().innerText(),/7天窗口已用：52%/);await top();await shot('token-budget-and-subscription-windows');await close();
  await show('local-empty');await summary().getByText('查看各阶段与订阅窗口',{exact:true}).click();assert.match(await summary().innerText(),/5小时窗口已用：未知/);assert.match(await summary().innerText(),/7天窗口已用：未知/);await close();checks.push('positive-token200k-windows38and52-empty-unknown');
  await page.setViewportSize({width:390,height:1100});await show('local-account-3');await advanced('wool-390-legacy-expanded');observations.woolMobile=await opacityAndContrast();await close();checks.push('legacy-summary-and-field-hint12px-narrow-single-column-no-overflow');
  await page.setViewportSize({width:1440,height:1200});await page.getByRole('button',{name:'主题',exact:true}).click();await page.getByRole('menuitemradio',{name:'黑夜',exact:true}).click();await show('local-account-3');observations.dark=await opacityAndContrast();await top();await shot('dark-budget-overview');await close();checks.push('wool-dark-modal-footer-opaque-theme-surface-primary-contrast');
  assert.equal(apiAttempts.length,0);assert.equal(consoleErrors.length,0);assert.equal(networkFailures.length,0);checks.push('zero-production-api-console-network');
}catch(error){failure=error;try{await page.screenshot({path:path.join(out,'failure.png')});}catch{}}
finally{await context.tracing.stop({path:path.join(out,'trace.zip')});await browser.close();await fs.writeFile(path.join(out,'console-network.json'),JSON.stringify({consoleErrors,networkFailures,apiAttempts},null,2));await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:!failure,checks,observations,error:failure?.message,stack:failure?.stack,browser_closed:true,preview_preserved:true},null,2));}
if(failure)throw failure;console.log(JSON.stringify({passed:true,checks,out}));
