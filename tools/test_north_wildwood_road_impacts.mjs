import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../assets/road-impacts.js',import.meta.url),'utf8');
const roads={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Test Road'},geometry:{type:'LineString',coordinates:[[0,.5],[.001,.5]]}}]};
function fixture(fetchResponse){
  const values=new Uint8ClampedArray(20*4);
  for(let x=5;x<16;x++)values.set([27,183,245,255],x*4);
  values.set([99,212,113,255],10*4); // Disconnected/uncertain land is not flooding.
  const layers=new Set(),panes=new Map(),elements=new Map();
  const classSet=new Set();
  const element=()=>({classList:{toggle:()=>{}},setAttribute(){},addEventListener(name,handler){this[name]=handler;},hidden:true});
  for(const id of ['roadImpactsToggle','roadImpactsStatus','roadImpactsKey'])elements.set(id,element());
  let observer;
  const map={hasLayer:layer=>layers.has(layer),removeLayer:layer=>layers.delete(layer),getPane:name=>panes.get(name),createPane:name=>panes.set(name,{style:{}})};
  const bounds={getWest:()=>0,getEast:()=>.001,getSouth:()=>0,getNorth:()=>1};
  const image={complete:true,naturalWidth:20,naturalHeight:1};
  const frame={getElement:()=>image,getBounds:()=>bounds};
  let leaf;
  const glSources=new Map(),glLayers=new Map();
  const gl={getSource:id=>glSources.get(id),getLayer:id=>glLayers.get(id),addSource(id,options){glSources.set(id,{data:options.data,setData(data){this.data=data;}});},addLayer(layer){glLayers.set(layer.id,layer);},setLayoutProperty(id,key,value){glLayers.get(id).layout[key]=value;}};
  let fetchCount=0;
  const ctx={URL,console,Uint8ClampedArray,APP_BASE:new URL('https://example.test/north-wildwood/'),map,
    currentFloodLayer:frame,floodFrameState:'ready',lastRenderToken:1,floodLatLngBounds:bounds,
    document:{body:{dataset:{},classList:{contains:name=>classSet.has(name)}},getElementById:id=>elements.get(id),createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){},getImageData:()=>({data:values})})})},
    fetch:async()=>{fetchCount++;return fetchResponse?fetchResponse(fetchCount):{ok:true,json:async()=>roads};},
    requestAnimationFrame:callback=>setTimeout(callback,0),
    MutationObserver:class{constructor(callback){observer=callback;}observe(){}},
    L:{canvas:()=>({}),geoJSON(data){leaf={data,clearLayers(){this.data={type:'FeatureCollection',features:[]};},addData(data){this.data=data;},addTo(){layers.add(this);return this;}};return leaf;}},
    window:{NORTH_WILDWOOD_3D:{getMap:()=>gl}},
    isWetRasterPixel:(v,o)=>v[o+3]>0&&!(v[o]===99&&v[o+1]===212&&v[o+2]===113),
    clearFloodLayer(){ctx.currentFloodLayer=null;ctx.floodFrameState='unavailable';},
    async renderHour(){ctx.lastRenderToken++;ctx.clearFloodLayer();values.fill(0);ctx.currentFloodLayer=frame;ctx.floodFrameState='ready';}
  };
  vm.createContext(ctx);vm.runInContext(source,ctx);
  return {ctx,api:ctx.window.NORTH_WILDWOOD_ROAD_IMPACTS,fetchCount:()=>fetchCount,leaf:()=>leaf,elements,
    activateGl(){classSet.add('map-3d-ready');observer();},glSources,glLayers};
}

const test=fixture();
assert.equal(test.fetchCount(),0,'Disabled Road Impacts must not fetch road data at startup');
await test.api.setEnabled(true);
assert.equal(test.fetchCount(),1);
assert.equal(test.api.state().sections,2,'Wet runs should split around disconnected land');
assert.equal(test.leaf().data.features.length,2,'The first Leaflet update must contain the newly calculated data');
test.activateGl();
assert.equal(test.glLayers.get('nw-road-impacts').layout.visibility,'visible');
assert.equal(test.glSources.get('nw-road-impacts-source').data.features.length,2);
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
console.log('Road Impacts lazy loading, flood mask, Leaflet/3D visibility, keyboard, frame replacement, cancellation, and retry checks passed');
