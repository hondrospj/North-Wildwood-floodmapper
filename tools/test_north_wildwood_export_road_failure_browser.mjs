// Full app: a selected road-label provider outage must produce a visible,
// retryable preview error. Only that provider's HTTP boundary is controlled.
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
  fixture:'Road tiles first return 503, then a valid transparent 1px PNG. This tests transport recovery, not geographic road-label correctness.'};
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
let outage=true,failedRequests=0,recoveredRequests=0,workerRequests=0,documents=0;
const invalidLevels=[];
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==','base64');
await page.route(/World_Transportation\/MapServer\/tile\//,route=>{
  const level=new URL(route.request().url()).pathname.split('/tile/')[1]?.split('/')[0];
  if(!/^\d+$/.test(level))invalidLevels.push({level,outage,url:route.request().url()});
  if(outage){failedRequests++;return route.fulfill({status:503,contentType:'text/plain',body:'Controlled road-provider outage'});}
  if(!/^\d+$/.test(level))return route.fulfill({status:400,contentType:'text/plain',body:'Tile level must be an integer'});
  recoveredRequests++;return route.fulfill({status:200,contentType:'image/png',headers:{'access-control-allow-origin':'*'},body:tile});
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
    layer:{pane:exportRoadsLayer?.options.pane,tileSize:exportRoadsLayer?.options.tileSize,
      zoomOffset:exportRoadsLayer?.options.zoomOffset,opacity:exportRoadsLayer?.options.opacity,
      index:parent?[...parent.children].indexOf(container):null},
    roadTiles:[...(exportRoadsLayer?.getContainer?.()?.querySelectorAll('canvas.leaflet-tile')||[])].map(tile=>({complete:tile.complete,width:tile.naturalWidth})),
    selection:{mode:currentDataMode,index:currentHourIndex,time:entry.timeUtc,stage:getStageValue(entry)}};
},label);
try{
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  if(await page.locator('#roadsToggle').getAttribute('aria-checked')!=='true')await page.locator('#roadsToggle').click();
  await page.locator('#openDownloadModalBtn').click();await page.locator('#exportFormatPngBtn').click();
  await page.locator('#downloadBtn').click();await page.locator('#exportAspectSquareBtn').click();
  await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:90000});
  const failed=await snapshot('controlled-outage');result.states.push(failed);
  assert.ok(failedRequests>0);assert.equal(failed.state,'error');assert.match(failed.status,/couldn.t load|try again/i);
  assert.equal(failed.retryVisible,true);assert.equal(failed.retryEnabled,true);assert.equal(failed.downloadEnabled,true);assert.equal(failed.busy,false);
  assert.equal(failed.roadsEnabled,'true');assert.ok(failed.roadTiles.some(tile=>tile.complete&&tile.width===0));
  assert.ok(Math.abs(failed.camera.zoom-Math.round(failed.camera.zoom))>1e-6,'The fixture must exercise a fractional export camera zoom');
  assert.equal(workerRequests,0);
  await page.evaluate(()=>{window.__failedRoadLayer=exportRoadsLayer;window.__failedRoadMap=exportMap;window.__failedRoadOptions=exportRoadsLayer.options;});
  result.checks.push('A selected road-provider 503 produces a visible preview error with enabled Retry/Download, before any GIF worker');
  if(retained)await page.screenshot({path:path.join(output,`${name}-road-outage.png`)});
  outage=false;
  await page.locator('#exportPreviewRetryBtn').click();
  await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:90000});
  const recovered=await snapshot('retry-after-network-recovery');result.states.push(recovered);
  assert.equal(recovered.state,'ready',JSON.stringify({recovered,warnings:result.warnings}));
  assert.ok(recoveredRequests>0);assert.equal(recovered.roadsEnabled,'true');assert.equal(recovered.downloadEnabled,true);
  assert.deepEqual(recovered.selection,failed.selection);assert.equal(workerRequests,0);assert.equal(documents,1);
  assert.deepEqual(recovered.camera,failed.camera);assert.deepEqual(recovered.layer,failed.layer);
  assert.equal(await page.evaluate(()=>window.__failedRoadLayer===exportRoadsLayer&&window.__failedRoadMap===exportMap&&window.__failedRoadOptions===exportRoadsLayer.options),true);
  assert.equal(await page.evaluate(()=>Number.isInteger(exportRoadsLayer._tileZoom)),true);
  assert.ok(recovered.roadTiles.length>0&&recovered.roadTiles.every(tile=>tile.complete&&tile.width>0));
  assert.deepEqual(invalidLevels,[],'Retry must retain integer tile-service levels at fractional export camera zoom');
  result.checks.push('Actual Retry redraws the failed road tiles and produces a ready preview on the same renderer without reload or selection changes');
  if(retained)await page.screenshot({path:path.join(output,`${name}-road-recovered.png`)});
  assert.deepEqual(result.errors,[]);
}catch(error){
  result.failure=error.stack;
  result.states.push(await snapshot('failure').catch(()=>({label:'page unavailable'})));
  if(retained)await page.screenshot({path:path.join(output,`${name}-road-failure.png`)}).catch(()=>{});
  throw error;
}finally{
  await Promise.allSettled(warningDetails);
  result.transport={failedRequests,recoveredRequests,workerRequests,documents,invalidLevels};
  await browser.close();
  if(retained)fs.writeFileSync(path.join(output,`${name}-road-preview.json`),JSON.stringify(result,null,2));
  else fs.rmSync(output,{recursive:true,force:true});
  console.log(JSON.stringify(result,null,2));
}
