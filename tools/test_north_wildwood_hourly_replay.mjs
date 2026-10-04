// Hourly historical observations must produce a continuous, explicitly
// interpolated quarter-hour replay without filling missing observations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL(process.env.NWW_SOURCE || '../index.html',import.meta.url),'utf8');
function extract(name){
 const start=html.search(new RegExp('^    (?:async )?function '+name+'\\(','m'));
 assert(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);
}
const date='1962-03-07',nextDate='1962-03-08';
const start=Date.parse(date+'T00:00Z');
const sample=(minutes,stage)=>({timeUtc:new Date(start+minutes*60000).toISOString(),navd88StageFt:stage,isMissingObservedHour:stage===null,sourceResolutionMinutes:60,sourceStationId:'8557380',isLewesSurrogate:true});
const day={date,isLewesSurrogate:true,entries:Array.from({length:24},(_,h)=>sample(h*60,h))};
const nextDay={date:nextDate,isLewesSurrogate:true,entries:[sample(1440,24)]};
let days=new Map([[date,day],[nextDate,nextDay]]);
const c=vm.createContext({Date,Math,Number,Map,Set,console,
 getStageValue:e=>e?.navd88StageFt??null,
 entryTimeMs:e=>e?.timeUtc?Date.parse(e.timeUtc):null,
 getObservedSourceHoursForDay:d=>d?.entries||[],
 parseStoredLocalNyToDate:s=>new Date(s+'Z'),
 formatNyLocalIso:d=>d.toISOString().slice(0,16),
 addDaysToDateKey:(s,n)=>new Date(Date.parse(s+'T00:00Z')+n*86400000).toISOString().slice(0,10),
 getObservedDayRecord:s=>days.get(s),
 detectSeriesResolutionMinutes:()=>60,
 annotateHydraulicSeries:s=>s,
 getTimelineIntervalMinutes:()=>15,
 getEntryESTDate:e=>new Date(e.timeUtc),
 getNyParts:d=>({minute:d.getUTCMinutes()})
});
for(const name of ['setTimelineSlotFields','makeMissingTimelineEntry','makeInterpolatedTimelineEntry','buildQuarterHourTimelineSeries','buildObservedCanonicalSeries','sampleCanonicalHydraulicSeries'])vm.runInContext(extract(name),c);
const build=()=>c.buildObservedCanonicalSeries(day,date);
let series=build();
assert.equal(series.length,96);
assert.equal(series.filter(e=>Number.isFinite(c.getStageValue(e))).length,96,'Hourly data acquired 72 artificial gaps');
for(let i=0;i<96;i++){
 assert.equal(series[i].navd88StageFt,i/4);
 assert.equal(series[i].isInterpolatedTimelineFrame===true,i%4!==0);
 assert.equal(series[i].isMissingObservedHour,false);
 assert.equal(series[i].isMeasuredQuarterHourArchive===true,false);
 assert.equal(series[i].sourceStationId,'8557380');
 assert.equal(series[i].observedDate,date);
 if(i%4)assert.equal(series[i].interpolationSpanSeconds,3600);
}
assert.deepEqual(Array.from(c.sampleCanonicalHydraulicSeries(series,60),e=>e.navd88StageFt),day.entries.map(e=>e.navd88StageFt),'Hourly values changed');
// A genuine missing hourly reading must not be bridged across two hours.
const saved=day.entries[9];day.entries[9]=sample(540,null);
series=build();
for(let i=33;i<=39;i++)assert.equal(series[i].navd88StageFt,null,'Real observation gap was fabricated');
assert.equal(series[32].navd88StageFt,8);assert.equal(series[40].navd88StageFt,10);
day.entries[9]=saved;
// No endpoint means no extrapolation, and another gauge cannot supply it.
days.delete(nextDate);series=build();
assert.equal(series.filter(e=>Number.isFinite(e.navd88StageFt)).length,93);
assert(series.slice(93).every(e=>e.navd88StageFt===null));
days.set(nextDate,{...nextDay,isLewesSurrogate:false});
assert(build().slice(93).every(e=>e.navd88StageFt===null));
days.set(nextDate,{...nextDay,entries:[{navd88StageFt:50,isDailyPeakOnly:true}]});
assert(build().slice(93).every(e=>e.navd88StageFt===null));
days.set(nextDate,nextDay);
// Keep the primary quarter-hour archive's stricter 30-minute gap policy.
const primary={date,entries:[sample(0,0),sample(60,4)]};
series=c.buildObservedCanonicalSeries(primary,date);
assert(series.slice(1,4).every(e=>e.navd88StageFt===null));
primary.entries=[sample(0,0),sample(30,2)];
assert.equal(c.buildObservedCanonicalSeries(primary,date)[1].navd88StageFt,1);
// A date-only crest never becomes a synthetic daily hydrograph.
const peak={isDailyPeakOnly:true,navd88StageFt:7.5};
assert.deepEqual(Array.from(c.buildObservedCanonicalSeries({date,entries:[peak]},date)),[peak]);
// Interpolation following a fitted crest is not itself a crest observation.
const before={t:start,entry:{...sample(0,3),isFittedCrestFrame:true,isOfficialCrestFrame:true}};
const interpolated=c.makeInterpolatedTimelineEntry(before,{t:start+3600000,entry:sample(60,2)},start+900000,15);
assert.equal(interpolated.isFittedCrestFrame,false);assert.equal(interpolated.isOfficialCrestFrame,false);
// December 31 must preload the next year's real midnight endpoint.
const calls=[];
Object.assign(c,{getObservedArchiveSourceForDate:()=> 'lewes',ensureObservedArchiveYear:async(...a)=>calls.push(a),lewesHourlyDaysByDate:new Map([['1962-12-31',{}]]),observed15MinuteDaysByDate:new Map()});
vm.runInContext(extract('ensureObservedArchiveForDate'),c);
assert.equal(await c.ensureObservedArchiveForDate('1962-12-31'),true);
assert.deepEqual(calls,[['lewes','1962'],['lewes','1963']]);
calls.length=0;await c.ensureObservedArchiveForDate(date);
assert.deepEqual(calls,[['lewes','1962']]);
console.log('PASS hourly replay: 96 frames, unchanged readings, interpolation provenance, genuine gaps, midnight/year boundary, primary cadence, and date-only crests');
