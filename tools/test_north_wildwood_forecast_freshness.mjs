import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const runtime = name => fs.readFileSync(new URL('app/runtime/' + name + '.js', import.meta.url), 'utf8');
const forecast = runtime('21-forecast-and-observed-loading').split('    async function loadForecast(')[0];
const statusSource = runtime('18-flood-frame-rendering').split('    async function decodeFloodFrameImage(')[0];
const cycle = Date.parse('2026-11-08T06:00:00Z');
const cutoff = cycle + 72 * 60 * 60 * 1000;
const end = Date.parse('2026-11-12T05:00:00Z');
const data = {petssCycleUtc: new Date(cycle).toISOString(), forecastEndUtc: new Date(end).toISOString()};
let now = cutoff;
const status = {dataset:{}, style:{setProperty(){}}, textContent:'', hidden:true};
const timers = new Map();
const context = vm.createContext({
  Date: {parse:Date.parse, now:()=>now}, currentDataMode:'forecast', forecastData:data, currentFloodLayer:null,
  document: {getElementById:id=>id==='floodFrameStatus'?status:null},
  formatFixedESTFromUtc(value, includeYear) {assert.equal(includeYear,true);return value;},
  window: {
    setTimeout(fn, delay) {const token={};timers.set(token,{fn, time:now+delay});return token;},
    clearTimeout(token) {timers.delete(token);}
  }
});
vm.runInContext(forecast+'\n'+statusSource, context);

context.scheduleForecastFreshnessNotice();
assert.equal(status.hidden,true);
assert.equal([...timers.values()][0].time,cutoff+1);
function advance(time) {
  now=time;
  for (const [token, timer] of [...timers]) {
    if(timer.time<=now) {timers.delete(token);timer.fn();}
  }
}
advance(cutoff+1);
assert.match(status.textContent,/Forecast from 2026-11-08T06:00:00.000Z is over 72 hours old/);
assert.equal([...timers.values()][0].time,end);
context.setFloodFrameStatus('Frame retry in progress.','error');
assert.match(status.textContent,/over 72 hours old.*Frame retry in progress/);
assert.equal(status.dataset.state,'error');
advance(end);
assert.match(status.textContent,/Forecast expired 2026-11-12T05:00:00.000Z/);
assert.equal(timers.size,0);
context.setFloodFrameStatus('', 'info');
assert.match(status.textContent,/Forecast expired/);
context.currentDataMode='observed';
context.scheduleForecastFreshnessNotice();
assert.equal(status.hidden,true);
assert.equal(timers.size,0);
context.currentDataMode='return-interval';
context.scheduleForecastFreshnessNotice();
assert.equal(status.hidden,true);
assert.equal(context.getForecastFreshness({},now).state,null);
context.forecastData={petssCycleUtc:new Date(now).toISOString(), forecastEndUtc:new Date(now+3600000).toISOString()};
context.currentDataMode='forecast';
context.currentFloodLayer={_floodmapperFrame:{forecastSource:data}};
context.scheduleForecastFreshnessNotice();
assert.match(status.textContent,/Forecast expired/, 'A fresh payload must wait for its rendered image');
context.currentFloodLayer={_floodmapperFrame:{forecastSource:context.forecastData}};
context.scheduleForecastFreshnessNotice();
assert.equal(status.hidden,true);
assert.equal([...timers.values()][0].time,now+3600000);
console.log('Forecast freshness passed: exact age and expiry, existing status, alternate modes, and a newer forecast.');
