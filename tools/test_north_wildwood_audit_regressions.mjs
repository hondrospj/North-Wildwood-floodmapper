// Full-app tests for the eight September 21 audit findings. No flood-data mocks.
// Run with the same NWW_TEST_URL / PLAYWRIGHT_MODULE / CHROME_PATH as the layout suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),...(engine===chromium?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
const page=await browser.newPage({viewport:{width:1024,height:768},hasTouch:true,acceptDownloads:true});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('crash',()=>console.error('Browser page crashed'));
const parcel=JSON.parse(fs.readFileSync(new URL('../assets/parcel-history-v2/NorthWildwoodParcels.geojson',import.meta.url))).features[0];
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
async function reachable(selector){return page.locator(selector).evaluate(element=>{const rect=element.getBoundingClientRect();const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return hit===element||element.contains(hit);});}
try{
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready'),{},{timeout:120000});
  await page.evaluate(()=>warmBackgroundData());
  const data=await page.evaluate(async()=>{
    async function inspect(date){
      await ensureObservedArchiveForDate(date);
      const day=getObservedDayRecord(date),series=buildObservedCanonicalSeries(day,date);
      const source=getObservedSourceHoursForDay(day),finite=series.filter(entry=>Number.isFinite(getStageValue(entry)));
      const peak=source.filter(entry=>Number.isFinite(getStageValue(entry))).sort((a,b)=>getStageValue(b)-getStageValue(a))[0];
      const daily=buildObservedDailyMaximumSeries(date.slice(0,7)).find(entry=>entry.observedDate===date);
      return{date,classification:day.classification,calendar:day.peakNAVD88,source:day.pipelineSource,peak:Math.max(...finite.map(getStageValue)),rawPeak:peak&&getStageValue(peak),rawTime:peak?.displayTimeEST,dailyPeak:daily&&getStageValue(daily),dailyTime:daily?.displayTimeEST,slots:series.map(entry=>[entryTimeMs(entry),getStageValue(entry)])};
    }
    const first=await inspect('2026-08-31');
    const august10=await inspect('2026-08-10');
    const august13=await inspect('2026-08-13');
    const second=await inspect('2026-08-31');
    const historic=await inspect('1962-03-06');
    const crest=await inspect('1998-02-05');
    const third=await inspect('2026-08-31');
    let badCadenceRejected=false;
    try{addArchiveShardDays({source:'lewes',intervalMinutes:15,days:[]},'lewes');}catch{badCadenceRejected=true;}
    const missingDay={date:'2008-01-01',peakNAVD88:4.1,pipelineSource:'N',isLewesSurrogate:true};
    const missing=buildObservedCanonicalSeries(missingDay,missingDay.date);
    const sampled=sampleCanonicalHydraulicSeries(missing,60);
    return{first,august10,august13,second,third,historic,crest,badCadenceRejected,missing,sampled,missingLabel:formatSnapshotTime(sampled[0]),missingExport:getExportFrameDateTimeText(sampled[0]),nullSurrogate:decodeSurrogateHundredths(null),cacheIsolated:lewesHourlyDaysByDate.has('1962-03-06')&&!observed15MinuteDaysByDate.has('1962-03-06')};
  });
  check(JSON.stringify(data.first.slots)===JSON.stringify(data.second.slots)&&JSON.stringify(data.second.slots)===JSON.stringify(data.third.slots),'Date navigation changes playback');
  check(data.august10.classification==='minor'&&data.august10.calendar===3.37,'August 10 calendar is not reconciled with primary USGS');
  for(const item of [data.first,data.august10,data.august13]){
    check(item.source==='U',`${item.date}: primary USGS is not selected`);
    check(Math.abs(item.calendar-item.peak)<0.011,`${item.date}: calendar/replay peak mismatch`);
    check(item.dailyPeak===item.peak,`${item.date}: daily/replay peak mismatch`);
  }
  check(Math.abs(data.historic.rawPeak-data.historic.dailyPeak)<1e-9,'Hourly bias correction differs in Daily Max');
  check(data.historic.rawTime===data.historic.dailyTime,'Hourly peak time differs in Daily Max');
  check(data.historic.dailyTime==='1962-03-06T21:00','Historical peak has the wrong time');
  check(data.crest.slots.length>1&&Math.abs(data.crest.peak-data.crest.calendar)<0.011&&data.crest.peak===data.crest.dailyPeak,'Official pre-2007 crest lost its replay or disagrees across entry points');
  check(data.badCadenceRejected&&data.cacheIsolated,'Sources/cadences can contaminate each other');
  check(data.missing.length===1&&data.sampled.length===1&&data.sampled[0].isDailyPeakOnly,'Missing hourly data is presented as a full replay');
  check(!data.sampled[0].displayTimeEST&&data.sampled[0].observationInterval==='daily','Daily-only peak has an invented observation time');
  check(/unknown/i.test(data.missingLabel)&&/unknown/i.test(data.missingExport),'Daily-only labels hide unknown peak time');
  check(data.nullSurrogate===null,'Missing NOAA level became a real water level');
  console.log('Historical source, cadence, daily peak, and navigation-order checks passed');

  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(1000);
  await page.evaluate(feature=>{openParcelFloodPrompt(feature,map.getCenter());},parcel);
  check(await reachable('.nw-mobile-popup .maplibregl-popup-close-button'),'Popup close inaccessible when opened');
  await page.locator('#hourSlider').focus();await page.keyboard.press('End');
  await page.waitForTimeout(1000);
  const popup=await page.evaluate(feature=>({actual:document.querySelector('.nw-mobile-popup .house-alert-popup').textContent,expected:new DOMParser().parseFromString(buildHouseAlertPopup(feature),'text/html').querySelector('.house-alert-popup').textContent}),parcel);
  check(popup.actual===popup.expected,'Building reading did not refresh with the timeline');
  check(await reachable('.nw-mobile-popup .maplibregl-popup-close-button'),'Popup close inaccessible after timeline change');
  await page.locator('.nw-mobile-popup .maplibregl-popup-close-button').tap();
  check(await page.locator('.nw-mobile-popup').count()===0,'Popup close does not dismiss the popup');

  await page.locator('#mobileControlsToggle').tap();
  await page.locator('#dataSourceHelpBtn').tap();
  for(const key of ['Tab','Tab','Shift+Tab']){
    await page.keyboard.press(key);
    check(await page.evaluate(()=>!!document.activeElement.closest('#infoModal')),'Focus escaped help dialog');
  }
  check(await page.evaluate(()=>document.getElementById('hourSlider').closest('[inert]')!==null),'Modal background remains keyboard-active');
  await page.locator('#infoModalCloseBtn').tap();
  await page.waitForTimeout(100);
  check(await page.evaluate(()=>document.activeElement.id==='dataSourceHelpBtn'),'Help focus not restored to opener');
  check(await page.evaluate(()=>!document.getElementById('hourSlider').closest('[inert]')),'Modal left the map inert after closing');

  // Deterministic provider fixtures; real form, normalization, parcel matching,
  // marker renderer, drawer and popup paths are exercised without rate limits.
  const lat=Number(parcel.properties.centroidLat||parcel.properties.analysisLat),lon=Number(parcel.properties.centroidLon||parcel.properties.analysisLon);
  await page.route('https://geocode.arcgis.com/**',route=>route.fulfill({json:{candidates:[{address:'1601 Ocean Avenue, North Wildwood, NJ',score:100,location:{x:lon,y:lat},attributes:{Match_addr:'1601 Ocean Avenue, North Wildwood, NJ'}}]}}));
  await page.route('https://nominatim.openstreetmap.org/**',route=>route.fulfill({json:[]}));
  await page.locator('#townAddressInput').fill('1601 Ocean Avenue');
  await page.locator('#townAddressSearchBtn').tap();
  await page.waitForFunction(()=>!document.getElementById('townAddressSearchBtn').disabled,{},{timeout:30000});
  check(!await page.locator('body').evaluate(element=>element.classList.contains('mobile-controls-open')),'Address result leaves drawer open');
  check(await page.locator('#map3d .nw-address-marker').count()===1,'Address marker missing on visible renderer');
  await page.locator('.nw-mobile-popup .maplibregl-popup-close-button').tap();
  await page.evaluate(()=>clearTownAddressLookup());
  check(await page.locator('.nw-address-marker').count()===0,'Clear leaves visible address marker behind');

  // End the preceding address-search animation before arranging this test's
  // known town-wide camera. Otherwise its delayed moveend can restore zoom 17.
  await page.evaluate(()=>{map.stop();const active=window.NORTH_WILDWOOD_3D.getMap();active.stop();active.jumpTo({center:[-74.7999,39.0069],zoom:13,bearing:0,pitch:0});});
  await page.setViewportSize({width:1024,height:768});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(900);
  const bounds=await page.evaluate(()=>({active:getActiveMapBounds().toBBoxString(),visible:window.NORTH_WILDWOOD_3D.getMap().getBounds().toArray(),zoom:window.NORTH_WILDWOOD_3D.getMap().getZoom(),legacy:map.getSize()}));
  console.log('Current View input bounds',JSON.stringify(bounds));
  check(Math.abs(bounds.zoom-13)<1e-9,'Export test camera was changed by a preceding interaction');
  const actualBounds=bounds.active.split(',').map(Number),expectedBounds=bounds.visible.flat();
  check(actualBounds.every((value,index)=>Number.isFinite(value)&&Math.abs(value-expectedBounds[index])<1e-9),'Active bounds differ from the visible renderer');
  await page.locator('#mobileControlsToggle').tap();
  await page.locator('#openDownloadModalBtn').tap();
  await page.locator('#exportFormatPngBtn').tap();
  await page.locator('#exportExtentCurrentBtn').tap();
  const downloadPromise=page.waitForEvent('download',{timeout:120000});
  await page.locator('#downloadBtn').tap();
  const download=await downloadPromise;
  check(await download.failure()===null,'PNG export failed');
  const legend=await page.locator('.export-depth-key-ends').evaluate(element=>{
    const boxes=[...element.children].map(child=>{const r=child.getBoundingClientRect();return{left:r.left,right:r.right};});
    return{labels:[...element.children].map(child=>child.textContent),overlap:boxes.some((box,index)=>index>0&&box.left<boxes[index-1].right+1)};
  });
  check(!legend.overlap,'Downloaded depth-key labels overlap: '+JSON.stringify(legend));
  const framing=await page.evaluate(()=>({visible:getActiveMapBounds().toBBoxString(),exported:exportMap.getBounds().toBBoxString(),zoom:exportMap.getZoom()}));
  const v=framing.visible.split(',').map(Number),e=framing.exported.split(',').map(Number);
  check(e[0]<=v[0]+1e-5&&e[1]<=v[1]+1e-5&&e[2]>=v[2]-1e-5&&e[3]>=v[3]-1e-5,'Export does not contain the visible geographic bounds');
  check(framing.zoom<19,'Current View export zoomed into a zero-area hidden map: '+JSON.stringify(framing));
  if(process.env.NWW_SCREENSHOT_DIR){fs.mkdirSync(process.env.NWW_SCREENSHOT_DIR,{recursive:true});await download.saveAs(`${process.env.NWW_SCREENSHOT_DIR}/fixed-current-view.png`);await page.screenshot({path:`${process.env.NWW_SCREENSHOT_DIR}/fixed-mobile.png`});}
  await page.evaluate(()=>setDownloadModalOpen(false));
  await page.evaluate(()=>loadObservedDay('2008-02-12'));
  const dailyOnly=await page.evaluate(()=>{
    const range={startMs:entryTimeMs(currentSeriesHours[0]),endMs:entryTimeMs(currentSeriesHours[0])};
    return{count:currentSeriesHours.length,entry:currentSeriesHours[0],label:document.getElementById('timeText').textContent,bubble:document.getElementById('timelineBubble').textContent,exportFrames:buildExportRangeFrameItems(currentSeriesHours,range,'15min').map(item=>item.entry),loaded:observedArchiveLoadedYears.has('lewes:2008')};
  });
  check(dailyOnly.count===1&&dailyOnly.entry.isDailyPeakOnly,'Actual uncovered date does not remain daily-only');
  check(/unknown/i.test(dailyOnly.label)&&/daily peak only/i.test(dailyOnly.bubble),'Actual uncovered date hides its missing peak time');
  check(!dailyOnly.loaded,'Uncovered NOAA year was marked loaded');
  check(dailyOnly.exportFrames.length===1&&dailyOnly.exportFrames[0].observationInterval==='daily','Quarter-hour export relabeled a daily-only peak');
  check(!errors.length,'Uncaught browser errors: '+errors.join('; '));
  console.log(JSON.stringify({checks,historical:{...data.historic,slots:undefined},export:framing,errors},null,2));
}finally{await browser.close();}
