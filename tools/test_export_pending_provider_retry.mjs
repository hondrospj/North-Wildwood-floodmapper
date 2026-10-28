// Pure metadata classification: this file never starts a browser or retries I/O.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./test_north_wildwood_export_road_labels_browser.mjs',import.meta.url),'utf8');
const fn=source.match(/function classifyPendingProviderPreviewRetry\([^]*?\n}/)?.[0];
assert.ok(fn,'Classify the exact predicate used by the real browser test');
const context=vm.createContext({URL});vm.runInContext(fn,context);
const classify=value=>JSON.parse(JSON.stringify(context.classifyPendingProviderPreviewRetry(value.state,value.warning,value.context)));
const layer=(url,count,ready)=>({kind:'raster',url,mapContains:true,ownsMap:true,mapMissing:false,containerPresent:true,containerAttached:true,
 isLoading:ready<count,tileZoom:16,
 native:{count,complete:ready,ready,pending:count-ready,failed:0,tiles:Array.from({length:count},(_,i)=>({tag:'IMG',complete:i<ready,naturalWidth:i<ready?256:0}))},
 tracked:{count,current:count,tiles:Array.from({length:count},(_,i)=>({current:true,complete:i<ready,naturalWidth:i<ready?256:0,coords:{x:i,y:0,z:16}}))}});
function fixture(){return{
 context:{name:'normal-route-free',routeEverInstalled:false,coldPreviewReady:true,pendingProviderRetries:0},
 warning:{session:'normal-route-free',text:'Export preview could not be rendered.',captureErrors:[],errors:[{name:'Error',message:'The map background is still loading. Please try the export again.'}]},
 state:{state:'error',busy:false,basemap:layer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',78,28),
  roads:layer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',28,28),
  floodImage:{src:'https://example.test/actual-depth.webp',complete:true,naturalWidth:2186,naturalHeight:2824}}};}
assert.deepEqual(classify(fixture()),{eligible:true,reason:'genuine-pending-provider',pendingProviders:['basemap'],
 basemap:{eligible:true,pendingTiles:50,readyTiles:28,totalTiles:78},roads:{eligible:true,pendingTiles:0,readyTiles:28,totalTiles:28}});
