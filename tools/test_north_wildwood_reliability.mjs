import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import "../assets/municipal-time.js";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
function extract(name) {
  const start = html.search(new RegExp("^    (?:async )?function " + name + "\\(", "m"));
  assert(start >= 0, name);
  return html.slice(start, html.indexOf("\n    }", start) + 6);
}
function context(names, stubs = {}) {
  const ctx = vm.createContext({console, Math, Number, Boolean, Map, Set, Promise, AbortSignal,
    Uint8Array, Uint8ClampedArray, MIN_STAGE:-4, MIN_DEPTH_STAGE:0, MAX_STAGE:20, STAGE_STEP:0.1,
    MINOR_FLOOD_FT:3.25, MODERATE_FLOOD_FT:4.25, MAJOR_FLOOD_FT:5.25,
    MINOR_VERTICAL_PENALTY_FT:0.75, MODERATE_VERTICAL_PENALTY_FT:0.25, MAJOR_VERTICAL_PENALTY_FT:0,
    ...stubs});
  for (const name of [...new Set(["normalizeStageValue", ...names])]) vm.runInContext(extract(name), ctx);
  return ctx;
}
const stageFns=["roundToCatalogPrecision","floorToCatalogStep","getOverlayStage"];
const stage=context(stageFns);
for (const missing of [null, undefined, "", "  ", false, true, NaN, Infinity, [], {}]) assert.equal(stage.getOverlayStage(missing),null);
assert.equal(stage.getOverlayStage(0),0); assert.equal(stage.getOverlayStage("3.94"),3.9);
const depth=context([...stageFns,"normalizeHydraulicPhase","getVerticalBathtubPenalty","getPenaltyRemainingFraction",
  "getPenalizedConnectedDepth","isDevelopedRasterPixel","getFillingTransitionPixelDepth","getDepthQueryDisplayDepth"]);
for (const value of [3.35,3.74,4.29,5.31]) {
  const ground=2.6, code=32794, connection=Math.ceil(value*10)/10;
  const pixel=[Math.floor(code/256),code%256,Math.round(connection*10)+50,255];
  const colorDepth=depth.getFillingTransitionPixelDepth(pixel,[0,0,255,255],0,value);
  const queryDepth=depth.getDepthQueryDisplayDepth({elevation:ground,connectionStage:connection,developedFlag:true},value,{flooded:true},"filling");
  assert(Math.abs(colorDepth-queryDepth)<1e-9, `Color and click depth diverged at ${value}`);
}
assert.equal(depth.getDepthQueryDisplayDepth({elevation:2.6,connectionStage:3.4},null,{flooded:true}),null);
assert.equal(depth.getDepthQueryDisplayDepth({elevation:5,connectionStage:3.4},3.3,{flooded:true},"filling"),null);
let attempts=0,available=false;
const cache=context(["getOverlayRecord"],{overlayRecordCache:new Map(), exportCancelRequested:false,
  normalizeHydraulicPhase:x=>x,stageToCode:String,throwIfExportCancelled(){},
  async findWorkingOverlay(){attempts++; return available?{url:"recovered.png"}:null;}});
