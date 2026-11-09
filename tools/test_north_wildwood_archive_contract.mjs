import { readAppSource } from './app_source.mjs';
// Network-independent failure/retry and cache-isolation tests for the real loaders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=readAppSource(new URL('../index.html',import.meta.url));
function extract(name){const start=html.search(new RegExp('^    (?:async )?function '+name+'\\(','m'));assert(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);}
function context(names,extra={}){
  const c=vm.createContext({Map,Set,Number,Math,Date,Promise,console:{warn(){}},archiveGeneration:0,observedArchiveLoadedYears:new Set(),observedArchiveUnavailableYears:new Set(),observedArchiveYearPromises:new Map(),observed15MinuteDaysByDate:new Map(),lewesHourlyDaysByDate:new Map(),observedData:null,observedDaysCache:null,clearExportAvailabilityCache(){},...extra});
  for(const name of names)vm.runInContext(extract(name),c);
  return c;
}
const primary={source:'stone-harbor',stationId:'01411360',intervalMinutes:15,days:[{d:'2026-01-01',u:Date.parse('2026-01-01T00:00Z')/1000,v:Array(96).fill(100),p:100}]};
const cache=context(['validateArchiveDays','addArchiveShardDays'],{
  TOWN_CONFIG:{observed:{usgsGaugeId:'01411360'}},surrogateStationId:()=> '8557380',
  parseStoredLocalNyToDate:value=>new Date(value+'Z'),
  addDaysToDateKey:(value,n)=>new Date(Date.parse(value+'T00:00Z')+n*86400000).toISOString().slice(0,10)
});
cache.addArchiveShardDays(primary,'stone-harbor');
assert.equal(cache.observed15MinuteDaysByDate.size,1);
assert.equal(cache.lewesHourlyDaysByDate.size,0);
assert.throws(()=>cache.addArchiveShardDays({...primary,stationId:'1005'},'stone-harbor'),/gauge mismatch/);
assert.throws(()=>cache.addArchiveShardDays(primary,'lewes'),/interval/);
const badDay={d:'2026-01-02',u:Date.parse('2026-01-02T00:00Z')/1000,v:[1]};
assert.throws(()=>cache.addArchiveShardDays({...primary,days:[{...primary.days[0],v:Array(96).fill(200)},badDay]},'stone-harbor'),/cadence/);
assert.equal(cache.observed15MinuteDaysByDate.size,1,'Malformed response partially installed');
assert.equal(cache.observed15MinuteDaysByDate.get('2026-01-01').v[0],100,'Malformed response overwrote an existing day');
const changedDay={...primary.days[0],v:Array(96).fill(574),p:574};
assert.throws(()=>cache.addArchiveShardDays({...primary,days:[primary.days[0],changedDay]},'stone-harbor'),/Duplicate archive day/);
assert.throws(()=>cache.addArchiveShardDays({...primary,days:[primary.days[0],{d:'2026-01-02'}]},'stone-harbor'),/no sample array/);
assert.throws(()=>cache.addArchiveShardDays({...primary,days:[primary.days[0],{...primary.days[0],d:'2025-01-01'}]},'stone-harbor',{year:'2026'}),/outside 2026/);
assert.throws(()=>cache.addArchiveShardDays(primary,'stone-harbor',{indexedDates:['2026-01-01','2026-01-02']}),/omit an indexed date/);
assert.equal(cache.observed15MinuteDaysByDate.get('2026-01-01').v[0],100,'Rejected transport must not partially mutate an existing day');
assert.throws(()=>cache.addArchiveShardDays({...primary,schema:'north-wildwood-observed-15min-v1',
  archiveStartDate:'2026-01-01',archiveEndDate:'2026-01-03',days:[primary.days[0],{...primary.days[0],d:'2026-01-03',
    u:Date.parse('2026-01-03T00:00Z')/1000}]},'stone-harbor'),/missing dates/);



