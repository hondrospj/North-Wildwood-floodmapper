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
