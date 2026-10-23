import { readAppSource } from './app_source.mjs';
// Ensure every UI selection consumes the scheduled product without a local subtraction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = readAppSource(new URL('../index.html', import.meta.url));
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
const before=JSON.stringify(forecast);
if(forecast.operationalForecastProduct)assert.equal(forecast.operationalForecastProduct,'TWL');
if(forecast.operationalForecastStatistic)assert.equal(forecast.operationalForecastStatistic,'ensemble_mean');
assert.equal(forecast.forecasts.mean.product,'mean');
assert.match(forecast.sourceType,/TWL/);
for(const hour of select(forecast,'mean')) {
  if(hour.sourceColumn)assert.equal(hour.sourceColumn,'TWL');
  assert.ok(Math.abs(hour.mllwStageFt-hour.rawPetssValue)<=.005001,'Mean was locally shifted');
  assert.ok(Math.abs(hour.navd88StageFt-(hour.mllwStageFt+forecast.navd88OffsetFromMllwFt))<=.005001,'Datum conversion changed');
}
assert.equal(JSON.stringify(forecast),before,'Selection mutated the issued data');
for(const missing of [null,{}, {scenarioForecasts:{mean:{hours:null}}}])assert.equal(select(missing,'mean').length,0);
const fallback={hours:[{timeUtc:'2026-10-17T00:00:00Z',sourceColumn:'TWL',mllwStageFt:4}]};
assert.equal(select(fallback,'mean'),fallback.hours);
assert.equal(select(fallback,'lowEnd').length,0,'A bound substituted the mean curve');
assert.equal(select(fallback,'highEnd').length,0,'A bound substituted the mean curve');
assert.equal(select(forecast,'missing').length,0);
console.log('Passed issued PETSS TWL mean, datum conversion, independent range selection, missing data and nonmutating reads');
