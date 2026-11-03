import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browserName=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[browserName==='edge'?'chromium':browserName].launch({headless:true,
 ...(browserName==='edge'?{channel:'msedge'}:{}),
 ...(browserName==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(browserName==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(['chromium','edge'].includes(browserName)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),
});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9022/index.html';
const artifacts=process.env.NWW_DEEP_CORE_ARTIFACT_DIR||path.join(process.env.NWW_AUDIT_OUTPUT||os.tmpdir(),'deep-core',browserName);fs.mkdirSync(artifacts,{recursive:true});
const evidence=[{browser:browserName,version:browser.version()}];
async function opened(){const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});const page=await context.newPage();page.on('pageerror',error=>evidence.push({pageError:error.message}));return {context,page};}
async function ready(page){await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:120000});}
async function snapshot(page){return page.evaluate(()=>({mode:currentDataMode,overlay:currentOverlayMode,interval:getTimelineIntervalMinutes(),frames:currentSeriesHours.length,frameState:floodFrameState,layerMode:currentFloodLayer?._floodmapperFrame?.dataMode,days:observedData?.days?.length||0,status:document.getElementById('stageSubText').textContent}));}
try{
 // Delay an actual successful archive response. All user actions are native
 // button clicks; no selection generations or renderer functions are replaced.
 {
  const {context,page}=await opened();let release,entered;const hold=new Promise(resolve=>release=resolve),held=new Promise(resolve=>entered=resolve);
  await page.route('**/canonical_daily_v2.json*',async route=>{const response=await route.fetch();evidence.push({heldStatus:response.status(),heldBytes:(await response.body()).length});entered();await hold;await route.fulfill({response});});
  try{
   await ready(page);await page.locator('#observedDataBtn').click();await held;
   await page.locator('#dynamicModeBtn').click();await page.locator('#intervalQuarterBtn').click();await page.locator('#intervalDailyBtn').click();await page.locator('#intervalQuarterBtn').click();
   release();await page.evaluate(()=>backgroundDataPromise);
   await page.waitForFunction(()=>currentDataMode==='observed'&&currentSeriesHours.length>1&&floodFrameState==='ready',{},{timeout:90000});
   const state=await snapshot(page);assert.equal(state.overlay,'dynamic');assert.equal(state.interval,15);assert.equal(state.layerMode,'observed');evidence.push({slowPastSuccess:state});
   await page.screenshot({path:path.join(artifacts,'slow-past-success.png')});
   // The actual selected day stays bounded while its renderer uses the same
   // preceding crest and raster as a continuous same-gauge model run.
   const midnight=await page.evaluate(async()=>{
    await loadObservedDay('2026-09-26');await switchOverlayMode('depth');await renderHour(1);
    const day=currentRawSeriesHours,entry=currentSeriesHours[1],previous=getObservedSourceHoursForDay(getObservedDayRecord('2026-09-25'));
    const continuous=annotateHydraulicSeries([...previous.slice(-32),...day]);const expected=continuous.find(row=>entryTimeMs(row)===entryTimeMs(entry));
    const reference=await getHydraulicOverlayRecord('depth',getOverlayStage(getStageValue(entry)),expected.hydraulicPhase,expected,continuous);
    const image=await getDrainageRasterImage(reference.url),shown=currentFloodLayer.getElement(),canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(shown,0,0);const actual=ctx.getImageData(0,0,canvas.width,canvas.height).data;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);const desired=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let differing=0;for(let i=0;i<actual.length;i+=4)if(actual[i]!==desired[i]||actual[i+1]!==desired[i+1]||actual[i+2]!==desired[i+2]||actual[i+3]!==desired[i+3])differing++;
    return {phase:entry.hydraulicPhase,crest:entry.hydraulicCrestTimeUtc,crestStage:entry.hydraulicCrestStageFt,frames:currentSeriesHours.length,start:day[0].timeUtc,end:day.at(-1).timeUtc,retention:getDrainageRetentionMilestones(entry,day).map(row=>row.timeUtc),differingPixels:differing,layerPhase:currentFloodLayer._floodmapperFrame.phase};
   });
   assert.equal(midnight.phase,'draining');assert.equal(midnight.layerPhase,'draining');assert.equal(midnight.crest,'2026-09-26T01:30:00.000Z');assert.equal(midnight.crestStage,4.75);assert.equal(midnight.frames,96);assert.equal(midnight.differingPixels,0);assert.equal(midnight.retention[0],midnight.crest);evidence.push({midnight});
   await page.screenshot({path:path.join(artifacts,'midnight-fixed.png')});
   const dailyParity=await page.evaluate(async()=>{
    await loadObservedDay('2026-09-27');await renderHour(getPeakHourIndex(currentSeriesHours));
    const quarter={time:currentSeriesHours[currentHourIndex].timeUtc,stage:getSelectedStageNavd88(),phase:currentFloodLayer._floodmapperFrame.phase};
    const image=currentFloodLayer.getElement(),canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const first=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    await setTimelineIntervalMinutes(1440);const daily={time:currentSeriesHours[currentHourIndex].timeUtc,stage:getSelectedStageNavd88(),phase:currentFloodLayer._floodmapperFrame.phase};
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(currentFloodLayer.getElement(),0,0);const second=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let differingPixels=0;for(let i=0;i<first.length;i+=4)if(first[i]!==second[i]||first[i+1]!==second[i+1]||first[i+2]!==second[i+2]||first[i+3]!==second[i+3])differingPixels++;
    return{quarter,daily,differingPixels};
   });
   assert.equal(dailyParity.quarter.time,'2026-09-27T14:00:00.000Z');assert.deepEqual(dailyParity.daily,dailyParity.quarter);assert.equal(dailyParity.differingPixels,0);evidence.push({dailyParity});
  }finally{release();await context.close();}
 }
 {
  const {context,page}=await opened();let release,entered;const hold=new Promise(resolve=>release=resolve),held=new Promise(resolve=>entered=resolve);
  await page.route('**/canonical_daily_v2.json*',async route=>{const response=await route.fetch();entered();await hold;await route.fulfill({response});});
  try{
   await ready(page);await page.locator('#observedDataBtn').click();await held;await page.locator('#dynamicModeBtn').click();await page.locator('#forecastDataBtn').click();release();await page.evaluate(()=>backgroundDataPromise);
   await page.waitForFunction(()=>currentDataMode==='forecast'&&currentSeriesHours.length>0&&floodFrameState==='ready',{},{timeout:60000});
   const state=await snapshot(page);assert.equal(state.layerMode,'forecast');evidence.push({newerForecastWins:state});
  }finally{release();await context.close();}
 }
 {
  const {context,page}=await opened();let release,entered;const hold=new Promise(resolve=>release=resolve),held=new Promise(resolve=>entered=resolve);
  await page.route(/\/(observed_archive_index|stone_harbor_observed15min)\.json(?:\?|$)/,route=>route.fulfill({status:503,body:'Archive unavailable'}));
  await page.route('**/canonical_daily_v2.json*',async route=>{await route.fetch();entered();await hold;await route.fulfill({status:503,body:'Archive unavailable'});});
  try{
   await ready(page);await page.locator('#observedDataBtn').click();await held;await page.locator('#dynamicModeBtn').click();await page.locator('#intervalQuarterBtn').click();release();await page.evaluate(()=>backgroundDataPromise);
   await page.waitForFunction(()=>document.getElementById('stageSubText').textContent.includes('could not load'),{},{timeout:30000});
   const state=await snapshot(page);assert.equal(state.mode,'observed');assert.equal(state.frames,0);assert.equal(state.frameState,'failed');assert.equal(state.layerMode,undefined);evidence.push({slowPastFailure:state});
   await page.screenshot({path:path.join(artifacts,'slow-past-failure.png')});
  }finally{release();await context.close();}
 }
 assert.ok(!evidence.some(row=>row.pageError),JSON.stringify(evidence.filter(row=>row.pageError)));
 console.log('Passed native actual-archive midnight and Daily Max raster parity, delayed Past overlay/interval success, newer-mode cancellation and active failure.');
 console.log(JSON.stringify(evidence,null,2));
}catch(error){evidence.push({failure:error.stack});throw error;}finally{fs.writeFileSync(path.join(artifacts,'native-results.json'),JSON.stringify(evidence,null,2));await browser.close();}
