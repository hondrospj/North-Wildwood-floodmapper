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
const output = process.env.NWW_AUDIT_OUTPUT;
if(output)fs.mkdirSync(output,{recursive:true});
async function pageFor(){const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));return page;}
async function ready(page){await page.waitForFunction(()=>state.loadedRange&&state.points.length>0&&!document.getElementById('load').disabled,{}, {timeout:60000});}
async function snapshot(page,label){if(output)await page.screenshot({path:path.join(output,`${name}-city-${label}.png`)});}
try {
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
  await outage.route('**/comparison/2026.json',async route=>{comparisonSeen();await heldComparison;await route.fulfill({status:503,body:'Unavailable'});});
  await outage.goto(url);await ready(outage);await seenComparison;
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
  await race.evaluate(()=>{document.getElementById('start').value='2024-01-01';document.getElementById('end').value='2024-01-01';window.oldCityLoad=loadRange();});await seen;
  await race.locator('#year-jump').selectOption('2025');
  await race.waitForFunction(()=>state.loadedRange?.start==='2025-01-01'&&!document.getElementById('load').disabled);
  releaseOld();await race.evaluate(()=>window.oldCityLoad);
  assert.ok(await race.evaluate(()=>state.loadedRange.start==='2025-01-01'&&state.loadedRange.end==='2025-12-31'&&state.points.every(point=>point.timestamp.startsWith('2025'))&&document.getElementById('range').textContent.includes('2025')),'older response cannot replace newer selection');
  checks.push('delayed range cannot overwrite later year selection');await snapshot(race,'race');await race.close();
  const indexPending=await pageFor();let releaseIndex;const heldIndex=new Promise(resolve=>releaseIndex=resolve);let indexRequested;const seenIndex=new Promise(resolve=>indexRequested=resolve);
  await indexPending.route('**/comparison/index.json',async route=>{indexRequested();await heldIndex;await route.continue();});
  try{
    await indexPending.goto(url);await ready(indexPending);await seenIndex;
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
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const bodyPending=await pageFor();
  try{
    await bodyPending.route('**/comparison/index.json',route=>route.continue({url:`http://127.0.0.1:${server.address().port}/comparison/index.json`}));
    await bodyPending.clock.install();await bodyPending.goto(url);await ready(bodyPending);await seenBody;
    assert.ok(await bodyPending.evaluate(()=>!state.comparisonIndex&&!!state.plotArea),'primary plot renders while optional index body remains pending');
    await bodyPending.clock.fastForward(10001);await bodyPending.locator('#comparison-retry').waitFor({state:'visible'});
    assert.ok(await bodyPending.evaluate(()=>!state.comparisonIndexPromise&&state.chartPoints.length>0&&document.getElementById('error').hidden),'body deadline leaves primary usable and clears the in-flight request for retry');
    releaseBody();await bodyPending.locator('#comparison-retry').click();await bodyPending.waitForFunction(()=>state.comparisonIndex&&state.comparisonPoints.length>0);
    checks.push('comparison index body deadline preserves primary and supports successful retry');await snapshot(bodyPending,'index-body-retry');
  }finally{releaseBody();await bodyPending.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  assert.deepEqual(errors,[],'dashboard emits no uncaught page errors');checks.push('no uncaught browser errors');
} finally {await browser.close();}
const result={browser:name,checks,errors};if(output)fs.writeFileSync(path.join(output,`${name}-city-result.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