const compact=context(['ensureObserved15MinuteArchive'],{
  observed15MinuteData:null,OBSERVED_15MIN_URL:'fallback',observedArchiveIndexTextPromise:null,
  TOWN_CONFIG:{observed:{usgsGaugeId:'01411360'}},
  async preloadObservedArchiveIndexText(){throw Error('index unavailable')},
  async fetchJson(){return {...primary,stationId:'1005'}},
  addArchiveShardDays:(payload,source,options)=>cache.addArchiveShardDays(payload,source,options)
});
await assert.rejects(()=>compact.ensureObserved15MinuteArchive(),/gauge mismatch/);
assert.equal(compact.observed15MinuteData,null,'Invalid fallback installed as the primary index');
compact.fetchJson=async()=>primary;
assert.equal((await compact.ensureObserved15MinuteArchive()).stationId,'01411360','Valid compact fallback cannot retry');
compact.observed15MinuteData=null;
const invalidIndex=Promise.resolve(JSON.stringify({
  ...primary, schema:'north-wildwood-observed-day-index-v1', archiveStartDate:'2026-01-01', archiveEndDate:'2026-01-03',
  days:[{d:'2026-01-01'},{d:'2026-01-03'}]
}));
compact.observedArchiveIndexTextPromise=invalidIndex;
compact.preloadObservedArchiveIndexText=()=>invalidIndex;
assert.equal(await compact.ensureObserved15MinuteArchive(),primary,'An incomplete primary day index must use the actual compact fallback');
assert.equal(compact.observedArchiveIndexTextPromise,null,'Rejecting an index must make its response retryable');


const lewesSummary={source:'lewes',stationId:'8557380',intervalMinutes:60,
  archiveStartDate:'1962-03-01',archiveEndDate:'1962-03-10',days:[{d:'1962-03-01'},{d:'1962-03-07'},{d:'1962-03-10'}]};
const lewes=context(['validateArchiveDays','ensureLewesArchiveIndex'],{
  surrogateEnabled:()=>true,surrogateStationId:()=> '8557380',surrogateStationName:()=> 'Lewes',surrogateStationShort:()=> 'Lewes',
  primaryArchiveStartDate:()=> '2007-10-01',LEWES_ARCHIVE_INDEX_URL:'lewes-index',
  canonicalDailyData:{days:[['1962-03-07',500,'N'],['1962-03-08',null,'-'],['2009-11-13',544,'N']]},
  lewesArchiveIndexData:null,lewesArchiveIndexPromise:null,lewesHourlyData:null,
  mergeObservedArchiveIndex() {},refreshObservedArchiveUi() {},
});
lewes.fetchJson=async()=>({...lewesSummary,stationId:'99999999'});
assert.equal(await lewes.ensureLewesArchiveIndex(),null);
assert.equal(lewes.lewesHourlyData,null,'A wrong-station index must not change source provenance');
lewes.fetchJson=async()=>({...lewesSummary,days:lewesSummary.days.filter(day=>day.d!=='1962-03-07')});
assert.equal(await lewes.ensureLewesArchiveIndex(),null,'An index omitting a known canonical Lewes day must not be authoritative');
lewes.fetchJson=async()=>lewesSummary;
assert.equal(await lewes.ensureLewesArchiveIndex(),lewesSummary,'Legitimate sparse Lewes coverage must remain usable');
assert.equal(lewes.lewesHourlyData.stationId,'8557380');

