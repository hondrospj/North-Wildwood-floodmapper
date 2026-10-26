import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = ['00-configuration','02-data-and-datums','11-export-selection','12-export-date-editors','13-export-range','17-export-encoding']
  .map(name=>fs.readFileSync(new URL(`app/runtime/${name}.js`,import.meta.url),'utf8')).join('\n');
const extract = name => {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};

// A fresh Forecast page must not advertise its forecast window as complete
// archive availability; the real range path initializes history before deciding.
{
  let bounds = null, warms = 0, lewes = 0, clears = 0;
  const forecast = [{ timeUtc:'2026-10-26T17:00:00Z' },{ timeUtc:'2026-10-30T05:00:00Z' }];
  const ctx = vm.createContext({ currentDataMode:'forecast',
    getObservedArchiveDateBounds: () => bounds,
    getForecastExportEntries: () => forecast,
    getEntryESTDate: e => e ? new Date(e.timeUtc) : null,
    getDownloadCurrentEntry: () => forecast[0],
    warmBackgroundData: async () => { warms++; bounds = {firstDate:new Date('2025-01-01T05:00:00Z'),lastDate:new Date('2026-10-26T17:00:00Z')}; },
    ensureLewesArchiveIndex: async () => { lewes++; },
    clearExportAvailabilityCache: () => { clears++; },
  });
  for(const name of ['getDownloadArchiveBounds','ensureExportArchiveAvailability']) vm.runInContext(extract(name),ctx);
  assert.equal(ctx.getDownloadArchiveBounds(), null, 'Uninitialized history has no forecast-only native picker limits');
  await ctx.ensureExportArchiveAvailability();
  const available = ctx.getDownloadArchiveBounds();
  assert.equal(available.firstDate.toISOString(),'2025-01-01T05:00:00.000Z');
  assert.equal(available.lastDate.toISOString(),'2026-10-30T05:00:00.000Z');
  assert.equal(ctx.currentDataMode,'forecast','Archive initialization does not navigate the main map');
  assert.deepEqual([warms,lewes,clears],[1,1,1]);
  ctx.currentDataMode='return-interval'; await ctx.ensureExportArchiveAvailability();
  assert.equal(warms,1,'Synthetic modeled storms need no historical transport');
}

// Healthy forecast ranges remain independent of an unavailable history service
// in both encoders; ranges extending outside forecast coverage still need it.
for (const format of ['png','gif']) {
  const noop=()=>{};
  const forecast=[0,1,2].map(hour=>({timeUtc:new Date(Date.parse('2026-10-26T17:00:00Z')+hour*3600000).toISOString(),navd88StageFt:hour}));
  const range={startMs:Date.parse(forecast[0].timeUtc),endMs:Date.parse(forecast[2].timeUtc)};
  let history=0,downloaded=0,error='';
  const status={textContent:''};
  const ctx=vm.createContext({currentDataMode:'forecast',exportInProgress:false,floodFrameState:'ready',
    getForecastExportEntries:()=>forecast,getStageValue:e=>e.navd88StageFt,entryTimeMs:e=>Date.parse(e.timeUtc),
    getDownloadScopeValue:()=> 'range',getDownloadFormatValue:()=>format,getDownloadAspectValue:()=> 'viewport',
    validateDownloadRangeForExport:()=>({ok:true,range}),
    ensureExportArchiveAvailability:async()=>{history++;throw Error('history offline');},
    ensureObservedArchiveRange:async()=>{history++;throw Error('archive offline');},
    getDownloadFrameItems:()=>[{entry:forecast[0]}],EXPORT_PNG_SELECTION_LIMIT:337,
    document:{getElementById:()=>status},stopPlayback:noop,syncDownloadRangeInputs:noop,
    setDownloadModalOpen:noop,setDownloadBusy:busy=>{ctx.exportInProgress=busy;},
    throwIfExportCancelled:noop,setExportProgress:noop,setDownloadStatus:message=>{status.textContent=message;},
    ensureExportLibraries:async()=>{},exportPng:async()=>{downloaded++;},exportGif:async()=>{downloaded++;},
    isExportCancelledError:()=>false,getFriendlyExportError:e=>e.message,toast:message=>{error=message;},
    finishExportProgress:noop,updateDownloadSummary:noop,console:{error:noop},
  });
  for(const name of ['exportRangeNeedsObservedArchive','downloadCurrentSelection'])vm.runInContext(extract(name),ctx);
  assert.equal(ctx.exportRangeNeedsObservedArchive(range),false);
  assert.equal(ctx.exportRangeNeedsObservedArchive({...range,startMs:range.startMs-3600000}),true);
  assert.equal(ctx.exportRangeNeedsObservedArchive({...range,endMs:range.endMs+3600000}),true);
  await ctx.downloadCurrentSelection();
  assert.equal(history,0,`${format}: no history dependency for fully covered forecast range`);
  assert.equal(downloaded,1);assert.equal(error,'');assert.equal(ctx.exportInProgress,false);
}

