import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const extract = name => {
  const source = html.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    }`))?.[0];
  assert.ok(source, `${name} must exist`);
  return source;
};
let physics = false, daily = false, writes = 0, markup = '';
const nodes = Object.fromEntries(['legendList','legendTitle','legendSub','legendNote','legendDock'].map(id => [id, {
  dataset: {}, childElementCount: 0, textContent: '', querySelector: () => null,
  appendChild() { this.childElementCount++; }
}]));
Object.defineProperty(nodes.legendList, 'innerHTML', {
  get: () => markup,
  set(value) { markup = value; writes++; this.childElementCount = value.trim() ? 1 : 0; }
});
const context = vm.createContext({
  document: {getElementById: id => nodes[id], body: {classList: {contains: () => daily}}, createElement: () => ({})},
  currentOverlayMode: 'depth', DEPTH_LEGEND: [], DYNAMIC_LEGEND: [{label:'Minor flooding', color:'#ff0'}],
  physicsForecastApplies: () => physics
});
vm.runInContext(extract('renderLegend'), context);
context.renderLegend();
assert.match(markup, /Uncertain/);
const initialWrites = writes;
context.renderLegend();
assert.equal(writes, initialWrites, 'An unchanged legend must preserve its DOM');
physics = true;
context.renderLegend();
assert.match(markup, /Current Time/);
assert.doesNotMatch(markup, /Uncertain/);
daily = true;
context.renderLegend();
assert.match(markup, /Daily Max/);
assert.match(markup, /each cell's greatest modeled depth/);
daily = false;
context.renderLegend();
assert.match(markup, /Current Time/);
physics = false;
context.renderLegend();
assert.match(markup, /Uncertain/);
context.currentOverlayMode = 'dynamic';
context.renderLegend();
assert.equal(nodes.legendTitle.textContent, 'Flood Stages');
assert.match(markup, /stage-legend-green/);
assert.match(markup, /Minor<.*Moderate<.*Major</);
assert.doesNotMatch(markup, /legend-row/);
physics = true;
context.renderLegend();
assert.doesNotMatch(markup, /stage-legend-green/);
physics = false;
context.currentOverlayMode = 'depth';
context.renderLegend();
assert.equal(nodes.legendTitle.textContent, 'Flood Depth');
assert.match(markup, /Uncertain/);

// The standalone app must supply the metadata previously supplied by CupaJoe.
const slider = {min:'0', max:'23', attributes:{}, setAttribute(name,value) { this.attributes[name] = value; }};
nodes.hourSlider = slider;
nodes.timelineBubble = {textContent:'Fri 9 · 4 PM EDT1.71 ft', querySelectorAll: () => [{textContent:'Fri 9 · 4 PM EDT'}, {textContent:'1.71 ft'}]};
context.currentSeriesHours = [{},{}];
context.currentDataMode = 'forecast';
vm.runInContext(extract('updateTimelineAccessibility'), context);
context.updateTimelineAccessibility();
assert.equal(slider.attributes['aria-valuetext'], 'Fri 9 · 4 PM EDT 1.71 ft');
assert.equal(slider.attributes['aria-label'], 'Flood forecast time');
assert.equal(slider.disabled, false);
context.currentDataMode = 'observed'; slider.max = '0';
context.updateTimelineAccessibility();
assert.equal(slider.attributes['aria-label'], 'Observed flood time');
assert.equal(slider.disabled, true, 'A single crest must not expose a usable slider');
context.currentDataMode = 'return-interval'; slider.max = '23';
context.updateTimelineAccessibility();
assert.equal(slider.attributes['aria-label'], 'Modeled flood time');
context.currentSeriesHours = [];
context.updateTimelineAccessibility();
assert.equal(slider.disabled, true);
console.log('Passed legend model/interval transitions, stable markup, and app-owned timeline accessibility');