let requests=0,available=false;
const loader=context(['ensureObservedArchiveYear'],{
  observed15MinuteData:null,OBSERVED_15MIN_URL:'fallback',
  async ensureObserved15MinuteArchive(){},async ensureLewesArchiveIndex(){return null},
  getObservedArchiveShardUrl:()=> 'shard',
  async fetchJson(url){requests++;if(url==='shard'&&available)return primary;throw Error('offline')},
  addArchiveShardDays:(payload,source,options)=>cache.addArchiveShardDays(payload,source,options),async ensureLewesHourlyArchive(){return {days:[{d:'1962-03-06',v:[1]}]}}
});
assert.equal(await loader.ensureObservedArchiveYear('stone-harbor','2026'),false);
assert.equal(loader.observedArchiveLoadedYears.size,0,'Failed year marked loaded');
available=true;
assert.equal(await loader.ensureObservedArchiveYear('stone-harbor','2026'),true,'Network error did not retry');
assert.equal(requests,3);
assert.equal(await loader.ensureObservedArchiveYear('lewes','2026'),false,'Old fallback incorrectly satisfied new year');
assert(!loader.observedArchiveLoadedYears.has('lewes:2026'));
loader.ensureLewesArchiveIndex=async()=>({days:[{d:'1962-03-06'}]});
const before=requests;
assert.equal(await loader.ensureObservedArchiveYear('lewes','2025'),false);
assert.equal(requests,before,'Requested a shard outside declared coverage');

const lewesMetadata={stationId:'8557380'};
const fullLewes={source:'lewes',stationId:'8557380',intervalMinutes:60,days:[
  {d:'1962-03-07',u:Date.parse('1962-03-07T00:00Z')/1000,v:Array(24).fill(500),p:500},
]};
let compactStation='99999999';
const lewesFallback=context(['ensureLewesHourlyArchive','ensureObservedArchiveYear'],{
  surrogateEnabled:()=>true,LEWES_HOURLY_URL:'lewes-compact',lewesHourlyData:lewesMetadata,
  async ensureLewesArchiveIndex(){return {days:[{d:'1962-03-07'}]};},
  getObservedArchiveShardUrl:()=> 'lewes-shard',
  async fetchJson(url){if(url==='lewes-shard')throw Error('offline');return {...fullLewes,stationId:compactStation};},
  addArchiveShardDays:(payload,source,options)=>cache.addArchiveShardDays(payload,source,options)
});
assert.equal(await lewesFallback.ensureObservedArchiveYear('lewes','1962'),false);
assert.equal(lewesFallback.lewesHourlyData,lewesMetadata,'Invalid compact metadata must not replace the known gauge');
compactStation='8557380';
assert.equal(await lewesFallback.ensureObservedArchiveYear('lewes','1962'),true);
assert.equal(lewesFallback.lewesHourlyData.stationId,'8557380','The valid compact retry can commit metadata');

let releaseOld,releaseNew;
const heldOld=new Promise(resolve=>{releaseOld=resolve}),heldNew=new Promise(resolve=>{releaseNew=resolve});
loader.observedArchiveLoadedYears=new Set();
loader.fetchJson=()=>heldOld;
const old=loader.ensureObservedArchiveYear('stone-harbor','2026').catch(error=>error);
await new Promise(resolve=>setImmediate(resolve));
loader.archiveGeneration++;
loader.observedArchiveYearPromises=new Map();
loader.fetchJson=()=>heldNew;
const latest=loader.ensureObservedArchiveYear('stone-harbor','2026');
await new Promise(resolve=>setImmediate(resolve));
releaseOld(primary);
assert.match((await old).message,/superseded/);
assert.equal(loader.observedArchiveYearPromises.size,1,'Old request removed the new in-flight request');
releaseNew(primary);assert.equal(await latest,true);

let finishCanonical;
const daily=context(['ensureCanonicalDailyArchive'],{canonicalDailyData:null,CANONICAL_DAILY_URL:'daily',fetchJson:()=>new Promise(resolve=>{finishCanonical=resolve})});
const stale=daily.ensureCanonicalDailyArchive().catch(error=>error);daily.archiveGeneration++;finishCanonical({days:[]});
assert.match((await stale).message,/superseded/);assert.equal(daily.canonicalDailyData,null);
console.log('Archive gauge/cadence isolation, atomic validation, missing coverage, retries and Reload races passed');
