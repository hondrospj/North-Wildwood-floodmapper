// Actual app, local NJOGIS geometry, rendering and PNG/GIF encoders. The street
// fault uses its own context after native models and a real roads-OFF preview.
// The normal cold-export context has independent caches and never installs a route.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const retained = process.env.NWW_AUDIT_OUTPUT;
const output = retained || fs.mkdtempSync(path.join(os.tmpdir(),'nww-street-labels-'));
fs.mkdirSync(output,{recursive:true});
const result = {browser:name,version:browser.version(),checks:[],states:[],errors:[],warnings:[],previewWarnings:[],httpErrors:[],requestFailures:[],floodTransport:[]};
const pendingPreviewWarnings=[];
const roadDataPattern='**/assets/roads/north-wildwood-road-centerlines.geojson';
const isRoadData=url=>new URL(url).pathname.endsWith('/assets/roads/north-wildwood-road-centerlines.geojson');
const record=(list,value)=>{list.push(value);if(list.length>80)list.shift();};
const diagnosticUrl=value=>{
  try{const url=new URL(value);for(const key of [...url.searchParams.keys()])if(/token|key|secret/i.test(key))url.searchParams.set(key,'[redacted]');return url.href;}
  catch{return String(value);}
};
const modelImageKey=value=>{const url=new URL(value);url.search='';url.hash='';return url.href;};
result.sessions=[];
let page=null,activeSession=null;
function saveState(state){
  const value={session:activeSession.name,...state};
  result.states.push(value);activeSession.log.states.push(value);
}
async function captureInputDiagnostics(){
  if(!page||page.isClosed()||!activeSession||activeSession.log.inputDiagnostics)return;
  let deadline;
  try{
    activeSession.log.inputDiagnostics=await Promise.race([
      page.evaluate(()=>{
        const active=document.activeElement;
        return{...window.__streetLabelInputDiagnostics,capturedAt:Date.now(),performanceNow:performance.now(),
          exportStep:document.getElementById('downloadModal')?.dataset.exportStep,
          previewState:document.getElementById('exportPreview')?.dataset.state,
          activeElement:{id:active?.id,tag:active?.tagName},
          inputs:['downloadStartDateText','downloadEndDateText'].map(id=>{
            const e=document.getElementById(id);if(!e)return{id,present:false};
            const r=e.getBoundingClientRect(),style=getComputedStyle(e),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            return{id,present:true,type:e.type,value:e.value,disabled:e.disabled,readOnly:e.readOnly,
              inert:e.inert||!!e.closest('[inert]'),ariaDisabled:e.getAttribute('aria-disabled'),
              display:style.display,visibility:style.visibility,box:{x:r.x,y:r.y,width:r.width,height:r.height},hitTarget:hit?.id||hit?.tagName};
          })};
      }),
      new Promise(resolve=>{deadline=setTimeout(()=>resolve({unavailable:'Renderer diagnostic evaluation exceeded 3000 ms'}),3000);}),
    ]);
  }catch(error){activeSession.log.inputDiagnostics={unavailable:error.message.slice(0,200)};}
  finally{clearTimeout(deadline);}
}
async function startSession(name){
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const ownedPage=await context.newPage();
  const log={name,routeEverInstalled:false,states:[],errors:[],warnings:[],previewWarnings:[],httpErrors:[],requestFailures:[],floodTransport:[]};
  const session={name,context,page:ownedPage,log,phase:'startup',failures:0,roadDataRequests:0,successfulRequests:0,roadDataResponses:[],modelImages:new Set(),requestIds:new WeakMap(),nextRequestId:0,coldPreviewReady:false,pendingProviderRetries:0,retriedPreviewActions:new Set()};
  const observed=(key,value)=>{
    record(log[key],value);
    record(result[key],typeof value==='string'?`[${name}] ${value}`:{session:name,...value});
  };
  const isModel=url=>session.modelImages.has(modelImageKey(url))||/\/assets\/hydraulic-[^/]+\/.*\.(?:png|webp)(?:\?|$)/i.test(url);
  const requestId=request=>{if(!session.requestIds.has(request))session.requestIds.set(request,++session.nextRequestId);return session.requestIds.get(request);};
  ownedPage.setDefaultTimeout(30000);
  await ownedPage.addInitScript(()=>{
    const d=window.__streetLabelInputDiagnostics={timeOrigin:performance.timeOrigin,events:[],rafGaps:[],longTasks:[],maxRafGap:0,maxLongTask:0,longTasksSupported:false};
    const add=(key,value)=>{d[key].push(value);if(d[key].length>64)d[key].shift();};
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      const target=event.target instanceof Element?event.target.closest('[id]'):null;
      add('events',{type,isTrusted:event.isTrusted,target:target?.id||event.target?.tagName,at:performance.now(),observedAt:Date.now(),
        exportStep:document.getElementById('downloadModal')?.dataset.exportStep,activeElement:document.activeElement?.id});
    },true);
    let previous;
    document.addEventListener('visibilitychange',()=>{previous=undefined;});
    const frame=at=>{if(previous!==undefined&&document.visibilityState==='visible'){
      const gap=at-previous;d.maxRafGap=Math.max(d.maxRafGap,gap);if(gap>100)add('rafGaps',{at,gap});
    }previous=at;requestAnimationFrame(frame);};requestAnimationFrame(frame);
    if(typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes?.includes('longtask')){
      d.longTasksSupported=true;
      new PerformanceObserver(list=>{for(const e of list.getEntries()){d.maxLongTask=Math.max(d.maxLongTask,e.duration);add('longTasks',{at:e.startTime,duration:e.duration});}}).observe({type:'longtask',buffered:true});
    }
  });
  ownedPage.on('pageerror',error=>observed('errors',error.message));
  ownedPage.on('console',message=>{
    if(message.type()!=='warning')return;
    observed('warnings',message.text());
    if(!/Export preview could not be rendered/.test(message.text()))return;
    // Firefox's text may contain only "Error". Capture its actual browser
    // object, retaining arrival order even when argument evaluation completes
    // out of order across different preview jobs.
    const detail={session:name,phase:session.phase,observedAt:new Date().toISOString(),text:message.text(),errors:[],captureErrors:[]};
    record(log.previewWarnings,detail);record(result.previewWarnings,detail);
    pendingPreviewWarnings.push(Promise.all(message.args().map(handle=>handle.evaluate(value=>
      value instanceof Error?{name:value.name,message:value.message,stack:value.stack,exportRasterReadiness:value.exportRasterReadiness||null}:null)
      .catch(error=>({captureError:error.message})))).then(values=>{
      detail.errors=values.filter(value=>value?.name);
      detail.captureErrors=values.filter(value=>value?.captureError).map(value=>value.captureError);
      detail.capturedAt=new Date().toISOString();
    }));
  });
  ownedPage.on('request',request=>{
    if(isRoadData(request.url())){session.roadDataRequests++;log.roadDataRequests=session.roadDataRequests;}
    if(isModel(request.url()))observed('floodTransport',{id:requestId(request),phase:session.phase,event:'requested',observedAt:new Date().toISOString(),url:diagnosticUrl(request.url()),resourceType:request.resourceType()});
  });
  ownedPage.on('response',response=>{
    if(isRoadData(response.url())&&response.status()===200){
      session.successfulRequests++;
      session.roadDataResponses.push(response.json().then(data=>({status:response.status(),type:data.type,features:data.features?.length})).catch(error=>({error:error.message})));
    }
    if(response.status()>=400)observed('httpErrors',{phase:session.phase,observedAt:new Date().toISOString(),url:diagnosticUrl(response.url()),status:response.status(),resourceType:response.request().resourceType()});
    if(isModel(response.url())){
      const headers=response.headers();
      observed('floodTransport',{id:requestId(response.request()),phase:session.phase,event:'headers',observedAt:new Date().toISOString(),url:diagnosticUrl(response.url()),status:response.status(),contentLength:headers['content-length'],contentType:headers['content-type']});
    }
  });
  ownedPage.on('requestfinished',request=>{
    if(isModel(request.url()))observed('floodTransport',{id:requestId(request),phase:session.phase,event:'finished',observedAt:new Date().toISOString(),url:diagnosticUrl(request.url()),timing:request.timing()});
  });
  ownedPage.on('requestfailed',request=>observed('requestFailures',{phase:session.phase,observedAt:new Date().toISOString(),url:diagnosticUrl(request.url()),resourceType:request.resourceType(),failure:request.failure()?.errorText}));
  result.sessions.push(log);page=ownedPage;activeSession=session;
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  if(await page.locator('#roadsToggle').getAttribute('aria-checked')!=='true')await page.locator('#roadsToggle').click();
  const modelInputs=await page.evaluate(()=>({queryUrl:DEPTH_QUERY_PNG_URL,developedUrl:DEVELOPED_QUERY_PNG_URL,
    queryCached:!!depthQueryGridPromise,developedCached:!!developedQueryGridPromise,exportMapCreated:!!exportMap,
    performanceTimeOrigin:performance.timeOrigin,performanceNow:performance.now()}));
  for(const url of [modelInputs.queryUrl,modelInputs.developedUrl])if(url)session.modelImages.add(modelImageKey(url));
  saveState({label:'initial-model-inputs',...modelInputs});
  return session;
}
async function strictModelReadiness(){
  activeSession.phase='native-model-prerequisites';
  const model=await page.evaluate(async()=>{
    const started=performance.now();
    try{
      const [query,developed]=await Promise.all([getDepthQueryGrid(),getDevelopedQueryGrid()]);
      const pixel={x:1311,y:1694};
      const summarize=grid=>({width:grid.width,height:grid.height,length:grid.values.length,
        rgba:[...grid.values.slice((pixel.y*grid.width+pixel.x)*4,(pixel.y*grid.width+pixel.x)*4+4)]});
      const corners=getConfiguredWorldFileCornersLatLng().map(corner=>L.CRS.EPSG3857.project(corner));
      const u=(pixel.x+.5)/query.width,v=(pixel.y+.5)/query.height;
      const point={x:corners[0].x+(corners[1].x-corners[0].x)*u+(corners[3].x-corners[0].x)*v,
        y:corners[0].y+(corners[1].y-corners[0].y)*u+(corners[3].y-corners[0].y)*v};
      const location=L.CRS.EPSG3857.unproject(point);
      const sample=await samplePackedDepthGrid(location.lat,location.lng);
      return{ok:true,elapsedMs:performance.now()-started,expectedSize:getWorldFileRasterSize(),
        query:summarize(query),developed:summarize(developed),pixel,location,sample,
        performanceTimeOrigin:performance.timeOrigin,performanceNow:performance.now()};
    }catch(error){return{ok:false,elapsedMs:performance.now()-started,error:{name:error.name,message:error.message}};}
  });
  saveState({label:'strict-native-model-prerequisites',...model});
  assert.equal(model.ok,true,JSON.stringify(model));
  for(const key of ['query','developed']){
    assert.equal(model[key].width,model.expectedSize.width);assert.equal(model[key].height,model.expectedSize.height);
    assert.equal(model[key].length,model[key].width*model[key].height*4);
  }
  assert.deepEqual(model.query.rgba,[128,62,112,255]);assert.deepEqual(model.developed.rgba,[8,192,255,255]);
  assert.equal(model.sample.elevation,6.2);assert.equal(model.sample.connectionStage,6.2);
  assert.equal(model.sample.developedFlag,true);assert.equal(model.sample.sourceDistanceFt,2240);
}

