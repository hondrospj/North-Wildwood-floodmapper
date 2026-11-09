import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../assets/3d/north-wildwood-3d.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function clock(){let now=0,id=0;const rows=new Map();return{rows,setTimeout(fn,ms){const key=++id;rows.set(key,{fn,at:now+ms});return key;},clearTimeout(key){rows.delete(key);},setInterval(fn,ms){const key=++id;rows.set(key,{fn,at:now+ms,repeat:ms});return key;},clearInterval(key){rows.delete(key);},async tick(ms){const end=now+ms;while(true){const item=[...rows].filter(([,r])=>r.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;const[key,row]=item;now=row.at;if(row.repeat)row.at+=row.repeat;else rows.delete(key);row.fn();await flush();}now=end;await flush();}};}
let checks=0;
// A response or JSON body that ignores abort must still settle and release its timer.
for(const point of ['response','body'])for(const ending of ['timeout','cancel']){
 const timer=clock(),gate=deferred();let signal;
 const c=vm.createContext({AbortController,window:timer,fetch:async(_url,options)=>{signal=options.signal;if(point==='response')await gate.promise;return{ok:true,json:async()=>{if(point==='body')await gate.promise;return{late:true};}};}});
 vm.runInContext(fn('fetch3dJson'),c);const job=c.fetch3dJson('asset','Asset failed.');const rejected=assert.rejects(job,/timed out|cancelled/);await flush();assert.equal(signal.aborted,false);
 if(ending==='timeout')await timer.tick(20000);else job.cancel();await rejected;assert.equal(signal.aborted,true);assert.equal(timer.rows.size,0);gate.resolve();await flush();checks++;
}
// Evict an expired style request, then ignore its late JSON body after a healthy retry.
{
 const timer=clock(),gate=deferred();let count=0;
 const c=vm.createContext({AbortController,window:{...timer,ShorelyRoadLabels:{styleBasemap:s=>s}},ESRI_STYLE_URL:'https://example.test/root.json',ESRI_VECTOR_TILES:'tiles',mapStylePromise:null,cloneJson:x=>JSON.parse(JSON.stringify(x)),absoluteStyleAsset:x=>x,fetch:async()=>({ok:true,json:async()=>++count===1?gate.promise:{layers:[]}})});
 for(const name of ['fetch3dJson','load3dStyle'])vm.runInContext(fn(name),c);
 const old=c.load3dStyle(),rejected=assert.rejects(old,/timed out/);await flush();await timer.tick(20000);await rejected;assert.equal(c.mapStylePromise,null);
 const current=await c.load3dStyle(),cached=c.mapStylePromise;gate.resolve({layers:[{id:'obsolete'}]});await flush();assert.equal(c.mapStylePromise,cached);assert.equal(current.layers.length,0);assert.equal(timer.rows.size,0);checks++;
}
function startupFixture(){
 const timer=clock(),styles=deferred(),buildings=deferred(),classes=new Set(),maps=[];let style=()=>styles.promise,build=async()=>{};
 class Map{constructor(){maps.push(this);this.listeners=new MapNative();}on(){}off(name,cb){if(this.listeners.get(name)===cb)this.listeners.delete(name);}once(name,cb){this.listeners.set(name,cb);queueMicrotask(()=>this.listeners.get(name)?.());}getPitch(){return 0;}remove(){this.removed=true;}resize(){}}
 const MapNative=globalThis.Map;
 const c=vm.createContext({glMap:null,glMapPromise:null,glMapInitialization:null,glStyleReady:false,mapStylePromise:null,buildingDataPromise:null,window:{...timer,matchMedia:()=>({matches:false})},document:{body:{dataset:{},classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)}},getElementById:()=>({})},map:{getCenter:()=>({lng:0,lat:0}),getZoom:()=>14,invalidateSize(){}},maplibregl:{Map},MAP_MAX_ZOOM:22,GRAPHICS_FALLBACK_NOTICE:'3D graphics unavailable',DEFAULT_PITCH:0,DEFAULT_BEARING:0,TERRAIN_EXAGGERATION:4,townAddressMarker:null,townAddressPopup:null,console:{warn(){}},requestAnimationFrame:cb=>queueMicrotask(cb),loadMapLibreRuntime:async()=>{},load3dStyle:()=>style(),syncBuildings3d:()=>build()});
 for(const name of ['schedulePersistentNavControlSync','syncFloodPresentationMode','syncPersistentNavControl','addCore3dLayers','wire3dInteractions','wire3dContextRecovery','syncBoundary3d','syncFloodLayer3d','syncSatellite3d','syncRoadLabels3d','syncParcels3d','syncNsi3d','updateDiagnostics','suspendLeafletVisualLayers'])c[name]=()=>{};
 vm.runInContext(fn('ensure3dMap'),c);return{c,timer,styles,buildings,maps,classes,style:value=>{style=value;},build:value=>{build=value;}};
}
{
 const h=startupFixture(),old=h.c.ensure3dMap();await flush();await h.timer.tick(20000);assert.equal(await old,null);assert.equal(h.c.document.body.dataset.map3d,'fallback');assert.equal(h.c.glMapPromise,null);
 h.style(async()=>({}));const current=await h.c.ensure3dMap();assert.ok(current);assert.equal(h.maps.length,1);h.styles.resolve({});await flush();assert.equal(h.maps.length,1);assert.equal(h.c.glMap,current);assert.ok(h.classes.has('map-3d-ready'));assert.equal(h.timer.rows.size,0);checks++;
}
{
 const h=startupFixture();h.build(()=>h.buildings.promise);const old=h.c.ensure3dMap();await h.timer.tick(15000);h.styles.resolve({});await flush();assert.equal(h.maps.length,1);assert.ok(!h.classes.has('map-3d-ready'));
 await h.timer.tick(4999);assert.equal(h.maps[0].removed,undefined);await h.timer.tick(1);assert.equal(await old,null);assert.equal(h.maps[0].removed,true);assert.ok(!h.classes.has('map-3d-ready'));
 h.buildings.resolve();await flush();assert.equal(h.c.glMap,null);assert.ok(!h.classes.has('map-3d-ready'));assert.equal(h.timer.rows.size,0);checks++;
}
// A failed required asset cancels its sibling body and cannot populate data late.
{
 const timer=clock(),gate=deferred(),signals=[];
 const c=vm.createContext({AbortController,URL,window:timer,buildingData:null,buildingDataPromise:null,APP_BASE:new URL('https://example.test/'),TOWN_CONFIG:{structures:{buildings3dPath:'Buildings'},boundary:{boundaryUrl:'boundary'}},fetch:async(url,options)=>{signals.push(options.signal);return{ok:!url.includes('Buildings'),json:()=>gate.promise};}});
 for(const name of ['fetch3dJson','loadBuildingData'])vm.runInContext(fn(name),c);
 await assert.rejects(c.loadBuildingData(),/building asset could not be loaded/);assert.equal(c.buildingDataPromise,null);assert.ok(signals.every(signal=>signal.aborted));assert.equal(timer.rows.size,0);gate.resolve({features:[]});await flush();assert.equal(c.buildingData,null);checks++;
}
// An old building wait cannot add sources to a replacement renderer.
{
 const gate=deferred();let mutations=0;const original={getSource:()=>null,addSource:()=>mutations++};
 const c=vm.createContext({glMap:original,glStyleReady:true,TOWN_CONFIG:{structures:{buildings3dPath:'Buildings'}},layerVisible:()=>false,loadBuildingData:()=>gate.promise});
 vm.runInContext(fn('syncBuildings3d'),c);const job=c.syncBuildings3d({preload:true});c.glMap={addSource:()=>mutations++};gate.resolve({features:[]});await job;assert.equal(mutations,0);checks++;
}
// A delayed native layer update must preserve a newer explicit query mode.
{
 const start=source.indexOf('  var originalSetBuildingsEnabled ='),end=source.indexOf('  var originalSetSatelliteEnabled =',start),wrapper=source.slice(start,end);
 for(const pitch of [0,60]){
  const gate=deferred(),started=deferred(),toggle={classList:{toggle(){}},setAttribute(){}};
  const c=vm.createContext({
   buildingToggleGeneration:0,mapQueryGeneration:0,mapClickMode:'depth',setBuildingsEnabled:async()=>{},
   document:{body:{classList:{contains:n=>n==='map-3d-ready'}},getElementById:()=>toggle},
   glMap:{getPitch:()=>pitch},glStyleReady:true,map3dReady:()=>true,map:null,buildingsLayer:null,
   ensure3dMap(){throw Error('Buildings cannot initialize the native renderer');},
   setMapClickMode(mode){c.mapClickMode=mode;},updateExportBuildingsLayer(){},updateMapClickModeControl(){},toast(){},
   syncBuildings3d(){started.resolve();return gate.promise;},suspendLeafletVisualLayers(){}
  });
  vm.runInContext(wrapper,c);
  const job=c.setBuildingsEnabled(true);
  await Promise.race([started.promise,job]);
  ++c.mapQueryGeneration;
  c.mapClickMode='depth';
  gate.resolve();
  await job;
  assert.equal(c.mapClickMode,'depth');
  checks++;
 }
}
// Native top-down images must finish before frame commit and remain retryable after transport failure.
for(const outcome of ['both-ready','hidden-native-failed','hidden-plane-failed']){
 const native=deferred(),gpu=deferred(),layer={_url:'new'},sourceImage={};let restored=0,settled=false,pitch=60;
 const map={getPitch:()=>pitch,getSource:()=>sourceImage},plane={textureReady:true,committedUrl:'new',whenReady:()=>gpu.promise};
 const c=vm.createContext({glMap:map,glStyleReady:true,lastRenderToken:1,pendingFloodLayer:layer,pendingFlood3dRequest:null,floodPlaneLayer:plane,currentFloodLayer:{_url:'old'},document:{body:{dataset:{map3d:'ready'},classList:{contains:()=>true}}},map:{hasLayer:()=>true},waitForNativeFloodImage3d:()=>native.promise,syncFloodLayer3d(){if(!c.pendingFlood3dRequest)restored++;}});
 vm.runInContext(fn('prepareFloodFrame3d'),c);const job=c.prepareFloodFrame3d(layer,{stage:4.4},1).then(value=>{settled=true;return value;});native.resolve(outcome!=='hidden-native-failed');await flush();assert.equal(settled,false,'Native readiness alone cannot commit a frame while the pitched presentation is pending');pitch=0;gpu.resolve(outcome!=='hidden-plane-failed');assert.equal(await job,outcome==='both-ready');assert.equal(restored,outcome==='both-ready'?0:1);checks++;
}
for(const outcome of ['ready','error','timeout','superseded','replacement']){
 const timer=clock(),listeners=new Map(),sourceImage={loaded:()=>loaded,image:{old:true}},versions=new WeakMap();let loaded=false,current=true;const replacement={};
 const map={getSource:()=>outcome==='replacement'&&!current?replacement:sourceImage,on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},off(name,fn){listeners.get(name)?.delete(fn);}};
 const c=vm.createContext({window:timer,imageLayerVersions:versions});vm.runInContext(fn('waitForNativeFloodImage3d'),c);versions.set(sourceImage,'requested');let settled=false;const job=c.waitForNativeFloodImage3d(map,sourceImage,()=>current).then(value=>{settled=true;return value;});await flush();assert.equal(settled,false);
 if(outcome==='ready'){loaded=true;sourceImage.image={new:true};for(const cb of listeners.get('sourcedata'))cb();}
 if(outcome==='error')for(const cb of [...listeners.get('error')])cb({sourceId:'nw-flood-drape-source'});
 if(outcome==='timeout')await timer.tick(20000);
 if(outcome==='superseded'||outcome==='replacement'){current=false;await timer.tick(100);}
 assert.equal(await job,outcome==='ready');assert.equal(versions.has(sourceImage),outcome==='ready');assert.equal(timer.rows.size,0);assert.ok([...listeners.values()].every(rows=>rows.size===0));checks++;
}
console.log(`${checks} additional 3D cases passed: bounded responses/bodies, cancelled late transports, style cache retry, total startup deadline, late initialization isolation, explicit click intent and native flood image readiness/failure cleanup.`);
