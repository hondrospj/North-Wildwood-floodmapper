// Delayed real modeled responses with native clicks in an isolated headless browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browserName=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[browserName==='edge'?'chromium':browserName].launch({headless:true,
 ...(browserName==='edge'?{channel:'msedge'}:{}),
  ...(browserName==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(browserName==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(['chromium','edge'].includes(browserName)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),
});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9041/index.html';
const artifacts=process.env.NWW_MODELED_ARTIFACT_DIR||path.join(process.env.NWW_AUDIT_OUTPUT||os.tmpdir(),'modeled-loading',browserName);
fs.mkdirSync(artifacts,{recursive:true});
const payload=fs.readFileSync(new URL('../return_intervals.json',import.meta.url));
const records=JSON.parse(payload).intervals;
const evidence=[{browser:browserName,version:browser.version()}],errors=[];
async function snapshot(page){return page.evaluate(()=>({mode:currentDataMode,view:currentViewType,
 overlay:currentOverlayMode,interval:getTimelineIntervalMinutes(),datum:currentDatum,
 years:currentReturnIntervalYears,count:currentSeriesHours.length,offset:currentSeriesHours[currentHourIndex]?.offsetHours,
 stage:getStageValue(currentSeriesHours[currentHourIndex]),label:currentSelectedLabel,
 frameState:floodFrameState,layerMode:currentFloodLayer?._floodmapperFrame?.dataMode,
 layerOffset:currentFloodLayer?._floodmapperFrame?.entry?.offsetHours,
 cached:!!returnIntervalData,pending:!!loadReturnInterval.pendingSelection,
 sub:document.getElementById('stageSubText').textContent,status:document.getElementById('floodFrameStatus').textContent,
 sliderDisabled:document.getElementById('hourSlider').disabled}));}
async function open(){
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
 const page=await context.newPage();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));
 let release,entered,requests=0,fail=false;
 const hold=new Promise(resolve=>release=resolve),held=new Promise(resolve=>entered=resolve);
 await page.route('**/return_intervals.json*',async route=>{
  requests++;entered();await hold;
  await route.fulfill(fail?{status:503,body:'Modeled data temporarily unavailable'}:{status:200,contentType:'application/json',body:payload});
 });
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:120000});
 return {context,page,held,release,get requests(){return requests;},set fail(value){fail=value;}};
}
async function modelReady(page,years=10,interval=60){
 await page.waitForFunction(({years,interval})=>currentDataMode==='return-interval'&&currentReturnIntervalYears===years&&
  getTimelineIntervalMinutes()===interval&&currentSeriesHours.length>0&&floodFrameState==='ready'&&
  currentFloodLayer?._floodmapperFrame?.dataMode==='return-interval',{years,interval},{timeout:120000});
 const state=await snapshot(page),record=records.find(item=>Number(item.years)===years);
 assert.equal(state.offset,0);assert.equal(state.layerOffset,0);assert.equal(state.stage,record.targetNavd88Ft);
 assert.equal(state.overlay,'dynamic');assert.equal(state.pending,false);return state;
}
async function chooseYear(page,years){
 const select=page.locator('#returnIntervalCard select');
 if(await select.count()&&await select.first().isVisible())await select.first().selectOption(String(years));
 else await page.locator(`#return${years}Btn`).click();
}
try{
 for(const cadence of [60,15,1440]){
  const h=await open();try{
   await h.page.locator('#returnIntervalDataBtn').click();await h.held;
   const pending=await snapshot(h.page);assert.equal(pending.count,0);assert.equal(pending.sliderDisabled,true);
   assert.match(pending.status,/Loading modeled flood/);assert.doesNotMatch(pending.label,/Mean/);
   await h.page.locator('#dynamicModeBtn').click();await h.page.locator('#datumNavd88Btn').click();
   if(cadence!==60)await h.page.locator(cadence===15?'#intervalQuarterBtn':'#intervalDailyBtn').click();
   assert.equal(h.requests,1);h.release();const state=await modelReady(h.page,10,cadence);
   assert.equal(state.datum,'navd88');evidence.push({cadence,pending,state});
   await h.page.screenshot({path:path.join(artifacts,`modeled-${cadence}.png`)});
  }finally{h.release();await h.context.close();}
 }
 for(const later of ['forecast','observed']){
  const h=await open();try{
   await h.page.locator('#returnIntervalDataBtn').click();await h.held;await h.page.locator('#dynamicModeBtn').click();
   await h.page.locator(later==='forecast'?'#forecastDataBtn':'#observedDataBtn').click();
   await h.page.waitForFunction(mode=>currentDataMode===mode&&currentSeriesHours.length>0&&floodFrameState==='ready',later,{timeout:120000});
   h.release();await h.page.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>r.name.includes('return_intervals.json')&&r.responseEnd>0));
   await h.page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const state=await snapshot(h.page);assert.equal(state.mode,later);assert.equal(state.layerMode,later);assert.equal(state.cached,false);
   evidence.push({newerMode:later,state});
  }finally{h.release();await h.context.close();}
 }
 {
  const h=await open();try{
   await h.page.locator('#returnIntervalDataBtn').click();await h.held;await h.page.locator('#dynamicModeBtn').click();
   await h.page.locator('#intervalQuarterBtn').click();h.fail=true;h.release();
   await h.page.waitForFunction(()=>document.getElementById('stageSubText').textContent==='Modeled flood data could not load');
   const failed=await snapshot(h.page);assert.equal(failed.count,0);assert.equal(failed.frameState,'failed');assert.equal(failed.layerMode,undefined);
   assert.match(failed.status,/Select a modeled flood to retry/);h.fail=false;
   await chooseYear(h.page,10);const recovered=await modelReady(h.page,10,15);assert.equal(h.requests,2);
   evidence.push({activeFailure:failed,retry:recovered});
  }finally{h.release();await h.context.close();}
 }
 {
  const h=await open();try{
   await h.page.locator('#returnIntervalDataBtn').click();await h.held;await chooseYear(h.page,50);
   await h.page.locator('#dynamicModeBtn').click();await h.page.locator('#intervalQuarterBtn').click();
   h.release();const state=await modelReady(h.page,50,15);evidence.push({newerYear:state});
  }finally{h.release();await h.context.close();}
 }
 assert.deepEqual(errors,[],'No unexpected JavaScript errors');
 console.log('Passed native modeled loading, latest overlay/cadence/datum, peak-first selection, newer Forecast/Past/year ownership and failure/retry.');
 console.log(JSON.stringify(evidence,null,2));
}finally{
 fs.writeFileSync(path.join(artifacts,'modeled-loading-results.json'),JSON.stringify({evidence,errors},null,2));
 await browser.close();
}
