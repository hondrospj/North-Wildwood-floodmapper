// Pure metadata classification: this file never starts a browser or retries I/O.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./test_north_wildwood_export_road_labels_browser.mjs',import.meta.url),'utf8');
const fn=source.match(/function classifyPendingProviderPreviewRetry\([^]*?\n}/)?.[0];
assert.ok(fn,'Classify the exact predicate used by the real browser test');
const context=vm.createContext({URL});vm.runInContext(fn,context);
const classify=value=>JSON.parse(JSON.stringify(context.classifyPendingProviderPreviewRetry(value.state,value.warning,value.context)));
const layer=(url,count,ready)=>({layerId:url.includes('/Reference/')?202:101,kind:'raster',url,mapContains:true,ownsMap:true,mapMissing:false,containerPresent:true,containerAttached:true,
 isLoading:ready<count,tileZoom:16,
 native:{count,complete:ready,ready,pending:count-ready,failed:0,tiles:Array.from({length:count},(_,i)=>({tag:'IMG',complete:i<ready,naturalWidth:i<ready?256:0}))},
 tracked:{count,current:count,tiles:Array.from({length:count},(_,i)=>({current:true,complete:i<ready,naturalWidth:i<ready?256:0,coords:{x:i,y:0,z:16}}))}});
const captureOriginal=(f,role='basemap')=>{f.warning.errors[0].exportRasterReadiness={schemaVersion:1,reason:'deadline',observedAt:1793221133000,layer:structuredClone(f.state[role])};};
function fixture(){const f={
 context:{name:'normal-route-free',routeEverInstalled:false,coldPreviewReady:true,actionId:'Png-16:9',pendingProviderRetries:0,retriedPreviewActions:[]},
 warning:{session:'normal-route-free',phase:'Png-16:9',observedAt:'2026-10-28T20:58:53.395Z',text:'Export preview could not be rendered.',captureErrors:[],errors:[{name:'Error',message:'The map background is still loading. Please try the export again.'}]},
 state:{state:'error',busy:false,basemap:layer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',78,28),
  roads:layer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',28,28),
  floodImage:{src:'https://example.test/actual-depth.webp',complete:true,naturalWidth:2186,naturalHeight:2824}}};captureOriginal(f);return f;}
