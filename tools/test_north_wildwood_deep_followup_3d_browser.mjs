// Actual application UI and original assets in a fresh isolated headless browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium',engine=playwright[name==='edge'?'chromium':name];
const browser=await engine.launch({headless:true,...(name==='edge'?{channel:'msedge'}:{}),...(name==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const base=process.env.NWW_TEST_URL||'http://127.0.0.1:9041/index.html';
const output=process.env.NWW_AUDIT_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'nww-followup-3d-'));fs.mkdirSync(output,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],errors:[],areas:[],states:[]};
const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});page.setDefaultTimeout(30000);page.on('pageerror',e=>result.errors.push(e.message));
const stylePattern='**/OpenStreetMap_v2/VectorTileServer/resources/styles/root.json';let styles=[];const holdStyle=route=>{styles.push(route);};
function track3dStartupTiming(button){
 const timing={trustedClick:false,startedAt:null,busyAt:null,finishedAt:null};
 window.__nww3dStartupTiming=timing;
 const observer=new MutationObserver(()=>{
  if(!timing.trustedClick)return;
  const busy=button.getAttribute('aria-busy');
  if(busy==='true'&&timing.busyAt===null)timing.busyAt=performance.now();
  if(busy==='false'&&timing.busyAt!==null&&timing.finishedAt===null){
   timing.finishedAt=performance.now();observer.disconnect();
  }
 });
 button.addEventListener('click',event=>{
  if(!event.isTrusted)return;
  timing.trustedClick=true;timing.startedAt=performance.now();
 },{capture:true,once:true});
 observer.observe(button,{attributes:true,attributeFilter:['aria-busy']});
}
function snapshot(){return page.evaluate(()=>{const gl=window.NORTH_WILDWOOD_3D.getMap(),source=gl?.getSource('nw-flood-drape-source');return{index:currentHourIndex,time:currentSeriesHours[currentHourIndex]?.timeUtc,url:currentFloodLayer?._url,sourceUrl:source?.url,sourceLoaded:source?.loaded(),frame:floodFrameState,mode:mapClickMode,state:window.NORTH_WILDWOOD_3D.state(),busy:document.querySelector('.nw-simple-view').getAttribute('aria-busy')};});}
try{
 await page.route(stylePattern,holdStyle);
 await page.goto(base,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
 await page.locator('#openDownloadModalBtn').click();await page.locator('#exportChangeAreaBtn').click();
 for(const[width,height]of[[844,390],[667,375],[568,320],[320,568]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  for(const id of ['exportAreaApplyBtn','exportAreaCancelBtn']){await page.locator('#'+id).scrollIntoViewIfNeeded();const bounds=await page.locator('#'+id).boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=height+1,`${id} reachable at ${width}x${height}`);await page.locator('#'+id).click({trial:true});}
  result.areas.push({width,height,actionsReachable:true});
 }
 await page.locator('#exportAreaApplyBtn').click();await page.locator('#downloadModalCloseBtn').click();await page.setViewportSize({width:1440,height:1000});result.checks.push('Custom-area Apply/Cancel are reachable through real hit testing at four phone portrait/landscape sizes');
 await page.locator('.nw-simple-view').evaluate(track3dStartupTiming);
 const started=Date.now();await page.locator('.nw-simple-view').click();await page.waitForFunction(()=>Number.isFinite(window.__nww3dStartupTiming?.finishedAt),{},{timeout:23000});
 const fallback=await snapshot(),timing=await page.evaluate(()=>window.__nww3dStartupTiming),elapsedMs=timing.finishedAt-timing.startedAt;
 result.states.push({label:'style-stall-fallback',elapsedMs,driverElapsedMs:Date.now()-started,heldStyleRequests:styles.length,timing,...fallback});assert.ok(styles.length>=1,'The real configured style request is held during startup');assert.equal(timing.trustedClick,true);assert.ok(Number.isFinite(timing.startedAt)&&timing.startedAt<=timing.busyAt&&timing.busyAt<=timing.finishedAt);assert.equal(fallback.state.ready,false);assert.equal(fallback.busy,'false');assert.equal(await page.evaluate(()=>document.body.dataset.map3d),'fallback');assert.ok(elapsedMs<23000);
 const zoom=await page.evaluate(()=>map.getZoom());await page.locator('.nw-simple-zoom-in').click();await page.waitForFunction(expected=>map.getZoom()===expected,zoom+1,{timeout:3000});assert.equal(await page.evaluate(()=>map.getZoom()),zoom+1);result.checks.push('A stalled style request falls back within the complete 20-second startup budget and restores 2D zoom');
 await page.unroute(stylePattern,holdStyle);for(const route of styles)await route.abort().catch(()=>{});
 const buildingPattern='**/NorthWildwoodBuildings3D.geojson*',buildingRoutes=[];
 const holdBuildings=route=>{buildingRoutes.push(route);};
 await page.route(buildingPattern,holdBuildings);
 await page.locator('#parcelsToggle').click();await page.locator('#mapClickDepthBtn').waitFor({state:'visible'});
 await page.locator('#buildingsToggle').click();
 await page.waitForFunction(()=>buildingsLayer&&map.hasLayer(buildingsLayer),{},{timeout:10000});
 assert.equal(await page.evaluate(()=>window.NORTH_WILDWOOD_3D.getMap()),null);
 assert.equal(buildingRoutes.length,0,'Buildings in Leaflet must not request native building assets');
 await page.locator('.nw-simple-view').click();
 // WebGL fallback can finish without ever reaching the building request.
 for(let i=0;i<230&&!buildingRoutes.length;i++){
  if(await page.locator('.nw-simple-view').getAttribute('aria-busy')==='false')break;
  await page.waitForTimeout(100);
 }
 if(!buildingRoutes.length){
  await page.waitForFunction(()=>!window.NORTH_WILDWOOD_3D.getMap()&&document.body.dataset.map3d==='fallback',{},{timeout:5000});
  assert.equal(await page.locator('#buildingsToggle').getAttribute('aria-checked'),'true');
  assert.equal(await page.evaluate(()=>map.hasLayer(buildingsLayer)),true);
  result.webgl='unavailable or startup timed out: 2D retained';result.checks.push('Unavailable WebGL preserves the 2D Buildings layer');
 }else{
  await page.locator('#mapClickDepthBtn').click();assert.equal(await page.evaluate(()=>mapClickMode),'depth');
  for(const route of buildingRoutes){const response=await route.fetch({timeout:15000});await route.fulfill({response});}
  await page.unroute(buildingPattern,holdBuildings);
  await page.waitForFunction(()=>window.NORTH_WILDWOOD_3D.state().ready&&window.NORTH_WILDWOOD_3D.state().pitch===60&&document.querySelector('.nw-simple-view').getAttribute('aria-busy')==='false',{},{timeout:20000});
  assert.equal(await page.evaluate(()=>mapClickMode),'depth');
  assert.equal(await page.locator('#mapClickDepthBtn').getAttribute('aria-pressed'),'true');
  result.checks.push('Manual 3D entry preserves an explicit Flood Depth choice while loading building assets');
  await page.locator('.nw-simple-view').click();await page.waitForFunction(()=>window.NORTH_WILDWOOD_3D.state().pitch===0,{},{timeout:10000});
  await page.locator('#observedDataBtn').click();await page.waitForFunction(()=>currentDataMode==='observed'&&floodFrameState==='ready',{},{timeout:60000});await page.evaluate(()=>loadObservedDay('2026-09-26'));
  await page.waitForFunction(()=>{const s=window.NORTH_WILDWOOD_3D.getMap().getSource('nw-flood-drape-source');return s?.loaded()&&s.image&&s.url===currentFloodLayer?._url;},{},{timeout:20000});
  const before=await snapshot();result.states.push({label:'storm-before',...before});
  const target=await page.evaluate(async()=>{for(let i=0;i<currentSeriesHours.length;i++){const e=currentSeriesHours[i];if(getStageValue(e)<=1)continue;const a=await getHydraulicOverlayRecord(currentOverlayMode,getOverlayStage(getStageValue(e)),getHydraulicPhaseForEntry(e,i,currentSeriesHours),e,currentRawSeriesHours);if(a?.url&&!a.url.startsWith('blob:')&&a.url!==currentFloodLayer._url)return{index:i,url:a.url,stage:getStageValue(e),time:e.timeUtc};}return null;});assert.ok(target,'Use a real positive-water static storm asset');result.target=target;
  let failure=true,failedRequests=0;const failNative=route=>{if(failure&&route.request().resourceType()==='fetch'){failedRequests++;return route.abort('failed');}return route.continue();};await page.route(target.url,failNative);
  await page.evaluate(i=>renderHour(i),target.index);const failed=await snapshot();result.states.push({label:'native-image-failed',...failed});assert.ok(failedRequests>=2,'The real renderer must retry a transient failure once');assert.equal(failed.index,before.index,'A failed native image cannot advance the selected time');assert.equal(failed.url,before.url);assert.equal(failed.sourceUrl,before.url,'The native image source rolls back to the committed frame');
  failure=false;await page.evaluate(i=>renderHour(i),target.index);const recovered=await snapshot();result.states.push({label:'native-image-recovered',...recovered});assert.equal(recovered.index,target.index);assert.equal(recovered.url,target.url);assert.equal(recovered.sourceUrl,target.url);assert.equal(recovered.sourceLoaded,true);result.checks.push('A failed native top-down image retains the committed storm time and retries successfully without reload');
  await page.unroute(target.url,failNative);
  // Hold one native image request, select another real frame, then release the
  // obsolete transport. The late image must not replace the newer selection.
  await page.evaluate(i=>renderHour(i),before.index);let held=[];const holdNative=route=>{if(route.request().resourceType()==='fetch'){held.push(route);return;}return route.continue();};await page.route(target.url,holdNative);
  await page.evaluate(i=>{window.__pendingNativeSelection=renderHour(i);},target.index);for(let i=0;i<100&&!held.length;i++)await page.waitForTimeout(50);assert.ok(held.length);
  const latestIndex=(target.index+1)%await page.evaluate(()=>currentSeriesHours.length);await page.evaluate(i=>renderHour(i),latestIndex);const latest=await snapshot();
  for(const route of held)await route.continue().catch(()=>{});await page.unroute(target.url,holdNative);await page.evaluate(()=>window.__pendingNativeSelection);await page.waitForTimeout(300);const afterLate=await snapshot();result.states.push({label:'late-obsolete-native-image',...afterLate});assert.equal(afterLate.index,latest.index);assert.equal(afterLate.url,latest.url);assert.equal(afterLate.sourceUrl,latest.url);assert.equal(afterLate.sourceLoaded,true);result.checks.push('A late obsolete native image cannot overwrite a newer time selection');result.webgl='3D and native top-down cases exercised';
 }
 assert.deepEqual(result.errors,[]);await page.screenshot({path:path.join(output,`${name}-followup-3d.png`)});
}catch(e){result.failure=e.stack;result.states.push(await snapshot().catch(()=>({label:'unavailable'})));throw e;}
finally{await browser.close();fs.writeFileSync(path.join(output,`${name}-followup-3d.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
