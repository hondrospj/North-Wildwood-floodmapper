import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const runtime=process.env.NWW_DEEP_CORE_RUNTIME_ROOT||path.join(path.dirname(fileURLToPath(import.meta.url)),'app/runtime');
const source=fs.readFileSync(path.join(runtime,'22-calendar-and-modes.js'),'utf8');
function extract(name){const match=source.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`,'ms'));assert.ok(match,name);return match[0];}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(stage='warmup'){
 const hold=deferred(),renders=[],messages=[],nodes=new Map();let firstCalendar=true,firstRender=true;
 const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',classList:{toggle(){}},setAttribute(){}});return nodes.get(id);};
 const c=vm.createContext({Promise,console,selectionGeneration:0,lastRenderToken:0,currentDataMode:'forecast',currentViewType:'forecast',currentOverlayMode:'depth',currentTimelineIntervalMinutes:60,overlayPreloadGeneration:0,currentHourIndex:0,currentTopTideIndex:null,selectedObservedDate:null,currentMonthKey:null,currentFloodLayer:{},currentRawSeriesHours:[],currentSeriesHours:[{timeUtc:'2026-11-03T12:00Z',navd88StageFt:2}],currentSelectedLabel:'Mean',currentSelectedSubLabel:'',currentRangeLabel:'',topTideEvents:[],observedData:null,
  document:{getElementById:el},cancelPendingFloodFrame(invalidate=true){if(invalidate)c.lastRenderToken++;return c.lastRenderToken;},stopPlayback(){},toast:message=>messages.push(message),updateDataModeButtons(){},updateModeButtons(){},updateTimelineIntervalUI(){},refreshCurrentDisplayText(){},syncSliderBounds(){},renderSelectionMeta(){},renderTimelineMeta(){},renderTimelineDays(){},setFloodFrameStatus:message=>messages.push(message),clearFloodLayer(){c.currentFloodLayer=null;},reportFloodFrameFailure(){},renderTopTides(){},scheduleHistoricalTopTideWarmup(){},getForecastScenarioLabel:()=> 'Mean',
  getTimelineIntervalMinutes:()=>c.currentTimelineIntervalMinutes,
  async warmBackgroundData(){if(stage==='warmup')await hold.promise;c.observedData={days:[{date:'2026-11-03'}]};},
  async ensureObservedArchiveForDate(){if(stage==='detail')await hold.promise;},
  async renderCalendar(){if((stage==='calendar'||stage==='day-calendar'&&c.currentSeriesHours.length)&&firstCalendar){firstCalendar=false;await hold.promise;}},
  getLatestObservedDate:()=> '2026-11-03',getObservedDayRecord:date=>({date,peakNAVD88:2,hours:[]}),buildTopTideEvents:()=>[],
  buildObservedCanonicalSeries:day=>Array.from({length:4},(_,i)=>({observedDate:day.date,timeUtc:day.date+`T0${i}:00Z`,navd88StageFt:2})),
  sampleCanonicalHydraulicSeries:series=>c.currentTimelineIntervalMinutes===60?series.filter((_,index)=>index%2===0):series,buildObservedDailyMaximumSeries:()=>[{observedDate:'2026-11-03',navd88StageFt:2}],formatStageForDisplay:String,normalizeStageValue:Number,classifyFloodEntries:()=> 'none',getPeakHourIndex:()=>0,findClosestMeasuredEntryIndex:()=>0,
  async renderHour(index){if(!c.currentSeriesHours.length)return;c.lastRenderToken++;renders.push({mode:c.currentDataMode,overlay:c.currentOverlayMode,interval:c.currentTimelineIntervalMinutes,date:c.currentSeriesHours[index]?.observedDate});if(stage==='render'&&c.currentDataMode==='observed'&&firstRender){firstRender=false;await hold.promise;}},
  async loadForecast(){c.currentSeriesHours=[{navd88StageFt:1}];c.currentViewType='forecast';},
  async loadReturnInterval(){c.currentSeriesHours=[{navd88StageFt:1}];c.currentViewType='return-interval';},
 });
 for(const name of ['setObservedDaySelection','loadObservedDay','loadTopTideEvent','switchDataMode','switchOverlayMode','setTimelineIntervalMinutes'])vm.runInContext(extract(name),c);
 return {c,hold,renders,messages};
}
let cases=0;
for(const stage of ['warmup','detail','calendar','day-calendar','render']){
 const {c,hold,renders}=setup(stage);const pending=c.switchDataMode('observed');await tick();
 await c.switchOverlayMode('dynamic');await c.setTimelineIntervalMinutes(15);await c.switchOverlayMode('depth');await c.switchOverlayMode('dynamic');await c.setTimelineIntervalMinutes(1440);
 hold.resolve();await pending;
 assert.equal(c.currentDataMode,'observed');assert.equal(c.currentOverlayMode,'dynamic');assert.equal(c.currentTimelineIntervalMinutes,1440);
 assert.ok(c.currentSeriesHours.length,`${stage}: successful history must become playable`);assert.equal(c.currentSeriesHours.length,1,`${stage}: committed frames must use the latest daily cadence`);
 assert.equal(renders.at(-1).overlay,'dynamic');assert.equal(renders.at(-1).interval,1440);
 assert.equal(c.loadObservedDay.pendingSelection,null);assert.equal(c.switchDataMode.pendingObservedSelectionGeneration,null);cases++;
}
for(const nextMode of ['forecast','return-interval'])for(const outcome of ['success','failure']){
 const {c,hold,renders}=setup();const pending=c.switchDataMode('observed');await tick();await c.switchOverlayMode('dynamic');
 await c.switchDataMode(nextMode);const selected=c.currentSeriesHours;
 if(outcome==='success')hold.resolve();else hold.reject(Error('Obsolete history failure'));await pending;
 assert.equal(c.currentDataMode,nextMode);assert.equal(c.currentSeriesHours,selected);assert.equal(renders.at(-1).mode,nextMode);cases++;
}
{
 const {c,hold,messages}=setup();const pending=c.switchDataMode('observed');await tick();await c.switchOverlayMode('dynamic');hold.reject(Error('Active history unavailable'));await pending;
 assert.equal(c.currentDataMode,'observed');assert.equal(c.currentSeriesHours.length,0);assert.equal(c.currentFloodLayer,null);assert.ok(messages.some(message=>message.includes('Observed data could not load')),'Overlay change must not swallow active failure');cases++;
}
for(const outcome of ['success','failure']){
 const {c,hold,renders}=setup('detail');c.currentDataMode='observed';c.currentViewType='observed-day';
 const pending=c.loadObservedDay('2026-09-26');await tick();await c.switchOverlayMode('dynamic');await c.setTimelineIntervalMinutes(15);
 if(outcome==='success')hold.resolve();else hold.reject(Error('Active detail unavailable'));await pending;
 if(outcome==='success'){assert.equal(c.selectedObservedDate,'2026-09-26');assert.equal(renders.at(-1).overlay,'dynamic');assert.equal(renders.at(-1).interval,15);}else assert.equal(c.currentFloodLayer,null);
 assert.equal(c.loadObservedDay.pendingSelection,null);cases++;
}
{
 const {c,hold}=setup();const pending=c.switchDataMode('observed');await tick();await c.loadObservedDay('2026-09-26');const selected=c.currentSeriesHours;hold.resolve();await pending;
 assert.equal(c.selectedObservedDate,'2026-09-26');assert.equal(c.currentSeriesHours,selected,'A late default-day load must not overwrite the explicit day');cases++;
}
console.log(`${cases} deep core observed loading, overlay/interval, ownership and failure cases passed.`);
