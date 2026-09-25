// Regression: the phone day navigator and native range must cover the same day.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const nyDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const sameDay=(a,b)=>nyDay.format(new Date(a.timeUtc))===nyDay.format(new Date(b.timeUtc));
const context=vm.createContext({currentSeriesHours:[],currentHourIndex:0,mobile:true,
 isMobileTimeline:()=>context.mobile,sameEntryESTDay:sameDay,
 getStageValue:e=>e?.level??1,getTimelineHourColor:e=>e.color||'green'});
for(const name of ['getTimelineSliderBounds','buildTimelineGroupGradient']) {
 const source=html.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    }`))?.[0];
 assert.ok(source,name);vm.runInContext(source,context);
}
for(const minutes of [60,15]) {
 const first=Date.parse('2026-09-25T21:00:00Z');
 context.currentSeriesHours=Array.from({length:84*60/minutes+1},(_,i)=>({timeUtc:new Date(first+i*minutes*60000).toISOString()}));
 for(let i=0;i<context.currentSeriesHours.length;i++) {
  context.currentHourIndex=i;
  const {start,end,selected}=context.getTimelineSliderBounds();
  assert.equal(selected,i);assert.ok(start<=i&&i<=end);
  for(let j=start;j<=end;j++)assert.ok(sameDay(context.currentSeriesHours[i],context.currentSeriesHours[j]));
  if(start)assert.ok(!sameDay(context.currentSeriesHours[i],context.currentSeriesHours[start-1]));
  if(end<context.currentSeriesHours.length-1)assert.ok(!sameDay(context.currentSeriesHours[i],context.currentSeriesHours[end+1]));
 }
 // Resize out of phone mode restores the whole horizon without moving time.
 context.mobile=false;
 const whole=context.getTimelineSliderBounds();
 assert.equal(whole.start,0);assert.equal(whole.end,context.currentSeriesHours.length-1);
 assert.equal(whole.selected,context.currentHourIndex);
 context.mobile=true;
}
// Daily maxima and the first/last single-frame day must stay reachable via arrows.
context.currentSeriesHours=['2026-09-26T00:00Z','2026-09-26T13:00Z','2026-09-27T14:00Z'].map(timeUtc=>({timeUtc}));
for(let i=0;i<3;i++){context.currentHourIndex=i;const b=context.getTimelineSliderBounds();assert.equal(b.start,i);assert.equal(b.end,i);}
context.currentSeriesHours=[];context.currentHourIndex=99;
assert.equal(context.getTimelineSliderBounds().selected,0);
// The color transition is centered between samples, including partial days.
context.currentSeriesHours=[{color:'red'},{color:'green'},{color:'gold'},{color:'purple'}];
assert.equal(context.buildTimelineGroupGradient(1,2,true),'linear-gradient(90deg, green 0.000%, green 50.000%, gold 50.000%, gold 100.000%)');
assert.equal(context.buildTimelineGroupGradient(2,2,true),'linear-gradient(90deg, gold, gold)');
console.log('Passed mobile day bounds, hourly/quarter-hour endpoints, daily peaks, resize retention, and gradient alignment');
