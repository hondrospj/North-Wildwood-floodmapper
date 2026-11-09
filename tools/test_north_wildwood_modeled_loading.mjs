// Exercise the actual modeled/mode/cadence handlers against delayed real storm data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const runtime = process.env.NWW_MODELED_RUNTIME_ROOT || fileURLToPath(new URL('./app/runtime/', import.meta.url));
const source = ['02-data-and-datums.js', '22-calendar-and-modes.js']
  .map(name => fs.readFileSync(path.join(runtime, name), 'utf8')).join('\n');
const payload = JSON.parse(fs.readFileSync(new URL('../return_intervals.json', import.meta.url), 'utf8'));
function extract(name) {
  const found = source.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(found, name); return found[0];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const nodes = new Map(), requests = [], renders = [], messages = [];
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, { value:'', textContent:'', classList:{toggle(){}}, setAttribute(){} });
    return nodes.get(id);
  };
  const forecast = [{ timeUtc:'2026-11-03T12:00Z', navd88StageFt:0.02, tag:'forecast' }];
  const c = vm.createContext({ Promise, console, Number, Map, Math, Date,
    selectionGeneration:0, lastRenderToken:0,
    getForecastFreshness:() => ({state:null}), getForecastSourceForNotice:() => null, currentDataMode:'forecast', currentViewType:'forecast',
    currentOverlayMode:'depth', currentDatum:'navd88', currentTimelineIntervalMinutes:60,
    currentReturnIntervalYears:10, returnIntervalData:null, overlayPreloadGeneration:0,
    currentHourIndex:0, currentTopTideIndex:null, selectedObservedDate:null,
    getTimelineNavigationIndex:() => c.currentHourIndex,
    currentRawSeriesHours:forecast, currentSeriesHours:forecast, currentFloodLayer:{tag:'old-map'},
    currentSelectedLabel:'Mean', currentSelectedSubLabel:'Mean', currentRangeLabel:'forecast',
    RETURN_INTERVALS_URL:'return_intervals.json', RETURN_INTERVAL_OPTIONS:payload.intervals.map(item => Number(item.years)),
    document:{getElementById:el, querySelector:el, body:{dataset:{}}},
    withFreshJsonUrl:url => url,
    fetchJson() { const hold = deferred(); requests.push(hold); return hold.promise; },
    annotateHydraulicSeries:entries => entries.map(entry => ({...entry})),
    getStageValue:entry => Number(entry?.navd88StageFt),
    getPeakHourIndex:entries => entries.reduce((best, entry, index) => Number(entry.navd88StageFt) > Number(entries[best].navd88StageFt) ? index : best, 0),
    findClosestEntryIndex: (entries, reference) => entries.reduce((best, entry, index) =>
      Math.abs(Date.parse(entry.timeUtc) - Date.parse(reference.timeUtc)) < Math.abs(Date.parse(entries[best].timeUtc) - Date.parse(reference.timeUtc)) ? index : best, 0),
    cancelPendingFloodFrame(invalidate=true) { if (invalidate) c.lastRenderToken++; return c.lastRenderToken; },
    stopPlayback(){}, updateDataModeButtons(){}, updateModeButtons(){}, updateTimelineIntervalUI(){},
    clearExportAvailabilityCache(){}, syncSliderBounds(){}, renderSelectionMeta(){}, renderTimelineMeta(){}, renderTimelineDays(){},
    setFloodFrameStatus:(message, state) => messages.push({message, state}), toast:message => messages.push({message}),
    clearFloodLayer(){ c.currentFloodLayer=null; }, reportFloodFrameFailure(){}, renderTopTides(){},
    getForecastScenarioLabel:() => 'Mean', refreshCurrentDisplayText(){}, loadTopTideEvent(){},
    async loadForecast() {
      c.currentViewType='forecast'; c.currentRawSeriesHours=forecast; c.currentSeriesHours=forecast;
      c.currentSelectedLabel='Mean'; c.currentHourIndex=0;
    },
    async warmBackgroundData(){}, async renderCalendar(){}, getLatestObservedDate:() => '2026-11-03',
    async loadObservedDay() {
      c.selectionGeneration++; c.currentDataMode='observed'; c.currentViewType='observed-day';
      c.currentRawSeriesHours=[{tag:'observed'}]; c.currentSeriesHours=c.currentRawSeriesHours;
      c.currentSelectedLabel='Observed'; c.currentHourIndex=0;
    },
    scheduleHistoricalTopTideWarmup(){},
    async renderHour(index) {
      if (!c.currentSeriesHours.length) return;
      c.lastRenderToken++;
      renders.push({mode:c.currentDataMode, overlay:c.currentOverlayMode, interval:c.getTimelineIntervalMinutes(),
        datum:c.currentDatum, entry:c.currentSeriesHours[index]});
    }
  });
  for (const name of ['getTimelineIntervalMinutes','getReturnIntervalRecord','getReturnIntervalLabel',
    'updateReturnIntervalButtons','buildReturnIntervalDailyMaximumSeries','buildReturnIntervalDisplaySeries',
    'loadReturnInterval','switchReturnInterval','setTimelineIntervalMinutes','switchOverlayMode','switchDataMode']) {
    vm.runInContext(extract(name), c);
  }
  return {c, requests, renders, messages, nodes};
}
function assertModeled(h, years=10, cadence=60) {
  const {c, renders}=h, record=payload.intervals.find(item => Number(item.years)===years);
  assert.equal(c.currentDataMode,'return-interval'); assert.equal(c.currentViewType,'return-interval');
  assert.equal(c.currentTimelineIntervalMinutes,cadence); assert.equal(c.currentReturnIntervalYears,years);
  assert.ok(c.currentSeriesHours.length); assert.ok(c.currentSeriesHours.every(entry => Number.isFinite(entry.offsetHours)));
  assert.equal(c.currentSelectedLabel,`${c.getReturnIntervalLabel(years)} Flood`);
  assert.equal(c.currentSeriesHours[c.currentHourIndex].offsetHours,0,'A new modeled choice must start at its peak.');
  assert.equal(c.currentSeriesHours[c.currentHourIndex].navd88StageFt,record.targetNavd88Ft);
  assert.equal(c.loadReturnInterval.pendingSelection,null); assert.equal(renders.at(-1).mode,'return-interval');
  assert.equal(renders.at(-1).overlay,c.currentOverlayMode); assert.equal(renders.at(-1).datum,c.currentDatum);
  assert.equal(renders.at(-1).interval,cadence);
}
let cases=0;
for (const starter of ['mode','year']) for (const cadence of [60,15,1440]) {
  const h=setup(), {c,requests,messages,nodes}=h;
  const pending=starter==='mode' ? c.switchDataMode('return-interval') : c.switchReturnInterval(50);
  assert.equal(requests.length,1); assert.equal(c.currentSeriesHours.length,0,'Pending Modeled must not expose Forecast data.');
  assert.match(nodes.get('stageSubText').textContent,/Loading modeled/);
  assert.ok(messages.some(item => /Previous flood map shown/.test(item.message)));
  await c.switchOverlayMode('dynamic'); await c.setTimelineIntervalMinutes(cadence);
  await c.switchOverlayMode('depth'); await c.switchOverlayMode('dynamic'); c.currentDatum='mllw';
  assert.equal(requests.length,1,'Pending cadence changes must reuse the owned request.');
  requests[0].resolve(payload); await pending; assertModeled(h,starter==='mode'?10:50,cadence); cases++;
}
for (const duplicate of ['mode','same-year']) {
  const h=setup(), {c,requests}=h;
  const pending=c.switchDataMode('return-interval');
  const repeated=duplicate==='mode' ? c.switchDataMode('return-interval') : c.switchReturnInterval(10);
  assert.equal(requests.length,1,'The same modeled selection must retain the pending data request.');
  requests[0].resolve(payload);
  await Promise.all([pending,repeated]);
  assertModeled(h);
  cases++;
}
for (const later of ['forecast','observed']) for (const result of ['success','failure']) {
  const h=setup(), {c,requests,renders,messages}=h;
  const pending=c.switchDataMode('return-interval'); await c.switchOverlayMode('dynamic');
  await c.switchDataMode(later); const active=c.currentSeriesHours, rendered=renders.length, notified=messages.length;
  if(result==='success') requests[0].resolve(payload); else requests[0].reject(Error('Obsolete modeled request failed'));
  await pending;
  assert.equal(c.currentDataMode,later); assert.equal(c.currentSeriesHours,active); assert.equal(renders.length,rendered);
  assert.equal(messages.length,notified); assert.equal(c.returnIntervalData,null,'An obsolete response must not populate the current cache.');
  assert.equal(c.loadReturnInterval.pendingSelection,null); cases++;
}
for (const retry of ['mode','same-year']) {
  const h=setup(), {c,requests,messages,nodes}=h;
  const pending=c.switchDataMode('return-interval'); await c.switchOverlayMode('dynamic'); await c.setTimelineIntervalMinutes(15);
  requests[0].reject(Error('Active modeled request failed')); await pending;
  assert.equal(c.currentSeriesHours.length,0); assert.equal(c.currentFloodLayer,null);
  assert.equal(nodes.get('stageSubText').textContent,'Modeled flood data could not load');
  assert.ok(messages.some(item => item.state==='error' && /Modeled flood data could not load/.test(item.message)));
  const next=retry==='mode' ? c.switchDataMode('return-interval') : c.switchReturnInterval(10);
  assert.equal(requests.length,2); requests[1].resolve(payload); await next; assertModeled(h,10,15); cases++;
}
{
  const h=setup(), {c,requests}=h;
  const pending=c.switchDataMode('return-interval'); requests[0].resolve({intervals:[]}); await pending;
  assert.equal(c.currentSeriesHours.length,0); assert.equal(c.returnIntervalData,null,'Invalid payload must remain retryable.');
  const retry=c.switchReturnInterval(10); assert.equal(requests.length,2);
  requests[1].resolve(payload); await retry; assertModeled(h); cases++;
}
for (const obsolete of ['success','failure']) {
  const h=setup(), {c,requests,messages}=h;
  const first=c.switchDataMode('return-interval'); const second=c.switchReturnInterval(100);
  await c.switchOverlayMode('dynamic'); await c.setTimelineIntervalMinutes(15);
  requests[1].resolve(payload); await second; assertModeled(h,100,15); const notified=messages.length;
  if(obsolete==='success') requests[0].resolve(payload); else requests[0].reject(Error('Old year unavailable'));
  await first; assertModeled(h,100,15); assert.equal(messages.length,notified); cases++;
}
{
  const h=setup(), {c,requests}=h;
  const pending=c.switchDataMode('return-interval'); requests[0].resolve(payload); await pending;
  c.currentHourIndex=c.currentSeriesHours.findIndex(entry => entry.offsetHours===3);
  await c.setTimelineIntervalMinutes(15);
  assert.equal(c.currentSeriesHours[c.currentHourIndex].offsetHours,3,'A loaded modeled series should preserve its actual selected storm time.');
  assert.equal(requests.length,1); cases++;
}
await tick();
console.log(`${cases} modeled loading, cadence, overlay, datum, supersession, failure and retry cases passed.`);
