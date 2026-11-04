// Exercise the real ancillary dashboard and committed archive, with delayed or
// unavailable optional HTTP responses supplied only at the network boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
});
const url = process.env.NWW_CITY_TEST_URL || new URL('city-gauge/',new URL('.',process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html')).href;
const checks = [], errors = [];
const primaryIndex=JSON.parse(fs.readFileSync(new URL('../city-gauge/data/index.json',import.meta.url),'utf8'));
const latestArchiveYear=Number(primaryIndex.coverage.lastTimestamp.slice(0,4));
assert.ok(Number.isInteger(latestArchiveYear),'Archive fixture must identify its latest year');
// Keep the explicit 2025/2026 partial-outage case, while also intercepting the
// default newest shard after routine archive updates advance to another year.
const outagePattern=new RegExp(`/comparison/(?:2026|${latestArchiveYear})\\.json(?:\\?.*)?$`);
async function requestGate(promise,label,timeout=30000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${label}`)),timeout);})]);}
  finally{clearTimeout(timer);}
}
const output = process.env.NWW_AUDIT_OUTPUT;
if(output)fs.mkdirSync(output,{recursive:true});
async function pageFor(){const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));return page;}
async function ready(page){await page.waitForFunction(()=>state.loadedRange&&state.points.length>0&&!document.getElementById('load').disabled,{}, {timeout:60000});}
async function snapshot(page,label){if(output)await page.screenshot({path:path.join(output,`${name}-city-${label}.png`)});}
try {
  const primaryPending=await pageFor();let releasePrimaryIndex;
  const primaryGate=new Promise(resolve=>releasePrimaryIndex=resolve);let primaryIndexSeen;
  const primarySeen=new Promise(resolve=>primaryIndexSeen=resolve);const pendingErrors=[];
  primaryPending.on('pageerror',error=>pendingErrors.push(error.message));
  await primaryPending.route('**/data/index.json',async route=>{primaryIndexSeen();await primaryGate;await route.continue();});
  try{
    await primaryPending.goto(url,{waitUntil:'domcontentloaded'});await requestGate(primarySeen,'primary archive index');
    await primaryPending.evaluate(()=>{
      window.pendingCityInputs=[];
      for(const type of ['click','change'])document.addEventListener(type,event=>pendingCityInputs.push({
        type,id:event.target.id,range:event.target.dataset.range,isTrusted:event.isTrusted}),true);
    });
    assert.equal(await primaryPending.locator('[data-range="3"]').isEnabled(),true,'Pending data preserves the existing control appearance');
    await primaryPending.locator('[data-range="3"]').click();
    await primaryPending.locator('[data-range="7"]').focus();await primaryPending.keyboard.press('Enter');
    await primaryPending.locator('#month-jump').fill('2026-10');
    await primaryPending.locator('#month-jump').focus();await primaryPending.keyboard.press('ArrowUp');await primaryPending.keyboard.press('Tab');
    await primaryPending.locator('#start').fill('2026-01-01');await primaryPending.locator('#end').fill('2026-01-02');
    await primaryPending.locator('#load').click();
    assert.equal(await primaryPending.evaluate(()=>state.index),null,'The real primary index remains held during early input');
    assert.equal(await primaryPending.evaluate(()=>state.loadSequence),0,'Pre-index interactions cannot start incomplete range loads');
    // There are no year choices before the index arrives; cover this direct
    // entry point separately without manufacturing an enabled year option.
    await primaryPending.evaluate(()=>openYear(2025));
    releasePrimaryIndex();await ready(primaryPending);
    await primaryPending.locator('[data-range="3"]').click();
    await primaryPending.waitForFunction(()=>state.loadedRange?.start===shiftDate(document.getElementById('end').value,-2)&&!document.getElementById('load').disabled);
    const inputs=await primaryPending.evaluate(()=>pendingCityInputs);
    assert.ok(inputs.some(event=>event.range==='3'&&event.isTrusted),'Exercise a trusted early range click');
    assert.ok(inputs.some(event=>event.range==='7'&&event.isTrusted),'Exercise native keyboard button activation while pending');
    assert.deepEqual(pendingErrors,[],'Early inputs must not dereference a pending primary index');
    checks.push('pending primary index accepts early native input safely; controls work after the real response');
    await snapshot(primaryPending,'primary-index-pending');
  }finally{releasePrimaryIndex();await primaryPending.close();}
  const dst=await pageFor();await dst.goto(url);await ready(dst);
  await dst.locator('#start').fill('2025-11-02');await dst.locator('#end').fill('2025-11-02');await dst.locator('#load').click();
  await dst.waitForFunction(()=>state.loadedRange?.start==='2025-11-02'&&!document.getElementById('load').disabled);
  assert.ok(await dst.evaluate(()=>state.points.some(point=>point.ambiguous)),'fixture retains ambiguous DST source records');
  await dst.locator('#reset-zoom').click();await dst.locator('#zoom-in').click();await dst.locator('#zoom-out').click();await dst.locator('#reset-zoom').click();
  assert.ok(await dst.evaluate(()=>Number.isFinite(state.viewStart)&&Number.isFinite(state.viewEnd)&&!!state.plotArea),'DST reset and zoom preserve finite plot bounds');
  checks.push('DST reset and zoom preserve plot; ambiguous rows retained');
  await dst.locator('#start').fill('2024-01-01');await dst.locator('#end').fill('2024-01-01');
  const download=dst.waitForEvent('download');await dst.locator('#csv').click();
  assert.ok((await download).suggestedFilename().includes('2025-11-02_2025-11-02'),'CSV labels use loaded range even when input edits are not loaded');
  checks.push('CSV filename matches displayed data');await snapshot(dst,'dst');await dst.close();

  const outage=await pageFor();let releaseComparison;const heldComparison=new Promise(resolve=>releaseComparison=resolve);let comparisonSeen;const seenComparison=new Promise(resolve=>comparisonSeen=resolve);
  await outage.route(outagePattern,async route=>{comparisonSeen();await heldComparison;await route.fulfill({status:503,body:'Unavailable'});});
  await outage.goto(url);await ready(outage);await requestGate(seenComparison,'default comparison shard request');
  assert.ok(await outage.evaluate(()=>state.chartPoints.length>0&&!!state.plotArea),'municipal plot renders while optional comparison is still pending');
  releaseComparison();await outage.waitForFunction(()=>document.getElementById('comparison-window-status').textContent.includes('unavailable'));
  assert.ok(await outage.evaluate(()=>state.points.length>0&&document.getElementById('error').hidden&&state.comparisonPoints.length===0));
  checks.push('optional comparison delay and HTTP503 preserve municipal plot');
  await outage.locator('#start').fill('2025-12-31');await outage.locator('#end').fill('2026-01-01');await outage.locator('#load').click();
  await outage.waitForFunction(()=>state.loadedRange?.start==='2025-12-31'&&state.comparisonPoints.length>0&&document.getElementById('comparison-window-status').textContent.includes('unavailable'));
  assert.ok(await outage.evaluate(()=>state.comparisonPoints.every(point=>new Date(point.time).getUTCFullYear()===2025||new Date(point.time).toISOString().startsWith('2026-01-01T0'))),'available comparison shard remains usable');
  checks.push('partial comparison outage preserves available comparison years');await snapshot(outage,'outage');await outage.close();

  const race=await pageFor();await race.goto(url);await ready(race);
  let releaseOld;const held=new Promise(resolve=>releaseOld=resolve);let requested;const seen=new Promise(resolve=>requested=resolve);
  await race.route('**/data/2024.json',async route=>{requested();await held;await route.continue();});
  await race.evaluate(()=>{document.getElementById('start').value='2024-01-01';document.getElementById('end').value='2024-01-01';window.oldCityLoad=loadRange();});await requestGate(seen,'delayed 2024 archive request');
  await race.locator('#year-jump').selectOption('2025');
  await race.waitForFunction(()=>state.loadedRange?.start==='2025-01-01'&&!document.getElementById('load').disabled);
  releaseOld();await requestGate(race.evaluate(()=>window.oldCityLoad),'original range response');
  assert.ok(await race.evaluate(()=>state.loadedRange.start==='2025-01-01'&&state.loadedRange.end==='2025-12-31'&&state.points.every(point=>point.timestamp.startsWith('2025'))&&document.getElementById('range').textContent.includes('2025')),'older response cannot replace newer selection');
  checks.push('delayed range cannot overwrite later year selection');await snapshot(race,'race');await race.close();
  const indexPending=await pageFor();let releaseIndex;const heldIndex=new Promise(resolve=>releaseIndex=resolve);let indexRequested;const seenIndex=new Promise(resolve=>indexRequested=resolve);
  await indexPending.route('**/comparison/index.json',async route=>{indexRequested();await heldIndex;await route.continue();});
  try{
    await indexPending.goto(url);await ready(indexPending);await requestGate(seenIndex,'comparison index request');
    assert.ok(await indexPending.evaluate(()=>!state.comparisonIndex&&state.chartPoints.length>0&&!!state.plotArea),'primary plot renders while optional index headers remain pending');
    await indexPending.locator('#year-jump').selectOption('2025');
    await indexPending.waitForFunction(()=>state.loadedRange?.start==='2025-01-01'&&!document.getElementById('load').disabled);
    releaseIndex();await indexPending.waitForFunction(()=>state.comparisonIndex&&state.comparisonPoints.length>0);
    assert.ok(await indexPending.evaluate(()=>state.loadedRange.start==='2025-01-01'&&state.points.every(point=>point.timestamp.startsWith('2025'))&&state.comparisonPoints.every(point=>point.time>=epoch('2025-01-01 00:00:00')&&point.time<=epoch('2025-12-31 23:59:59'))),'late optional index fills the latest selected primary range');
    checks.push('pending comparison index permits startup and late results use current range');await snapshot(indexPending,'index-pending');
  }finally{releaseIndex();await indexPending.close();}

  // A real chunked HTTP response delivers headers and a partial JSON body,
  // exercising the deadline through response.json(), rather than only fetch().
  const indexBody=fs.readFileSync(new URL('../city-gauge/comparison/index.json',import.meta.url));let releaseBody;const heldBody=new Promise(resolve=>releaseBody=resolve);let bodyRequested;const seenBody=new Promise(resolve=>bodyRequested=resolve);let firstBody=true;
  const server=http.createServer(async(request,response)=>{
    response.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    if(firstBody){firstBody=false;response.flushHeaders();response.write(indexBody.subarray(0,20));bodyRequested();await heldBody;if(!response.destroyed)response.end(indexBody.subarray(20));}
    else response.end(indexBody);
  });
  await requestGate(new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}), 'chunked response server startup');
  const bodyPending=await pageFor();
  try{
    await bodyPending.route('**/comparison/index.json',route=>route.continue({url:`http://127.0.0.1:${server.address().port}/comparison/index.json`}));
    await bodyPending.clock.install();await bodyPending.goto(url);await ready(bodyPending);await requestGate(seenBody,'partial comparison index body');
    assert.ok(await bodyPending.evaluate(()=>!state.comparisonIndex&&!!state.plotArea),'primary plot renders while optional index body remains pending');
    await bodyPending.clock.fastForward(10001);await bodyPending.locator('#comparison-retry').waitFor({state:'visible'});
    assert.ok(await bodyPending.evaluate(()=>!state.comparisonIndexPromise&&state.chartPoints.length>0&&document.getElementById('error').hidden),'body deadline leaves primary usable and clears the in-flight request for retry');
    releaseBody();await bodyPending.locator('#comparison-retry').click();await bodyPending.waitForFunction(()=>state.comparisonIndex&&state.comparisonPoints.length>0);
    checks.push('comparison index body deadline preserves primary and supports successful retry');await snapshot(bodyPending,'index-body-retry');
  }finally{releaseBody();await bodyPending.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const firstDate=primaryIndex.coverage.firstTimestamp.slice(0,10),firstYear=Number(firstDate.slice(0,4));
  const boundsPage=await pageFor();await boundsPage.goto(url);await ready(boundsPage);
  await boundsPage.locator('#year-jump').selectOption(String(firstYear));
  await boundsPage.waitForFunction(year=>state.loadedRange?.start.startsWith(String(year))&&!document.getElementById('load').disabled,firstYear);
  await boundsPage.locator('#start').fill(firstDate);await boundsPage.locator('#end').fill(firstDate);await boundsPage.locator('#load').click();
  await boundsPage.waitForFunction(day=>state.loadedRange?.start===day&&state.loadedRange?.end===day&&!document.getElementById('load').disabled,firstDate);
  const beforeFirst=await boundsPage.evaluate(()=>state.points.length),archiveRequests=[];
  boundsPage.on('request',request=>{if(/\/data\/\d{4}\.json/.test(request.url()))archiveRequests.push(request.url());});
  await boundsPage.locator('[data-range="365"]').click();
  await boundsPage.waitForFunction(day=>document.getElementById('start').value===day&&!document.getElementById('load').disabled,firstDate);
  assert.ok(beforeFirst>0,'The actual earliest archive day contains municipal readings');
  assert.ok(await boundsPage.evaluate(day=>state.loadedRange.start===day&&state.loadedRange.end===day&&state.points.length>0&&document.getElementById('error').hidden,firstDate),'Quick ranges clamp to the real archive coverage');
  assert.ok(archiveRequests.every(request=>Number(request.match(/\/(\d{4})\.json/)[1])>=firstYear),'Quick range cannot request a nonexistent earlier archive year');
  for(const width of [320,360,390,1440]){
    await boundsPage.setViewportSize({width,height:844});await boundsPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await boundsPage.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,canvases:[...document.querySelectorAll('canvas')].map(canvas=>({width:canvas.getBoundingClientRect().width,parent:canvas.parentElement.getBoundingClientRect().width,right:canvas.getBoundingClientRect().right}))}));
    assert.ok(geometry.scrollWidth<=geometry.viewport+1,`${width}px city dashboard has no page overflow`);
    assert.ok(geometry.canvases.every(canvas=>canvas.width<=canvas.parent+1&&canvas.right<=geometry.viewport+1),`${width}px plots fit their actual parent`);
  }
  checks.push('earliest-day1-year shortcut stays inside archive; phone320/360/390 and desktop plots fit');await snapshot(boundsPage,'coverage-widths');await boundsPage.close();

  const indexHeaders=await pageFor();let releaseFirstIndex,releaseRetryIndex,indexHeaderSeen,retryHeaderSeen,indexRequests=0;
  const firstIndexGate=new Promise(resolve=>releaseFirstIndex=resolve),retryIndexGate=new Promise(resolve=>releaseRetryIndex=resolve),firstIndexSeen=new Promise(resolve=>indexHeaderSeen=resolve),retryIndexSeen=new Promise(resolve=>retryHeaderSeen=resolve);
  await indexHeaders.route('**/data/index.json',async route=>{indexRequests++;if(indexRequests===1){indexHeaderSeen();await firstIndexGate;}else if(indexRequests===2){retryHeaderSeen();await retryIndexGate;}await route.continue().catch(()=>{});});
  try{
    await indexHeaders.clock.install();await indexHeaders.goto(url,{waitUntil:'domcontentloaded'});await requestGate(firstIndexSeen,'held primary index headers');
    await indexHeaders.clock.fastForward(10001);await indexHeaders.waitForFunction(()=>document.getElementById('loading').hidden&&document.getElementById('error').textContent.includes('too long'),{},{timeout:5000});
    assert.ok(await indexHeaders.evaluate(()=>!state.index&&!state.indexPromise&&!!state.indexError&&!document.getElementById('load').disabled),'Primary index deadline clears its request and leaves the existing Show button usable');
    await indexHeaders.locator('#load').click();await requestGate(retryIndexSeen,'primary index retry headers');
    await indexHeaders.locator('#load').click();await indexHeaders.locator('[data-range="3"]').click();
    assert.equal(indexRequests,2,'Early input during a pending index retry cannot duplicate initialization');
    assert.equal(await indexHeaders.evaluate(()=>state.loadSequence),0,'Pending retry inputs cannot begin incomplete range loads');
    releaseRetryIndex();await ready(indexHeaders);releaseFirstIndex();
    assert.ok(await indexHeaders.evaluate(()=>!!state.index&&!!state.plotArea&&state.points.length>0&&!state.indexError));
    checks.push('primary index header deadline supports native Show retry and deduplicates pending retry clicks');await snapshot(indexHeaders,'primary-header-retry');
  }finally{releaseFirstIndex();releaseRetryIndex();await indexHeaders.close();}

  const shardHeaders=await pageFor();await shardHeaders.clock.install();await shardHeaders.goto(url);await ready(shardHeaders);
  const retained=await shardHeaders.evaluate(()=>({range:{...state.loadedRange},count:state.points.length}));let releaseShard,shardSeen;
  const shardGate=new Promise(resolve=>releaseShard=resolve),heldShardSeen=new Promise(resolve=>shardSeen=resolve);let shardRequests=0;
  await shardHeaders.route('**/data/2025.json',async route=>{shardRequests++;if(shardRequests===1){shardSeen();await shardGate;}await route.continue().catch(()=>{});});
  try{
    await shardHeaders.locator('#year-jump').selectOption('2025');await requestGate(heldShardSeen,'held primary shard headers');
    await shardHeaders.clock.fastForward(10001);await shardHeaders.waitForFunction(()=>!document.getElementById('load').disabled&&document.getElementById('error').textContent.includes('too long'),{},{timeout:5000});
    assert.ok(await shardHeaders.evaluate(old=>state.loadedRange.start===old.range.start&&state.loadedRange.end===old.range.end&&state.points.length===old.count&&document.getElementById('loading').hidden&&!state.cache.has(2025),retained),'Failed primary shard retains truthful loaded range and has no poisoned cache');
    const retainedCsv=shardHeaders.waitForEvent('download');await shardHeaders.locator('#csv').click();assert.ok((await retainedCsv).suggestedFilename().includes(`${retained.range.start}_${retained.range.end}`));
    await shardHeaders.locator('#load').click();await shardHeaders.waitForFunction(()=>state.loadedRange?.start==='2025-01-01'&&!document.getElementById('load').disabled);releaseShard();
    assert.ok(await shardHeaders.evaluate(()=>state.points.length>0&&state.points.every(point=>point.timestamp.startsWith('2025'))&&document.getElementById('error').hidden));
    checks.push('primary shard header deadline retains chart/CSV truth and native Show retries successfully');await snapshot(shardHeaders,'primary-shard-retry');
  }finally{releaseShard();await shardHeaders.close();}

  for(const kind of ['index','shard']){
    const payload=fs.readFileSync(new URL(kind==='index'?'../city-gauge/data/index.json':'../city-gauge/data/2024.json',import.meta.url));let releaseBody,bodySeen,first=true;
    const bodyGate=new Promise(resolve=>releaseBody=resolve),partialSeen=new Promise(resolve=>bodySeen=resolve);
    const primaryServer=http.createServer(async(request,response)=>{response.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});if(first){first=false;response.flushHeaders();response.write(payload.subarray(0,20));bodySeen();await bodyGate;if(!response.destroyed)response.end(payload.subarray(20));}else response.end(payload);});
    await requestGate(new Promise((resolve,reject)=>{primaryServer.once('error',reject);primaryServer.listen(0,'127.0.0.1',resolve);}),`primary ${kind} chunked server`);
    const bodyPage=await pageFor();
    try{
      await bodyPage.clock.install();
      if(kind==='shard'){await bodyPage.goto(url);await ready(bodyPage);}
      await bodyPage.route(kind==='index'?'**/data/index.json':'**/data/2024.json',route=>route.continue({url:`http://127.0.0.1:${primaryServer.address().port}/city-${kind}.json`}));
      if(kind==='index')await bodyPage.goto(url,{waitUntil:'domcontentloaded'});else await bodyPage.locator('#year-jump').selectOption('2024');
      await requestGate(partialSeen,`partial primary ${kind} JSON body`);
      await bodyPage.clock.fastForward(10001);await bodyPage.waitForFunction(()=>!document.getElementById('load').disabled&&document.getElementById('error').textContent.includes('too long'),{},{timeout:5000});
      assert.equal(await bodyPage.locator('#loading').isVisible(),false,'Body deadline clears the loading overlay');
      if(kind==='index')assert.ok(await bodyPage.evaluate(()=>!state.index&&!state.indexPromise&&!!state.indexError));
      else assert.ok(await bodyPage.evaluate(year=>state.loadedRange.start.startsWith(String(year))&&!state.cache.has(2024),latestArchiveYear),'Partial shard body cannot replace the existing committed chart');
      await bodyPage.locator('#load').click();await ready(bodyPage);releaseBody();
      assert.ok(await bodyPage.evaluate(expected=>state.points.length>0&&!!state.plotArea&&document.getElementById('error').hidden&&(expected==='index'||state.points.every(point=>point.timestamp.startsWith('2024'))),kind));
      checks.push(`primary ${kind} response-body deadline remains retryable through native Show`);await snapshot(bodyPage,`primary-${kind}-body-retry`);
    }finally{releaseBody();await bodyPage.close();primaryServer.closeAllConnections();await new Promise(resolve=>primaryServer.close(resolve));}
  }
  assert.deepEqual(errors,[],'dashboard emits no uncaught page errors');checks.push('no uncaught browser errors');
} finally {await browser.close();}
const result={browser:name,checks,errors};if(output)fs.writeFileSync(path.join(output,`${name}-city-result.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
