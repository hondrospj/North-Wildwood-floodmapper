import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = readAppSource(new URL('../index.html', import.meta.url));
const extract = name => {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
const ctx = vm.createContext({});
vm.runInContext(`${extract('getExportFooterLayout')}\n${extract('getExportViewportConfigForRatio')}`, ctx);
const outputSizes = [[1920,1080],[1080,1350],[1080,1920],[1200,1200],
  [3840,2160],[2160,2700],[2160,3840],[2160,2160]];
const disjoint = (one,two) => one.x + one.width <= two.x || two.x + two.width <= one.x ||
  one.y + one.height <= two.y || two.y + two.height <= one.y;

// Every fixed format retains its original canvas dimensions; all chrome is
// outside the map and has enough space in landscape, portrait and square.
for (const [width, height] of outputSizes) {
  const layout = ctx.getExportFooterLayout(width, height);
  assert.equal(layout.width, width);
  assert.equal(layout.height, height);
  assert.equal(layout.map.height + layout.footerHeight, height);
  for (const key of ['timestamp','legend','branding']) {
    const box = layout[key];
    assert.ok(box.y >= layout.map.height, `${key} covers map at ${width} × ${height}`);
    assert.ok(box.x >= 0 && box.x + box.width <= width, `${key} extends beyond output width`);
    assert.ok(box.y + box.height <= height, `${key} extends beyond output height`);
  }
  for (const [one,two] of [['timestamp','legend'],['branding','timestamp'],['branding','legend']]) {
    assert.ok(disjoint(layout[one],layout[two]), `${one} overlaps ${two} at ${width} × ${height}`);
  }
  if (layout.stacked) {
    assert.equal(layout.legend.x,layout.timestamp.x,'Stacked key starts at the footer content edge');
    assert.equal(layout.legend.width,width - layout.legend.x * 2,'Stacked key uses the full footer content width');
  }
  assert.ok(layout.attribution.y >= layout.map.height);
}
// Map View preserves selected geographic ratio after reserving footer space,
// rather than silently cropping off part of the selected view.
for (const longEdge of [1440,2160]) for (const ratio of [0.3,0.5,0.8,1,4/3,16/9,3.6]) {
  const config = ctx.getExportViewportConfigForRatio(ratio, longEdge);
  const layout = ctx.getExportFooterLayout(config.width, config.height);
  assert.ok(Math.max(config.width, config.height) <= longEdge);
  assert.ok(Math.abs(layout.map.width / layout.map.height - ratio) < 0.004, `Map ratio changed at ${ratio}`);
}

// Full PNG/preview and fast GIF obtain identical text, typography and bounds.
const nodes = {};
const label = { replaceChildren(...rows) { this.rows = rows; } };
nodes.exportTimestampLabel = label;
Object.assign(ctx, {
  document: { getElementById: id => nodes[id], createElement: () => ({style:{}}) },
  getExportAspectConfig: () => ({width:1080,height:1920}),
  getExportFrameTimestampText: () => 'North Wildwood\nOctober 23, 2026 · 1:00 PM\n5.75 ft MLLW',
  getExportCaptureScale: () => 1,
});
vm.runInContext(`${extract('getExportTimestampRows')}\n${extract('updateExportTimestampLabel')}\n${extract('drawExportTimestampOnCanvas')}`, ctx);
ctx.updateExportTimestampLabel({});
const drawn = [];
const drawing = {
  save(){}, restore(){}, fillText(text,x,y,width){drawn.push({text,x,y,width,font:this.font,color:this.fillStyle});}
};
ctx.drawExportTimestampOnCanvas(drawing, {width:1080,height:1920}, {});
const layout = ctx.getExportFooterLayout(1080,1920);
assert.equal(label.rows.length,3);
label.rows.forEach((row,index) => {
  const draw = drawn[index];
  assert.equal(row.textContent, draw.text);
  assert.equal(parseFloat(row.style.width), draw.width);
  assert.equal(parseFloat(row.style.top) + layout.timestamp.y + parseFloat(row.style.height)/2, draw.y);
  assert.ok(draw.font.startsWith(`${row.style.fontWeight} ${parseFloat(row.style.fontSize)}px`));
  assert.equal(row.style.color, draw.color);
});

// Larger title/date/level rows must fit their reserved area at every real
// GIF and PNG size; checking only the timestamp container can hide clipped text.
for (const [width,height] of outputSizes) {
  const layout = ctx.getExportFooterLayout(width,height);
  const rows = ctx.getExportTimestampRows({},layout);
  assert.equal(rows.length,3);
  rows.forEach((row,index) => {
    assert.ok(row.y >= layout.timestamp.y,`Text row ${index} starts above its box at ${width} × ${height}`);
    assert.ok(row.y + row.height <= layout.timestamp.y + layout.timestamp.height,
      `Text row ${index} is clipped below its box at ${width} × ${height}`);
    assert.ok(row.y >= layout.map.height && row.y + row.height <= height,
      `Text row ${index} crosses the map/footer boundary at ${width} × ${height}`);
    if (index) assert.ok(rows[index - 1].y + rows[index - 1].height <= row.y,
      `Text rows overlap at ${width} × ${height}`);
  });
}

// Compact dates remain precise. Daily-crest-only observations and design
// storms must never acquire a fabricated clock time while copy is shortened.
const dates = vm.createContext({
  MONTH_NAMES:['January','February','March','April','May','June','July','August','September','October','November','December'],
  formatHourEntryTime:entry=>entry.fallback || '--',
});
vm.runInContext(`const NY_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true
});\n${['getNyParts','getEntryESTDate','getReturnIntervalStormLabel','formatSelectedObservedDate',
  'stripExportTimeZoneLabel','getExportFrameDateTimeText'].map(extract).join('\n')}`,dates);
assert.equal(dates.getExportFrameDateTimeText({timeUtc:'2026-10-23T17:00:00Z'}),'Oct 23, 2026 · 1 PM');
assert.equal(dates.getExportFrameDateTimeText({timeUtc:'2026-10-23T17:15:00Z'}),'Oct 23, 2026 · 1:15 PM');
assert.equal(dates.getExportFrameDateTimeText({timeUtc:'2026-12-05T03:05:00Z'}),'Dec 4, 2026 · 10:05 PM');
assert.equal(dates.getExportFrameDateTimeText({timeUtc:'1962-03-07T15:45:00Z'}),'Mar 7, 1962 · 10:45 AM');
const dailyPeak = dates.getExportFrameDateTimeText({isDailyPeakOnly:true,observedDate:'1962-03-07'});
assert.match(dailyPeak,/Mar(?:ch)? 7, 1962/);
assert.match(dailyPeak,/Peak time unknown/);
assert.doesNotMatch(dailyPeak,/\b(?:AM|PM)\b/,'A date-only crest cannot assert a clock time');
assert.equal(dates.getExportFrameDateTimeText({returnIntervalYears:100}),'100-Year Storm');
assert.equal(dates.getExportFrameDateTimeText({fallback:'October 23, 2026 · 1:15 PM EDT'}),
  'October 23, 2026 · 1:15 PM');

// Large flood rasters extend beyond their visible bounds. Compositing clips
// before drawing so neither water nor alpha can contaminate the footer.
const ops = [];
Object.assign(ctx, {overlayOpacity:0.75});
vm.runInContext(extract('drawExportFloodOnCanvas'), ctx);
const rasterContext = {
  canvas:{width:1920,height:1080},
  save(){ops.push(['save']);}, beginPath(){ops.push(['begin']);},
  rect(...r){ops.push(['rect',...r]);}, clip(){ops.push(['clip']);},
  drawImage(...args){ops.push(['image',...args]);}, restore(){ops.push(['restore']);},
};
ctx.drawExportFloodOnCanvas(rasterContext,'raster',{x:-40,y:-30,width:2200,height:1300});
assert.deepEqual(ops.map(op=>op[0]),['save','begin','rect','clip','image','restore']);
assert.equal(ops[2][4], ctx.getExportFooterLayout(1920,1080).map.height);
assert.equal(rasterContext.globalAlpha,0.75);
assert.match(extract('addFastCompositeGifFrames'), /drawExportFloodOnCanvas\(ctx, overlayImg, overlayRect\)/);
assert.match(extract('captureExportMapForegroundCanvas'), /hideFooter: true/);
assert.match(extract('captureExportRoadLabelsCanvas'), /hideFooter: true/);
assert.match(extract('captureExportLayerCanvas'), /footer\.style\.visibility = previousFooterVisibility/);
assert.match(source, /id="exportFooter"/);
assert.match(source, /#f4a742 33\.333333%.*#e74c3c 33\.333333%.*#7d3c98 66\.666667%/);
console.log('PASS export footer: GIF/PNG text bounds, non-overlapping branding, full-width stacked keys, precise compact dates, matching typography, clipped flood rasters and hard stage bands.');

// Preview and download share the in-flight authoritative boundary request.
// No first frame can capture the gray world mask before its town hole exists.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
const authoritativeRings = [[[38.9,-74.9],[39.1,-74.9],[39.1,-74.7],[38.9,-74.9]]];
const authoritativeFeature = {type:'Feature',geometry:{type:'Polygon'}};
function boundaryHarness() {
  const request = deferred();
  const counts = {fetch:0,map:0,mask:0,outline:0,draw:0};
  const layers = new Set();
  const map = {invalidateSize(){},hasLayer:layer=>layers.has(layer),removeLayer:layer=>layers.delete(layer)};
  const layer = kind => ({kind, addTo(){layers.add(this);return this;}});
  const state = vm.createContext({
    console:{warn(){}},municipalBoundaryLoadPromise:null,municipalBoundaryRings:[[]],municipalBoundaryFeature:null,
    FALLBACK_TOWN_MASK_RING:[], exportMap:null, exportBoundaryMask:null,exportBoundaryOutline:null,
    exportBoundaryGeometryRings:null,exportBoundaryGeometryFeature:null,
    fetchMunicipalBoundaryFeature:()=>{counts.fetch++;return request.promise;},
    updateMunicipalBoundaryLayer(){},syncLeftPanelLayout(){},throwIfExportCancelled(){},isTownBoundaryEnabled:()=>true,
    document:{documentElement:{}},getComputedStyle:()=>({getPropertyValue:()=>''}),
    makeExportBoundaryMask:()=>{counts.mask++;return layer('mask');},
    makeExportBoundaryVector:()=>{counts.outline++;return layer('outline');},
    applyExportStageAspect(){},getDownloadAspectValue:()=> '1:1',
    updateExportLegend(){},updateExportParcelsLayer(){},fitExportMapToSelectedExtent(){},
    updateExportTimestampLabel(){},updateExportRoadLayerAppearance(){},
    getStageValue:()=>5,getOverlayStage:x=>x,getHydraulicPhaseForEntry:()=> 'filling',
    currentOverlayMode:'depth',currentSeriesHours:[],currentRawSeriesHours:[],exportFrameViewPrimed:false,
    setExportFloodLayer:async()=>{counts.draw++;},waitForExportMapReady(){},waitForStableRender(){},
  });
  vm.runInContext(['loadMunicipalBoundary','hasValidExportBoundaryGeometry','ensureExportMunicipalBoundary',
    'updateExportBoundaryVisibility','prepareExportFrame'].map(extract).join('\n'),state);
  state.ensureExportMap=()=>{
    counts.map++;
    assert.equal(state.hasValidExportBoundaryGeometry(),true,'Do not create an export map with an all-world mask');
    state.exportMap=map;
    state.updateExportBoundaryVisibility();
    return map;
  };
  return {state,request,counts,map,layers,layer};
}
{
  const h=boundaryHarness();
  const one=h.state.prepareExportFrame({entry:{}},{isFirstFrame:true});
  const two=h.state.ensureExportMunicipalBoundary();
  assert.equal(h.counts.fetch,1,'Reuse the pending live-map boundary load');
  assert.equal(h.counts.map,0);
  h.request.resolve({feature:authoritativeFeature,rings:authoritativeRings});
  await Promise.all([one,two]);
  assert.equal(h.counts.draw,1);
  assert.equal(h.counts.mask,1);
  assert.equal(h.counts.outline,1);
  h.state.updateExportBoundaryVisibility();
  assert.equal(h.counts.mask,1,'Stable geometry does not rebuild Canvas layers on every frame');
}
{
  const h=boundaryHarness();
  const pending=h.state.prepareExportFrame({entry:{}},{isFirstFrame:true});
  h.request.reject(Error('boundary offline'));
  await assert.rejects(pending,/town boundary could not load/);
  assert.equal(h.counts.map,0,'A failed boundary is never presented as a valid export');
  assert.equal(h.counts.draw,0);
  assert.equal(h.state.municipalBoundaryLoadPromise,null,'A failed request remains retryable');
  h.state.fetchMunicipalBoundaryFeature=async()=>({feature:authoritativeFeature,rings:authoritativeRings});
  await h.state.prepareExportFrame({entry:{}},{isFirstFrame:true});
  assert.equal(h.counts.draw,1);
}
{
  const h=boundaryHarness();
  const oldMask=h.layer('old-world-mask'), oldOutline=h.layer('empty-outline');
  h.layers.add(oldMask);h.layers.add(oldOutline);
  h.state.exportMap=h.map;h.state.exportBoundaryMask=oldMask;h.state.exportBoundaryOutline=oldOutline;
  const pending=h.state.loadMunicipalBoundary();
  h.request.resolve({feature:authoritativeFeature,rings:authoritativeRings});
  await pending;
  assert.equal(h.layers.has(oldMask),false,'Replace an export mask cached before geometry arrived');
  assert.equal(h.layers.has(oldOutline),false);
  assert.equal(h.layers.has(h.state.exportBoundaryMask),true);
  assert.equal(h.layers.has(h.state.exportBoundaryOutline),true);
  h.state.municipalBoundaryRings=authoritativeRings.map(ring=>ring.slice());
  h.state.updateExportBoundaryVisibility();
  assert.equal(h.counts.mask,2,'A later authoritative geometry identity refreshes the cached export');
}
{
  let geometry,options;
  const masks=vm.createContext({
    municipalBoundaryRings:authoritativeRings,FALLBACK_TOWN_MASK_RING:[],
    L:{polygon:(rings,opts)=>{geometry=rings;options=opts;return{};}},
  });
  vm.runInContext(`${extract('createBoundaryMaskGeometry')}\n${extract('makeExportBoundaryMask')}`,masks);
  masks.makeExportBoundaryMask();
  assert.equal(geometry.length,2,'The mask must include a town-shaped hole after the outer world ring');
  assert.equal(geometry[1],authoritativeRings[0]);
  assert.equal(options.fillOpacity,0.62);
  assert.equal(options.stroke,false);
}
assert.match(extract('captureFastGifBaseCanvas'),/await ensureExportMunicipalBoundary\(\);\s*const mapInstance = ensureExportMap/);
console.log('PASS export boundary readiness: one shared request, no early/all-gray capture, failed-load retry, stale map repair and authoritative geometry updates.');
