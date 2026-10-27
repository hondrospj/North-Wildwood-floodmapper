// Run the maintained functions against controlled sessions, transports and GPU commits.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const sources = [read('app/runtime/09-raster-lifecycle.js'), read('app/runtime/18-flood-frame-rendering.js'),
  read('app/runtime/20-timeline-rendering.js'), read('app/runtime/23-refresh-and-playback.js'),
  read('app/runtime/26-depth-queries.js'), read('../assets/3d/north-wildwood-3d.js')].join('\n');
function extract(name) {
  const match = sources.match(new RegExp(`^( *)(?:async )?function ${name}\\([^\\n]*\\) \\{`, 'm'));
  assert.ok(match, name);
  const end = sources.indexOf('\n' + (match[1] || '    ') + '}', match.index) + (match[1].length || 4) + 2;
  return sources.slice(match.index, end);
}
function deferred() { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function flush() { for(let i=0;i<20;i++) await Promise.resolve(); }
function timers() {
  let id=0;const rows=new Map();return {rows,
    setTimeout(fn,ms){const key=++id;rows.set(key,{fn,ms,interval:false});return key;},
    clearTimeout(key){rows.delete(key);},
    setInterval(fn,ms){const key=++id;rows.set(key,{fn,ms,interval:true});return key;},
    clearInterval(key){rows.delete(key);},
    run(ms){for(const [key,row] of [...rows])if(row.ms===ms){if(!row.interval)rows.delete(key);row.fn();}}
  };
}
let cases=0;
// A prior run may resolve OR reject after restart. Neither can schedule a tick,
// stop the current run, or report its obsolete error to the current user.
for(const outcome of ['resolve','reject']) {
  const clock=timers(),pending=[],notices=[];
  const c=vm.createContext({playTimer:null,playbackGeneration:0,playbackInFlight:false,playbackObservedDaysAdvanced:0,playbackPausedForConfirmation:false,currentSeriesHours:[{},{}],
    ...clock,performance:{now:()=>0},PLAYBACK_MINIMUM_FRAME_DELAY_MS:20,
    updatePlayPauseButton(){},setPlaybackStillThereOpen(){},toast:message=>notices.push(message),getPlaybackFrameDurationMs:()=>950,
    stepPlaybackForward(){const gate=deferred();pending.push(gate);return gate.promise;}});
  for(const n of ['clearPlaybackTimer','stopPlayback','startPlayback'])vm.runInContext(extract(n),c);
  c.startPlayback();c.stopPlayback();c.startPlayback();assert.equal(pending.length,2);
  pending[0][outcome](outcome==='reject'?Error('Old frame failed'):true);await flush();
  assert.equal([...clock.rows.values()].filter(t=>t.ms===950).length,0);
  assert.ok(c.playTimer);assert.deepEqual(notices,[]);
  pending[1].resolve();await flush();assert.equal([...clock.rows.values()].filter(t=>t.ms===950).length,1);
  clock.run(950);assert.equal(pending.length,3);c.stopPlayback();pending[2].resolve();await flush();
  assert.equal([...clock.rows.values()].filter(t=>t.ms===950).length,0);cases++;
}
// The actual image loaders terminate a held request, release resources, ignore
// late events and permit a new request for the same URL.
{
  const clock=timers(),images=[],released=[];
  class Image {constructor(){images.push(this);}set src(value){this.url=value;}get src(){return this.url;}}
  const c=vm.createContext({window:clock,Image,Promise,Error,URL,Date,exportInProgress:false,exportCancelRequested:false,
    drainageRasterImageCache:new Map(),DRAINAGE_RASTER_IMAGE_CACHE_LIMIT:2,retainRasterObjectUrl:url=>()=>released.push(url),
    DEPTH_QUERY_PNG_URL:'https://example.test/query.png',DEVELOPED_QUERY_PNG_URL:'https://example.test/developed.png',depthQueryGridPromise:null,developedQueryGridPromise:null,
    document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:[1,2,3,4]})})})}});
  for(const n of ['awaitRasterRequest','getDrainageRasterImage','loadDepthQueryPng','getDepthQueryGrid','getDevelopedQueryGrid'])vm.runInContext(extract(n),c);
  let settled=false;const first=c.getDepthQueryGrid().then(()=>assert.fail('Held image succeeded'),error=>{settled=true;assert.equal(error.name,'TimeoutError');});
  const late=images[0].onload;clock.run(20000);await first;assert.ok(settled);assert.equal(images.length,1,'Timeout must not silently spend a second deadline');assert.equal(c.depthQueryGridPromise,null);
  late();await flush();assert.equal(c.depthQueryGridPromise,null);
  const retry=c.getDepthQueryGrid();images[1].naturalWidth=1;images[1].naturalHeight=1;images[1].onload();assert.equal((await retry).width,1);
  const drain=c.getDrainageRasterImage('blob:drain');const stale=images[2].onload;clock.run(20000);assert.equal(await drain,null);assert.deepEqual(released,['blob:drain']);assert.equal(c.drainageRasterImageCache.size,0);stale();assert.equal(released.length,1);
  const drainRetry=c.getDrainageRasterImage('blob:drain');images[3].onload();assert.equal(await drainRetry,images[3]);assert.equal(released.length,2);
  // Old failures may never clear a replacement promise installed by Reload.
  c.depthQueryGridPromise=null;const old=c.getDepthQueryGrid().catch(()=>null);const oldImage=images.at(-1);c.depthQueryGridPromise=null;
  const newer=c.getDepthQueryGrid();const newImage=images.at(-1);oldImage.onerror();await flush();images.at(-1).onerror();await old;
  assert.ok(c.depthQueryGridPromise,'The newer pending cache must survive an old rejection');newImage.naturalWidth=1;newImage.naturalHeight=1;newImage.onload();await newer;
  cases+=3;
}
// Cancel only one export wait. A concurrent non-export consumer still receives
// the healthy shared result, including a transport completing after cancellation.
{
  const clock=timers(),gate=deferred();const c=vm.createContext({window:clock,exportInProgress:false,exportCancelRequested:false,Promise,Error});
  vm.runInContext(extract('awaitRasterRequest'),c);const mapWait=c.awaitRasterRequest(gate.promise);assert.equal(mapWait,gate.promise);
  c.exportInProgress=true;const exporting=c.awaitRasterRequest(gate.promise);c.exportCancelRequested=true;clock.run(80);
  await assert.rejects(exporting,error=>error.name==='AbortError');assert.equal(clock.rows.size,0);
  gate.resolve('decoded grid');assert.equal(await mapWait,'decoded grid');await flush();cases++;
}
// The real Leaflet frame coordinator cannot publish a candidate before the
// active GPU renderer accepts it, and must retain the old layer on failure.
for(const outcome of ['ready','failure','superseded']) {
  const clock=timers(),gate=deferred(),started=deferred(),active=new Set();
  class Layer {
    constructor(url){this._url=url;this.handlers=new Map();this.image={complete:true,naturalWidth:4,decode:async()=>{}};}
    on(name,fn){this.handlers.set(name,fn);return this;}off(name){this.handlers.delete(name);return this;}
    addTo(){active.add(this);queueMicrotask(()=>this.handlers.get('load')?.());return this;}
    getElement(){return this.image;}setOpacity(value){this.opacity=value;}
  }
  const previous=new Layer('old');active.add(previous);
  const c=vm.createContext({window:{...clock,NORTH_WILDWOOD_3D:{prepareFloodFrame:async()=>{started.resolve();return gate.promise;}}},requestAnimationFrame:fn=>queueMicrotask(fn),console,
    document:{body:{dataset:{initialFloodFrame:'ready'},classList:{contains:()=>false}}},
    currentSeriesHours:[{stage:1}],currentRawSeriesHours:[],currentHourIndex:0,currentDataMode:'forecast',lastRenderToken:1,currentFloodLayer:previous,pendingFloodLayer:null,
    getStageValue:entry=>entry.stage,retainRasterObjectUrl:()=>()=>{},toast(){},ensureMap(){},getHydraulicOverlayRecord:async()=>({url:'new'}),preloadImage:async url=>url,ensureOverlayBounds:async()=>{},
    createHydraulicImageOverlay:url=>new Layer(url),overlayOpacity:.75,mapHasFit:true,floodLatLngBounds:{},updatePersistentDepthQueryPopup(){},markInitialFloodFrameReady(){},preloadPromiseCache:new Map(),
    map:{hasLayer:layer=>active.has(layer),removeLayer(layer){active.delete(layer);layer.handlers.get('remove')?.();}}});
  for(const n of ['decodeFloodFrameImage','waitForRecoveryFloodLayer','setFloodLayer'])vm.runInContext(extract(n),c);
  const job=c.setFloodLayer('depth',1,'slack',1,{stage:1});await started.promise;
  assert.equal(c.currentFloodLayer,previous);assert.ok(active.has(previous));assert.equal(c.document.body.dataset.floodFrame,undefined);
  if(outcome==='superseded')c.lastRenderToken++;
  gate.resolve(outcome!=='failure');const result=await job;
  if(outcome==='ready'){assert.equal(result,true);assert.equal(c.currentFloodLayer._url,'new');assert.ok(!active.has(previous));}
  else {assert.equal(result,false);assert.equal(c.currentFloodLayer,previous);assert.ok(active.has(previous));}
  cases++;
}
// GPU readiness follows precisely this pending map/layer/request, including
// another time selection, a context reset, a removed layer, and a replacement map.
for(const outcome of ['ready','failed','new-selection','context-loss','removed-layer','replacement-map']) {
  const gate=deferred(),layer={_url:'new'},old={_url:'old'},mapInstance={getPitch:()=>60};let restores=0;
  const plane={textureReady:true,committedUrl:'old',whenReady:()=>gate.promise};
  const c=vm.createContext({glMap:mapInstance,glStyleReady:true,lastRenderToken:10,pendingFloodLayer:layer,pendingFlood3dRequest:null,floodPlaneLayer:plane,currentFloodLayer:old,
    document:{body:{dataset:{map3d:'ready'},classList:{contains:()=>true}}},map:{hasLayer:value=>value===c.pendingFloodLayer},
    syncFloodLayer3d(){if(!c.pendingFlood3dRequest)restores++;}});
  vm.runInContext(extract('prepareFloodFrame3d'),c);const job=c.prepareFloodFrame3d(layer,{stage:2},10);
  if(outcome==='new-selection')c.lastRenderToken++;
  if(outcome==='context-loss')c.glStyleReady=false;
  if(outcome==='removed-layer')c.pendingFloodLayer=null;
  if(outcome==='replacement-map')c.glMap={getPitch:()=>60};
  if(outcome!=='failed')plane.committedUrl='new';gate.resolve(outcome!=='failed');
  assert.equal(await job,outcome==='ready');assert.equal(c.pendingFlood3dRequest,null);assert.equal(restores,outcome==='ready'?0:1);cases++;
}
// A decoded image from an obsolete frame must not touch the GPU at all.
{
  const clock=timers(),images=[];class Image {constructor(){images.push(this);}set src(value){this.url=value;}}
  const c=vm.createContext({window:clock,Image,document:{body:{dataset:{}}},Promise,Number,Float32Array});
  vm.runInContext(extract('createFlatFloodPlane'),c);const plane=c.createFlatFloodPlane({});
  plane.gl={createTexture(){assert.fail('Obsolete image attempted a GPU upload');}};plane.texture={};plane.textureReady=true;plane.committedUrl='old';plane.pendingFrame={isCurrent:()=>false};
  const pending=plane.loadTexture('new');await images[0].onload();assert.equal(await pending,false);assert.equal(plane.committedUrl,'old');assert.equal(clock.rows.size,0);cases++;
}
// A failed allocation/upload or lost context retains the last complete texture.
// An error left by another map layer must not reject a healthy candidate.
for(const outcome of ['allocation-error','upload-error','context-loss','prior-error']) {
  const clock=timers(),images=[],deleted=[],oldTexture={old:true},newTexture={candidate:true};
  let uploaded=false;const errors=outcome==='prior-error'?[1280,0,0]:[];
  class Image {constructor(){images.push(this);}set src(value){this.url=value;}}
  const c=vm.createContext({window:clock,Image,document:{body:{dataset:{}}},Promise,Number,Float32Array});
  vm.runInContext(extract('createFlatFloodPlane'),c);const plane=c.createFlatFloodPlane({});
  plane.gl={NO_ERROR:0,getParameter:()=>null,activeTexture(){},pixelStorei(){},bindTexture(){},texParameteri(){},generateMipmap(){},
    createTexture:()=>outcome==='allocation-error'?null:newTexture,deleteTexture:value=>deleted.push(value),
    texImage2D(){uploaded=true;},isContextLost:()=>outcome==='context-loss'&&uploaded,
    getError:()=>errors.length?errors.shift():outcome==='upload-error'&&uploaded?1285:0};
  plane.texture=oldTexture;plane.textureReady=true;plane.committedUrl='old';plane.coordinates=['old'];plane.altitudeMeters=1;
  plane.pendingFrame={isCurrent:()=>true,coordinates:['new'],altitudeMeters:2};plane.updateGeometry=()=>{};
  const pending=plane.loadTexture('new');await images[0].onload();const ready=await pending;
  assert.equal(ready,outcome==='prior-error');assert.equal(plane.committedUrl,outcome==='prior-error'?'new':'old');
  assert.equal(plane.texture,outcome==='prior-error'?newTexture:oldTexture);assert.equal(plane.altitudeMeters,outcome==='prior-error'?2:1);
  assert.equal(deleted.includes(newTexture),['upload-error','context-loss'].includes(outcome));assert.equal(clock.rows.size,0);cases++;
}
console.log(`${cases} map fix cases passed: playback sessions, bounded/retryable images, shared export cancellation, renderer commit ordering, graphics/context/request races, and obsolete GPU uploads.`);
