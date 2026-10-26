// Count expensive NY boundary conversions instead of relying on a machine-
// dependent time limit. A full archive must not eagerly convert every day.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=['03-time-series','13-export-range','14-export-calendars']
  .map(name=>fs.readFileSync(new URL(`app/runtime/${name}.js`,import.meta.url),'utf8')).join('\n');
function extract(name) {
  const match=source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match,`Missing ${name}`);return match[0];
}
function harness(days,entries=[],mode='forecast') {
  let calls=0;
  const ctx=vm.createContext({Date,Intl,Map,Set,
    NY_PARTS_FORMATTER:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true}),
    currentDataMode:mode,EXPORT_RANGE_MAX_MS:84*3600000,
    getObservedDays:()=>days,getForecastExportEntries:()=>entries,getReturnIntervalExportEntries:()=>entries,
    getEntryESTDate:entry=>new Date(entry.timeUtc),entryTimeMs:entry=>Date.parse(entry.timeUtc),
    exportAvailabilityCache:null,exportAvailabilityDayMapCache:null,exportAvailabilityMonthMapCache:null,
    exportAvailabilityBoundsCache:null,exportAvailabilityHourTotalCache:null,observedExportDayIndexCache:null,
    exportEntriesForDayCache:new Map(),exportTimePickerLastSignature:'',
  });
  for(const name of ['getNyParts','getLocalNyDateCandidates','parseStoredLocalNyToDate','getExportDayKeyFromDate',
    'getObservedExportDayIndex','getForecastExportEntriesLimited','getExportAvailabilityDayMap',
    'getExportAvailabilityBoundsForDays','getExportAvailabilityBounds','getExportAvailabilityMonthMap','clearExportAvailabilityCache']) {
    vm.runInContext(extract(name),ctx);
  }
  const parse=ctx.parseStoredLocalNyToDate;
  ctx.parseStoredLocalNyToDate=value=>{calls++;return parse(value);};
  return {ctx,calls:()=>calls};
}

const count=30333,dayMs=86400000,startMs=Date.parse('1943-10-01T12:00:00Z');
const days=Array.from({length:count},(_,i)=>({date:new Date(startMs+i*dayMs).toISOString().slice(0,10),hours:[]}));
days.find(day=>day.date==='2026-03-08').hours=Array(23).fill({});
days.find(day=>day.date==='2025-11-02').hours=Array(25).fill({});
const lastKey=days.at(-1).date;
const nextKey=new Date(startMs+count*dayMs).toISOString().slice(0,10);
// This fixture ends in October: UTC+4 creates the desired local instants.
const entries=[`${lastKey}T23:15`,`${lastKey}T23:45`,`${nextKey}T01:00`]
  .map(local=>({timeUtc:new Date(Date.parse(local+':00Z')+4*3600000).toISOString()}));
const {ctx,calls}=harness(days,entries);
const dayMap=ctx.getExportAvailabilityDayMap();
assert.equal(dayMap.size,count+1);assert.equal(calls(),0,'Constructing the full day catalog must parse no NY boundaries');
assert.equal(dayMap.get(lastKey).count,26);assert.equal(dayMap.get(lastKey).observed,true);assert.equal(dayMap.get(lastKey).forecast,true);
assert.equal(dayMap.get(nextKey).count,1);assert.equal(dayMap.get(nextKey).observed,false);assert.equal(dayMap.get(nextKey).forecast,true);
assert.equal(dayMap.get('2026-03-08').count,23);assert.equal(dayMap.get('2025-11-02').count,25);
const total=Array.from(dayMap.values()).reduce((sum,meta)=>sum+meta.count,0);
assert.equal(total,count*24+3,'Counts and observed/forecast classifications remain unchanged');
const bounds=ctx.getExportAvailabilityBounds();
assert.equal(calls(),2,'Global bounds resolve only the first and last day boundary');
assert.equal(bounds.firstDate.toISOString(),'1943-10-01T04:00:00.000Z');
assert.equal(bounds.lastDate.toISOString(),new Date(Date.parse(nextKey+'T23:00:00Z')+4*3600000).toISOString());
const months=ctx.getExportAvailabilityMonthMap();
assert.equal(calls(),2,'Constructing all month aggregates must not resolve their date bounds');
assert.equal(months.size,new Set([...days.map(day=>day.date.slice(0,7)),nextKey.slice(0,7)]).size);
assert.equal(months.get('1950-01').observed,true);assert.equal(months.get('1950-01').forecast,false);
const currentMonth=months.get(nextKey.slice(0,7));
assert.equal(currentMonth.observed,true);assert.equal(currentMonth.forecast,true);
assert.equal(currentMonth.firstDate.toISOString(),new Date(Date.parse(nextKey.slice(0,7)+'-01T00:00:00Z')+4*3600000).toISOString());
assert.equal(currentMonth.lastDate.toISOString(),bounds.lastDate.toISOString());
assert.equal(calls(),3,'Reading the boundary month resolves its first date and reuses the global last date');
assert.equal(ctx.getExportAvailabilityBounds(),bounds);assert.equal(ctx.getExportAvailabilityMonthMap(),months);
void currentMonth.firstDate;void currentMonth.lastDate;assert.equal(calls(),3,'Repeated boundary reads use cached Date objects');
assert.equal(dayMap.get(lastKey).lastDate.toISOString(),entries[1].timeUtc,'A 23:45 forecast extends the legacy23:00 boundary');
const spring=dayMap.get('2026-03-08'),fall=dayMap.get('2025-11-02');
assert.equal(spring.firstDate.toISOString(),'2026-03-08T05:00:00.000Z');
assert.equal(spring.lastDate.toISOString(),'2026-03-09T03:00:00.000Z');
assert.equal(fall.firstDate.toISOString(),'2025-11-02T04:00:00.000Z');
assert.equal(fall.lastDate.toISOString(),'2025-11-03T04:00:00.000Z');
assert.equal(spring.lastDate-spring.firstDate,22*3600000);assert.equal(fall.lastDate-fall.firstDate,24*3600000);
const resolved=calls();void spring.firstDate;void spring.lastDate;void fall.firstDate;void fall.lastDate;assert.equal(calls(),resolved);
ctx.clearExportAvailabilityCache();assert.notEqual(ctx.getExportAvailabilityDayMap(),dayMap);assert.equal(calls(),resolved,'Invalidation reconstructs a lazy catalog');

// Modeled calendars still expose their synthetic days and exact late-quarter
// endpoint, with no observed-day contamination or eager boundary conversion.
{
  const {ctx,calls}=harness(days,[{timeUtc:'2026-11-02T04:45:00Z'}],'return-interval');
  const map=ctx.getExportAvailabilityDayMap();assert.equal(map.size,1);assert.equal(calls(),0);
  const meta=map.get('2026-11-01');assert.equal(meta.observed,false);assert.equal(meta.forecast,true);assert.equal(meta.modeled,true);
  assert.equal(meta.firstDate.toISOString(),'2026-11-01T04:00:00.000Z');
  assert.equal(meta.lastDate.toISOString(),'2026-11-02T04:45:00.000Z');
  assert.equal(calls(),2);
}
console.log('PASS export availability: 30,333 historical days; 0 initial boundary parses, 2 for global bounds, 1 more for the boundary month; counts, forecast flags, DST and late-quarter endpoints preserved.');