// A passive archive/summary update preserves an in-progress text edit and its
// caret, while explicit synchronization can still apply a picker/reset value.
{
  const noop=()=>{};
  const canonical={value:'2026-10-26T13:00',dataset:{}};
  const text={value:'12/3D/YYYY',selectionStart:4,selectionEnd:4,classList:{toggle:noop,remove:noop},setAttribute:noop,removeAttribute:noop};
  const picker={},select={};let populated=0;
  const ctx=vm.createContext({currentDataMode:'forecast',exportInProgress:false,
    document:{activeElement:text,getElementById:()=>null},
    getExportDateEditorElements:()=>({canonical,dateText:text,datePicker:picker,timeSelect:select}),
    populateExportTimeSelect:()=>{populated++;}
  });
  vm.runInContext(extract('syncExportDateTimeEditorFromCanonical'),ctx);
  ctx.syncExportDateTimeEditorFromCanonical('start',{preserveActiveEdit:true});
  assert.equal(text.value,'12/3D/YYYY');assert.equal(text.selectionStart,4);assert.equal(populated,0);
  ctx.syncExportDateTimeEditorFromCanonical('start');
  assert.equal(text.value,'10/26/2026');assert.equal(populated,1);
}

// Storm-relative days must remain identical in the timeline and actual export
// frame selection, even when midnight falls inside a storm-relative day.
{
  const origin=Date.parse('2026-10-26T01:45:00Z');
  const entries=[[-12,0.5],[0,5.5619],[2.25,2.9474],[12,1.262]].map(([offsetHours,navd88StageFt])=>({
    offsetHours,navd88StageFt,timeUtc:new Date(origin+offsetHours*3600000).toISOString(),exportSourceMode:'return-interval'
  }));
  const ctx=vm.createContext({ currentDataMode:'return-interval',returnIntervalData:{windowHours:24},
    getStageValue:e=>e.navd88StageFt,entryTimeMs:e=>Date.parse(e.timeUtc),
    annotateHydraulicSeries:rows=>rows,getTimelineIntervalMinutes:()=>1440,currentRawSeriesHours:entries,currentSeriesHours:entries,
    getDownloadFrameItemFromEntry:entry=>({entry}),findClosestEntryIndex:()=>0,
    getReturnIntervalExportEntries:()=>entries,getDownloadIntervalConfig:()=>({value:'daily'}),
    buildDailyMaximumSeries:()=>{throw Error('Modeled maxima cannot use synthetic calendar days');},
  });
  for(const name of ['buildReturnIntervalDailyMaximumSeries','buildReturnIntervalDisplaySeries','buildDailyMaximumRangeFrameItems','getDownloadRangeSummaryFrameCount']) vm.runInContext(extract(name),ctx);
  const range={startMs:origin-12*3600000,endMs:origin+12*3600000};
  const main=ctx.buildReturnIntervalDisplaySeries(entries);
  const exported=ctx.buildDailyMaximumRangeFrameItems(entries,range);
  assert.deepEqual(Array.from(main,e=>e.navd88StageFt),[5.5619,1.262]);
  assert.deepEqual(Array.from(exported,item=>item.entry.navd88StageFt),[5.5619,1.262]);
  assert.deepEqual(Array.from(exported,item=>item.entry.offsetHours),[0,12]);
  assert.equal(ctx.getDownloadRangeSummaryFrameCount(range),2);
  assert.deepEqual(Array.from(ctx.buildDailyMaximumRangeFrameItems(entries,{startMs:origin+3600000,endMs:range.endMs}),item=>item.entry.navd88StageFt),[2.9474,1.262], 'Partial ranges retain the same storm-day bins');
}

// A script request that never fires load/error must expire, be removed and be
// retryable; a late callback from the discarded request must not clear the retry.
{
  const timers=new Map();let id=0,ready=false;const scripts=[];
  const ctx=vm.createContext({ OPTIONAL_SCRIPT_URLS:{html2canvas:'https://example.test/capture.js'},
    OPTIONAL_SCRIPT_TIMEOUT_MS:12000,optionalScriptPromises:new Map(),
    setTimeout:(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;},clearTimeout:key=>timers.delete(key),
    document:{createElement:()=>({dataset:{},remove(){this.removed=true;}}),head:{appendChild:s=>scripts.push(s)}}
  });ctx.window=ctx;vm.runInContext(extract('loadOptionalScript'),ctx);
  const stalled=ctx.loadOptionalScript('html2canvas',()=>ready);
  const rejected=assert.rejects(stalled,/too long/);
  assert.equal(timers.size,1);assert.equal([...timers.values()][0].ms,12000);
  [...timers.values()][0].fn();await rejected;
  assert.equal(scripts[0].removed,true);assert.equal(ctx.optionalScriptPromises.size,0);
  const retry=ctx.loadOptionalScript('html2canvas',()=>ready);
  assert.equal(scripts.length,2);ready=true;scripts[1].onload();await retry;
  assert.equal(timers.size,0,'Successful retry clears its deadline');
}

console.log('PASS holistic export: initialized history bounds, forecast exports during history outages, consistent modeled daily peaks, bounded/retryable optional dependencies.');
