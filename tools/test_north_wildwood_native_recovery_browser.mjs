// Actual WebGL loss/restoration, real storm images, and native view-button retry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium',engine=playwright[name==='edge'?'chromium':name];
const browser=await engine.launch({headless:true,...(name==='edge'?{channel:'msedge'}:{}),
 ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
 ...(name==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
 ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),
});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9043/index.html';
const out=process.env.NWW_AUDIT_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'nww-native-recovery-'));fs.mkdirSync(out,{recursive:true});
const result={browser:name,version:browser.version(),cases:[],errors:[]};
async function snapshot(page){return page.evaluate(()=>{const renderer=window.NORTH_WILDWOOD_3D.getMap(),source=renderer?.getSource('nw-flood-drape-source');return{
 state:document.body.dataset.map3d,plane:document.body.dataset.map3dFloodTexture,nativeLoaded:source?.loaded(),nativeImage:!!source?.image,
 nativeUrl:source?.url,pitch:renderer?.getPitch(),bearing:renderer?.getBearing(),zoom:renderer?.getZoom(),center:renderer?.getCenter(),
 index:currentHourIndex,time:currentSeriesHours[currentHourIndex]?.timeUtc,url:currentFloodLayer?._url,
 status:document.getElementById('map3dStatus').textContent};});}
function sameSelectionAndView(actual,expected){
 for(const key of ['index','time','url','pitch','bearing'])assert.equal(actual[key],expected[key],`${key} survives graphics recovery`);
 assert.ok(Math.abs(actual.zoom-expected.zoom)<.02,'Recovery retains camera zoom');
 assert.ok(Math.abs(actual.center.lng-expected.center.lng)<1e-6&&Math.abs(actual.center.lat-expected.center.lat)<1e-6,'Recovery retains map center');
}
try{
 for(const pitch of [0,60])for(const failNative of [false,true]){
  if(process.env.NWW_RECOVERY_CASE&&process.env.NWW_RECOVERY_CASE!==`${pitch}-${failNative?'failure':'healthy'}`)continue;
  const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
  page.on('pageerror',error=>result.errors.push(error.message));
  const row={pitch,failNative,requests:[]};result.cases.push(row);
  try{
   await page.goto(url,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:120000});
   row.initialControlReadiness=await page.evaluate(()=>({appInert:document.getElementById('app').inert,loaderHidden:document.getElementById('nwSiteLoader').hidden,loaderClass:document.getElementById('nwSiteLoader').className}));
   // The welcome screen intentionally keeps controls inert for its completion
   // pause after nw-app-ready. A focus() call during that pause cannot send the
   // compass key, unlike native clicks that automatically wait for the overlay.
   await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
   await page.locator('.nw-direction-wheel').focus();
   assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('nw-direction-wheel')),true,'Send the native key only after the actual compass accepts focus');
   await page.keyboard.press('ArrowUp');
   await page.waitForFunction(()=>window.NORTH_WILDWOOD_3D.state().ready||document.body.dataset.map3d==='fallback',{},{timeout:25000});
   if(!await page.evaluate(()=>window.NORTH_WILDWOOD_3D.state().ready)){
    row.skipped='The profile cannot initialize WebGL; the actual 2D fallback remains active.';break;
   }
   if(pitch===60){await page.locator('.nw-simple-view').click();await page.waitForFunction(()=>window.NORTH_WILDWOOD_3D.state().pitch===60&&document.querySelector('.nw-simple-view').getAttribute('aria-busy')==='false');}
   await page.locator('#observedDataBtn').click();await page.waitForFunction(()=>currentDataMode==='observed'&&floodFrameState==='ready',{},{timeout:90000});
   await page.evaluate(()=>loadObservedDay('2026-09-26'));
   row.target=await page.evaluate(async()=>{for(let index=0;index<currentSeriesHours.length;index++){
    const entry=currentSeriesHours[index];if(getStageValue(entry)<=1)continue;
    const asset=await getHydraulicOverlayRecord(currentOverlayMode,getOverlayStage(getStageValue(entry)),getHydraulicPhaseForEntry(entry,index,currentSeriesHours),entry,currentRawSeriesHours);
    if(asset?.url&&!asset.url.startsWith('blob:')){await renderHour(index);return{index,url:asset.url,stage:getStageValue(entry)};}
   }return null;});
   assert.ok(row.target,'Use a real positive-water storm image');
   await page.waitForFunction(()=>{const source=window.NORTH_WILDWOOD_3D.getMap().getSource('nw-flood-drape-source');return source?.loaded()&&source.image;},{},{timeout:30000});
   row.before=await snapshot(page);let failing=failNative;
   await page.route(row.target.url,route=>{const kind=route.request().resourceType();row.requests.push({kind,url:route.request().url()});return failing&&kind==='fetch'?route.abort('failed'):route.continue();});
   const extension=await page.evaluate(()=>{const gl=window.NORTH_WILDWOOD_3D.getMap().getCanvas().getContext('webgl2');window.__nwwRecoveryTestExtension=gl?.getExtension('WEBGL_lose_context');return!!window.__nwwRecoveryTestExtension;});
   if(!extension){row.skipped='WEBGL_lose_context is unavailable in this native profile; no restoration claim.';continue;}
   await page.evaluate(()=>window.__nwwRecoveryTestExtension.loseContext());
   await page.waitForFunction(()=>document.body.dataset.map3d==='recovering',{},{timeout:5000});
   await page.waitForTimeout(100);await page.evaluate(()=>window.__nwwRecoveryTestExtension.restoreContext());
   await page.waitForFunction(()=>['ready','unavailable'].includes(document.body.dataset.map3d),{},{timeout:25000});
   row.restored=await snapshot(page);sameSelectionAndView(row.restored,row.before);
   if(failNative){
    assert.ok(row.requests.some(request=>request.kind==='fetch'),'The actual native image transport failed');
    // The plane can decode a cached image without a network request. Recovery
    // clears the old texture, so ready here requires a successful new upload.
    assert.equal(row.restored.plane,'ready','The independent GPU plane uploaded its image during recovery');
    assert.equal(row.restored.nativeLoaded,true);assert.equal(row.restored.nativeImage,false);
    assert.equal(row.restored.state,'unavailable','A healthy hidden plane cannot certify a missing native image');
    assert.match(row.restored.status,/could not recover/i);failing=false;
    await page.locator('.nw-simple-view').click();
    await page.waitForFunction(()=>document.body.dataset.map3d==='ready'&&document.querySelector('.nw-simple-view').getAttribute('aria-busy')==='false',{},{timeout:25000});
    row.retried=await snapshot(page);assert.equal(row.retried.nativeImage,true);assert.equal(row.retried.nativeUrl,row.before.url);sameSelectionAndView(row.retried,row.before);
   }else{
    assert.equal(row.restored.state,'ready');assert.equal(row.restored.nativeImage,true);assert.equal(row.restored.nativeUrl,row.before.url);
   }
   await page.screenshot({path:path.join(out,`${name}-native-recovery-${pitch}-${failNative?'retry':'healthy'}.png`)});
  }catch(error){row.failure=error.stack;row.failedState=await snapshot(page).catch(()=>null);throw error;}
  finally{await page.close();}
 }
 assert.deepEqual(result.errors,[]);console.log(JSON.stringify({browser:name,version:result.version,cases:result.cases.map(row=>({pitch:row.pitch,failNative:row.failNative,skipped:row.skipped,restored:row.restored?.state,retried:row.retried?.state})),errors:result.errors},null,2));
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();fs.writeFileSync(path.join(out,`${name}-native-recovery.json`),JSON.stringify(result,null,2)+'\n');}