const pending={eligible:true,pendingTiles:50,readyTiles:28,totalTiles:78},ready={eligible:true,pendingTiles:0,readyTiles:28,totalTiles:28};
assert.deepEqual(classify(fixture()),{eligible:true,reason:'original-raster-deadline-pending',originalProvider:'basemap',original:pending,pendingProviders:['basemap'],basemap:pending,roads:ready});
const roadsPending=fixture();roadsPending.state.basemap=layer(roadsPending.state.basemap.url,78,78);roadsPending.state.roads=layer(roadsPending.state.roads.url,35,0);captureOriginal(roadsPending,'roads');
assert.deepEqual(classify(roadsPending).pendingProviders,['roads']);assert.equal(classify(roadsPending).originalProvider,'roads');assert.equal(classify(roadsPending).eligible,true);
const bothPending=fixture();bothPending.state.basemap=layer(bothPending.state.basemap.url,96,0);bothPending.state.roads=layer(bothPending.state.roads.url,35,0);captureOriginal(bothPending);
assert.deepEqual(classify(bothPending).pendingProviders,['basemap','roads']);assert.equal(classify(bothPending).eligible,true);
const firstCold=fixture();firstCold.context.coldPreviewReady=false;firstCold.context.actionId='broad-current-view';firstCold.warning.phase='broad-current-view';
assert.equal(classify(firstCold).eligible,true);
// A late diagnostic may show ready tiles. Only the independent original
// synchronous deadline snapshot can justify recovery in that situation.
const nowReady=fixture();nowReady.state.basemap=layer(nowReady.state.basemap.url,78,78);
assert.equal(classify(nowReady).eligible,true);assert.deepEqual(classify(nowReady).pendingProviders,[]);
const roadsNowReady=structuredClone(roadsPending);roadsNowReady.state.roads=layer(roadsNowReady.state.roads.url,35,35);
assert.equal(classify(roadsNowReady).eligible,true);assert.equal(classify(roadsNowReady).originalProvider,'roads');
const encodedUrl=fixture();encodedUrl.state.basemap.url=new URL(encodedUrl.state.basemap.url).href;
assert.equal(classify(encodedUrl).eligible,true,'Equivalent encoded tile-template URLs identify the same layer');
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
 ['original deadline already ready',f=>f.warning.errors[0].exportRasterReadiness.layer=layer(f.state.basemap.url,78,78)],
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
const original=f=>f.warning.errors[0].exportRasterReadiness;
const originalNegatives=[
 ['missing original deadline snapshot',f=>delete f.warning.errors[0].exportRasterReadiness],
 ['wrong original schema',f=>original(f).schemaVersion=2],
 ['nondeadline original reason',f=>original(f).reason='tile-error'],
 ['missing original clock',f=>delete original(f).observedAt],
 ['invalid original clock',f=>original(f).observedAt=0],
 ['missing original layer',f=>original(f).layer=null],
 ['unknown original provider',f=>original(f).layer.url='https://example.test/World_Street_Map'],
 ['wrong original provider host',f=>original(f).layer.url=original(f).layer.url.replace('server.arcgisonline.com','example.test')],
 ['original vector layer',f=>original(f).layer.kind='vector'],
 ['original detached container',f=>original(f).layer.containerAttached=false],
 ['original missing container',f=>original(f).layer.containerPresent=false],
 ['original map mismatch',f=>original(f).layer.ownsMap=false],
 ['original map no longer contains layer',f=>original(f).layer.mapContains=false],
 ['original pending but not loading',f=>original(f).layer.isLoading=false],
 ['original empty native layer',f=>original(f).layer=layer(f.state.basemap.url,0,0)],
 ['original bad native tile',f=>{const a=original(f).layer;a.native.tiles[0].naturalWidth=0;a.native.failed=1;}],
 ['original unreported bad tile',f=>original(f).layer.native.tiles[0].naturalWidth=0],
 ['original mismatched native count',f=>original(f).layer.native.count++],
 ['original mismatched completion count',f=>original(f).layer.native.complete++],
 ['original mismatched pending count',f=>original(f).layer.native.pending--],
 ['original missing tracked layer',f=>delete original(f).layer.tracked],
 ['original mismatched tracked count',f=>original(f).layer.tracked.count--],
 ['original missing current tiles',f=>{const a=original(f).layer;a.tracked.tiles.forEach(t=>t.current=false);a.tracked.current=0;}],
 ['original native pending but current all ready',f=>original(f).layer.tracked.tiles.forEach(t=>{t.complete=true;t.naturalWidth=256;})],
 ['original stale current tile zoom',f=>original(f).layer.tracked.tiles[0].coords.z=15],
 ['original fractional tile zoom',f=>original(f).layer.tileZoom=16.5],
 ['original stale isLoading with ready tiles',f=>{original(f).layer=layer(f.state.basemap.url,78,78);original(f).layer.isLoading=true;}],
 ['original ready even though later pending',f=>original(f).layer=layer(f.state.basemap.url,78,78)],
 ['original ready and later ready',f=>{original(f).layer=layer(f.state.basemap.url,78,78);f.state.basemap=layer(f.state.basemap.url,78,78);} ],
 ['missing original layer identity',f=>delete original(f).layer.layerId],
 ['changed current layer identity',f=>f.state.basemap.layerId=999],
 ['same layer moved to a new valid grid',f=>{f.state.basemap.tileZoom=17;f.state.basemap.tracked.tiles.forEach(tile=>tile.coords.z=17);}],
 ['changed current source on same layer',f=>f.state.basemap.url+='?different-generation=1'],
 ['missing current basemap identity',f=>delete f.state.basemap.layerId],
 ['missing current roads identity',f=>delete f.state.roads.layerId],
 ['warning from another action',f=>f.warning.phase='Png-9:16'],
 ['unknown preview action',f=>f.context.actionId='unbounded-next-action'],
 ['missing preview action',f=>delete f.context.actionId],
 ['missing action budget ledger',f=>delete f.context.retriedPreviewActions],
 ['duplicate actions in ledger',f=>{f.context.retriedPreviewActions=['Gif-1:1','Gif-1:1'];f.context.pendingProviderRetries=2;}],
 ['unknown action in ledger',f=>{f.context.retriedPreviewActions=['unbounded-action'];f.context.pendingProviderRetries=1;}],
 ['negative total retry count',f=>f.context.pendingProviderRetries=-1],
];
for(const[name,change]of originalNegatives){const f=fixture();change(f);assert.equal(classify(f).eligible,false,name);}
// Each named action has one budget; changing aspect does not create an
// unbounded retry loop and never permits a second Retry of the same action.
const consumed=fixture();assert.equal(classify(consumed).eligible,true);
consumed.context.retriedPreviewActions=['Png-16:9'];consumed.context.pendingProviderRetries=1;
assert.equal(classify(consumed).eligible,false,'Same action cannot retry twice');
consumed.context.actionId='Png-9:16';consumed.warning.phase='Png-9:16';
assert.equal(classify(consumed).eligible,true,'A distinct fixed action has its own budget');
consumed.context.retriedPreviewActions.push('Png-9:16');consumed.context.pendingProviderRetries=2;
assert.equal(classify(consumed).eligible,false,'New action also stops after one Retry');
firstCold.context.retriedPreviewActions=['broad-current-view'];firstCold.context.pendingProviderRetries=1;
assert.equal(classify(firstCold).eligible,false,'Cold first attempt gets at most one Retry');
const fixedActions=['broad-current-view','town-restored','Png-1:1','Png-4:5','Png-16:9','Png-9:16','Gif-1:1','Gif-4:5','Gif-16:9','Gif-9:16','png-download-ready','gif-download-ready','roads-disabled','roads-reenabled','current-crop'];
assert.equal(fixedActions.length,15);
for(const actionId of fixedActions){const f=fixture();f.context.actionId=actionId;f.warning.phase=actionId;f.context.retriedPreviewActions=[...fixedActions];f.context.pendingProviderRetries=15;assert.equal(classify(f).eligible,false,`Fixed cap rejects ${actionId}`);}
console.log(`PASS pending-provider UI Retry: 7 original/current positives, ${negatives.length+originalNegatives.length} rejected states, original deadline identity, 15 fixed action budgets and duplicate-action rejection.`);
