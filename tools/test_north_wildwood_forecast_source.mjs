// The default map must consume the published lower NOAA curve, not derived p25.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const forecast = JSON.parse(fs.readFileSync(new URL('../forecast.json', import.meta.url), 'utf8'));
const body = html.match(/    function getForecastScenarioHours\([\s\S]*?\n    }/)?.[0];
assert.ok(body, 'Forecast selector is present');
const context = vm.createContext({forecastData: forecast, currentForecastScenario: 'mean'});
vm.runInContext(body, context);
const select = context.getForecastScenarioHours;
assert.equal(select(), forecast.forecasts.lowEnd.hours);
assert.notEqual(select(), forecast.scenarioForecasts.mean.hours);
assert.ok(select().length > 12);
for (const key of ['lowEnd', 'highEnd']) {
  assert.equal(select(forecast, key), forecast.scenarioForecasts[key].hours);
}
for (const missing of [null, {}, {scenarioForecasts: forecast.scenarioForecasts},
  {forecasts: {lowEnd: {product: 'mean', hours: forecast.forecasts.mean.hours}}},
  {forecasts: {lowEnd: {product: 'e90', hours: null}}}]) {
  assert.equal(select(missing, 'mean').length, 0, 'Unavailable TWL90p must not fall back to another curve');
}
assert.match(html, /mean: \{ label: "Forecast", percentile: "NOAA forecast"/);
console.log(`Passed exact TWL90p selection for ${select().length} hours and missing-source cases`);
