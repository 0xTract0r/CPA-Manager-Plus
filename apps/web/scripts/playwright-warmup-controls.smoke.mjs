/**
 * 本地真实浏览器 warmup 控制验收。只允许 loopback dev:demo。
 * Vite 浏览器内 API spy 只记录或注入明确标记的故障响应，不改产品/真实后端。
 * npm run dev:demo -- --host 127.0.0.1 --port 4186 --strictPort
 * CPAMP_UI_BASE=http://127.0.0.1:4186 PLAYWRIGHT_MODULE=/path/to/playwright-core OUT_DIR=/path/to/evidence node scripts/playwright-warmup-controls.smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.CPAMP_UI_BASE||'http://127.0.0.1:4186';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Requires loopback demo');
const out=path.resolve(process.env.OUT_DIR||'.tmp-warmup-controls/latest');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const results=[],consoleErrors=[],networkFailures=[],blockedRequests=[],observations={};
const start=Date.now();
const selected=process.env.CPAMP_UI_CASES?.split(',');
async function runCase(name,fn,{width=1440,theme='wool'}={}){
 if(selected&&!selected.includes(name))return;
 assert(Date.now()-start<600000,'Ten minute batch limit exceeded');
 const context=await browser.newContext({viewport:{width,height:1000},locale:'zh-CN'});
 await context.addInitScript(({theme})=>{localStorage.setItem('cli-proxy-theme',JSON.stringify({state:{theme},version:0}));localStorage.setItem('cli-proxy-language',JSON.stringify({state:{language:'zh-CN'},version:0}));},{theme});
 await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 const page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('console',m=>{if(m.type()==='error')consoleErrors.push({case:name,message:m.text()});});
 page.on('pageerror',e=>consoleErrors.push({case:name,message:e.message}));
 page.on('requestfailed',r=>{if(r.failure()?.errorText!=='net::ERR_ABORTED')networkFailures.push({case:name,path:new URL(r.url()).pathname,error:r.failure()?.errorText});});
 page.on('response',r=>{if(r.status()>=400)networkFailures.push({case:name,path:new URL(r.url()).pathname,status:r.status()});});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==new URL(base).origin||/^\/api\//.test(u.pathname)||/\/v[01]\//.test(u.pathname)){blockedRequests.push({case:name,origin:u.origin,path:u.pathname,method:route.request().method()});return route.fulfill({status:200,contentType:'application/json',body:'{}'});}return route.continue();});
 let error;const at=Date.now();
 const shot=async suffix=>page.screenshot({path:path.join(out,`${name}-${suffix}.png`)});
 const dialog=()=>page.locator('[role="dialog"]:not(.modal-closing)');
 const stable=async()=>{await page.waitForFunction(()=>document.querySelectorAll('[role="dialog"]').length===1);};
 const gear=async id=>{await page.getByRole('textbox',{name:'搜索凭证',exact:true}).fill(id);await page.getByTestId(`auth-file-account-settings-${id}.json`).click();await page.getByTestId('account-settings-open-limits').waitFor();await stable();};
 const open=async id=>{await gear(id);await page.getByTestId('account-settings-open-limits').click();await page.getByTestId('account-limits-editor').waitFor();await stable();assert.equal(await page.getByTestId('account-limits-editor').getAttribute('data-account-name'),`${id}.json`);};
 const close=async()=>{await page.locator('.modal-close-floating').click();await page.waitForFunction(()=>document.querySelectorAll('[role="dialog"]').length===0);};
 const data=()=>page.evaluate(async()=>window.__warmupSmoke.api.list());
 const file=async id=>(await data()).files.find(f=>f.auth_index===id);
 const save=async()=>{await page.getByTestId('apply-account-limits').click();await page.getByText('已保存，仅对此账号生效。',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('[data-testid="apply-account-limits"]')?.textContent?.includes('保存中'));assert(await page.getByTestId('apply-account-limits').isDisabled());};
 const fits=async locator=>{const b=await locator.boundingBox();assert(b&&b.x>=-1&&b.x+b.width<=width+1,'Element exceeds viewport');assert(await locator.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Horizontal content overflow');};
 try{
  await page.goto(`${base}/?pacing-feedback=1#/demo/auth-files`,{waitUntil:'domcontentloaded',timeout:45000});
  await page.getByTestId('auth-file-account-settings-local-account-3.json').waitFor({timeout:45000});
  if(await page.locator('html').getAttribute('data-theme')!==theme){await page.getByRole('button',{name:'主题',exact:true}).click();await page.getByRole('menuitemradio',{name:theme==='dark'?'黑夜':'纸色',exact:true}).click();await page.waitForFunction(theme=>document.documentElement.getAttribute('data-theme')===theme,theme);}
  // 浏览器运行态 spy：前端流程仍调用现有 demo 内存 handler，fault 均显式记录。
  await page.evaluate(async()=>{
   const {authFilesApi:api}=await import('/src/services/api/authFiles.ts');
   const p=window.__warmupSmoke={api,writes:[],polls:[],delay:false,pending:false,missing:null,restricted:null,authoritative:null};
   const list=api.list.bind(api),update=api.updateAccountScheduling.bind(api),poll=api.getWarmupPacing.bind(api);
   const transform=f=>{if(f.auth_index===p.missing)delete f.account_scheduling.warmup_control;if(f.auth_index===p.restricted){f.unavailable=true;f.status='unavailable';f.account_scheduling.warmup.mature=false;f.account_scheduling.warmup_control.manual_mature=true;f.account_scheduling.limit_policy.restricted_reasons=['health'];}return f;};
   api.list=async()=>{const r=await list();r.files=r.files.map(transform);return r;};
   api.getWarmupPacing=async(...args)=>{const r=await poll(...args);p.polls.push({at:Date.now(),id:args[1],balance:r.account_scheduling.warmup_traffic_pacing?.request_balance});return transform(r);};
   api.updateAccountScheduling=async request=>{p.writes.push(structuredClone(request));if(p.delay){p.pending=true;await new Promise(resolve=>p.release=resolve);p.pending=false;}const r=await update(request);if(p.authoritative){r.account_scheduling.warmup_control.speed_profile=p.authoritative;r.account_scheduling.warmup_control.source='profile';}return r;};
  });
  assert.equal((await data()).files.length,15,'15 demo accounts');
  await fn({page,dialog,gear,open,close,data,file,save,fits,shot,stable});
 }catch(e){error=e;try{await shot('failure');}catch{}}
 finally{
  let probe;try{probe=await page.evaluate(()=>({writes:window.__warmupSmoke?.writes,polls:window.__warmupSmoke?.polls}));}catch{}
  await context.tracing.stop({path:path.join(out,`${name}-trace.zip`)});await context.close();
  results.push({case:name,passed:!error,elapsed_ms:Date.now()-at,error:error?.message,stack:error?.stack,probe});
  console.log(JSON.stringify({case:name,passed:!error,error:error?.message}));
 }
}
try{
await runCase('profiles',async({page,open,close,file,save,shot})=>{
 const baseline=await file('local-speed-medium');
 for(const [initial,next]of [['low','medium'],['medium','high'],['high','extreme'],['extreme','low']]){
  const id='local-speed-'+initial;await open(id);assert(await page.getByTestId('speed-profile-'+initial).isChecked());
  for(const speed of ['low','medium','high','extreme'])assert(await page.getByTestId('speed-profile-'+speed).isEnabled());
  assert.equal(await page.getByTestId('warmup-period-days').count(),0);
  for(const id of ['rate-explanation-disclosure','limit-scenario-disclosure','legacy-scheduling-advanced'])if(await page.getByTestId(id).count())assert.equal(await page.getByTestId(id).evaluate(e=>e.open),false);
  await page.getByTestId('speed-profile-'+next).check();await save();assert.equal((await file(id)).account_scheduling.warmup_control.speed_profile,next);await shot(initial+'-saved');await close();
  await open(id);assert(await page.getByTestId('speed-profile-'+next).isChecked(),'Reopening must preserve saved profile');await close();
  if(initial==='low')assert.deepEqual((await file('local-speed-medium')).account_scheduling.warmup_control,baseline.account_scheduling.warmup_control,'Only current account changes');
 }
 const writes=await page.evaluate(()=>window.__warmupSmoke.writes);assert.equal(writes.length,4);for(const w of writes){assert.equal(w.name,w.auth_index+'.json');assert(!('first_production_at'in w));assert(!('rate_scale'in w));assert(!('limit_overrides'in w));}
});
await runCase('period-history',async({page,open,close,file,save,shot})=>{
 const id='local-no-anchor',before=(await file(id)).account_scheduling.first_production_at;await open(id);
 assert.match(await page.getByTestId('account-scheduling-summary').innerText(),/首次投产|首次投放/);
 assert.equal(await page.getByTestId('warmup-period-days').count(),0);await page.getByTestId('warmup-mode-days').check();const days=page.getByTestId('warmup-period-days');assert.equal(await days.getAttribute('min'),'1');assert.equal(await days.getAttribute('max'),'365');
 for(const invalid of ['0','366']){await days.fill(invalid);assert(await page.getByTestId('apply-account-limits').isDisabled());assert.equal(await days.getAttribute('aria-invalid'),'true');}
 await days.fill('30');assert(await page.getByTestId('apply-account-limits').isEnabled());await save();const after=await file(id);assert.equal(after.account_scheduling.warmup_control.warmup_period_days,30);assert.equal(after.account_scheduling.first_production_at,before);await shot('30-days-no-anchor');await close();await open(id);assert.equal(await days.inputValue(),'30');await close();
 const writes=await page.evaluate(()=>window.__warmupSmoke.writes);assert.equal(writes.length,1);assert.equal(writes[0].warmup_period_days,30);assert(!('first_production_at'in writes[0]));
});
await runCase('mature-auto',async({page,open,close,file,save,shot})=>{
 const id='local-custom-period',before=await file(id);await open(id);assert.equal(await page.getByTestId('warmup-period-days').inputValue(),'30');await page.getByTestId('warmup-mode-mature').check();assert.equal(await page.getByTestId('warmup-period-days').count(),0);await save();
 let after=await file(id);assert.equal(after.account_scheduling.warmup_control.warmup_mode,'mature');assert.equal(after.account_scheduling.warmup_control.warmup_period_days,30);assert.equal(after.account_scheduling.warmup.mature,true);
 await page.getByTestId('account-pacing-recovery').getByText('已按成熟策略运行',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('[data-testid="account-pacing-recovery"] [role="progressbar"]'));assert.equal(await page.getByTestId('account-pacing-recovery').getByRole('progressbar').count(),0);await shot('mature-no-bar');
 await page.getByTestId('warmup-mode-auto').check();await save();after=await file(id);assert.equal(after.account_scheduling.warmup_control.warmup_mode,'auto');assert.equal(after.account_scheduling.warmup_control.manual_mature,false);assert.equal(after.account_scheduling.warmup_control.warmup_period_days,30);assert.equal(after.account_scheduling.first_production_at,before.account_scheduling.first_production_at);assert.equal(after.account_scheduling.warmup.mature,false);assert(await page.getByTestId('warmup-mode-days').isChecked());await shot('auto-period-retained');await close();await open(id);assert(await page.getByTestId('warmup-mode-days').isChecked());assert.equal(await page.getByTestId('warmup-period-days').inputValue(),'30');
});
await runCase('dirty-poll-save-lock',async({page,open,dialog,save,shot})=>{
 await open('local-empty');const recovery=page.getByTestId('account-pacing-recovery');await recovery.getByRole('progressbar').waitFor();assert.match(await recovery.innerText(),/新会话.*门槛 4/);const before=await recovery.getByRole('progressbar').getAttribute('aria-valuenow');
 await page.getByTestId('speed-profile-high').check();await page.getByTestId('warmup-mode-days').check();await page.getByTestId('warmup-period-days').fill('31');
 await page.evaluate(()=>window.__warmupSmoke.pollWaitStarted=Date.now());await page.waitForFunction(()=>window.__warmupSmoke.polls.some(p=>p.at>=window.__warmupSmoke.pollWaitStarted+3000),{},{timeout:12000});assert(await page.getByTestId('speed-profile-high').isChecked());assert.equal(await page.getByTestId('warmup-period-days').inputValue(),'31');const after=await recovery.getByRole('progressbar').getAttribute('aria-valuenow');assert(Number(after)>Number(before),'Live balance progresses while dirty draft stays');
 await page.getByRole('button',{name:'返回账号设置',exact:true}).click();await page.getByText('放弃未保存的调整？',{exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[role="dialog"]').length===1);assert(await page.getByTestId('speed-profile-high').isChecked());
 await page.evaluate(()=>window.__warmupSmoke.delay=true);await page.getByTestId('apply-account-limits').click();await page.waitForFunction(()=>window.__warmupSmoke.pending);
 for(const id of ['speed-profile-low','speed-profile-medium','speed-profile-high','speed-profile-extreme','warmup-mode-auto','warmup-mode-days','warmup-mode-mature','warmup-period-days'])assert(await page.getByTestId(id).isDisabled(),id+' must lock during save');
 await page.waitForFunction(()=>document.querySelector('[data-testid="account-limits-editor"] > button')?.disabled===true);assert(await page.getByRole('button',{name:'返回账号设置',exact:true}).isDisabled());assert(await page.locator('.modal-close-floating').isDisabled());await page.keyboard.press('Escape');assert.equal(await dialog().count(),1);await shot('locked');await page.evaluate(()=>window.__warmupSmoke.release());await page.getByText('已保存，仅对此账号生效。',{exact:true}).waitFor();assert(await page.getByTestId('speed-profile-high').isChecked());
});
await runCase('authoritative-response',async({page,open,shot})=>{
 await open('local-speed-medium');await page.evaluate(()=>window.__warmupSmoke.authoritative='low');await page.getByTestId('speed-profile-extreme').check();await page.getByTestId('apply-account-limits').click();await page.getByText('已保存，仅对此账号生效。',{exact:true}).waitFor();assert(await page.getByTestId('speed-profile-low').isChecked(),'UI must render normalized authoritative response, not submitted extreme');assert(await page.getByTestId('apply-account-limits').isDisabled());await shot('server-normalized-to-low');
});
await runCase('missing-projection',async({page,open,shot})=>{
 await page.evaluate(()=>window.__warmupSmoke.missing='local-speed-low');await page.getByRole('button',{name:'刷新',exact:true}).click();await open('local-speed-low');for(const id of ['low','medium','high','extreme']){assert(await page.getByTestId('speed-profile-'+id).isDisabled());assert(!await page.getByTestId('speed-profile-'+id).isChecked());}for(const mode of ['auto','days','mature'])assert(await page.getByTestId('warmup-mode-'+mode).isDisabled());assert(await page.getByTestId('apply-account-limits').isDisabled());assert.match(await page.getByTestId('speed-profile-picker').innerText(),/尚未提供.*升级服务端/);await shot('disabled-no-guess');
});
await runCase('restricted-mature',async({page,open,shot})=>{
 await page.evaluate(()=>window.__warmupSmoke.restricted='local-manual-mature');await page.getByRole('button',{name:'刷新',exact:true}).click();await open('local-manual-mature');assert.match(await page.getByTestId('account-scheduling-summary').innerText(),/已手动标成熟.*健康限制/);await page.waitForFunction(()=>window.__warmupSmoke.polls.length>0);const r=page.getByTestId('account-pacing-recovery');assert.equal(await r.getByRole('progressbar').count(),0);assert.doesNotMatch(await r.innerText(),/已按成熟策略运行|余额已.*确认|可以发送/);await shot('restricted-no-false-ready');
});
for(const theme of ['wool','dark'])for(const width of [1440,390])await runCase(`layout-${theme}-${width}`,async({page,gear,open,close,dialog,fits,shot})=>{
 await gear('local-speed-low');const summary=page.getByTestId('account-scheduling-summary');assert((await summary.boundingBox()).height<=(width===1440?80:110),'Gear summary expands');assert.equal(await page.getByTestId('speed-profile-picker').count(),0);assert.equal(await page.getByTestId('account-limit-policy').count(),0);await fits(dialog());await fits(summary);await shot('gear');await close();await open('local-speed-low');assert.equal(await page.locator('html').getAttribute('data-theme'),theme);for(const id of ['speed-profile-picker','warmup-mode-picker','account-pacing-recovery'])await fits(page.getByTestId(id));await fits(dialog());await fits(page.getByTestId('account-limits-editor'));const oldVisible=await page.getByTestId('account-limits-editor').locator('input[type="number"]:visible').count();assert.equal(oldVisible,0,'Legacy number inputs hidden by default');await page.getByTestId('account-pacing-recovery').getByRole('progressbar').waitFor();assert.match(await page.getByTestId('account-pacing-recovery').innerText(),/新会话门槛 4/);await shot('default');await page.getByTestId('warmup-mode-days').check();await fits(dialog());await fits(page.getByTestId('warmup-mode-picker'));await shot('days');
},{width,theme});
await runCase('source-labels',async({page,shot})=>{
 const text=await page.locator('body').innerText();assert.match(text,/脱敏/);assert.match(text,/速度.*养号.*合成|合成.*速度.*养号|11.*合成/,'New synthetic speed/warmup scenarios must be labelled');await shot('local-source');
});
}finally{
 await browser.close();
 const failed=results.filter(r=>!r.passed);const passed=!failed.length&&!consoleErrors.length&&!networkFailures.length&&!blockedRequests.length;
 const report={schema_version:1,agent:'ui-test-runner',target:base,passed,results,consoleErrors,networkFailures,blockedRequests,observations,elapsed_ms:Date.now()-start,browser_closed:true,preview_4186_preserved:true,coverage_gaps:['Chromium only','Demo API models core projection; no real backend/production requests','Fault injection requires Vite dev:demo source module endpoint','No claim of deploy/runtime readiness']};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'console-network.json'),JSON.stringify({consoleErrors,networkFailures,blockedRequests},null,2));console.log(JSON.stringify({passed,out,failed:failed.map(r=>r.case),consoleErrors:consoleErrors.length,networkFailures:networkFailures.length,blockedRequests:blockedRequests.length}));if(!passed)process.exitCode=1;
}
