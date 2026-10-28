// Diagnostic branch only. Never used as a release check or published asset.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'query-diagnostic');fs.mkdirSync(output,{recursive:true});
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:8771/index.html';
const expected={
  query:{width:2186,height:2824,samples:[{x:437,y:564,rgba:[0,0,255,255]},{x:874,y:1129,rgba:[0,0,255,255]},{x:1093,y:1412,rgba:[127,221,15,255]},{x:1311,y:1694,rgba:[128,62,112,255]},{x:1748,y:2259,rgba:[0,0,255,255]}]},
  developed:{width:2186,height:2824,samples:[{x:437,y:564,rgba:[255,255,0,255]},{x:874,y:1129,rgba:[255,255,0,255]},{x:1093,y:1412,rgba:[0,0,0,255]},{x:1311,y:1694,rgba:[8,192,255,255]},{x:1748,y:2259,rgba:[255,255,0,255]}]}
};
for(const [key,file] of [['query','NorthWildwoodHydraulicQuery5ft.png'],['developed','NorthWildwoodDevelopedMask5ft.png']]){
  const bytes=fs.readFileSync(path.join(root,'assets/hydraulic-v29/COGs/North Wildwood',file));
  Object.assign(expected[key],{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
const result={startedAt:new Date().toISOString(),sourceBaseline:'6405fe5c3fff7712ee9473d83033c17b4557d3e6',diagnosticCommit:process.env.NWW_DIAGNOSTIC_SHA,
  scope:'Actual application and assets. No routes, interception, mocks, cache overrides, application timer changes or retries. Application getter deadline remains20s. Independent raw probes also have20s observation deadlines.',
  environment:{platform:process.platform,arch:process.arch,node:process.version,cpus:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem()},expected,cases:[]};
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:process.env.NWW_CHROMIUM_CHANNEL||'chromium'}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
result.browser=browser.version();
function safeUrl(value){try{const u=new URL(value);for(const k of [...u.searchParams.keys()])if(/token|key|secret/i.test(k))u.searchParams.set(k,'[redacted]');return u.href;}catch{return value;}}
function checkPixels(value,fixture){assert.equal(value.width,fixture.width);assert.equal(value.height,fixture.height);assert.equal(value.length,fixture.width*fixture.height*4);assert.deepEqual(value.samples,fixture.samples);}
async function snapshot(page){return page.evaluate(()=>{
  const e=currentSeriesHours?.[currentHourIndex],modal=document.getElementById('downloadModal');
  const styles=modal?getComputedStyle(modal):null,bodyStyles=getComputedStyle(document.body);
  return{clock:{dateNow:Date.now(),performanceNow:performance.now(),timeOrigin:performance.timeOrigin},telemetry:window.__queryDiagnostic,
    queryCached:!!depthQueryGridPromise,developedCached:!!developedQueryGridPromise,queryUrl:DEPTH_QUERY_PNG_URL,developedUrl:DEVELOPED_QUERY_PNG_URL,
    selected:e?{time:e.timeUtc,stage:getStageValue(e),phase:getHydraulicPhaseForEntry(e,currentHourIndex,currentSeriesHours)}:null,
    appReady:document.body.classList.contains('nw-app-ready'),frame:floodFrameState,mapView:document.body.dataset.mapViewMode,bodyClasses:document.body.className,
    modal:modal?{hidden:modal.hidden,ariaHidden:modal.getAttribute('aria-hidden'),className:modal.className,display:styles.display,visibility:styles.visibility,backdropFilter:styles.backdropFilter,webkitBackdropFilter:styles.webkitBackdropFilter}:null,
    backdropNodes:[...document.querySelectorAll('[class*="backdrop"], [class*="modal-overlay"], #downloadModal')].filter(n=>n.getClientRects().length).map(n=>({id:n.id,className:n.className,filter:getComputedStyle(n).filter,backdropFilter:getComputedStyle(n).backdropFilter})),
    bodyFilter:bodyStyles.filter,resources:performance.getEntriesByType('resource').filter(e=>/NorthWildwood(?:HydraulicQuery|DevelopedMask)5ft\.png/i.test(e.name)).map(e=>e.toJSON()),
    floodImage:(()=>{const i=exportFloodLayer?.getElement?.();return i?{src:i.currentSrc||i.src,complete:i.complete,width:i.naturalWidth,height:i.naturalHeight,ready:exportFloodLayer._nwwExportFloodReady}:null;})()};
});}
async function runCase(name,fn){
  const item={name,startedAt:new Date().toISOString(),events:[],cdp:[],errors:[],warnings:[]};result.cases.push(item);
  const context=await browser.newContext({viewport:{width:1440,height:1000}});let page;
  try{
    await context.addInitScript(()=>{
      const clock=()=>({dateNow:Date.now(),performanceNow:performance.now(),timeOrigin:performance.timeOrigin});
      const data=window.__queryDiagnostic={initialClock:clock(),longTasks:[],eventLoopLag:[]};
      try{new PerformanceObserver(list=>{for(const e of list.getEntries())data.longTasks.push({startTime:e.startTime,duration:e.duration,name:e.name,clock:clock()});}).observe({type:'longtask',buffered:true});}catch(e){data.observerError=e.message;}
      let previous=performance.now();setInterval(()=>{const now=performance.now(),lag=now-previous-250;if(lag>50)data.eventLoopLag.push({lag,clock:clock()});previous=now;},250);
    });
    page=await context.newPage();page.setDefaultTimeout(30000);
    const ids=new WeakMap();let nextId=0;const id=r=>{if(!ids.has(r))ids.set(r,++nextId);return ids.get(r);};
    page.on('pageerror',e=>item.errors.push(e.message));
    page.on('console',m=>{if(['warning','error'].includes(m.type()))item.warnings.push({type:m.type(),text:m.text()});});
    page.on('request',r=>item.events.push({event:'requested',id:id(r),observedAt:new Date().toISOString(),url:safeUrl(r.url()),type:r.resourceType()}));
    page.on('response',r=>{const h=r.headers();item.events.push({event:'headers',id:id(r.request()),observedAt:new Date().toISOString(),url:safeUrl(r.url()),status:r.status(),headers:{'content-type':h['content-type'],'content-length':h['content-length'],'cache-control':h['cache-control'],'last-modified':h['last-modified'],server:h.server}});});
    page.on('requestfinished',r=>item.events.push({event:'finished',id:id(r),observedAt:new Date().toISOString(),url:safeUrl(r.url()),timing:r.timing()}));
    page.on('requestfailed',r=>item.events.push({event:'failed',id:id(r),observedAt:new Date().toISOString(),url:safeUrl(r.url()),error:r.failure()?.errorText,timing:r.timing()}));
    const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent',p=>item.cdp.push({event:'requestWillBeSent',observedAt:new Date().toISOString(),requestId:p.requestId,timestamp:p.timestamp,wallTime:p.wallTime,url:safeUrl(p.request.url),type:p.type,initialPriority:p.request.initialPriority,initiator:p.initiator?.type}));
    cdp.on('Network.responseReceived',p=>item.cdp.push({event:'responseReceived',observedAt:new Date().toISOString(),requestId:p.requestId,timestamp:p.timestamp,url:safeUrl(p.response.url),status:p.response.status,protocol:p.response.protocol,fromDiskCache:p.response.fromDiskCache,fromServiceWorker:p.response.fromServiceWorker,timing:p.response.timing}));
    for(const event of ['Network.loadingFinished','Network.loadingFailed','Network.resourceChangedPriority'])cdp.on(event,p=>item.cdp.push({event,observedAt:new Date().toISOString(),...p}));
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
    item.before=await snapshot(page);await fn(page,item);item.passed=true;
  }catch(e){item.passed=false;item.failure=e.stack;}
  finally{
    if(page){item.after=await snapshot(page).catch(e=>({snapshotError:e.message}));await page.screenshot({path:path.join(output,`${name}.png`),timeout:15000}).catch(e=>{item.screenshotError=e.message;});}
    await context.close();item.completedAt=new Date().toISOString();
    fs.writeFileSync(path.join(output,`${name}.json`),JSON.stringify(item,null,2)+'\n');
    console.log(JSON.stringify({name,passed:item.passed,failure:item.failure,measurements:item.measurements},null,2));
  }
}
try{
  await runCase('01-cold-actual-getters',async(page,item)=>{
    assert.equal(item.before.queryCached,false,'Actual query getter must be cold');assert.equal(item.before.developedCached,false,'Actual developed getter must be cold');
    item.measurements=await page.evaluate(async expected=>{
      const started={dateNow:Date.now(),performanceNow:performance.now(),timeOrigin:performance.timeOrigin};
      const results=await Promise.allSettled([getDepthQueryGrid(),getDevelopedQueryGrid()]);
      const summarize=(g,f)=>({width:g.width,height:g.height,length:g.values.length,samples:f.samples.map(({x,y})=>({x,y,rgba:[...g.values.slice((y*g.width+x)*4,(y*g.width+x)*4+4)]}))});
      const summary=results.map((r,i)=>r.status==='fulfilled'?{status:r.status,value:summarize(r.value,expected[i?'developed':'query'])}:{status:r.status,error:{name:r.reason?.name,message:r.reason?.message}});
      let worldSample=null;
      if(results.every(r=>r.status==='fulfilled')){
        const g=results[0].value,c=getConfiguredWorldFileCornersLatLng().map(p=>L.CRS.EPSG3857.project(p)),u=1311.5/g.width,v=1694.5/g.height;
        const point=L.CRS.EPSG3857.unproject({x:c[0].x+(c[1].x-c[0].x)*u+(c[3].x-c[0].x)*v,y:c[0].y+(c[1].y-c[0].y)*u+(c[3].y-c[0].y)*v});
        worldSample={location:point,value:await samplePackedDepthGrid(point.lat,point.lng)};
      }
      return{started,completed:{dateNow:Date.now(),performanceNow:performance.now()},elapsedMs:performance.now()-started.performanceNow,summary,worldSample};
    },expected);
    for(const [i,key]of ['query','developed'].entries()){assert.equal(item.measurements.summary[i].status,'fulfilled',JSON.stringify(item.measurements.summary[i]));checkPixels(item.measurements.summary[i].value,expected[key]);}
    const v=item.measurements.worldSample.value;assert.equal(v.elevation,6.2);assert.equal(v.connectionStage,6.2);assert.equal(v.developedFlag,true);assert.equal(v.sourceDistanceFt,2240);
  });
  await runCase('02-cold-actual-export',async(page,item)=>{
    assert.equal(item.before.queryCached,false,'Cold export starts without a preloaded query grid');
    await page.locator('#openDownloadModalBtn').click();await page.locator('#exportFormatPngBtn').click();
    const date=await page.locator('#downloadStartDateText').inputValue(),time=await page.locator('#downloadStartTimeSelect').inputValue();
    await page.locator('#downloadEndDateText').fill(date);await page.locator('#downloadEndTimeSelect').focus();await page.locator('#downloadEndTimeSelect').selectOption(time);
    if(await page.locator('#downloadModal').getAttribute('data-export-step')!=='review')await page.locator('#downloadBtn').click();
    await page.locator('#exportAspectSquareBtn').click();await page.locator('#exportExtentTownBtn').click();
    item.modalOpened=await snapshot(page);
    await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:180000});
    item.measurements=await page.evaluate(()=>({state:document.getElementById('exportPreview').dataset.state,status:document.getElementById('exportPreviewStatus').textContent,clock:{dateNow:Date.now(),performanceNow:performance.now(),timeOrigin:performance.timeOrigin},format:getDownloadFormatValue(),dimensions:getExportAspectConfig()}));
    assert.equal(item.measurements.state,'ready',JSON.stringify(item.measurements));
    const grids=await page.evaluate(async expected=>{const [q,d]=await Promise.all([getDepthQueryGrid(),getDevelopedQueryGrid()]);return[q,d].map((g,i)=>({width:g.width,height:g.height,length:g.values.length,samples:expected[i?'developed':'query'].samples.map(({x,y})=>({x,y,rgba:[...g.values.slice((y*g.width+x)*4,(y*g.width+x)*4+4)]}))}));},expected);
    checkPixels(grids[0],expected.query);checkPixels(grids[1],expected.developed);item.decodedGrids=grids;
  });

}finally{
  await browser.close();result.completedAt=new Date().toISOString();result.passed=result.cases.length===2&&result.cases.every(c=>c.passed);
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:result.passed,browser:result.browser,cases:result.cases.map(c=>({name:c.name,passed:c.passed,failure:c.failure}))},null,2));
  if(!result.passed)process.exitCode=1;
}