const roadsPending=fixture();roadsPending.state.basemap=layer(roadsPending.state.basemap.url,78,78);roadsPending.state.roads=layer(roadsPending.state.roads.url,35,0);
assert.deepEqual(classify(roadsPending).pendingProviders,['roads']);assert.equal(classify(roadsPending).eligible,true);
const bothPending=fixture();bothPending.state.basemap=layer(bothPending.state.basemap.url,96,0);bothPending.state.roads=layer(bothPending.state.roads.url,35,0);
assert.deepEqual(classify(bothPending).pendingProviders,['basemap','roads']);assert.equal(classify(bothPending).eligible,true);
const firstCold=fixture();firstCold.context.coldPreviewReady=false;
assert.equal(classify(firstCold).eligible,true);assert.deepEqual(classify(firstCold).pendingProviders,['basemap']);
const negatives=[
 ['street-fault context',f=>f.context.name='street-data-fault'],
 ['routed normal context',f=>f.context.routeEverInstalled=true],
 ['route status missing',f=>delete f.context.routeEverInstalled],
 ['invalid cold-preview state',f=>f.context.coldPreviewReady='false'],
 ['missing cold-preview state',f=>delete f.context.coldPreviewReady],
 ['one retry already used',f=>f.context.pendingProviderRetries=1],
 ['more than one retry used',f=>f.context.pendingProviderRetries=2],
 ['missing retry budget',f=>delete f.context.pendingProviderRetries],
 ['already ready',f=>f.state.state='ready'],
 ['empty selection',f=>f.state.state='empty'],
 ['export busy',f=>f.state.busy=true],
 ['wrong actual error',f=>f.warning.errors[0].message='The flood image could not load. Please try the export again.'],
 ['only matching console text',f=>{f.warning.text+=' The map background is still loading. Please try the export again.';f.warning.errors=[];}],
 ['matching substring only',f=>f.warning.errors[0].message+=' Additional failure'],
 ['native decode error',f=>f.warning.errors[0]={name:'EncodingError',message:'Invalid image request.'}],
 ['wrong error type',f=>f.warning.errors[0].name='TypeError'],
 ['error argument extraction failed',f=>f.warning.captureErrors.push('unavailable handle')],
 ['error extraction unproven',f=>delete f.warning.captureErrors],
 ['warning from another context',f=>f.warning.session='street-data-fault'],
 ['missing warning',f=>f.warning=null],
 ['vector basemap',f=>f.state.basemap.kind='vector'],
 ['detached basemap container',f=>f.state.basemap.containerAttached=false],
 ['missing basemap container',f=>f.state.basemap.containerPresent=false],
 ['basemap not in export map',f=>f.state.basemap.mapContains=false],
 ['basemap owned by another map',f=>f.state.basemap.ownsMap=false],
 ['missing basemap map',f=>f.state.basemap.mapMissing=true],
 ['wrong basemap service',f=>f.state.basemap.url=f.state.roads.url],
 ['wrong provider host',f=>f.state.basemap.url=f.state.basemap.url.replace('server.arcgisonline.com','example.test')],
 ['invalid provider URL',f=>f.state.basemap.url='broken'],
 ['basemap not loading',f=>f.state.basemap.isLoading=false],
 ['empty native tile list',f=>{f.state.basemap.native={count:0,ready:0,pending:0,failed:0,tiles:[]};}],
 ['stale isLoading with all tiles ready',f=>{f.state.basemap=layer(f.state.basemap.url,78,78);f.state.basemap.isLoading=true;}],
 ['bad basemap tile',f=>{f.state.basemap.native.tiles[0].naturalWidth=0;f.state.basemap.native.failed=1;f.state.basemap.native.ready--;}],
 ['unreported bad tile',f=>f.state.basemap.native.tiles[0].naturalWidth=0],
 ['tile count inconsistent',f=>f.state.basemap.native.count++],
 ['pending count inconsistent',f=>f.state.basemap.native.pending--],
 ['unproven native tile completion',f=>delete f.state.basemap.native.tiles[30].complete],
 ['no current tracked tiles',f=>{f.state.basemap.tracked.tiles.forEach(t=>t.current=false);f.state.basemap.tracked.current=0;}],
 ['tracked current tiles all ready',f=>f.state.basemap.tracked.tiles.forEach(t=>{t.complete=true;t.naturalWidth=256;})],
 ['tracked bad current tile',f=>{f.state.basemap.tracked.tiles[0].naturalWidth=0;}],
 ['tracked current count inconsistent',f=>f.state.basemap.tracked.current--],
 ['stale tracked zoom',f=>f.state.basemap.tracked.tiles[0].coords.z=15],
 ['fractional tile zoom',f=>f.state.basemap.tileZoom=16.5],
 ['missing current tile metadata',f=>delete f.state.basemap.tracked],
 ['roads missing',f=>f.state.roads=null],
 ['roads detached',f=>f.state.roads.containerAttached=false],
 ['roads not owned',f=>f.state.roads.ownsMap=false],
 ['roads still loading',f=>f.state.roads.isLoading=true],
 ['roads empty',f=>f.state.roads=layer(f.state.roads.url,0,0)],
 ['roads failed tile',f=>{f.state.roads.native.tiles[0].naturalWidth=0;f.state.roads.native.failed=1;f.state.roads.native.ready--;}],
 ['both providers already ready',f=>f.state.basemap=layer(f.state.basemap.url,78,78)],
 ['wrong roads provider service',f=>f.state.roads.url=f.state.basemap.url],
 ['wrong roads provider host',f=>f.state.roads.url=f.state.roads.url.replace('server.arcgisonline.com','example.test')],
 ['missing roads current metadata',f=>delete f.state.roads.tracked],
 ['roads tracked count inconsistent',f=>f.state.roads.tracked.count--],
 ['roads current count inconsistent',f=>f.state.roads.tracked.current--],
 ['roads stale current zoom',f=>f.state.roads.tracked.tiles[0].coords.z=15],
 ['roads fractional tile zoom',f=>f.state.roads.tileZoom=16.5],
 ['roads native complete count inconsistent',f=>f.state.roads.native.complete--],
 ['basemap native complete count inconsistent',f=>f.state.basemap.native.complete++],
 ['basemap tracked count inconsistent',f=>f.state.basemap.tracked.count--],
 ['roads tracked bad tile',f=>f.state.roads.tracked.tiles[0].naturalWidth=0],
 ['roads current tile pending while native all ready',f=>{f.state.roads.tracked.tiles[0].complete=false;f.state.roads.tracked.tiles[0].naturalWidth=0;}],
 ['flood missing',f=>f.state.floodImage=null],
 ['flood still pending',f=>f.state.floodImage.complete=false],
 ['flood failed',f=>f.state.floodImage.naturalWidth=0],
 ['flood zero height',f=>f.state.floodImage.naturalHeight=0],
 ['flood has no source',f=>f.state.floodImage.src=''],
];
for(const[name,change]of negatives){const f=fixture();change(f);assert.equal(classify(f).eligible,false,name);}
// The same context can spend one budget, independent of the next aspect.
const consumed=fixture();assert.equal(classify(consumed).eligible,true);consumed.context.pendingProviderRetries++;
for(const aspect of ['1:1','4:5','16:9','9:16']){consumed.state.aspect=aspect;assert.equal(classify(consumed).eligible,false,`Budget must not reset for ${aspect}`);}
firstCold.context.pendingProviderRetries=1;
assert.deepEqual(classify(firstCold),{eligible:false,reason:'retry-budget-used'},'A cold attempt must use the same one-Retry budget');
console.log(`PASS pending-provider UI Retry: four provider positives, ${negatives.length} rejected states, explicit cold-state metadata and one shared cold/later context budget.`);
