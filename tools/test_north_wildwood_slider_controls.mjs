import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let nextId = 0;
const frames = new Map();
const renders = [];
const context = vm.createContext({
  currentSeriesHours: Array.from({length:100}, (_,i) => ({i})), currentHourIndex:0,
  requestAnimationFrame: fn => { frames.set(++nextId,fn); return nextId; },
  cancelAnimationFrame: id => frames.delete(id),
  stopPlayback: () => {}, toast: message => {throw Error(message);},
  renderHour: async index => {context.cancelTimelineSelection(); context.currentHourIndex=index; renders.push(index);}
});
vm.runInContext('let timelineSelectionFrame=0; let pendingTimelineSelection=null;',context);
for(const name of ['cancelTimelineSelection','flushTimelineSelection','queueTimelineSelection','stepTimeline']) {
  const code = html.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    }`))?.[0];
  assert.ok(code,name);vm.runInContext(code,context);
}
const nextFrame=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
// Fast scrubbing renders only the newest position, once per browser frame.
for(let i=1;i<40;i++) context.queueTimelineSelection(i);
assert.equal(frames.size,1); assert.equal(renders.length,0);
nextFrame(); assert.deepEqual(renders,[39]);
// Release must commit immediately and must not leave a stale callback behind.
context.queueTimelineSelection(45);context.queueTimelineSelection(49,true);
assert.deepEqual(renders,[39,49]); assert.equal(frames.size,0);
context.queueTimelineSelection(49,true);assert.equal(renders.length,2);
// A day/data navigation supersedes any queued drag.
context.queueTimelineSelection(50); context.cancelTimelineSelection();nextFrame();assert.equal(renders.length,2);
context.queueTimelineSelection(55);context.currentSeriesHours=[...context.currentSeriesHours];nextFrame();assert.equal(renders.length,2);
// Precision stepping starts at the pending drag position and crosses midnight.
context.queueTimelineSelection(71);context.stepTimeline(1);assert.equal(renders.at(-1),72);assert.equal(frames.size,0);
context.currentHourIndex=0;context.stepTimeline(-1);assert.equal(renders.length,3);
context.currentHourIndex=99;context.stepTimeline(1);assert.equal(renders.length,3);
context.currentHourIndex=23;context.stepTimeline(1);assert.equal(renders.at(-1),24);
context.stepTimeline(-1);assert.equal(renders.at(-1),23);
context.queueTimelineSelection(NaN,true);assert.equal(renders.length,5);
context.currentSeriesHours=[];context.queueTimelineSelection(1,true);assert.equal(renders.length,5);
console.log('Passed drag coalescing, release commit, stale selection cancellation, precision stepping and endpoints');

const dayContext = vm.createContext({currentSeriesHours:[],currentHourIndex:0,
 getEntryESTDate:e=>e?.timeUtc ? new Date(e.timeUtc) : null,
 getNyParts:d=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(d).map(p=>[p.type,p.value]))
});
for(const name of ['getTimelineClockMinutes','getTimelineDaySelection']) {
 const code=html.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    }`))?.[0];assert.ok(code,name);vm.runInContext(code,dayContext);
}
for(const minutes of [15,60]) {
 const start=Date.parse('2026-10-03T21:00Z');
 dayContext.currentSeriesHours=Array.from({length:84*60/minutes+1},(_,i)=>({timeUtc:new Date(start+i*minutes*60000).toISOString()}));
 const indexOf=t=>dayContext.currentSeriesHours.findIndex(e=>e.timeUtc===new Date(t).toISOString());
 dayContext.currentHourIndex=indexOf('2026-10-04T20:00Z'); // 4 PM local
 const nextStart=indexOf('2026-10-05T04:00Z'),nextEnd=indexOf('2026-10-06T04:00Z')-1;
 assert.equal(dayContext.getTimelineDaySelection(nextStart,nextEnd),indexOf('2026-10-05T20:00Z'));
 assert.equal(dayContext.getTimelineDaySelection(0,indexOf('2026-10-04T04:00Z')-1),0); // earliest partial day starts 5 PM
 assert.equal(dayContext.getTimelineDaySelection(nextEnd+1,dayContext.currentSeriesHours.length-1),indexOf('2026-10-06T20:00Z'));
}
// Preserve wall-clock time when a DST change makes the next day 25 hours.
dayContext.currentSeriesHours=['2026-10-31T19:15Z','2026-11-01T05:15Z','2026-11-01T06:15Z','2026-11-01T20:15Z'].map(timeUtc=>({timeUtc}));dayContext.currentHourIndex=0;
assert.equal(dayContext.getTimelineDaySelection(1,3),3);
// Modeled storms use their relative day; unknown crest times are not invented.
dayContext.currentSeriesHours=[{returnIntervalYears:100,offsetHours:-15},{returnIntervalYears:100,offsetHours:0},{returnIntervalYears:100,offsetHours:9},{returnIntervalYears:100,offsetHours:23}];
assert.equal(dayContext.getTimelineDaySelection(1,3),2);
dayContext.currentSeriesHours=[{isDailyPeakOnly:true},{isDailyPeakOnly:true}];assert.equal(dayContext.getTimelineDaySelection(1,1),1);
console.log('Passed same-clock day navigation, partial days, DST, modeled relative time and daily crests');
