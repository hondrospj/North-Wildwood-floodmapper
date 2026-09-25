// Ensure every UI selection consumes the already adjusted scheduled product once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const forecast = JSON.parse(fs.readFileSync(new URL('../forecast.json', import.meta.url), 'utf8'));
const body = html.match(/    function getForecastScenarioHours\([\s\S]*?\n    }/)?.[0];
assert.ok(body);
const context = vm.createContext({forecastData:forecast,currentForecastScenario:'mean'});
vm.runInContext(body,context);
const select=context.getForecastScenarioHours;
for(const key of ['lowEnd','mean','highEnd']) {
  assert.equal(select(forecast,key),forecast.scenarioForecasts[key].hours);
  assert.ok(select(forecast,key).length>12);
}
const first=select()[0],raw=forecast.forecasts.lowEnd.hours.find(h=>h.timeUtc===first.timeUtc);
assert.ok(Math.abs(first.mllwStageFt-(raw.rawPetssValue-.25))<=.005001);
assert.equal(select()[0].mllwStageFt,first.mllwStageFt,'Repeated reads must not subtract again');
for(const missing of [null,{}, {...forecast,scenarioVersion:undefined},
  {...forecast,scenarioAdjustmentFt:0}, {...forecast,scenarioForecasts:{}},
  {...forecast,scenarioForecasts:{mean:{hours:null}}}]) {
  assert.equal(select(missing,'mean').length,0,'Older or missing settings must not silently substitute another curve');
}
for(const label of ['Minimum','Mean','Maximum'])assert.ok(html.includes(`label: "${label}", percentile: ""`));
console.log('Passed adjusted scenario selection, missing/old-source cases, one-time adjustment, and neutral display labels');