async function flushPreviewWarnings(){
  let completed=0;
  while(completed<pendingPreviewWarnings.length){
    const pending=pendingPreviewWarnings.slice(completed);completed=pendingPreviewWarnings.length;
    await Promise.all(pending);
  }
}
async function terminal(label) {
  activeSession.phase=label;
  await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:180000});
  await flushPreviewWarnings();
  const warning=activeSession.log.previewWarnings.at(-1);
  const inspectCompanions=activeSession.name==='normal-route-free'&&activeSession.log.routeEverInstalled===false&&warning?.session===activeSession.name&&warning.phase===label&&warning.errors.at(-1)?.message==='The map background is still loading. Please try the export again.';
  const state = await page.evaluate(inspectCompanions=>{
    const safely=read=>{try{return read();}catch(error){return{error:error.message};}};
    const publicUrl=value=>{
      if(typeof value!=='string')return value;
      try{const url=new URL(value);for(const key of [...url.searchParams.keys()])if(/token|key|secret/i.test(key))url.searchParams.set(key,'[redacted]');return url.href;}
      catch{return value;}
    };
    const layerState=layer=>{
      if(!layer)return null;
      const container=layer.getContainer?.(),gl=layer._maplibreGL?._glMap;
      const native=[...(container?.querySelectorAll('img.leaflet-tile, canvas.leaflet-tile')||[])];
      const tracked=Object.values(layer._tiles||{});
      return{layerId:layer._leaflet_id??null,kind:typeof layer._createMaplibreLayer==='function'?'vector':'raster',url:typeof layer._url==='string'?publicUrl(layer._url):null,
        mapContains:safely(()=>exportMap.hasLayer(layer)),ownsMap:layer._map===exportMap,mapMissing:!layer._map,
        containerPresent:!!container,containerAttached:!!container?.isConnected,
        isLoading:safely(()=>layer.isLoading?.()),tileZoom:layer._tileZoom,
        native:{count:native.length,complete:native.filter(tile=>tile.complete).length,
          ready:native.filter(tile=>tile.complete&&tile.naturalWidth>0).length,
          failed:native.filter(tile=>tile.complete&&!tile.naturalWidth).length,
          pending:native.filter(tile=>!tile.complete).length,
          tiles:native.map(tile=>({tag:tile.tagName,complete:!!tile.complete,naturalWidth:tile.naturalWidth||0,naturalHeight:tile.naturalHeight||0,
            width:tile.width,height:tile.height,src:tile.tagName==='IMG'?publicUrl(tile.currentSrc||tile.src):null}))},
        tracked:{count:tracked.length,current:tracked.filter(tile=>tile.current).length,loaded:tracked.filter(tile=>tile.loaded).length,
          active:tracked.filter(tile=>tile.active).length,
          tiles:tracked.map(tile=>({current:!!tile.current,loaded:tile.loaded||null,active:!!tile.active,
            coords:tile.coords?{x:tile.coords.x,y:tile.coords.y,z:tile.coords.z}:null,
            complete:!!tile.el?.complete,naturalWidth:tile.el?.naturalWidth||0}))},
        vector:gl?{loaded:safely(()=>gl.loaded()),tilesLoaded:safely(()=>gl.areTilesLoaded())}:null};
    };
    // Observe existing renderers only. Never load, redraw, or capture a layer
    // to make a failed preview eligible for its one native UI Retry.
    const companions=()=>{
      const layer=exportRoadsLayer,gl=layer?.getMaplibreMap?.(),style=gl?.getStyle?.(),container=layer?.getContainer?.(),canvas=gl?.getCanvas?.();
      const size=exportMap.getSize(),center=exportMap.getCenter(),glCenter=gl?.getCenter?.();
      const adjustedLng=glCenter?glCenter.lng+(((center.lng-glCenter.lng+180)%360+360)%360)-180:NaN;
      const a=gl?.project?.({lng:adjustedLng,lat:center.lat}),b=gl?.project?.(glCenter);
      const localCanvases=[...exportMap.getPane('roadsPane').querySelectorAll('.nww-export-road-labels')];
      const local=localCanvases[0],owners=[];
      exportMap.eachLayer(candidate=>{if(candidate._canvas===local&&typeof candidate.getLabels==='function')owners.push(candidate);});
      const owner=owners[0],labels=owner?.getLabels?.()||[],rect=local?.getBoundingClientRect(),mapRect=exportMap.getContainer().getBoundingClientRect();
      const context=local?.getContext('2d');let originClean=false,nonblank=false;
      if(context){context.getImageData(0,0,1,1);originClean=true;
        const box=labels[0]?.box;
        if(box?.length===4){const x=Math.max(0,Math.floor(Math.min(...box.map(p=>p.x)))),y=Math.max(0,Math.floor(Math.min(...box.map(p=>p.y))));
          const w=Math.min(512,local.width-x,Math.ceil(Math.max(...box.map(p=>p.x)))-x),h=Math.min(512,local.height-y,Math.ceil(Math.max(...box.map(p=>p.y)))-y);
          if(w>0&&h>0){const pixels=context.getImageData(x,y,w,h).data;for(let i=3;i<pixels.length;i+=4)if(pixels[i]){nonblank=true;break;}}}}
      return{map:{id:exportMap._leaflet_id,zoom:exportMap.getZoom(),center:{lat:center.lat,lng:center.lng},width:size.x,height:size.y},
        reference:{known:window.ShorelyRoadLabels?.isLayer(layer)===true,version:window.ShorelyRoadLabels?.VERSION,
          source:window.ShorelyRoadLabels?.SOURCE,mounted:layer?._roadMounted,styled:layer?._roadStyled,ready:layer?._roadReady,
          error:layer?._roadError?.message||null,opacity:layer?.options.opacity,containerOpacity:container?Number(getComputedStyle(container).opacity):null,
          styleLoaded:gl?.isStyleLoaded?.(),loaded:gl?.loaded?.(),tilesLoaded:gl?.areTilesLoaded?.(),contextLost:gl?.painter?.context?.gl?.isContextLost?.(),
          canvasAttached:!!canvas?.isConnected&&!!container?.contains(canvas),canvasWidth:canvas?.width,canvasHeight:canvas?.height,
          styleVersion:style?.metadata?.['shorelysafe:road-labels'],styleUnit:style?.metadata?.['shorelysafe:export-unit'],
          onlyShields:!!style?.layers?.length&&style.layers.every(item=>item.type==='symbol'&&/^road(?:\s|\/)/i.test(item['source-layer']||'')&&/shield$/i.test(item.id)&&!!item.layout?.['icon-image']),
          sources:Object.values(style?.sources||{}).map(source=>({type:source.type,url:source.url,tiles:source.tiles})),
          glZoom:gl?.getZoom?.(),centerPixelDelta:a&&b?Math.hypot(a.x-b.x,a.y-b.y):null},
        local:{canvasCount:localCanvases.length,ownerCount:owners.length,layerId:owner?._leaflet_id,mapContains:!!owner&&exportMap.hasLayer(owner),ownsMap:owner?._map===exportMap,
          attached:!!local?.isConnected,visible:!!local&&getComputedStyle(local).display!=='none'&&getComputedStyle(local).visibility!=='hidden',enabled:owner?.options.enabled,
          width:local?.width,height:local?.height,positionDelta:rect?Math.hypot(rect.left-mapRect.left,rect.top-mapRect.top):null,
          unit:owner?.options.unit,expectedUnit:Math.min(getExportAspectConfig().width,getExportAspectConfig().height)/1080,
          family:local?.dataset.fontFamily,bodyFamily:getComputedStyle(document.body).fontFamily,
          labelCount:Number(local?.dataset.labelCount),labels:labels.length,
          geometryValid:labels.length>0&&labels.every(label=>label.name&&label.text&&Number.isFinite(label.fontSize)&&label.fontSize>0&&Array.isArray(label.box)&&label.box.length===4&&label.box.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<=size.x&&p.y<=size.y)),originClean,nonblank}};
    };
    const resource=entry=>({name:publicUrl(entry.name),startTime:entry.startTime,duration:entry.duration,responseStart:entry.responseStart,responseEnd:entry.responseEnd,
      transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize});
    return{state:document.getElementById('exportPreview')?.dataset.state,
    status:document.getElementById('exportPreviewStatus')?.textContent,
    format:getDownloadFormatValue(),aspect:getDownloadAspectValue(),extent:getDownloadExtentValue(),
    dimensions:getExportAspectConfig(),busy:exportInProgress,
    performanceTimeOrigin:performance.timeOrigin,performanceNow:performance.now(),capturedAt:Date.now(),
    floodResourceTiming:performance.getEntriesByType('resource').filter(entry=>/\/assets\/hydraulic-[^/]+\/.*\.(?:png|webp)(?:\?|$)/i.test(entry.name)).slice(-12).map(entry=>({name:entry.name,startTime:entry.startTime,duration:entry.duration,responseStart:entry.responseStart,responseEnd:entry.responseEnd,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize})),
    exportDependencies:performance.getEntriesByType('resource').filter(entry=>/cdn\.jsdelivr\.net|unpkg\.com|VectorTileServer|World_Street_Map|World_Transportation/i.test(entry.name)).slice(-50).map(resource),
    basemap:safely(()=>layerState(exportBasemapColorLayer)),roads:safely(()=>layerState(exportRoadsLayer)),
    companions:inspectCompanions&&document.getElementById('exportPreview')?.dataset.state==='error'?safely(companions):null,
    floodImage:(()=>{const image=exportFloodLayer?.getElement?.();return image?{src:image.currentSrc||image.src,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight}:null;})()};
  },inspectCompanions);
  if(inspectCompanions&&state.state==='error')state.streetDataResponses=await Promise.all(activeSession.roadDataResponses);
  await flushPreviewWarnings();
  saveState({label,...state});
  console.log(`Street-label proof: ${label}: ${state.state}`);
  return state;
}
// A live provider can exceed its unchanged deadline on the first cold preview
// or a later aspect. Retain that native failure and exercise the existing UI
// recovery once per fixed preview action, only with synchronous pending-tile
// evidence from that actual deadline. Every final output assertion is required.
function classifyPendingProviderPreviewRetry(state, warning, context) {
  const no=reason=>({eligible:false,reason});
  if(context?.name!=='normal-route-free'||context.routeEverInstalled!==false)return no('context-not-route-free');
  if(typeof context.coldPreviewReady!=='boolean')return no('cold-preview-state-unproven');
  const actions=['broad-current-view','town-restored','Png-1:1','Png-4:5','Png-16:9','Png-9:16',
    'Gif-1:1','Gif-4:5','Gif-16:9','Gif-9:16','png-download-ready','gif-download-ready',
    'roads-disabled','roads-reenabled','current-crop'];
  if(!actions.includes(context.actionId))return no('unknown-preview-action');
  const used=context.retriedPreviewActions;
  if(!Array.isArray(used)||used.length>actions.length||new Set(used).size!==used.length||used.some(id=>!actions.includes(id))||
      !Number.isInteger(context.pendingProviderRetries)||context.pendingProviderRetries!==used.length)return no('invalid-retry-budget');
  if(used.includes(context.actionId))return no('preview-action-retry-used');
  if(used.length>=actions.length)return no('retry-action-cap');
  if(state?.state!=='error'||state.busy!==false)return no('not-idle-preview-error');
  const error=warning?.errors?.at(-1);
  if(warning?.session!==context.name||warning.phase!==context.actionId||!Array.isArray(warning.captureErrors)||warning.captureErrors.length||
      error?.name!=='Error'||error.message!=='The map background is still loading. Please try the export again.')return no('different-actual-error');
  const deadline=error.exportRasterReadiness;
  if(deadline?.schemaVersion!==1||deadline.reason!=='deadline'||!Number.isFinite(deadline.observedAt)||deadline.observedAt<=0)return no('missing-original-raster-deadline');
  const attached=layer=>layer?.mapContains===true&&layer.ownsMap===true&&layer.mapMissing===false&&
    layer.containerPresent===true&&layer.containerAttached===true;
  const provider=(layer,name,path)=>{
    if(!attached(layer)||layer.kind!=='raster'||!Number.isSafeInteger(layer.layerId)||layer.layerId<=0)return no(`${name}-not-owned-attached-raster`);
    let service;
    try{service=new URL(layer.url);}catch{return no(`different-${name}-provider`);}
    if(service.protocol!=='https:'||service.hostname!=='server.arcgisonline.com'||!service.pathname.startsWith(path))return no(`different-${name}-provider`);
    const native=layer.native,tiles=native?.tiles,tracked=layer.tracked,records=tracked?.tiles;
    const validTile=tile=>tile&&typeof tile.complete==='boolean'&&Number.isInteger(tile.naturalWidth)&&tile.naturalWidth>=0&&(!tile.complete||tile.naturalWidth>0);
    if(!Array.isArray(tiles)||!tiles.length||!tiles.every(validTile)||native.count!==tiles.length||native.failed!==0||
        native.complete!==tiles.filter(tile=>tile.complete).length||native.pending!==tiles.filter(tile=>!tile.complete).length||
        native.ready!==tiles.filter(tile=>tile.complete).length||native.ready+native.pending!==native.count)return no(`${name}-invalid-native-tiles`);
    if(!Array.isArray(records)||!records.length||tracked.count!==records.length||!records.every(validTile))return no(`${name}-invalid-tracked-tiles`);
    const current=records.filter(tile=>tile.current===true);
    if(!Number.isInteger(layer.tileZoom)||!current.length||tracked.current!==current.length||
        current.some(tile=>tile.coords?.z!==layer.tileZoom))return no(`${name}-invalid-current-tiles`);
    const pending=native.pending>0,currentPending=current.some(tile=>!tile.complete);
    if(pending?layer.isLoading!==true||!currentPending:layer.isLoading!==false||currentPending)return no(`${name}-stale-loading-state`);
    return{eligible:true,pendingTiles:native.pending,readyTiles:native.ready,totalTiles:native.count};
  };
  let originalUrl;
  try{originalUrl=new URL(deadline.layer?.url);}catch{return no('invalid-original-provider');}
  const imagery='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/%7Bz%7D/%7By%7D/%7Bx%7D';
  if(originalUrl.href===imagery){
    const warningAt=Date.parse(warning.observedAt);
    if(!Number.isFinite(state.performanceTimeOrigin)||!Number.isFinite(state.capturedAt)||!Number.isFinite(warningAt)||state.performanceTimeOrigin<=0||
      deadline.observedAt<state.performanceTimeOrigin||deadline.observedAt>warningAt||warningAt>state.capturedAt)return no('different-original-context-clock');
    const path='/ArcGIS/rest/services/World_Imagery/MapServer/tile/';
    const original=provider(deadline.layer,'original-basemap',path);
    if(!original.eligible)return original;
    if(original.pendingTiles===0)return no('original-deadline-already-ready');
    const basemap=provider(state.basemap,'basemap',path);
    if(!basemap.eligible)return basemap;
    if(new URL(state.basemap.url).href!==imagery||deadline.layer.layerId!==state.basemap.layerId||deadline.layer.tileZoom!==state.basemap.tileZoom)return no('different-current-dependency');
    const grid=layer=>{
      const tiles=layer.tracked.tiles.filter(tile=>tile.current);
      if(tiles.some(({coords:c})=>!c||![c.x,c.y,c.z].every(Number.isInteger)||c.x<0||c.y<0||c.z<0||c.z>24||c.x>=2**c.z||c.y>=2**c.z))return null;
      const keys=tiles.map(({coords:c})=>`${c.x}/${c.y}/${c.z}`).sort();
      return new Set(keys).size===keys.length?keys:null;
    };
    const before=grid(deadline.layer),current=grid(state.basemap);
    if(!before||!current||JSON.stringify(before)!==JSON.stringify(current))return no('different-current-tile-grid');
    const roads=state.roads,c=state.companions,r=c?.reference,m=c?.map,l=c?.local;
    const source='https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer',version='20261030-large-roads-v1';
    const positive=value=>Number.isFinite(value)&&value>0;
    if(!attached(roads)||roads.kind!=='vector'||!Number.isSafeInteger(roads.layerId)||roads.layerId<=0||roads.layerId===state.basemap.layerId||roads.isLoading!==false||
      roads.vector?.loaded!==true||roads.vector.tilesLoaded!==true||r?.known!==true||r.version!==version||r.source!==source||r.mounted!==true||r.styled!==true||r.ready!==true||r.error!==null||
      !positive(r.opacity)||r.opacity>1||!positive(r.containerOpacity)||r.containerOpacity>1||r.styleLoaded!==true||r.loaded!==true||r.tilesLoaded!==true||r.contextLost!==false||
      r.canvasAttached!==true||!positive(r.canvasWidth)||!positive(r.canvasHeight)||r.styleVersion!==version||r.onlyShields!==true||
      !Array.isArray(r.sources)||r.sources.length!==1||r.sources[0]?.type!=='vector'||r.sources[0].url!==`${source}?f=json`||
      JSON.stringify(r.sources[0].tiles)!==JSON.stringify([`${source}/tile/{z}/{y}/{x}.pbf`]))return no('unhealthy-reference-vector');
    if(!Number.isSafeInteger(m?.id)||m.id<=0||!positive(m.width)||!positive(m.height)||![m.zoom,m.center?.lat,m.center?.lng,r.glZoom,r.centerPixelDelta].every(Number.isFinite)||
      Math.abs(r.glZoom-(m.zoom-1))>.02||r.centerPixelDelta<0||r.centerPixelDelta>1)return no('different-reference-view');
    if(l?.canvasCount!==1||l.ownerCount!==1||!Number.isSafeInteger(l.layerId)||l.layerId<=0||[roads.layerId,state.basemap.layerId].includes(l.layerId)||
      l.mapContains!==true||l.ownsMap!==true||l.attached!==true||l.visible!==true||l.enabled!==true||l.width!==Math.ceil(m.width)||l.height!==Math.ceil(m.height)||
      !Number.isFinite(l.positionDelta)||l.positionDelta<0||l.positionDelta>1||!positive(l.unit)||l.unit!==l.expectedUnit||r.styleUnit!==l.unit||
      !l.family||l.family!==l.bodyFamily||!Number.isSafeInteger(l.labels)||l.labels<=0||l.labelCount!==l.labels||l.geometryValid!==true||l.originClean!==true||l.nonblank!==true)return no('unhealthy-local-street-canvas');
    if(!Array.isArray(state.streetDataResponses)||!state.streetDataResponses.length||state.streetDataResponses.some(response=>response?.status!==200||response.type!=='FeatureCollection'||response.features!==603))return no('unproven-local-street-data');
    const flood=state.floodImage;
    if(flood?.complete!==true||!flood.src||!positive(flood.naturalWidth)||!positive(flood.naturalHeight))return no('flood-not-ready');
    return{eligible:true,reason:'original-imagery-deadline-pending',originalProvider:'basemap',original,pendingProviders:basemap.pendingTiles?['basemap']:[],basemap,roads:{eligible:true,kind:'vector',ready:true,layerId:roads.layerId}};
  }
  const paths={basemap:'/ArcGIS/rest/services/World_Street_Map/MapServer/tile/',roads:'/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/'};
  const originalRole=Object.keys(paths).find(name=>originalUrl.pathname.startsWith(paths[name]));
  if(!originalRole)return no('unknown-original-provider');
  const original=provider(deadline.layer,`original-${originalRole}`,paths[originalRole]);
  if(!original.eligible)return original;
  if(original.pendingTiles===0)return no('original-deadline-already-ready');
  const basemap=provider(state.basemap,'basemap',paths.basemap);
  if(!basemap.eligible)return basemap;
  const roads=provider(state.roads,'roads',paths.roads);
  if(!roads.eligible)return roads;
  const pendingProviders=['basemap','roads'].filter(name=>({basemap,roads})[name].pendingTiles>0);
  if(deadline.layer.layerId!==state[originalRole].layerId||deadline.layer.tileZoom!==state[originalRole].tileZoom||
      originalUrl.href!==new URL(state[originalRole].url).href)return no('different-current-dependency');
  const flood=state.floodImage;
  if(flood?.complete!==true||!flood.src||!(flood.naturalWidth>0)||!(flood.naturalHeight>0))return no('flood-not-ready');
  return{eligible:true,reason:'original-raster-deadline-pending',originalProvider:originalRole,original,pendingProviders,basemap,roads};
}
async function ready(label) {
  let state = await terminal(label);
  const firstAttemptReady=state.state==='ready';
  let providerRetryUsed=false;
  if(state.state==='error'){
    const warning=activeSession.log.previewWarnings.at(-1);
    const context={name:activeSession.name,routeEverInstalled:activeSession.log.routeEverInstalled,
      coldPreviewReady:activeSession.coldPreviewReady,actionId:label,pendingProviderRetries:activeSession.pendingProviderRetries,
      retriedPreviewActions:[...activeSession.retriedPreviewActions]};
    const classification=classifyPendingProviderPreviewRetry(state,warning,context);
    saveState({label:`${label}-provider-retry-classification`,classification,context,warning});
    if(classification.eligible){
      activeSession.retriedPreviewActions.add(label);activeSession.pendingProviderRetries++;
      activeSession.log.pendingProviderRetries=activeSession.pendingProviderRetries;
      activeSession.log.retriedPreviewActions=[...activeSession.retriedPreviewActions];
      providerRetryUsed=true;
      assert.equal(await page.locator('#exportPreviewRetryBtn').isVisible(),true);
      assert.equal(await page.locator('#exportPreviewRetryBtn').isEnabled(),true);
      saveState({label:`${label}-provider-ui-retry`,actionId:label,attemptForAction:1,totalRetries:activeSession.pendingProviderRetries,classification});
      await page.locator('#exportPreviewRetryBtn').click({noWaitAfter:true,delay:50});
      // No recursion: a second error for this action remains a hard failure.
      state=await terminal(`${label}-after-provider-retry`);
    }
  }
  saveState({label:`${label}-attempt-result`,actionId:label,firstAttemptReady,providerRetryUsed,finalState:state.state});
  if(activeSession.name==='normal-route-free'&&label==='broad-current-view'){
    activeSession.log.coldPreviewFirstAttemptReady=firstAttemptReady;
    activeSession.log.coldPreviewRecovered=providerRetryUsed&&state.state==='ready';
  }
  assert.equal(state.state,'ready',JSON.stringify({state,warnings:result.warnings}));
  return state;
}
// These dialog actions never navigate. Preserve trusted input/hit checks and
// explicit state/output assertions, without Playwright's navigation epilogue.
async function singleFrame() {
  const date=await page.locator('#downloadStartDateText').inputValue();
  const time=await page.locator('#downloadStartTimeSelect').inputValue();
  await page.locator('#downloadEndDateText').fill(date);
  await page.locator('#downloadEndDateText').press('Tab',{noWaitAfter:true});
  await page.locator('#downloadEndTimeSelect').selectOption(time);
  const applied=await page.evaluate(()=>({start:getRangeInputDate('downloadStartInput')?.getTime(),end:getRangeInputDate('downloadEndInput')?.getTime(),frames:getDownloadFrameItems().length}));
  assert.ok(Number.isFinite(applied.start));assert.equal(applied.end,applied.start);assert.equal(applied.frames,1);
}
async function twoFrames() {
  const end=await page.evaluate(()=>{
    const date=new Date(getRangeInputDate('downloadStartInput').getTime()+3600000),parts=getNyParts(date);
    return{date:`${parts.month}/${parts.day}/${parts.year}`,time:`${pad2(Number(parts.hour24))}:${parts.minute}`};
  });
  await page.locator('#downloadEndDateText').fill(end.date);
  await page.locator('#downloadEndDateText').press('Tab',{noWaitAfter:true});
  await page.locator('#downloadEndTimeSelect').selectOption(end.time);
  const applied=await page.evaluate(()=>({duration:getRangeInputDate('downloadEndInput')?.getTime()-getRangeInputDate('downloadStartInput')?.getTime(),frames:getDownloadFrameItems().length}));
  assert.equal(applied.duration,3600000);assert.equal(applied.frames,2);
}
function gifFrames(bytes) {
  let offset=13+((bytes[10]&128)?3*(1<<((bytes[10]&7)+1)):0),count=0;
  const blocks=()=>{while(offset<bytes.length){const length=bytes[offset++];if(!length)return;offset+=length;}throw Error('Truncated GIF');};
  while(offset<bytes.length){
    const marker=bytes[offset++];if(marker===0x3b)return count;
    if(marker===0x21){offset++;blocks();}
    else if(marker===0x2c){const packed=bytes[offset+8];offset+=9;if(packed&128)offset+=3*(1<<((packed&7)+1));offset++;blocks();count++;}
    else throw Error(`Unexpected GIF marker ${marker}`);
  }
  throw Error('Missing GIF trailer');
}
async function review() {
  // A real 50 ms press makes Playwright await move/down/up separately on
  // Windows; actionability, 30-second deadlines and outcome checks stay intact.
  if(await page.locator('#downloadModal').getAttribute('data-export-step')!=='review')await page.locator('#downloadBtn').click({noWaitAfter:true,delay:50});
}
async function format(value) {
  if(await page.locator('#downloadModal').getAttribute('data-export-step')==='review')await page.locator('#exportReviewBackBtn').click({noWaitAfter:true,delay:50});
  await page.locator(`#exportFormat${value}Btn`).click({noWaitAfter:true,delay:50});
  await review();
}
async function layout(label,minimum=8) {
  const state=await page.evaluate(async()=>{
    const canvas=exportMap.getPane('roadsPane').querySelector('.nww-export-road-labels');
    let layer;exportMap.eachLayer(candidate=>{if(candidate._canvas===canvas&&typeof candidate.getLabels==='function')layer=candidate;});
    const family=canvas?.dataset.fontFamily,unit=Math.min(getExportAspectConfig().width,getExportAspectConfig().height)/1080;
    const scratch=document.createElement('canvas').getContext('2d');
    const fontMetrics=[20,18].map(size=>{
      scratch.font=`600 ${size*unit}px ${family}`;
      return{size:size*unit,font:scratch.font,full:scratch.measureText('W Spruce Ave').width,short:scratch.measureText('W Spruce').width};
    });
    const gl=exportRoadsLayer.getMaplibreMap(),vectorStyle=gl.getStyle();
    const shieldLayers=vectorStyle.layers.map(layer=>({id:layer.id,type:layer.type,sourceLayer:layer['source-layer'],icon:layer.layout['icon-image']}));
    const routes=[...new Set(gl.queryRenderedFeatures().map(feature=>feature.properties?._name).filter(Boolean))];
    const paths=await window.NORTH_WILDWOOD_EXPORT_ROADS.load();
    const spruce=paths.filter(path=>path.name==='West Spruce Avenue').map(path=>path.coordinates.map(([lng,lat])=>exportMap.latLngToContainerPoint([lat,lng])));
    const segmentDistance=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
    const route147OnSpruce=gl.queryRenderedFeatures().filter(feature=>feature.properties?._name==='NJ 147').some(feature=>{
      const lines=feature.geometry.type==='LineString'?[feature.geometry.coordinates]:feature.geometry.coordinates;
      return lines.some(line=>line.filter(([lng,lat])=>{const p=exportMap.latLngToContainerPoint([lat,lng]);return spruce.some(points=>points.some((a,i)=>i&&segmentDistance(p,points[i-1],a)<=8));}).length>=2);
    });
    return{labels:layer?.getLabels()||[],obstacles:layer?.options.obstacles||[],shieldLayers,routes,route147OnSpruce,activeVector:window.ShorelyRoadLabels.isLayer(exportRoadsLayer),width:canvas?.width,height:canvas?.height,
      family,bodyFamily:getComputedStyle(document.body).fontFamily,
      visible:canvas ? getComputedStyle(canvas).display!=='none' : false,
      dimensions:getExportAspectConfig(),zoom:exportMap.getZoom(),center:exportMap.getCenter(),pixelOrigin:exportMap.getPixelOrigin(),
      contextFont:canvas?.getContext('2d').font,fontMetrics,devicePixelRatio:window.devicePixelRatio};
  });
  saveState({label,...state});
  assert.equal(state.activeVector,true);
  assert.ok(state.shieldLayers.length>0);
  for(const layer of state.shieldLayers){assert.equal(layer.type,'symbol');assert.match(layer.id,/shield$/);assert.ok(layer.icon,'Only authoritative provider shields may join local ordinary names');}
  assert.equal(state.family,state.bodyFamily,'Street names must use the shared mapper font family');
  assert.equal(state.visible,true);assert.ok(state.labels.length>=minimum,`${label}: only ${state.labels.length} street names`);
  const unit=Math.min(state.dimensions.width,state.dimensions.height)/1080;
  for(const street of state.labels){
    assert.ok(street.name && street.text && !/^FR\s/.test(street.text));
    const minimumFont=label==='broad-current-view'?13:18;
    assert.ok(street.fontSize>=minimumFont*unit-1e-6&&street.fontSize<=20*unit+1e-6,`${label}: ${street.name} font ${street.fontSize} must retain the reviewed scale`);
    assert.ok(street.angle>=-Math.PI/2 && street.angle<=Math.PI/2,'Street names must remain upright');
    assert.ok(street.box.every(p=>p.x>=0&&p.y>=0&&p.x<=state.width&&p.y<=state.height),`${street.text} leaves the map/footer boundary`);
  }
  // Independent separating-axis check for the rotated collision rectangles.
  const separated=(one,two)=>[one,two].some(poly=>poly.some((p,i)=>{
    const q=poly[(i+1)%poly.length],nx=q.y-p.y,ny=p.x-q.x;
    const a=one.map(v=>v.x*nx+v.y*ny),b=two.map(v=>v.x*nx+v.y*ny);
    return Math.max(...a)<=Math.min(...b)+1e-6 || Math.max(...b)<=Math.min(...a)+1e-6;
  }));
  for(const street of state.labels)for(const obstacle of state.obstacles){
    assert.ok(separated(street.box,obstacle),`${label}: ${street.text} overlaps a route shield`);
  }
  for(let a=0;a<state.labels.length;a++)for(let b=a+1;b<state.labels.length;b++){
    assert.ok(separated(state.labels[a].box,state.labels[b].box),`${label}: overlapping ${state.labels[a].text}/${state.labels[b].text}`);
  }
  if(retained)await page.screenshot({path:path.join(output,`${name}-street-${label}.png`)});
  return state;
}
async function download(label) {
  const downloading=page.waitForEvent('download',{timeout:240000});downloading.catch(()=>{});
  await page.locator('#downloadBtn').click({noWaitAfter:true,delay:50});
  const failed=page.waitForFunction(()=>!exportInProgress&&document.getElementById('downloadStatus')?.classList.contains('error'),{},{timeout:240000,polling:100})
    .then(async()=>{throw Error(`Street-label export failed: ${await page.locator('#downloadStatus').textContent()}`);});
  failed.catch(()=>{});
  const item=await Promise.race([downloading,failed]);
  const file=path.join(output,`${name}-${label}-${path.basename(item.suggestedFilename())}`);
  await item.saveAs(file);assert.equal(await item.failure(),null);
  await page.waitForFunction(()=>!exportInProgress,{},{timeout:90000});
  return file;
}
async function verifyDownloadedInk(file,label) {
  const bytes=fs.readFileSync(file),mime=/\.gif$/i.test(file)?'image/gif':'image/png';
  const checked=await page.evaluate(async({url})=>{
    const source=exportMap.getPane('roadsPane').querySelector('.nww-export-road-labels');
    let layer;exportMap.eachLayer(candidate=>{if(candidate._canvas===source&&typeof candidate.getLabels==='function')layer=candidate;});
    const labels=layer.getLabels();
    const ink=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
    const image=new Image();image.src=url;await image.decode();
    const copy=document.createElement('canvas');copy.width=image.naturalWidth;copy.height=image.naturalHeight;
    const ctx=copy.getContext('2d');ctx.drawImage(image,0,0);
    const actual=ctx.getImageData(0,0,copy.width,copy.height).data;
    let expected=0,matched=0;
    for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
      const i=(y*source.width+x)*4;
      // Opaque dark pixels are glyph interiors; semitransparent antialiasing
      // and the white outline are deliberately excluded from this comparison.
      if(ink[i+3]<250||ink[i]>65||ink[i+1]>75||ink[i+2]>90)continue;
      expected++;const j=(y*copy.width+x)*4;
      if(actual[j]<95&&actual[j+1]<105&&actual[j+2]<125)matched++;
    }
    return{width:copy.width,height:copy.height,labels:labels.length,expected,matched,ratio:matched/expected};
  },{url:`data:${mime};base64,${bytes.toString('base64')}`});
  assert.ok(checked.expected>100,`${label}: no measurable local street lettering`);
  assert.ok(checked.ratio>0.90,`${label}: exported lettering lost pixels (${JSON.stringify(checked)})`);
  saveState({label,file:path.basename(file),bytes:bytes.length,...checked});
  return checked;
}

