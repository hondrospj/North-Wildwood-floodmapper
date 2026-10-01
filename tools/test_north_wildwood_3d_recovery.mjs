import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const s=fs.readFileSync(new URL('../assets/3d/north-wildwood-3d.js', import.meta.url),'utf8');
function fn(n){const start=s.search(new RegExp('^  (?:async )?function '+n+'\\(','m'));assert(start>=0);const end=s.indexOf('\n  }',start)+4;return s.slice(start,end);}
const classes=new Set();const body={dataset:{},classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)}};
const ctx={glMap:null,glMapPromise:null,glStyleReady:false,document:{body,getElementById:()=>({})},map:null,window:{setTimeout,clearTimeout},console:{warn:()=>{}},MAP_MAX_ZOOM:20,DEFAULT_PITCH:0,DEFAULT_BEARING:0,TERRAIN_EXAGGERATION:4,loadMapLibreRuntime:async()=>{},load3dStyle:async()=>({}),syncBuildings3d:async()=>{throw Error('building request failed')},maplibregl:{Map:class{on(){} once(n,cb){cb()}getPitch(){return 0}remove(){this.removed=true}}}};
for(const n of ['schedulePersistentNavControlSync','syncFloodPresentationMode','syncPersistentNavControl','addCore3dLayers','wire3dInteractions','syncBoundary3d','syncFloodLayer3d','syncSatellite3d','syncRoadLabels3d','syncParcels3d','syncNsi3d','updateDiagnostics','suspendLeafletVisualLayers'])ctx[n]=()=>{};
vm.createContext(ctx);vm.runInContext(fn('ensure3dMap'),ctx);await ctx.ensure3dMap();assert.equal(ctx.glMap,null);assert(!classes.has('map-3d-ready'));
const elements=new Map();let scripts=0;const runtime={window:{setTimeout,clearTimeout},mapLibreRuntimePromise:null,MAPLIBRE_CSS_URL:'style',MAPLIBRE_JS_URL:'script',document:{getElementById:id=>elements.get(id),createElement:tag=>({tag,dataset:{},remove(){elements.delete(this.id)},addEventListener:()=>{}}),head:{appendChild:el=>{elements.set(el.id,el);if(el.tag==='script')scripts++;queueMicrotask(()=>el.tag==='script'?el.onerror():el.onload());}}}};
vm.createContext(runtime);vm.runInContext(fn('loadMapLibreRuntime'),runtime);await runtime.loadMapLibreRuntime().catch(()=>{});
const retry=await Promise.race([runtime.loadMapLibreRuntime().then(()=>'resolved',()=>'rejected'),new Promise(r=>setTimeout(()=>r('still-pending'),30))]);assert.equal(retry,'rejected');assert.equal(scripts,2);
console.log('3D rollback and dependency retry regressions passed');

// The external 3D script is evaluated before the inline town configuration.
// Exercise that ordering and a failed request so neither can cache an empty
// building collection for the rest of the visit.
const requests=[];
let failBuildings=true;
const buildings={
  TOWN_CONFIG:null, APP_BASE:new URL('https://example.test/north-wildwood/'), URL,
  buildingData:null, buildingDataPromise:null, TERRAIN_EXAGGERATION:4,
  document:{body:{dataset:{}}}, console,
  buildingInsideMunicipality:()=>true,
  prepareVisualBuildingGround:features=>({values:features.map(()=>({value:2,source:'test ground'})),measuredCount:features.length,derivedCount:0,medianCount:0}),
  fetch:async url=>{
    requests.push(url);
    if(url.includes('Buildings')){
      if(failBuildings)return {ok:false};
      return {ok:true,json:async()=>({type:'FeatureCollection',metadata:{schema:'north-wildwood-3d-buildings-v2'},features:[{type:'Feature',properties:{stories:2},geometry:{type:'Polygon',coordinates:[]}}]})};
    }
    return {ok:true,json:async()=>({type:'FeatureCollection',features:[]})};
  }
};
vm.createContext(buildings);
// Include any module-level captured URLs, as well as the real loader.
vm.runInContext(s.split('\n').filter(line=>/^  var (?:BUILDINGS_3D_URL|MUNICIPAL_BOUNDARY_3D_URL) =/.test(line)).join('\n')+'\n'+fn('loadBuildingData'),buildings);
buildings.TOWN_CONFIG={structures:{buildings3dPath:'./assets/Buildings.geojson?v=1'},boundary:{boundaryUrl:'./Boundaries/town.geojson'}};
await assert.rejects(buildings.loadBuildingData(),/building asset could not be loaded/);
assert.equal(buildings.buildingData,null);
assert.equal(buildings.buildingDataPromise,null);
failBuildings=false;
const payload=await buildings.loadBuildingData();
assert.equal(payload.features.length,1);
assert.equal(payload.features[0].properties.renderHeightM,7.3);
assert.deepEqual(requests.slice(-2),['https://example.test/north-wildwood/assets/Buildings.geojson?v=1','https://example.test/north-wildwood/Boundaries/town.geojson']);
assert.equal(await buildings.loadBuildingData(),payload);
assert.equal(requests.length,4);

let cameraZoom=13, cameraPitch=60, enabled=true;
const cameraMoves=[];
const camera={
  BUILDING_MAX_CAMERA_ALTITUDE_METERS:1000,BUILDING_ALTITUDE_FALLBACK_MIN_ZOOM:16.25,MAP_MAX_ZOOM:22,
  layerVisible:()=>enabled,
  glMap:{getZoom:()=>cameraZoom,getPitch:()=>cameraPitch,jumpTo:options=>{cameraMoves.push(options);cameraZoom=options.zoom;}},
  cameraAltitudeAboveTerrainMeters:()=>5000/Math.pow(2,cameraZoom-13),
  cameraIsWithinBuildingRange:()=>camera.cameraAltitudeAboveTerrainMeters()<=1000
};
vm.createContext(camera);vm.runInContext(fn('focusEnabledBuildings3d'),camera);
camera.focusEnabledBuildings3d();
assert.ok(camera.cameraAltitudeAboveTerrainMeters()<=850);
assert.equal(cameraZoom,Math.ceil(cameraZoom));
assert.deepEqual(Object.keys(cameraMoves[0]),['zoom']);
camera.focusEnabledBuildings3d();assert.equal(cameraMoves.length,1);
cameraZoom=13;cameraPitch=0;camera.focusEnabledBuildings3d();assert.equal(cameraMoves.length,1);
cameraPitch=60;enabled=false;camera.focusEnabledBuildings3d();assert.equal(cameraMoves.length,1);
console.log('Late building configuration, asset retry, and requested 3D camera regressions passed');
