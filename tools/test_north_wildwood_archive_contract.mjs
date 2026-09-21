// Network-independent failure/retry and cache-isolation tests for the real loaders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function extract(name){const start=html.search(new RegExp('^    (?:async )?function '+name+'\\(','m'));assert(start>=0,name);return html.slice(start,html.indexOf('\n    }',start)+6);}
function context(names,extra={}){
  const c=vm.createContext({Map,Set,Number,Math,Date,Promise,console:{warn(){}},archiveGeneration:0,observedArchiveLoadedYears:new Set(),observedArchiveUnavailableYears:new Set(),observedArchiveYearPromises:new Map(),observed15MinuteDaysByDate:new Map(),lewesHourlyDaysByDate:new Map(),observedData:null,observedDaysCache:null,clearExportAvailabilityCache(){},...extra});
  for(const name of names)vm.runInContext(extract(name),c);
  return c;
}
const primary={source:'stone-harbor',stationId:'01411360',intervalMinutes:15,days:[{d:'2026-01-01',u:Date.parse('2026-01-01T00:00Z')/1000,v:Array(96).fill(100),p:100}]};
const cache=context(['addArchiveShardDays'],{
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

const compact=context(['ensureObserved15MinuteArchive'],{
  observed15MinuteData:null,OBSERVED_15MIN_URL:'fallback',
  TOWN_CONFIG:{observed:{usgsGaugeId:'01411360'}},
  async preloadObservedArchiveIndexText(){throw Error('index unavailable')},
  async fetchJson(){return {...primary,stationId:'1005'}},
  addArchiveShardDays:(payload,source)=>cache.addArchiveShardDays(payload,source)
});
await assert.rejects(()=>compact.ensureObserved15MinuteArchive(),/gauge mismatch/);
assert.equal(compact.observed15MinuteData,null,'Invalid fallback installed as the primary index');
compact.fetchJson=async()=>primary;
assert.equal((await compact.ensureObserved15MinuteArchive()).stationId,'01411360','Valid compact fallback cannot retry');

let requests=0,available=false;
const loader=context(['ensureObservedArchiveYear'],{
  observed15MinuteData:null,OBSERVED_15MIN_URL:'fallback',
  async ensureObserved15MinuteArchive(){},async ensureLewesArchiveIndex(){return null},
  getObservedArchiveShardUrl:()=> 'shard',
  async fetchJson(url){requests++;if(url==='shard'&&available)return primary;throw Error('offline')},
  addArchiveShardDays:(payload,source)=>cache.addArchiveShardDays(payload,source),async ensureLewesHourlyArchive(){return {days:[{d:'1962-03-06',v:[1]}]}}
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
