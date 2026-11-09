import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../assets/road-impacts.js',import.meta.url),'utf8');
const network=fs.readFileSync(new URL('app/runtime/02-data-and-datums.js',import.meta.url),'utf8');
const fetchJsonSource=network.match(/async function fetchJson\([^]*?\n    }/)?.[0];
assert.ok(fetchJsonSource);
const roads={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Test Road'},geometry:{type:'LineString',coordinates:[[0,.5],[.001,.5]]}}]};
function fixture(fetchResponse,{physics=false,restoredUi=false,shortDeadline=false}={}){
  const values=new Uint8ClampedArray(20*4);
  for(let x=5;x<16;x++)values.set([27,183,245,255],x*4);
  values.set([99,212,113,255],10*4); // Disconnected/uncertain land is not flooding.
  const depths=new Array(20).fill(.75);
  const physicsValues=new Uint8ClampedArray(20*4);
  for(let x=0;x<20;x++)physicsValues.set([0,229,1,255],x*4);
  const layers=new Set(),panes=new Map(),elements=new Map();
  const classSet=new Set();
  const element=()=>{
    const classes=new Set(),attributes=new Map();
    return {classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
      setAttribute(name,value){attributes.set(name,value);},getAttribute:name=>attributes.get(name),
      addEventListener(name,handler){this[name]=handler;},hidden:true};
  };
  for(const id of ['roadImpactsToggle','roadImpactsStatus','roadImpactsKey'])elements.set(id,element());
  if(restoredUi){elements.get('roadImpactsToggle').classList.toggle('on',true);elements.get('roadImpactsToggle').setAttribute('aria-checked','true');elements.get('roadImpactsKey').hidden=false;}
  let observer;
  const map={hasLayer:layer=>layers.has(layer),removeLayer:layer=>layers.delete(layer),getPane:name=>panes.get(name),createPane:name=>panes.set(name,{style:{}})};
  const bounds={getWest:()=>0,getEast:()=>.001,getSouth:()=>0,getNorth:()=>1};
  const image={complete:true,naturalWidth:20,naturalHeight:1};
  const physicsImage={...image,values:physicsValues};
  const frame={getElement:()=>image,getBounds:()=>bounds};
  let leaf;
  const glSources=new Map(),glLayers=new Map();
  const gl={getSource:id=>glSources.get(id),getLayer:id=>glLayers.get(id),addSource(id,options){glSources.set(id,{data:options.data,setData(data){this.data=data;}});},addLayer(layer){glLayers.set(layer.id,layer);},setLayoutProperty(id,key,value){glLayers.get(id).layout[key]=value;}};
  let fetchCount=0;
  const ctx={URL,console,AbortController,Uint8ClampedArray,APP_BASE:new URL('https://example.test/north-wildwood/'),map,
    currentFloodLayer:frame,floodFrameState:'ready',lastRenderToken:1,floodLatLngBounds:bounds,
    currentSeriesHours:[{stage:2}],currentHourIndex:0,currentOverlayMode:'depth',
    getSelectedStageNavd88:()=>2,getHydraulicPhaseForEntry:()=> 'filling',
    getPhysicsAssetForEntry:()=>physics?{query:{url:'https://example.test/query.png'}}:null,
    getActivePhysicsManifest:()=>({boundsWgs84:[[0,0],[1,.001]]}),
    preloadPhysicsQueryImage:async()=>physicsImage,getDepthQueryGrid:async()=>({}),
    sampleDepthModel:async(lat,lon)=>({depthFt:depths[Math.floor(lon/.001*20)]}),
    getDepthQueryDisplayDepth(sample,stage,renderedFlood,phase){assert.equal(stage,2);assert.equal(phase,'filling');assert.equal(renderedFlood.flooded,true);return sample?.depthFt;},
    document:{body:{dataset:{},classList:{contains:name=>classSet.has(name)}},getElementById:id=>elements.get(id),createElement:()=>{
      let raster=values;
      return {width:0,height:0,getContext:()=>({drawImage(image){raster=image.values||values;},getImageData:()=>({data:raster})})};
    }},
    fetch:async(_url, options)=>{fetchCount++;return fetchResponse?fetchResponse(fetchCount, options):{ok:true,json:async()=>roads};},
    requestAnimationFrame:callback=>setTimeout(callback,0),
    MutationObserver:class{constructor(callback){observer=callback;}observe(){}},
    L:{canvas:()=>({}),geoJSON(data){leaf={data,clearLayers(){this.data={type:'FeatureCollection',features:[]};},addData(data){this.data=data;},addTo(){layers.add(this);return this;}};return leaf;}},
    window:{NORTH_WILDWOOD_3D:{getMap:()=>gl},addEventListener(name,handler){this[name]=handler;},
      setTimeout:(callback, delay)=>setTimeout(callback,shortDeadline?5:delay),clearTimeout},
    isWetRasterPixel:(v,o)=>v[o+3]>0&&!(v[o]===99&&v[o+1]===212&&v[o+2]===113),
    clearFloodLayer(){ctx.currentFloodLayer=null;ctx.floodFrameState='unavailable';},
    async renderHour(){
      ctx.lastRenderToken++;
      ctx.floodFrameState='loading';
      if(ctx.waitForFrameCommit && !await ctx.waitForFrameCommit()){
        ctx.floodFrameState='failed';
        return false;
      }
      if(!ctx.repeatFrame)values.fill(0);
      ctx.currentFloodLayer={...frame};
      ctx.floodFrameState='ready';
    }
  };
  vm.createContext(ctx);vm.runInContext(fetchJsonSource,ctx);vm.runInContext(source,ctx);
  return {ctx,api:ctx.window.NORTH_WILDWOOD_ROAD_IMPACTS,fetchCount:()=>fetchCount,leaf:()=>leaf,elements,depths,physicsValues,
    activateGl(){classSet.add('map-3d-ready');observer();},glSources,glLayers};
}

const test=fixture();
assert.equal(test.fetchCount(),0,'Disabled Road Impacts must not fetch road data at startup');
assert.equal(test.api.state().enabled,false);
assert.equal(test.elements.get('roadImpactsToggle').getAttribute('aria-checked'),'false');
assert.equal(test.elements.get('roadImpactsToggle').classList.contains('on'),false);
assert.equal(test.elements.get('roadImpactsKey').hidden,true);
const restoredUi=fixture(null,{restoredUi:true});
assert.equal(restoredUi.fetchCount(),0,'Resetting restored controls must not load road data');
assert.equal(restoredUi.elements.get('roadImpactsToggle').getAttribute('aria-checked'),'false');
assert.equal(restoredUi.elements.get('roadImpactsToggle').classList.contains('on'),false);
assert.equal(restoredUi.elements.get('roadImpactsKey').hidden,true,'Startup must hide a restored visible key');
await test.api.setEnabled(true);
assert.equal(test.fetchCount(),1);
assert.equal(test.api.state().sections,2,'Wet runs should split around disconnected land');
assert.equal(test.leaf().data.features.length,2,'The first Leaflet update must contain the newly calculated data');
test.activateGl();
assert.equal(test.glLayers.get('nw-road-impacts').layout.visibility,'visible');
assert.equal(test.glSources.get('nw-road-impacts-source').data.features.length,2);
test.ctx.window.pageshow({persisted:false});
assert.equal(test.api.state().enabled,true,'The initial pageshow event must preserve a user action made during loading');
test.ctx.window.pageshow({persisted:true});
assert.equal(test.api.state().enabled,false,'Restoring a page from browser memory must turn Road Impacts off');
assert.equal(test.api.state().sections,0);
assert.equal(test.elements.get('roadImpactsKey').hidden,true);
assert.equal(test.glLayers.get('nw-road-impacts').layout.visibility,'none');
await test.api.setEnabled(true);
let prevented=false;
test.elements.get('roadImpactsToggle').keydown({key:' ',preventDefault(){prevented=true;}});
assert.ok(prevented);
assert.equal(test.api.state().enabled,false);
assert.equal(test.api.state().sections,0);
assert.equal(test.glLayers.get('nw-road-impacts').layout.visibility,'none');
await test.api.setEnabled(true);
await test.ctx.renderHour(1);
assert.equal(test.api.state().sections,0,'A dry replacement flood frame must remove the old impacts');
test.ctx.clearFloodLayer();
assert.equal(test.glSources.get('nw-road-impacts-source').data.features.length,0);

const transition=fixture();
await transition.api.setEnabled(true);
transition.activateGl();
let finishFrame,finishSampling,samplingStarted;
transition.ctx.waitForFrameCommit=()=>new Promise(resolve=>{finishFrame=resolve;});
const startedSampling=new Promise(resolve=>{samplingStarted=resolve;});
transition.ctx.getDepthQueryGrid=()=>new Promise(resolve=>{
  finishSampling=resolve;
  samplingStarted();
});
const render=transition.ctx.renderHour(1);
assert.equal(transition.api.state().sections,2,'A pending replacement keeps the displayed frame and its roads');
assert.equal(transition.glLayers.get('nw-road-impacts').layout.visibility,'visible');
finishFrame(true);
await startedSampling;
assert.equal(transition.api.state().sections,0,'A committed replacement drops old roads before sampling its depths');
assert.equal(transition.ctx.document.body.dataset.roadImpactsState,'loading');
assert.equal(transition.glLayers.get('nw-road-impacts').layout.visibility,'none');
assert.equal(transition.glLayers.get('nw-road-impacts-halo').layout.visibility,'none');
finishSampling({});
await render;
assert.equal(transition.ctx.document.body.dataset.roadImpactsState,'ready','A valid empty result is ready');

const repeated=fixture();
repeated.ctx.repeatFrame=true;
repeated.ctx.currentFloodLayer._floodmapperFrame={
  entry:{timeUtc:'2026-09-26T14:00:00Z'},stage:2,phase:'filling',overlayMode:'depth'
};
await repeated.api.setEnabled(true);
let finishRepeatedSampling,repeatedSamplingStarted;
const startedRepeatedSampling=new Promise(resolve=>{repeatedSamplingStarted=resolve;});
repeated.ctx.getDepthQueryGrid=()=>new Promise(resolve=>{
  finishRepeatedSampling=resolve;
  repeatedSamplingStarted();
});
const repeatedRender=repeated.ctx.renderHour(1);
await startedRepeatedSampling;
assert.equal(repeated.api.state().sections,2,'Reloading the same committed frame keeps its valid road data');
finishRepeatedSampling({});
await repeatedRender;

const retained=fixture();
await retained.api.setEnabled(true);
retained.ctx.waitForFrameCommit=async()=>false;
await retained.ctx.renderHour(1);
assert.equal(retained.api.state().sections,2,'A failed replacement keeps the road data for the retained flood frame');
assert.equal(retained.ctx.document.body.dataset.roadImpactsState,'ready');

const interrupted=fixture();
await interrupted.api.setEnabled(true);
let finishInterruptedSampling,interruptedSamplingStarted;
const startedInterruptedSampling=new Promise(resolve=>{interruptedSamplingStarted=resolve;});
interrupted.ctx.getDepthQueryGrid=()=>new Promise(resolve=>{
  finishInterruptedSampling=resolve;
  interruptedSamplingStarted();
});
const interruptedRender=interrupted.ctx.renderHour(1);
await startedInterruptedSampling;
interrupted.ctx.waitForFrameCommit=async()=>false;
await interrupted.ctx.renderHour(2);
finishInterruptedSampling({});
await interruptedRender;
assert.equal(interrupted.api.state().sections,0);
assert.equal(interrupted.ctx.document.body.dataset.roadImpactsState,'unavailable',
  'An abandoned road update settles if the next flood frame fails');

const threshold=fixture();
threshold.depths.fill(.49);
await threshold.api.setEnabled(true);
assert.equal(threshold.api.state().sections,0,'Water below half a foot must be excluded');
threshold.depths.fill(.5);
await threshold.api.refresh();
assert.equal(threshold.api.state().sections,0,'Water at exactly half a foot must be excluded');
threshold.depths.fill(.5000000000000002);
await threshold.api.refresh();
assert.equal(threshold.api.state().sections,0,'Floating-point subtraction must not include exactly half a foot');
threshold.depths.fill(.5001);
await threshold.api.refresh();
assert.equal(threshold.api.state().sections,2,'Water above half a foot must be included, still split around disconnected land');
assert.match(threshold.elements.get('roadImpactsStatus').textContent,/> 0\.5 ft/);

const physics=fixture(null,{physics:true});
for(let x=0;x<20;x++)physics.physicsValues.set([0,152,1,255],x*4);
await physics.api.setEnabled(true);
assert.equal(physics.api.state().sections,0,'152 mm is below half a foot');
for(let x=0;x<20;x++)physics.physicsValues.set([0,153,1,255],x*4);
await physics.api.refresh();
assert.equal(physics.api.state().sections,2,'153 mm is above half a foot');
for(let x=0;x<20;x++)physics.physicsValues[x*4+2]=0;
await physics.api.refresh();
assert.equal(physics.api.state().sections,0,'A physics query cell must also be wet');
physics.ctx.currentOverlayMode='dynamic';
physics.depths.fill(.5);
await physics.api.refresh();
assert.equal(physics.api.state().sections,0,'Flood Stages must use the routed depth model rather than the physics query');
physics.depths.fill(.5001);
await physics.api.refresh();
assert.equal(physics.api.state().sections,2);

const unavailable=fixture();
unavailable.ctx.getDepthQueryGrid=async()=>null;
await unavailable.api.setEnabled(true);
assert.equal(unavailable.ctx.document.body.dataset.roadImpactsState,'failed','Missing depth data must not fall back to highlighting every wet road');

const missingTerrain=fixture();
const displayDepth=missingTerrain.ctx.getDepthQueryDisplayDepth;
missingTerrain.ctx.getDepthQueryDisplayDepth=(sample,...args)=>
  sample?.developedFlag===null?null:displayDepth(sample,...args);
missingTerrain.ctx.sampleDepthModel=async()=>({depthFt:.75,developedFlag:null});
await missingTerrain.api.setEnabled(true);
assert.equal(missingTerrain.ctx.document.body.dataset.roadImpactsState,'failed',
  'An unavailable terrain companion is a failure, not a valid empty road result');
assert.equal(missingTerrain.api.state().sections,0);
assert.match(missingTerrain.elements.get('roadImpactsStatus').textContent,/Toggle off\/on to retry/);
await missingTerrain.api.setEnabled(false);
missingTerrain.ctx.sampleDepthModel=async()=>({depthFt:.75,developedFlag:false});
await missingTerrain.api.setEnabled(true);
assert.equal(missingTerrain.ctx.document.body.dataset.roadImpactsState,'ready');
assert.equal(missingTerrain.api.state().sections,2);

let release;
const pending=fixture(()=>new Promise(resolve=>{release=resolve;}));
const enable=pending.api.setEnabled(true);
pending.api.setEnabled(false);
release({ok:true,json:async()=>roads});
await enable;
assert.equal(pending.api.state().sections,0,'Finishing a road download must not re-enable a disabled layer');

const retry=fixture(count=>count===1?{ok:false}:{ok:true,json:async()=>roads});
await retry.api.setEnabled(true);
assert.equal(retry.ctx.document.body.dataset.roadImpactsState,'failed');
await retry.api.setEnabled(true);
assert.equal(retry.fetchCount(),2);
assert.equal(retry.api.state().sections,2);
for(const failure of ['headers','body']){
  const afterAbort=signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const stalled=fixture((count,{signal})=>{
    if(count>1)return {ok:true,json:async()=>roads};
    return failure==='headers'?afterAbort(signal):{ok:true,json:()=>afterAbort(signal)};
  },{shortDeadline:true});
  await stalled.api.setEnabled(true);
  assert.equal(stalled.ctx.document.body.dataset.roadImpactsState,'failed',`A stalled ${failure} must time out`);
  await stalled.api.setEnabled(false);
  await stalled.api.setEnabled(true);
  assert.equal(stalled.fetchCount(),2,`Retry must start a new request after stalled ${failure}`);
  assert.equal(stalled.api.state().sections,2);
}
console.log('Road Impacts default-off startup/restoration, strict half-foot cutoff, physics/routed depths, lazy loading, flood mask, Leaflet/3D visibility, keyboard, frame replacement, cancellation, and retry checks passed');
