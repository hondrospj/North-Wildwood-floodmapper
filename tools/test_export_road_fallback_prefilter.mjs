import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/export-road-labels.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const { layout, overlaps } = context.window.NORTH_WILDWOOD_EXPORT_ROADS.geometry;
const project = ([x, y]) => ({ x, y });
const measure = (text, size) => text.length * size * .52;
const paths = [{ name: 'Central Avenue', text: 'Central Ave', coordinates: [[100, 100], [160, 100]] }];
const original = JSON.stringify(paths);
const settings = { unit: 1, fontSize: 20, fallbackFontSize: 18, maxLabelsPerName: 1 };

assert.equal(layout(paths, project, { x: 300, y: 200 }, settings, measure).length, 0,
  'A short road cannot use an unconfigured smaller font');
const options = { ...settings, priorityFallbackSizes: [17, 16, 15, 14, 13.25, 13] };
const labels = layout(paths, project, { x: 300, y: 200 }, options, measure);
assert.equal(labels.length, 1, 'The prefilter must allow the same smaller priority fonts as final placement');
assert.equal(labels[0].text, 'Central');
assert.equal(labels[0].fontSize, 15, 'Keep the largest configured font that fits');
const fixedCanvasMeasure = text => measure(text, settings.fontSize * settings.unit);
const canvasLabels = layout(paths, project, { x: 300, y: 200 }, options, fixedCanvasMeasure);
assert.deepEqual(JSON.parse(JSON.stringify(canvasLabels)), JSON.parse(JSON.stringify(labels)),
  'Canvas measurements at the configured base font must use the same fallback scaling as final placement');
assert.ok(labels[0].box.every(p => p.x >= 0 && p.y >= 0 && p.x <= 300 && p.y <= 200));
assert.equal(JSON.stringify(paths), original, 'The source road geometry must stay unchanged');
const blocked = layout(paths, project, { x: 300, y: 200 }, { ...options, obstacles: [labels[0].box] }, measure);
for (const label of blocked) assert.equal(overlaps(label.box, labels[0].box), false,
  'A fallback must still respect shield collision rectangles');
const scaled = layout(paths.map(path => ({ ...path, coordinates: path.coordinates.map(([x, y]) => [2 * x, 2 * y]) })),
  project, { x: 600, y: 400 }, { ...options, unit: 2 }, measure);
assert.equal(scaled.length, 1);
assert.equal(scaled[0].fontSize, 30);
assert.equal(scaled[0].x, labels[0].x * 2);
assert.equal(scaled[0].y, labels[0].y * 2);
const scaledCanvasLabels = layout(paths.map(path => ({ ...path, coordinates: path.coordinates.map(([x, y]) => [2 * x, 2 * y]) })),
  project, { x: 600, y: 400 }, { ...options, unit: 2 }, text => measure(text, settings.fontSize * 2));
assert.deepEqual(JSON.parse(JSON.stringify(scaledCanvasLabels)), JSON.parse(JSON.stringify(scaled)),
  'The fixed-font Canvas measurement also scales exactly once for a 2x output');
console.log('Priority road fallback prefilter, largest fitting font, collision, scaling, and geometry checks passed');
