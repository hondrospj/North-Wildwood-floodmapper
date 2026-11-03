import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.NWW_DEEP_CORE_RUNTIME_ROOT || path.join(repo, 'tools/app/runtime');
const read = name => fs.readFileSync(name==='03-time-series.js'&&process.env.NWW_DEEP_CORE_DAILY_SOURCE?process.env.NWW_DEEP_CORE_DAILY_SOURCE:path.join(runtime, name), 'utf8');
const all = ['02-data-and-datums.js', '18-flood-frame-rendering.js', '21-forecast-and-observed-loading.js', '11-export-selection.js'].map(read).join('\n');
function extract(name) {
  const match = all.match(new RegExp(`^ {0,4}(?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, name); return match[0];
}
const archive = JSON.parse(fs.readFileSync(path.join(repo, 'observed_archive/stone-harbor/2026.json'), 'utf8'));
const c = vm.createContext({Date, Math, Number, Map, Set, console,
  NY_PARTS_FORMATTER: new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'numeric', minute:'2-digit', hour12:true, timeZoneName:'short'}),
  MONTH_NAMES:['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  TOWN_CONFIG:{observed:{usgsGaugeId:'01411360'},site:{usgsGaugeId:'01411360'}},
  MINOR_FLOOD_FT:3.25, MODERATE_FLOOD_FT:4.25, MAJOR_FLOOD_FT:5.25,
  currentTimelineIntervalMinutes:15, currentDataMode:'observed', currentRawSeriesHours:[], currentSeriesHours:[],
  getTimelineIntervalMinutes:()=>c.currentTimelineIntervalMinutes,
  observed15MinuteData:archive, observed15MinuteDaysByDate:new Map(archive.days.map(day=>[day.d,day])),
  lewesHourlyDaysByDate:new Map(), observedDaysCache:null,
  observedData:{days:archive.days.map(day=>({date:day.d,peakNAVD88:day.p==null?null:day.p/100,hours:[]}))},
  lewesHourlyData:null,surrogateStationName:()=> 'Lewes',surrogateStationId:()=> '8557380', surrogateStationShort:()=> 'Lewes', configuredSurrogate:()=>({}),
  primaryGaugeName:()=> 'Stone Harbor', decodeSurrogateHundredths:value=>value==null?null:value/100,
  surrogateEnabled:()=>true, primaryArchiveStartDate:()=> '2007-10-01',
  DATUM_OFFSETS:{mllw:2.75}, TOP_TIDE_WINDOW_HOURS:12, TOP_TIDE_SELECT_COUNT:10,
  historicTopTideEntries:[], selectedObservedDate:'2026-09-26',
  clearExportAvailabilityCache(){}, archiveGeneration:1,
});
for(const name of ['pad2','normalizeStageValue','getRawStageValue','getStageValue','getEntryESTDate','parseStoredESTToDate','getPeakHourIndex','classifyFloodStage','classifyFloodEntries','dateKeyToUtcMs','addDaysToDateKey']) vm.runInContext(extract(name),c);
for(const name of ['03-time-series.js','04-observation-archives.js','06-inundation-catalog.js','08-filling-and-drainage.js','19-observed-history.js']) vm.runInContext(read(name),c);
vm.runInContext(extract('getDownloadFrameItemFromEntry'),c);
let checks=0;
function check(value,message){assert.ok(value,message);checks++;}
const day=c.buildObservedCanonicalSeries(c.getObservedDayRecord('2026-09-26'),'2026-09-26');
const entry=day[1];
check(entry.hydraulicPhase==='draining','Midnight must not restart the release clock');
check(entry.hydraulicCrestTimeUtc==='2026-09-26T01:30:00.000Z'&&entry.hydraulicCrestStageFt===4.75,'Actual preceding evening crest must survive');
check(day.length===96&&day[0].timeUtc==='2026-09-26T04:00:00.000Z'&&day.at(-1).timeUtc==='2026-09-27T03:45:00.000Z','Antecedents must not expand the displayed day');
const milestones=c.getDrainageRetentionMilestones(entry,day);
check(milestones[0]?.timeUtc==='2026-09-26T01:30:00.000Z','Retention must receive the preceding crest footprint');
check(c.annotateHydraulicSeries(day)[1].hydraulicCrestTimeUtc===entry.hydraulicCrestTimeUtc,'Top 10 reannotation must retain the same context');
check(c.sampleCanonicalHydraulicSeries(day,60).length===24,'Hourly sampling must keep the requested day bounds');
check(!JSON.stringify(entry).includes('hydraulicAntecedents":[{"hydraulicAntecedents"'),'Entry metadata must remain serializable without recursive context');
const item=c.getDownloadFrameItemFromEntry({...entry,exportSourceMode:'observed'});
check(item.entry.hydraulicPhase==='draining'&&c.getDrainageRetentionMilestones(item.entry,item.series)[0]?.timeUtc===entry.hydraulicCrestTimeUtc,'Observed export phase and retention must match playback');
const offGrid=c.getDownloadFrameItemFromEntry({...entry,timeUtc:'2026-09-26T04:17:00.000Z',displayTimeUtc:'2026-09-26T04:17:00.000Z',navd88StageFt:3.40,stageFt:3.40,value:3.40,exportSourceMode:'observed'});
check(offGrid.entry.timeUtc==='2026-09-26T04:17:00.000Z'&&offGrid.entry.hydraulicCrestTimeUtc===entry.hydraulicCrestTimeUtc,'An off-grid export peak must keep its instant and antecedent crest');
for(const date of ['2026-09-27','2026-09-28','2026-09-29','2026-09-30']){
 const daily=c.buildObservedDailyMaximumSeries(date.slice(0,7)).find(row=>row.observedDate===date);
 const canonical=c.buildObservedCanonicalSeries(c.getObservedDayRecord(date),date).find(row=>c.entryTimeMs(row)===c.entryTimeMs(daily));
 check(daily.hydraulicPhase===canonical.hydraulicPhase,`${date}: Daily Max must retain the native peak phase`);
 check(c.getStageValue(daily)===c.getStageValue(canonical)&&daily.timeUtc===canonical.timeUtc,`${date}: Daily Max must keep the same native peak instant and stage`);
}
c.historicTopTideEntries=[{...entry,observedDate:'2026-09-26',navd88StageFt:5.77,crestTimeKnown:false,sourceArea:'stone-harbor'}];
const historical=c.buildHistoricalTopTideCandidates()[0];
check(historical.canonicalSeries[1].hydraulicCrestTimeUtc===entry.hydraulicCrestTimeUtc,'Historical Top 10 crest fitting must preserve midnight history');
function sourceDay(date,stage,station='01411360',surrogate=false){
 const start=c.parseStoredLocalNyToDate(date+'T00:00').getTime(),end=c.parseStoredLocalNyToDate(c.addDaysToDateKey(date,1)+'T00:00').getTime();
 const hours=Array.from({length:(end-start)/900000},(_,i)=>({timeUtc:new Date(start+i*900000).toISOString(),navd88StageFt:typeof stage==='function'?stage(i):stage,sourceStationId:station}));
 return {date,isLewesSurrogate:surrogate,timelineRawHours:hours,hours};
}
function install(days){c.observed15MinuteDaysByDate=new Map();c.observedDaysCache=null;c.observedData={days};c.historicTopTideEntries=[];}
for(const [date,count] of [['2024-03-10',92],['2024-11-03',100],['2025-01-01',96]]){
 const previous=sourceDay(c.addDaysToDateKey(date,-1),i=>i<84?3.3:4.5-(i-84)*.04);
 const selected=sourceDay(date,i=>3.9-i*.03);install([previous,selected]);
 const series=c.buildObservedCanonicalSeries(c.getObservedDayRecord(date),date);
 check(series.length===count,`${date}: DST/year day bounds changed`);
 check(series.every(row=>row.observedDate===date),`${date}: another date leaked into the timeline`);
 check(series[1].hydraulicCrestTimeUtc<series[0].timeUtc,`${date}: prior-day crest context missing`);
 check(new Set(series.map(row=>row.timeUtc)).size===count,`${date}: repeated-hour instants collapsed`);
}
for(const mismatch of ['station','archive-source']){
 const previous=sourceDay('2024-06-17',4.8,mismatch==='station'?'1005':'8557380',mismatch==='archive-source');
 const selected=sourceDay('2024-06-18',i=>3.6-i*.03);install([previous,selected]);
 const series=c.buildObservedCanonicalSeries(c.getObservedDayRecord(selected.date),selected.date);
 check(!series[0].hydraulicAntecedents?.length,`${mismatch}: a different gauge supplied antecedents`);
}
const missing=sourceDay('2024-06-17',4.8);missing.timelineRawHours.forEach(row=>row.navd88StageFt=null);
const selected=sourceDay('2024-06-18',i=>i<2?null:3.6-i*.03);install([missing,selected]);
const gaps=c.buildObservedCanonicalSeries(c.getObservedDayRecord(selected.date),selected.date);
check(gaps.slice(0,2).every(row=>row.isMissingTimelineFrame&&c.getStageValue(row)===null),'Context must not fabricate observations across a gap');
const offGridDay=sourceDay('2024-06-18',4.0);
const midnight=c.parseStoredLocalNyToDate('2024-06-18T00:00').getTime();
offGridDay.hours=offGridDay.timelineRawHours=[0,6,12,18,24,30].map((minute,index)=>({timeUtc:new Date(midnight+minute*60000).toISOString(),navd88StageFt:[4.2,5.1,4.8,4.6,4.4,4.0][index],sourceStationId:'01411360',observationQuality:'M',sourceResolutionMinutes:6,isMeasuredQuarterHourArchive:false,isInterpolatedTimelineFrame:false,source:'native-six-minute-peak'}));
install([sourceDay('2024-06-17',4.2),offGridDay]);
const dailyOffGrid=c.buildObservedDailyMaximumSeries('2024-06')[1];
check(dailyOffGrid.timeUtc==='2024-06-18T04:06:00.000Z'&&c.getStageValue(dailyOffGrid)===5.1,'Daily Max must retain an off-grid native peak instant and stage');
check(dailyOffGrid.hydraulicPhase==='slack'&&dailyOffGrid.observationQuality==='M'&&dailyOffGrid.isInterpolatedTimelineFrame===false&&dailyOffGrid.sourceStationId==='01411360'&&dailyOffGrid.source==='native-six-minute-peak'&&dailyOffGrid.sourceResolutionMinutes===6&&dailyOffGrid.isMeasuredQuarterHourArchive===false,'Daily Max phase resolution must preserve native peak provenance');
const onGridDay=sourceDay('2024-06-18',4.0);
onGridDay.hours=onGridDay.timelineRawHours=[0,6,12,18,24,30,36,42,48,54].map((minute,index)=>({timeUtc:new Date(midnight+minute*60000).toISOString(),navd88StageFt:[4.2,4.3,4.4,4.6,4.8,5.1,4.8,4.6,4.4,4.2][index],sourceStationId:'01411360',observationQuality:'M',sourceResolutionMinutes:6,isMeasuredQuarterHourArchive:true,isInterpolatedTimelineFrame:false,source:'native-on-grid-peak'}));
install([sourceDay('2024-06-17',4.2),onGridDay]);
const dailyOnGrid=c.buildObservedDailyMaximumSeries('2024-06')[1];
check(dailyOnGrid.timeUtc==='2024-06-18T04:30:00.000Z'&&c.getStageValue(dailyOnGrid)===5.1&&dailyOnGrid.hydraulicPhase==='slack','On-grid daily peak must retain its native stage, instant and phase');
check(dailyOnGrid.sourceStationId==='01411360'&&dailyOnGrid.sourceResolutionMinutes===6&&dailyOnGrid.observationQuality==='M'&&dailyOnGrid.isMeasuredQuarterHourArchive===true&&dailyOnGrid.isInterpolatedTimelineFrame===false&&dailyOnGrid.source==='native-on-grid-peak','Canonical phase resolution must not replace on-grid native quality flags or six-minute provenance');
function surrogateDay(date,values){return {date,isLewesSurrogate:true,hours:[],lewesCompactDay:{d:date,u:c.parseStoredLocalNyToDate(date+'T00:00').getTime()/1000,v:values}};}
const priorSurrogate=surrogateDay('2024-12-31',Array.from({length:24},(_,i)=>i===21?480:i===22?460:i===23?420:350));
const selectedSurrogate=surrogateDay('2025-01-01',Array.from({length:24},(_,i)=>400-i*20));
const nextSurrogate=surrogateDay('2025-01-02',Array(24).fill(200));install([priorSurrogate,selectedSurrogate,nextSurrogate]);
const surrogate=c.buildObservedCanonicalSeries(c.getObservedDayRecord(selectedSurrogate.date),selectedSurrogate.date);
check(surrogate[1].hydraulicCrestTimeUtc==='2025-01-01T02:00:00.000Z','Hourly surrogate context must preserve the prior local-evening crest');
check(surrogate.length===96&&surrogate.at(-1).timeUtc==='2025-01-02T04:45:00.000Z','Surrogate interpolation must preserve day bounds and the next endpoint');
check(c.getDrainageRetentionMilestones(surrogate[1],surrogate)[0]?.sourceStationId==='8557380','Surrogate retention must remain on its own station');
// Fetch boundary coverage: selected Jan 1 and cross-year range need the preceding
// shard, while a source transition must not fetch a different gauge for context.
const years=[];c.ensureObservedArchiveYear=async(source,year)=>{years.push(`${source}:${year}`);return true;};c.getTodayNyDateKey=()=> '2099-01-01';
c.getObservedArchiveSourceForDate=()=> 'stone-harbor';
await c.ensureObservedArchiveForDate('2025-01-01');
check(years.includes('stone-harbor:2024'),'January 1 must load the antecedent year');
years.length=0;c.getObservedArchiveSourceForDate=date=>date<'2025-01-01'?'lewes':'stone-harbor';
await c.ensureObservedArchiveForDate('2025-01-01');
check(!years.some(key=>key.endsWith(':2024')),'Archive source boundary must not borrow another gauge');
years.length=0;c.getObservedArchiveSourceForDate=()=> 'stone-harbor';
c.getExportDayKeyFromDate=date=>c.formatNyLocalIso(date).slice(0,10);
await c.ensureObservedArchiveRange(c.parseStoredLocalNyToDate('2025-01-01T00:00'),c.parseStoredLocalNyToDate('2025-01-02T01:00'));
check(years.includes('stone-harbor:2024'),'An export range starting January 1 must load the antecedent year');
console.log(`${checks} deep core history, real archive, export, gauge and DST/year checks passed.`);
