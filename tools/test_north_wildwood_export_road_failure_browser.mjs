// Full app: a real vector-road provider outage must produce a visible, retryable
// preview error. Recovery uses genuine provider PBFs; only transport is controlled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
  ...(name==='edge'?{channel:'msedge'}:{}),
  ...(name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
  ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const retained=process.env.NWW_AUDIT_OUTPUT;
const output=retained||fs.mkdtempSync(path.join(os.tmpdir(),'nww-road-preview-'));
fs.mkdirSync(output,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],states:[],errors:[],warnings:[],
  fixture:'After native startup, Esri vector tiles return HTTP503. Retry then uses real provider PBFs and must render genuine road symbols on the same renderer.'};
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(30000);page.on('pageerror',error=>result.errors.push(error.message));
const warningDetails=[];
page.on('console',message=>{
  if(message.type()!=='warning')return;
  const warning={message:message.text(),errors:[]};result.warnings.push(warning);
  warningDetails.push(Promise.all(message.args().map(handle=>handle.evaluate(value=>
    value instanceof Error?{name:value.name,message:value.message,stack:value.stack}:null).catch(()=>null)))
    .then(errors=>{warning.errors=errors.filter(Boolean);}));
});
let outage=true,failedRequests=0,recoveredRequests=0,recoveredResponses=0,workerRequests=0,documents=0;
const invalidLevels=[];
const vectorTilePattern=/\/OpenStreetMap_v2\/VectorTileServer\/tile\//i;
async function installRoadOutage(){
  await page.route(vectorTilePattern,route=>{
    const parts=new URL(route.request().url()).pathname.split('/tile/')[1];
    if(!/^\d+\/\d+\/\d+\.pbf$/.test(parts||''))invalidLevels.push({parts,outage,url:route.request().url()});
    if(outage){failedRequests++;return route.fulfill({status:503,contentType:'text/plain',headers:{'access-control-allow-origin':'*'},body:'Controlled vector-road provider outage'});}
    recoveredRequests++;return route.continue();
  });
}
page.on('response',response=>{
  if(!outage&&vectorTilePattern.test(response.url())&&response.status()===200)recoveredResponses++;
});
page.on('request',request=>{
  if(/\/gif\.worker\.js(?:\?|$)/.test(request.url()))workerRequests++;
  if(request.isNavigationRequest()&&request.frame()===page.mainFrame())documents++;
});
const snapshot=label=>page.evaluate(label=>{
  const preview=document.getElementById('exportPreview'),retry=document.getElementById('exportPreviewRetryBtn');
  const entry=currentSeriesHours[currentHourIndex];
  const container=exportRoadsLayer?.getContainer?.(),parent=container?.parentNode;
  const center=exportMap?.getCenter();
  return{label,state:preview?.dataset.state,status:document.getElementById('exportPreviewStatus')?.textContent,
    retryVisible:!!retry&&!retry.hidden&&retry.getClientRects().length>0,retryEnabled:!!retry&&!retry.disabled,
    downloadEnabled:!document.getElementById('downloadBtn').disabled,busy:exportInProgress,
    roadsEnabled:document.getElementById('roadsToggle').getAttribute('aria-checked'),
    camera:{zoom:exportMap?.getZoom(),lat:center?.lat,lng:center?.lng},
    layer:{pane:exportRoadsLayer?.options.pane,opacity:exportRoadsLayer?.options.opacity,
      index:parent?[...parent.children].indexOf(container):null},
    roadVector:(()=>{
      const layer=exportRoadsLayer,gl=layer?.getMaplibreMap?.(),style=gl?.getStyle?.();
      return{renderer:layer?._shorelyRoadLabels===true,styled:layer?._roadStyled===true,
        ready:layer?._roadReady===true,error:layer?._roadError?.message||null,
        mounted:!!layer&&exportMap?.hasLayer(layer),styleLoaded:gl?.isStyleLoaded?.(),
        loaded:gl?.loaded?.(),tilesLoaded:gl?.areTilesLoaded?.(),zoom:gl?.getZoom?.(),
        layerCount:style?.layers?.length||0,
        onlyRoadSymbols:!!style?.layers?.length&&style.layers.every(item=>item.type==='symbol'&&/^road(?:\s|\/)/i.test(item['source-layer']||'')),
        rendered:gl?.queryRenderedFeatures?.().length||0};
    })(),
    selection:{mode:currentDataMode,index:currentHourIndex,time:entry.timeUtc,stage:getStageValue(entry),
      extent:getDownloadExtentValue(),aspect:getDownloadAspectValue(),mapZoom:map.getZoom(),mapCenter:{lat:map.getCenter().lat,lng:map.getCenter().lng}}};
},label);
try{
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  if(await page.locator('#roadsToggle').getAttribute('aria-checked')!=='true')await page.locator('#roadsToggle').click();
  await page.evaluate(()=>roadsLayer.whenReady({timeoutMs:45000}));
  assert.equal(await page.evaluate(()=>!exportMap),true,'Outage must affect a genuinely cold export renderer');
  await installRoadOutage();
  await page.locator('#openDownloadModalBtn').click();await page.locator('#exportFormatPngBtn').click();
  await page.locator('#downloadBtn').click();await page.locator('#exportAspectSquareBtn').click();
  await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:90000});
  const failed=await snapshot('controlled-outage');result.states.push(failed);
  assert.ok(failedRequests>0);assert.equal(failed.state,'error');assert.match(failed.status,/couldn.t load|could not load|try again/i);
  assert.equal(failed.retryVisible,true);assert.equal(failed.retryEnabled,true);assert.equal(failed.downloadEnabled,true);assert.equal(failed.busy,false);
  assert.equal(failed.roadsEnabled,'true');assert.equal(failed.roadVector.renderer,true);
  assert.ok(failed.roadVector.error,'HTTP503 must reach the actual vector road renderer');
  assert.equal(failed.roadVector.ready,false);assert.equal(failed.roadVector.mounted,true);
  assert.equal(workerRequests,0);
  await page.evaluate(()=>{window.__failedRoadLayer=exportRoadsLayer;window.__failedRoadMap=exportMap;window.__failedRoadOptions=exportRoadsLayer.options;window.__failedRoadGL=exportRoadsLayer.getMaplibreMap();});
  result.checks.push('A selected road-provider 503 produces a visible preview error with enabled Retry/Download, before any GIF worker');
  if(retained)await page.screenshot({path:path.join(output,`${name}-road-outage.png`)});
  outage=false;
  await page.locator('#exportPreviewRetryBtn').click();
  await page.waitForFunction(()=>document.getElementById('exportPreview')?.dataset.state!=='error');
  await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:90000});
  const recovered=await snapshot('retry-after-network-recovery');result.states.push(recovered);
  assert.equal(recovered.state,'ready',JSON.stringify({recovered,warnings:result.warnings}));
  assert.ok(recoveredRequests>0);assert.ok(recoveredResponses>0,'Retry must fetch genuine successful provider vector tiles');assert.equal(recovered.roadsEnabled,'true');assert.equal(recovered.downloadEnabled,true);
  assert.deepEqual(recovered.selection,failed.selection);assert.equal(workerRequests,0);assert.equal(documents,1);
  assert.deepEqual(recovered.layer,failed.layer);
  assert.ok(Math.abs(recovered.camera.zoom-Math.round(recovered.camera.zoom))>1e-6,'Successful recovery must exercise a fractional export camera zoom');
  assert.equal(await page.evaluate(()=>window.__failedRoadLayer===exportRoadsLayer&&window.__failedRoadMap===exportMap&&window.__failedRoadOptions===exportRoadsLayer.options&&window.__failedRoadGL===exportRoadsLayer.getMaplibreMap()),true);
  assert.equal(recovered.roadVector.renderer,true);assert.equal(recovered.roadVector.ready,true);
  assert.equal(recovered.roadVector.error,null);assert.equal(recovered.roadVector.styleLoaded,true);
  assert.equal(recovered.roadVector.loaded,true);assert.equal(recovered.roadVector.tilesLoaded,true);
  assert.equal(recovered.roadVector.onlyRoadSymbols,true);assert.ok(recovered.roadVector.rendered>0);
  assert.ok(Math.abs(recovered.roadVector.zoom-(recovered.camera.zoom-1))<=.02,'The vector camera must match the fractional export camera');
  assert.deepEqual(invalidLevels,[],'Vector requests must retain integer tile-service levels at a fractional camera zoom');
  result.checks.push('Actual Retry refetches genuine vector tiles and produces a ready road preview on the same GL renderer without reload or selection changes');
  if(retained)await page.screenshot({path:path.join(output,`${name}-road-recovered.png`)});
  assert.deepEqual(result.errors,[]);
}catch(error){
  result.failure=error.stack;
  result.states.push(await snapshot('failure').catch(()=>({label:'page unavailable'})));
  if(retained)await page.screenshot({path:path.join(output,`${name}-road-failure.png`)}).catch(()=>{});
  throw error;
}finally{
  await Promise.allSettled(warningDetails);
  result.transport={failedRequests,recoveredRequests,recoveredResponses,workerRequests,documents,invalidLevels};
  await browser.close();
  if(retained)fs.writeFileSync(path.join(output,`${name}-road-preview.json`),JSON.stringify(result,null,2));
  else fs.rmSync(output,{recursive:true,force:true});
  console.log(JSON.stringify(result,null,2));
}
