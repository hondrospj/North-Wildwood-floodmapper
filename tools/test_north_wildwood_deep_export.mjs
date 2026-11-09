// Authoring-source regressions for actual export timestamps and pitched-roof identity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const repo = process.env.NWW_DEEP_SOURCE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const encoding = fs.readFileSync(path.join(repo, 'tools/app/runtime/17-export-encoding.js'), 'utf8');
const mapSource = fs.readFileSync(path.join(repo, 'tools/app/runtime/16-export-map.js'), 'utf8');
const rangeSource = fs.readFileSync(path.join(repo, 'tools/app/runtime/13-export-range.js'), 'utf8');
const three = fs.readFileSync(path.join(repo, 'assets/3d/north-wildwood-3d.js'), 'utf8');
function extract(source, name) {
  const start = source.search(new RegExp(`^ *(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing ${name}`);
  const indent = source.slice(start).match(/^ */)[0] || '    ';
  const ending = new RegExp(`^${indent}\\}`, 'm').exec(source.slice(start));
  assert.ok(ending, `Missing end for ${name}`);
  return source.slice(start, start + ending.index + ending[0].length);
}

let checks = 0;
if (process.env.NWW_DEEP_CASE !== 'building') {
  const ctx = vm.createContext({Map, Set, Math, Number, currentSeriesHours: [], entryTimeMs: e => Date.parse(e.timeUtc),
    findClosestEntryIndex: () => 0, getDownloadFrameItemFromEntry: entry => ({entry}),
    getDownloadIntervalConfig: () => ({value:'hourly',minutes:60})});
  for (const [source,name] of [[mapSource,'findClosestExportEntryForSlot'],[encoding,'buildHourlyRangeFrameItems'],[rangeSource,'getDownloadRangeSummaryFrameCount']]) vm.runInContext(extract(source,name),ctx);
  const entry = (time, extra = {}) => ({timeUtc:`2026-11-03T${time}:00Z`, navd88StageFt:1, observationQuality:'measured',hydraulicPhase:'draining', ...extra});
  const hours = ['21:00','22:00','23:00','23:59'].map(t=>entry(t));
  const check = (start,end,expected,source=hours) => {
    const range = {startMs:Date.parse(start),endMs:Date.parse(end)};
    const items = ctx.buildHourlyRangeFrameItems(source, range);
    assert.deepEqual(Array.from(items, x=>x.entry.timeUtc), expected, `${start} through ${end}`);
    assert.equal(new Set(items.map(x=>x.entry.timeUtc)).size,items.length,'Never reuse a reading');
    for(const item of items) {
      const instant=Date.parse(item.entry.timeUtc);
      assert.ok(instant>=range.startMs&&instant<=range.endMs,'Every actual frame instant is within the exact selected bounds');
      const original=source.find(e=>e.timeUtc===item.entry.timeUtc);
      assert.equal(item.entry.navd88StageFt,original.navd88StageFt);
      assert.equal(item.entry.observationQuality,original.observationQuality);
      assert.equal(item.entry.hydraulicPhase,original.hydraulicPhase);
    }
    checks++;
  };
  const z = value=>`2026-11-03T${value}Z`;
  for(const start of ['22:01:00','22:15:00','22:45:00','22:59:59.999']) check(z(start),z('23:00:00'),[z('23:00:00')]);
  check(z('22:15:00'),z('23:15:00'),[z('23:00:00')]);
  check(z('22:45:00'),z('23:15:00'),[z('23:00:00')]);
  check(z('22:15:00'),z('22:45:00'),[]);
  check(z('22:00:00.001'),z('22:59:59.999'),[]);
  check(z('22:00:00'),z('22:00:00'),[z('22:00:00')]);
  check(z('22:00:00'),z('22:59:59.999'),[z('22:00:00')]);
  const irregular=[entry('22:59',{navd88StageFt:7}),entry('23:01',{navd88StageFt:9}),entry('23:30')];
  check(z('22:30:00'),z('23:10:00'),[z('22:59:00')],irregular);
  check(z('23:00:00'),z('23:10:00'),[z('23:01:00')],irregular);
  check(z('22:15:00'),z('22:45:00'),[],[entry('22:30')]);
  const fall=['2025-11-02T04:00:00Z','2025-11-02T05:00:00Z','2025-11-02T06:00:00Z','2025-11-02T07:00:00Z'].map(timeUtc=>({timeUtc,navd88StageFt:1}));
  check('2025-11-02T04:15:00Z','2025-11-02T07:00:00Z',fall.slice(1).map(e=>e.timeUtc),fall);
  const spring=['2026-03-08T06:00:00Z','2026-03-08T07:00:00Z','2026-03-08T08:00:00Z'].map(timeUtc=>({timeUtc,navd88StageFt:1}));
  check('2026-03-08T06:15:00Z','2026-03-08T08:00:00Z',spring.slice(1).map(e=>e.timeUtc),spring);
  assert.equal(ctx.getDownloadRangeSummaryFrameCount({startMs:Date.parse(z('22:15:00')),endMs:Date.parse(z('22:45:00'))}),0);
  assert.equal(ctx.getDownloadRangeSummaryFrameCount({startMs:Date.parse(z('22:15:00')),endMs:Date.parse(z('23:00:00'))}),1);
  assert.deepEqual(Array.from(ctx.buildHourlyRangeFrameItems(hours,{startMs:Infinity,endMs:Infinity})),[]);
  assert.deepEqual(Array.from(ctx.buildHourlyRangeFrameItems(hours,{startMs:2,endMs:1})),[]);
}
if (process.env.NWW_DEEP_CASE !== 'hourly') {
  const ctx = vm.createContext({buildingData:null,parcelFeatures:[],ensureParcelAssets:async()=>{}});
  const helpers=['pointInsideRing','pointInsideMunicipalGeometry','buildingGeometryPolygons3d','buildingGeometrySegments3d','buildingPointOnSegment3d','buildingGeometryContainsPoint3d','buildingInteriorPoint3d','buildingSegmentParts3d','buildingFootprintFitsParcel3d','resolveClickedBuildingParcel3d'];
  for(const name of helpers) {
    if (new RegExp(`function ${name}\\(`).test(three)) vm.runInContext(extract(three,name),ctx);
  }
  // Exercise the real click handler first, so baseline failure demonstrates
  // the neighboring property rather than merely the absence of new helpers.
  const rawBuildings=JSON.parse(fs.readFileSync(path.join(repo,'assets/3d/NorthWildwoodBuildings3D.geojson'),'utf8')).features;
  const rawParcels=JSON.parse(fs.readFileSync(path.join(repo,'assets/parcel-history-v2/NorthWildwoodParcels.geojson'),'utf8')).features;
  let clicked=rawBuildings.find(feature=>feature.properties.footprintId==='34009_118023');
  let clickHandler,opened;
  Object.assign(ctx,{buildingData:{features:rawBuildings},parcelFeatures:rawParcels,
    glMap:{on(name,...args){if(name==='click')clickHandler=args.at(-1);},getPitch:()=>60,getLayer:()=>true,queryRenderedFeatures:()=>[clicked]},
    map:{on(){}},window:{addEventListener(){}},L:{latLng:(lat,lng)=>({lat,lng})},
    layerVisible:()=>true,mapClickMode:'building',mapQueryGeneration:0,lastRenderToken:1,
    beginMapQuery:()=>++ctx.mapQueryGeneration,
    sync3dViewToLeaflet(){},syncLeafletViewTo3d(){},handleDepthQueryClick(){throw Error('Expected building selection');},
    findParcelFeatureForLocation:async(lat,lng)=>rawParcels.find(feature=>ctx.pointInsideMunicipalGeometry([lng,lat],feature.geometry)),
    openParcelFloodPrompt:parcel=>{opened=parcel.properties.parcelId;},openFallbackBuildingPopup:(_point, properties)=>{opened=properties;}});
  for (const name of ['resize3dView', 'wire3dInteractions']) vm.runInContext(extract(three,name),ctx);
  ctx.wire3dInteractions();
  await clickHandler({point:{x:985,y:150},lngLat:{lng:-74.79706764221191,lat:39.011497839736876}});
  assert.equal(opened,'0507_128_23','A clicked 327 W Chestnut roof must not open neighboring 329 W Chestnut');checks++;
  clicked=rawBuildings.find(feature=>feature.properties.footprintId==='34009_26741');
  const shared=await ctx.resolveClickedBuildingParcel3d(clicked);
  assert.equal(shared.parcel.properties.nsi2026FootprintId,'34009_26731','The clicked roof shares a parcel with the associated NSI structure');
  await clickHandler({point:{x:720,y:465},lngLat:{lng:shared.point[0],lat:shared.point[1]}});
  assert.equal(opened,clicked.properties,'A shared parcel cannot supply another roof’s flood facts or projections');checks++;

  const ring=(x1,y1,x2,y2)=>[[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]];
  const polygon=(...rings)=>({type:'Polygon',coordinates:rings});
  const feature=(geometry,id,extra={})=>({type:'Feature',geometry,properties:{footprintId:id,...extra}});
  const select=async(building,parcels,rendered=building)=>{
    ctx.buildingData={features:[building]};ctx.parcelFeatures=parcels;
    return ctx.resolveClickedBuildingParcel3d(rendered);
  };
  const b=feature(polygon(ring(1,1,3,3)),'B');
  const own=feature(polygon(ring(0,0,4,4)),null,{parcelId:'own',nsi2026FootprintId:'B'});
  const neighbor=feature(polygon(ring(4,0,8,4)),null,{parcelId:'neighbor'});
  let resolved=await select(b,[neighbor,own],feature(polygon(ring(4.5,1,5,2)),'B'));
  assert.equal(resolved.parcel.properties.parcelId,'own','Resolve the full source footprint, never clipped tile geometry or ground behind the roof');checks++;
  const concave=feature(polygon([[0,0],[4,0],[4,1],[1,1],[1,4],[0,4],[0,0]]),'C');
  const courtyard=feature(polygon(ring(0,0,6,6),ring(2,2,4,4)),'H');
  for(const building of [concave,courtyard]){
    const point=ctx.buildingInteriorPoint3d(building.geometry);
    assert.ok(ctx.buildingGeometryContainsPoint3d(building.geometry,point,false),'Representative point is inside actual body, outside courtyard');checks++;
  }
  const parcelWithHole=feature(polygon(ring(0,0,4,4),ring(1.5,1.5,2.5,2.5)),null,{parcelId:'hole'});
  assert.equal((await select(b,[parcelWithHole])).parcel,null,'A parcel courtyard cannot contain solid building area');checks++;
  const matchingHole=feature(polygon(ring(0,0,6,6),ring(2,2,4,4)),null,{parcelId:'courtyard'});
  assert.equal((await select(courtyard,[matchingHole])).parcel.properties.parcelId,'courtyard');checks++;
  const edge=feature(polygon(ring(0,0,4,4)),'E');
  assert.equal((await select(edge,[own])).parcel.properties.parcelId,'own','Shared polygon boundaries are included');checks++;
  const multi=feature({type:'MultiPolygon',coordinates:[[ring(0,0,1,1)],[ring(3,0,4,1)]]},'M');
  const multiParcel=feature({type:'MultiPolygon',coordinates:[[ring(-1,-1,2,2)],[ring(2.5,-1,5,2)]]},null,{parcelId:'multi'});
  assert.equal((await select(multi,[multiParcel])).parcel.properties.parcelId,'multi');checks++;
  const acrossGap=feature(polygon(ring(0,0,4,1)),'gap');
  assert.equal((await select(acrossGap,[multiParcel])).parcel,null,'Do not bridge space between parcel components');checks++;
  const duplicate=feature(own.geometry,null,{parcelId:'duplicate'});
  assert.equal((await select(b,[own,duplicate])).parcel.properties.parcelId,'own','Stable footprint mapping disambiguates overlapping parcel records');checks++;
  const noIdentity={...own,properties:{parcelId:'shared'}};
  assert.equal((await select(b,[noIdentity])).parcel.properties.parcelId,'shared','A shared parcel may contain multiple buildings');checks++;
  assert.equal((await select(b,[noIdentity,duplicate])).parcel,null,'Ambiguous parcels use clicked-building fallback');checks++;
  ctx.buildingData={features:[]};ctx.parcelFeatures=[own];
  assert.equal((await ctx.resolveClickedBuildingParcel3d(b)).parcel,null,'Missing full footprint never substitutes clipped geometry');checks++;
  ctx.buildingData={features:rawBuildings};ctx.parcelFeatures=rawParcels;
  for(const [id,address,parcelId] of [['34009_118023','327 W CHESTNUT AVE','0507_128_23'],['34009_118009','325 W CHESTNUT AVE','0507_128_22']]){
    const result=await ctx.resolveClickedBuildingParcel3d({properties:{footprintId:id}});
    assert.equal(result.parcel?.properties.parcelId,parcelId,address);
    assert.equal(result.feature.properties.address,address);checks++;
  }
}
{
  const updates=[],layer={updateImage:options=>updates.push(options)};
  const ctx=vm.createContext({glStyleReady:true,imageLayerVersions:new WeakMap(),visibility:value=>value?'visible':'none',
    glMap:{getSource:()=>layer,getLayer:()=>true,setPaintProperty(){},setLayoutProperty(){}}});
  vm.runInContext(extract(three,'updateImageLayer'),ctx);
  const options={sourceId:'parcels',layerId:'parcel-overlay',url:'parcels.png',coordinates:[[0,1],[1,1],[1,0],[0,0]],visible:true};
  ctx.updateImageLayer(options);ctx.updateImageLayer(options);
  assert.equal(updates.length,1,'Normal image synchronization reuses one source');
  ctx.updateImageLayer({...options,reload:true});
  assert.equal(updates.length,2,'A successful Parcels enable retries an unchanged failed native image source');checks++;
}

console.log(`PASS deep export/3D: ${checks} timestamp, provenance, footprint and parcel cases`);
