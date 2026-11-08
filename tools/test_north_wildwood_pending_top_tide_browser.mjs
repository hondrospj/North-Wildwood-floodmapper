// Native pending-history controls with actual committed archive payloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
 ...(name==='edge'?{channel:'msedge'}:{}),
 ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(name==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(['edge','chromium'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),
});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9043/index.html';
const out=process.env.NWW_PENDING_TIDE_ARTIFACT_DIR||path.join(process.env.NWW_AUDIT_OUTPUT||os.tmpdir(),'pending-top-tide',name);
fs.mkdirSync(out,{recursive:true});const evidence=[],errors=[];
const payloads={1962:fs.readFileSync(new URL('../observed_archive/lewes/1962.json',import.meta.url)),2012:fs.readFileSync(new URL('../observed_archive/stone-harbor/2012.json',import.meta.url))};
const dates={1962:'1962-03-07',2012:'2012-10-29'};
const snapshot=page=>page.evaluate(()=>({mode:currentDataMode,view:currentViewType,interval:getTimelineIntervalMinutes(),overlay:currentOverlayMode,datum:currentDatum,date:selectedObservedDate,label:currentSelectedLabel,pending:loadTopTideEvent.pendingSelectionGeneration,generation:selectionGeneration,count:currentSeriesHours.length,time:currentSeriesHours[currentHourIndex]?.timeUtc,stage:getStageValue(currentSeriesHours[currentHourIndex]),layerDate:currentFloodLayer?._floodmapperFrame?.entry?.observedDate,layerUrl:currentFloodLayer?._url,frame:floodFrameState,status:document.getElementById('floodFrameStatus').textContent,timeText:document.getElementById('timeText').textContent}));
async function open(years=[1962], holdArchiveIndex=false){
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 const gates=new Map();let fail=false;
 let releaseIndex=()=>{};
 if(holdArchiveIndex){
  const heldIndex=new Promise(resolve=>{releaseIndex=resolve;});
  await page.route('**/observed_archive_index.json?*',async route=>{await heldIndex;await route.continue();});
 }
 for(const year of years){let release,entered;const hold=new Promise(r=>release=r),held=new Promise(r=>entered=r);let requests=0;
  gates.set(year,{held,release,get requests(){return requests;}});
  await page.route(`**/observed_archive/**/${year}.json*`,async route=>{requests++;entered();await hold;await route.fulfill(fail?{status:503,body:'Archive temporarily unavailable'}:{status:200,contentType:'application/json',body:payloads[year]});});
 }
 await page.route('**/lewes_hourly.json*',route=>fail?route.fulfill({status:503,body:'Archive temporarily unavailable'}):route.continue());
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:120000});
 await page.waitForFunction(()=>topTideEvents[0]?.dateKey==='1962-03-07'&&topTideEvents[1]?.dateKey==='2012-10-29');
 return {context,page,gates,releaseIndex,set fail(value){fail=value;},async close(){releaseIndex();for(const gate of gates.values())gate.release();await context.close();}};
}
async function choose(page,year){await page.locator('#topTideList .top-tide-item').nth(year===1962?0:1).click();}
async function ready(page,year){await page.waitForFunction(date=>currentViewType==='top-tide'&&selectedObservedDate===date&&floodFrameState==='ready'&&currentFloodLayer?._floodmapperFrame?.entry?.observedDate===date,dates[year],{timeout:120000});return snapshot(page);}
async function settled(page){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
try{
 {const h=await open([],true);try{
  assert.equal(await h.page.evaluate(()=>observed15MinuteData),null,'The preview must paint before the held archive index');
  const preview=h.page.locator('#topTideList');
  assert.deepEqual(await preview.locator('.top-tide-rank:visible').allTextContents(),['#1','#2','#3']);
  await preview.getByRole('button',{name:'Show more',exact:true}).click();
  const dialog=h.page.locator('#topTidesModal');
  assert.equal(await dialog.locator('.top-tide-rank:visible').count(),10);
  const november=dialog.locator('[data-flood-date="2009-11-13"]');
  assert.equal(await november.locator('.top-tide-rank').textContent(),'#9');
  await november.focus();
  h.releaseIndex();
  await h.page.waitForFunction(()=>topTideEvents[8]?.dateKey==='2026-09-26');
  assert.equal(await november.locator('.top-tide-rank').textContent(),'#10');
  assert.equal(await november.evaluate(button=>button===document.activeElement),true);
  evidence.push({case:'preview-before-archive-and-focus-after-rerank'});
 }finally{await h.close();}}
 for(const cadence of [15,60,1440]){const h=await open();try{
  const before=await snapshot(h.page);await choose(h.page,1962);await h.gates.get(1962).held;
  await h.page.locator('#dynamicModeBtn').click();await h.page.locator('#depthModeBtn').click();await h.page.locator('#dynamicModeBtn').click();
  await h.page.locator('#datumNavd88Btn').click();await h.page.locator('#intervalQuarterBtn').click();
  if(cadence!==15)await h.page.locator(cadence===60?'#intervalHourBtn':'#intervalDailyBtn').click();
  await h.page.setViewportSize({width:1280,height:850});await settled(h.page);
  const pending=await snapshot(h.page);assert.equal(pending.pending,pending.generation);assert.equal(pending.timeText,before.timeText);assert.equal(pending.layerUrl,before.layerUrl);assert.match(pending.status,/Loading March 7, 1962.*Previous flood map and time shown/);
  h.gates.get(1962).release();const after=await ready(h.page,1962);assert.equal(after.interval,cadence);assert.equal(after.overlay,'dynamic');assert.equal(after.datum,'navd88');assert.equal(after.stage,7.5);assert.equal(after.count,cadence===15?96:cadence===60?24:1);assert.equal(after.pending,null);
  evidence.push({case:'presentation-controls',cadence,pending,after});
 }finally{await h.close();}}
 for(const later of ['forecast','observed','return-interval']){const h=await open();try{
  await choose(h.page,1962);await h.gates.get(1962).held;await h.page.locator('#dynamicModeBtn').click();
  await h.page.locator(later==='forecast'?'#forecastDataBtn':later==='observed'?'#observedDataBtn':'#returnIntervalDataBtn').click();
  await h.page.waitForFunction(mode=>currentDataMode===mode&&currentSeriesHours.length>0&&currentViewType!=='top-tide',later,{timeout:120000});const newer=await snapshot(h.page);h.gates.get(1962).release();
  await h.page.waitForFunction(()=>loadTopTideEvent.pendingSelectionGeneration==null);await settled(h.page);const after=await snapshot(h.page);assert.equal(after.mode,later);assert.notEqual(after.view,'top-tide');assert.equal(after.generation,newer.generation);assert.notEqual(after.layerDate,dates[1962]);evidence.push({case:'newer-source',later,after});
 }finally{await h.close();}}
 for(const choice of ['same-mean','upper-end','same-10-year','50-year']){const h=await open();try{
  const modeled=choice.includes('year');if(modeled){await h.page.locator('#returnIntervalDataBtn').click();await h.page.waitForFunction(()=>currentDataMode==='return-interval'&&floodFrameState==='ready',{},{timeout:120000});}
  await choose(h.page,1962);await h.gates.get(1962).held;const pending=await snapshot(h.page);
  await h.page.locator(choice==='same-mean'?'#forecastMeanBtn':choice==='upper-end'?'#forecastHighBtn':choice==='same-10-year'?'#return10Btn':'#return50Btn').click();
  await h.page.waitForFunction(mode=>currentDataMode===mode&&currentViewType!=='top-tide'&&currentSeriesHours.length>0&&floodFrameState==='ready',modeled?'return-interval':'forecast',{timeout:120000});
  const newer=await snapshot(h.page);assert(newer.generation>pending.generation,'An explicit scenario/frequency reselect must supersede pending history');h.gates.get(1962).release();await h.page.waitForFunction(()=>loadTopTideEvent.pendingSelectionGeneration==null);await settled(h.page);
  const after=await snapshot(h.page);assert.equal(after.mode,modeled?'return-interval':'forecast');assert.equal(after.generation,newer.generation);assert.equal(after.view,modeled?'return-interval':'forecast');assert.notEqual(after.layerDate,dates[1962]);
  const selected=await h.page.evaluate(()=>({scenario:currentForecastScenario,years:currentReturnIntervalYears}));if(modeled)assert.equal(selected.years,choice==='same-10-year'?10:50);else assert.equal(selected.scenario,choice==='same-mean'?'mean':'highEnd');evidence.push({case:'explicit-scenario-frequency',choice,after,selected});
 }finally{await h.close();}}
 {const h=await open([1962,2012]);try{
  await choose(h.page,1962);await h.gates.get(1962).held;await choose(h.page,2012);await h.gates.get(2012).held;await h.page.locator('#intervalQuarterBtn').click();h.gates.get(2012).release();const newer=await ready(h.page,2012);h.gates.get(1962).release();await settled(h.page);
  await h.page.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>r.name.includes('/lewes/1962.json')&&r.responseEnd>0));await settled(h.page);const after=await snapshot(h.page);assert.equal(after.date,dates[2012]);assert.equal(after.layerDate,dates[2012]);assert.equal(after.interval,15);assert.equal(after.label,newer.label);evidence.push({case:'reverse-two-crests',after});
 }finally{await h.close();}}
 {const h=await open();try{
  await choose(h.page,1962);await h.gates.get(1962).held;await h.page.locator('#dynamicModeBtn').click();h.fail=true;h.gates.get(1962).release();const failed=await ready(h.page,1962);assert.equal(failed.count,1,'Unavailable detailed history retains its documented crest only');h.fail=false;await choose(h.page,1962);const after=await ready(h.page,1962);await h.page.waitForFunction(()=>currentSeriesHours.length===24);assert(h.gates.get(1962).requests>=2,'A failed shard must be retryable');evidence.push({case:'archive-outage-and-retry',failed,after:await snapshot(h.page)});
 }finally{await h.close();}}
 assert.deepEqual(errors,[]);console.log(`${evidence.length} native pending Top Tide cases passed in ${name} ${browser.version()}.`);
}finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({browser:name,version:browser.version(),evidence,errors},null,2));await browser.close();}