try{
  // Complete a real roads-OFF PNG before installing any route. This proves the
  // scientific inputs, CDN encoder and basemap through their existing loaders,
  // while leaving the local road JSON genuinely cold for the intended fault.
  const fault=await startSession('street-data-fault');
  await strictModelReadiness();
  assert.equal(fault.log.routeEverInstalled,false);assert.equal(fault.roadDataRequests,0);
  await page.locator('#roadsToggle').click();
  assert.equal(await page.locator('#roadsToggle').getAttribute('aria-checked'),'false');
  const faultPreference=await page.evaluate(()=>{
    document.getElementById('downloadFormatSelect').value='png';
    document.getElementById('downloadAspectSelect').value='1:1';
    document.getElementById('downloadExtentSelect').value='town';
    updateExportSegmentedUI();
    return{format:getDownloadFormatValue(),aspect:getDownloadAspectValue(),extent:getDownloadExtentValue()};
  });
  assert.deepEqual(faultPreference,{format:'png',aspect:'1:1',extent:'town'});
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});await singleFrame();await review();
  const preflight=await ready('road-disabled-prerequisites');
  assert.equal(preflight.format,'png');assert.equal(preflight.aspect,'1:1');assert.equal(preflight.extent,'town');
  assert.equal(preflight.dimensions.width,2160);assert.equal(preflight.dimensions.height,2160);
  assert.equal(preflight.floodImage.complete,true);assert.ok(preflight.floodImage.naturalWidth>0);
  assert.equal(await page.locator('#roadsToggle').getAttribute('aria-checked'),'false');
  assert.equal(fault.roadDataRequests,0,'A roads-OFF preview must not warm the local street JSON before its fault');
  assert.equal(fault.log.routeEverInstalled,false);
  saveState({label:'road-disabled-preflight-verified',roadDataRequests:fault.roadDataRequests,routeEverInstalled:fault.log.routeEverInstalled});
  await page.locator('#downloadModalCloseBtn').click({noWaitAfter:true,delay:50});
  const streetDataOutage=route=>{
    fault.failures++;return route.fulfill({status:503,contentType:'text/plain',body:'Controlled local street-data outage'});
  };
  fault.log.routeEverInstalled=true;
  await page.route(roadDataPattern,streetDataOutage);
  saveState({label:'local-data-fault-installed',observedAt:new Date().toISOString(),...await page.evaluate(()=>({performanceTimeOrigin:performance.timeOrigin,performanceNow:performance.now()}))});
  const faultWarningStart=fault.log.previewWarnings.length;
  await page.locator('#roadsToggle').click();
  assert.equal(await page.locator('#roadsToggle').getAttribute('aria-checked'),'true');
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});
  await singleFrame();await review();
  const failed=await terminal('local-data-outage');
  assert.equal(failed.state,'error');assert.ok(fault.failures>0);
  await flushPreviewWarnings();
  const lastFaultWarning=fault.log.previewWarnings.slice(faultWarningStart).at(-1);
  const lastFaultError=lastFaultWarning?.errors.at(-1);
  assert.equal(lastFaultError?.message,'The export road names could not load. Please try again.',
    'The controlled fault must fail specifically on its actual local street-data Error');
  saveState({label:'intended-street-data-failure',warning:lastFaultWarning.text,error:lastFaultError,failures:fault.failures,roadDataRequests:fault.roadDataRequests});
  console.log('Street-label proof: intended local street-data failure verified');
  assert.equal(await page.locator('#exportPreviewRetryBtn').isEnabled(),true);
  assert.equal(await page.locator('#downloadBtn').isEnabled(),true);
  const previousSuccessfulRequests=fault.successfulRequests;
  const previousRoadResponses=fault.roadDataResponses.length;
  await page.unroute(roadDataPattern,streetDataOutage);
  saveState({label:'local-data-fault-removed',failures:fault.failures,observedAt:new Date().toISOString(),...await page.evaluate(()=>({performanceTimeOrigin:performance.timeOrigin,performanceNow:performance.now()}))});
  await page.locator('#exportPreviewRetryBtn').click({noWaitAfter:true,delay:50});await ready('local-data-recovered');
  assert.ok(fault.successfulRequests>previousSuccessfulRequests);
  const receivedRoadData=await Promise.all(fault.roadDataResponses.slice(previousRoadResponses));
  assert.ok(receivedRoadData.length>0);
  for(const data of receivedRoadData)assert.deepEqual(data,{status:200,type:'FeatureCollection',features:603},'Retry must receive the actual local street dataset');
  saveState({label:'actual-street-data-response',successfulRequests:fault.successfulRequests,responses:receivedRoadData});
  console.log('Street-label proof: Retry received the actual 200/603 street dataset');
  result.checks.push('A local street-data 503 produces a retryable error, and actual Retry fetches the data and renders the preview');
  await captureInputDiagnostics();await fault.context.close();fault.log.closed=true;page=null;activeSession=null;

  // A fresh context has independent HTTP/model caches and never installs a
  // route. Its first actual UI export exercises the cold normal PNG path.
  const normal=await startSession('normal-route-free');
  const initial=await page.evaluate(()=>({queryCached:!!depthQueryGridPromise,developedCached:!!developedQueryGridPromise,exportMapCreated:!!exportMap}));
  assert.deepEqual(initial,{queryCached:false,developedCached:false,exportMapCreated:false});
  const preference=await page.evaluate(()=>{
    document.getElementById('downloadFormatSelect').value='png';
    document.getElementById('downloadAspectSelect').value='1:1';
    updateExportSegmentedUI();
    return{format:getDownloadFormatValue(),aspect:getDownloadAspectValue(),queryCached:!!depthQueryGridPromise,
      developedCached:!!developedQueryGridPromise,exportMapCreated:!!exportMap};
  });
  assert.deepEqual(preference,{format:'png',aspect:'1:1',...initial});
  assert.equal(normal.log.routeEverInstalled,false);
  saveState({label:'cold-normal-png-preference',...preference});
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});await singleFrame();await review();
  await ready('broad-current-view');
  assert.equal(await page.evaluate(()=>getExportAspectConfig().width),2160);
  // Large labels and shield collisions fit a different count with each system
  // font. Pin the important road coverage as well as density and legibility.
  const overview=await layout('broad-current-view',5);
  for(const street of ['New Jersey Avenue','Delaware Avenue','Atlantic Avenue','Ocean Avenue']){
    assert.ok(overview.labels.some(label=>label.name===street),`The default current view must retain ${street}`);
  }
  assert.equal(new Set(overview.labels.map(label=>label.name)).size,overview.labels.length,
    'The broad view must use one label per road rather than repeats to meet its coverage check');
  assert.ok(overview.labels.some(street=>street.name==='West Spruce Avenue')||overview.route147OnSpruce,
    'The northern spit must retain W Spruce or its genuine NJ147 route badge on the same road geometry');
  normal.coldPreviewReady=true;normal.log.coldPreviewReady=true;
  saveState({label:'cold-normal-preview-proven',firstAttemptReady:normal.log.coldPreviewFirstAttemptReady,providerRecoveryUsed:normal.log.coldPreviewRecovered,pendingProviderRetries:normal.pendingProviderRetries,routeEverInstalled:normal.log.routeEverInstalled});
  // This only changes the map framing. Its actual pointer action is checked
  // by Playwright; avoid its unrelated navigation epilogue during map work.
  assert.equal(await page.evaluate(()=>getDownloadExtentValue()),'current');
  await page.locator('#exportExtentTownBtn').click({noWaitAfter:true,delay:50});
  const townRestored=await ready('town-restored');
  assert.equal(townRestored.extent,'town');
  assert.equal(await page.locator('#exportExtentTownBtn').getAttribute('aria-pressed'),'true');
  result.checks.push('The default broad current view retains New Jersey Avenue and West Spruce Avenue in the shared font');

  const completedFrame=await page.evaluateHandle(()=>({layer:exportFloodLayer,image:exportFloodLayer.getElement(),source:exportFloodLayer._url}));
  const buttons=[['Square','1:1'],['Social','4:5'],['Landscape','16:9'],['Portrait','9:16']];
  for(const kind of ['Png','Gif']){
    await format(kind);
    for(const [button,aspect] of buttons){
      await page.locator(`#exportAspect${button}Btn`).click({noWaitAfter:true,delay:50});await ready(`${kind}-${aspect}`);
      const state=await layout(`${kind}-${aspect.replace(':','x')}`);
      assert.equal(state.dimensions.value,aspect);
      const identity=await page.evaluate(reference=>({sameSource:exportFloodLayer._url===reference.source,
        sameLayer:exportFloodLayer===reference.layer,sameImage:exportFloodLayer.getElement()===reference.image}),completedFrame);
      assert.deepEqual(identity,{sameSource:true,sameLayer:true,sameImage:true},'A layout-only change must retain the same completed flood image');
    }
  }
  await completedFrame.dispose();
  result.checks.push('Actual preview layout has readable, upright, fully bounded and non-overlapping shared-font labels in all four PNG and GIF aspect ratios');
  result.checks.push('All eight layout previews retain the same owned completed flood image while the camera and output dimensions change');

  await format('Png');await page.locator('#exportAspectSquareBtn').click({noWaitAfter:true,delay:50});
  await ready('png-download-ready');
  const png=await download('street-names');
  assert.deepEqual([...fs.readFileSync(png).subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const pngInk=await verifyDownloadedInk(png,'actual-png-street-ink');assert.equal(pngInk.width,2160);assert.equal(pngInk.height,2160);
  result.checks.push('The downloaded 2160px PNG preserves actual dark street-name glyphs above the flood overlay');

  await page.waitForFunction(()=>document.getElementById('exportProgressOverlay').hidden,{},{timeout:10000});
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});await twoFrames();await review();
  await format('Gif');await page.locator('#exportAspectSquareBtn').click({noWaitAfter:true,delay:50});
  await page.locator('#exportExtentTownBtn').click({noWaitAfter:true,delay:50});
  const gifTown=await ready('gif-download-ready');
  assert.equal(gifTown.extent,'town');
  assert.equal(await page.locator('#exportExtentTownBtn').getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>getDownloadFrameItems().length),2);
  const gif=await download('street-names');
  assert.match(fs.readFileSync(gif).subarray(0,6).toString(),/^GIF8[79]a$/);
  assert.equal(gifFrames(fs.readFileSync(gif)),2,'Exercise the real animated GIF capture path');
  const gifInk=await verifyDownloadedInk(gif,'actual-gif-street-ink');assert.equal(gifInk.width,1200);assert.equal(gifInk.height,1200);
  result.checks.push('The real two-frame GIF encoder preserves actual local street-name glyphs above the flood overlay');

  await page.waitForFunction(()=>document.getElementById('exportProgressOverlay').hidden,{},{timeout:10000});
  await page.locator('#roadsToggle').click();assert.equal(await page.locator('#roadsToggle').getAttribute('aria-checked'),'false');
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});await singleFrame();await review();await ready('roads-disabled');
  const hidden=await page.evaluate(()=>{
    const canvas=exportMap.getPane('roadsPane').querySelector('.nww-export-road-labels');
    let layer;exportMap.eachLayer(candidate=>{if(candidate._canvas===canvas&&typeof candidate.getLabels==='function')layer=candidate;});
    return{count:layer.getLabels().length,display:getComputedStyle(canvas).display,rasterOpacity:exportRoadsLayer.options.opacity};
  });
  assert.deepEqual(hidden,{count:0,display:'none',rasterOpacity:0});
  const hiddenCapture=await page.evaluate(async()=>{
    const canvas=await captureExportRoadLabelsCanvas();
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const size=exportMap.getSize();let opaque=0,mapOpaque=0,minX=canvas.width,minY=canvas.height,maxX=0,maxY=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]){
      opaque++;if(x<size.x&&y<size.y)mapOpaque++;
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
    }
    canvas.width=canvas.height=1;return{opaque,mapOpaque,bounds:{minX,minY,maxX,maxY},mapSize:size};
  });
  saveState({label:'roads-disabled-capture',...hiddenCapture});
  assert.equal(hiddenCapture.mapOpaque,0,'The isolated road-label capture must contain no geographic labels when disabled');
  await page.locator('#downloadModalCloseBtn').click({noWaitAfter:true,delay:50});await page.locator('#roadsToggle').click();
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});await singleFrame();await review();await ready('roads-reenabled');
  await layout('roads-reenabled');
  result.checks.push('Road names OFF hides local glyphs and reference tiles, then ON restores local names on the existing export map');

  await page.locator('#downloadModalCloseBtn').click({noWaitAfter:true,delay:50});
  // Apply the actual main map camera, then capture that current-view extent.
  await page.evaluate(()=>{
    const center=[-74.8005,39.002];
    const gl=window.NORTH_WILDWOOD_3D?.getMap?.();
    if(gl&&document.body.classList.contains('map-3d-ready'))gl.jumpTo({center,zoom:15.8,pitch:0,bearing:0});
    else map.setView([center[1],center[0]],15.8,{animate:false});
  });
  await page.locator('#openDownloadModalBtn').click({noWaitAfter:true,delay:50});await singleFrame();await review();
  await page.locator('#exportExtentCurrentBtn').click({noWaitAfter:true,delay:50});await ready('current-crop');await layout('current-crop',3);
  result.checks.push('A close current-view crop relocates labels to visible street stretches without clipping or overlap');
  assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){
  result.failure=error.stack;result.passed=false;
  await captureInputDiagnostics();
  if(retained&&page&&!page.isClosed())await page.screenshot({path:path.join(output,`${name}-street-label-failure.png`)}).catch(()=>{});
  throw error;
}finally{
  await captureInputDiagnostics();
  await browser.close();
  if(retained)fs.writeFileSync(path.join(output,`${name}-street-labels.json`),JSON.stringify(result,null,2));
  else fs.rmSync(output,{recursive:true,force:true});
  console.log(JSON.stringify({browser:result.browser,version:result.version,passed:result.passed,checks:result.checks,output:retained||null,failure:result.failure},null,2));
}
