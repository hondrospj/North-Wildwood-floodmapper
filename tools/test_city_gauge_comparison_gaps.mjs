// Exercise the shipped chart functions and record both gauge canvas paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../city-gauge/index.html', import.meta.url), 'utf8');
const functions = ['lowerBound', 'comparisonSeries', 'axisLabel', 'chartSeries', 'draw'].map(name => {
  const start = source.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const next = source.indexOf('\n    function ', start + 1);
  return source.slice(start, next);
}).join('\n');
const quarterHour = 15 * 60 * 1000, gap = 145 * 60 * 60 * 1000;
const before = Array.from({length: 24}, (_, i) => ({time: i * quarterHour, stone: 2 + i / 100}));
const gapStart = before.at(-1).time, gapEnd = gapStart + gap;
const after = before.map((p, i) => ({time: gapEnd + i * quarterHour, stone: p.stone}));
const comparisonPoints = [...before, ...after], end = comparisonPoints.at(-1).time;
const paths = [];
const canvasContext = new Proxy({
  strokeStyle: '', beginPath() { this.path = []; },
  moveTo(x, y) { this.path.push({move: true, x, y}); },
  lineTo(x, y) { this.path.push({move: false, x, y}); },
  stroke() {
    if (['#7654a8', '#0d5b7b'].includes(this.strokeStyle)) {
      paths.push({color: this.strokeStyle, points: this.path});
    }
  },
}, {get(target, key) { return key in target ? target[key] : () => {}; }});
const canvas = {parentElement: {getBoundingClientRect: () => ({width: 1000, height: 430})},
  style: {}, getContext: () => canvasContext, setAttribute() {}};
const state = {comparisonPoints, chartPoints: comparisonPoints.map((p, seq) =>
  ({time: p.time, value: p.stone, valid: true, seq})), viewStart: 0, viewEnd: end};
const context = vm.createContext({state, GAP_MS: 30 * 60 * 1000, devicePixelRatio: 1,
  FLOOD: {minor: 3.25, moderate: 4.25, major: 5.25}, Intl, Date, $: () => canvas});
vm.runInContext(functions, context);
for (const width of [1000, 2]) {
  const series = context.comparisonSeries(0, end, width);
  let previous = null, separated = false;
  for (const point of series) {
    if (!point) { previous = null; separated = true; continue; }
    assert.ok(!previous || previous.time > gapStart || point.time < gapEnd,
      `Comparison series must separate a 145-hour outage at width ${width}`);
    previous = point;
  }
  assert.ok(separated, `Outage requires a path separator at width ${width}`);
}
function assertCanvasSegments(color, expected, message) {
  const path = paths.find(path => path.color === color)?.points;
  assert.ok(path?.some(point => !point.move), 'Expected a drawn line');
  assert.equal(path.filter(point => point.move).length, expected, message);
}

context.draw();
assertCanvasSegments('#7654a8', 2, 'Stone Harbor canvas path must restart after the outage');
assertCanvasSegments('#0d5b7b', 2, 'North Wildwood canvas path must restart after the outage');

const samplesPerSide = 900;
state.chartPoints = Array.from({length: samplesPerSide * 2}, (_, seq) => ({
  seq,
  time: seq * quarterHour + (seq < samplesPerSide ? 0 : gap),
  value: seq % 4,
  valid: seq !== 60,
}));
state.comparisonPoints = [];
state.viewEnd = state.chartPoints.at(-1).time;
for (const width of [1000, 120]) {
  canvas.parentElement.getBoundingClientRect = () => ({width, height: 430});
  paths.length = 0;
  context.draw();
  assertCanvasSegments('#0d5b7b', 3,
    `North Wildwood must break only at the outage and the flagged reading at width ${width}`);
}

console.log('Both gauge chart paths preserve real gaps through rendering and decimation');