assert.equal(await cache.getOverlayRecord("depth",4),null);available=true;
assert.equal((await cache.getOverlayRecord("depth",4)).url,"recovered.png");assert.equal(attempts,2);
let releaseOld;const heldCache=new Promise(r=>releaseOld=r);cache.findWorkingOverlay=()=>heldCache;
const old=cache.getOverlayRecord("depth",5);cache.overlayRecordCache=new Map();releaseOld({url:"old.png"});await old;
assert.equal(cache.overlayRecordCache.size,0,"Old requests must not repopulate Reload's new cache");
for (const name of ["testImageUrl","preloadImage","getExportImageElement"]) {
  let available=false, requested=0;
  class FakeImage { set src(value) { requested++; queueMicrotask(()=>available?this.onload?.():this.onerror?.()); } }
  const images=context([name],{Image:FakeImage,window:{setTimeout,clearTimeout,setInterval,clearInterval},
    imageExistsCache:new Map(),preloadPromiseCache:new Map(),exportImageElementCache:new Map(),
    exportCancelRequested:false,exportInProgress:false});
  await images[name]("test.png");available=true;
  const recovered=await images[name]("test.png");assert(recovered);assert.equal(requested,2,`${name} retained a failed image`);
}
for(const failure of ["missing-record","image-error","bounds-error"]){
  const previous={id:"old"};const layers=new Set([previous]);
  const next={handlers:{},once(event,fn){this.handlers[event]=fn;return this},addTo(){layers.add(this);this.handlers.error();return this}};
  const frame=context(["clearFloodLayer","setFloodLayer"],{currentRawSeriesHours:[],lastRenderToken:1,
    document:{body:{dataset:{initialFloodFrame:"ready"}}},toast(){},ensureMap(){},
    async getHydraulicOverlayRecord(){return failure==="missing-record"?null:{url:"broken.png",filename:"broken.png"}},
    async preloadImage(url){return url},async ensureOverlayBounds(){if(failure==="bounds-error")throw Error("bounds");},
    currentFloodLayer:previous,pendingFloodLayer:null,currentDataMode:"observed",renderedFloodPixelCache:{},floodFrameState:"ready",
    createHydraulicImageOverlay(){return next},markInitialFloodFrameFailed(){},
    map:{hasLayer:x=>layers.has(x),removeLayer:x=>layers.delete(x)}});
  assert.notEqual(await frame.setFloodLayer("depth",4,"slack",1),true);
  assert.equal(layers.size,0,`${failure} retained an old map`);assert.equal(frame.currentFloodLayer,null);
}
const banner=[];const requests=[];let networkMode="fail-point";
const alerts=context(["checkNwsAlerts"],{nwsAlertPromise:null,lastSuccessfulNwsAlerts:null,
  document:{body:{dataset:{}},getElementById:()=>({})},TOWN_CONFIG:{alerts:{zoneCodes:["NJZ024"]}},NWS_POINT_URL:"points",
  async fetchJson(url){requests.push(url);if(networkMode==="all-fail"||url==="points")throw Error("offline");
    return {features:networkMode==="active"?[{id:"1",properties:{event:"Coastal Flood Warning"}}]:[]}},
  setBanner(...args){banner.push(args)},formatLocalBannerTime:String});
assert.equal(await alerts.checkNwsAlerts(),"unavailable");
assert(requests.some(x=>x.includes("zone=NJZ024")),"Configured zone must still be attempted");
alerts.NWS_POINT_URL=null;networkMode="active";assert.equal(await alerts.checkNwsAlerts(),"active");
networkMode="all-fail";assert.equal(await alerts.checkNwsAlerts(),"stale");
assert.equal(banner.at(-1)[1],"Coastal Flood Warning","A request failure discarded the last known alert");
networkMode="none";assert.equal(await alerts.checkNwsAlerts(),"none");assert.equal(banner.at(-1)[0],false);
let releaseFirst;const heldDate=new Promise(r=>releaseFirst=r);
const race=context(["loadObservedDay"],{selectionGeneration:0,async ensureObservedArchiveForDate(date){if(date==="2000-01-01")await heldDate;},
  getObservedDayRecord:()=>({peakNAVD88:4,hours:[]}),stopPlayback(){},updateDataModeButtons(){},
  buildTopTideEvents:()=>[],buildObservedCanonicalSeries:()=>[{}],getTimelineIntervalMinutes:()=>15,
  sampleCanonicalHydraulicSeries:x=>x,formatStageForDisplay:String,syncSliderBounds(){},getPeakHourIndex:()=>0,
  document:{getElementById:()=>({})},async renderCalendar(){},async renderHour(){},renderTopTides(){}});
const first=race.loadObservedDay("2000-01-01");await race.loadObservedDay("2026-09-12");releaseFirst();await first;
assert.equal(race.selectedObservedDate,"2026-09-12");
for (const invalid of ["2025-11-02 01:15:00","2025-03-09 02:15:00","2025-02-30 01:00:00"]) {
  assert(Number.isNaN(globalThis.NorthWildwoodTime.municipalEpoch(invalid)),invalid);
}
assert.equal(globalThis.NorthWildwoodTime.municipalEpoch("2025-11-02T01:15:00-04:00"), Date.parse("2025-11-02T05:15:00Z"));
assert.equal(globalThis.NorthWildwoodTime.municipalEpoch("2025-11-02T01:15:00-05:00"), Date.parse("2025-11-02T06:15:00Z"));
console.log("FloodMapper missing-data, depth, frame, retry, alert, selection, and timestamp regressions passed");
