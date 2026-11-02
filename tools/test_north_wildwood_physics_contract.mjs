import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = ['01-physics-manifests', '26-depth-queries']
  .map(name => fs.readFileSync(new URL(`./app/runtime/${name}.js`, import.meta.url), 'utf8')).join('\n');
function extract(name) {
  const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}
const model = JSON.parse(fs.readFileSync(new URL('../model/config/north_wildwood.json', import.meta.url)));
const pointer = vm.createContext({URL, Date, Number,
  forecastData: {petssCycleUtc: '2026-11-02T06:00:00Z'},
  PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE: `https://example.test/${model.bunny.remoteRoot}/${model.bunny.cyclePointerNameTemplate}`,
  PHYSICS_FORECAST_POINTER_URL: 'https://example.test/current.json.png',
  window: {location: {href: 'https://example.test/index.html'}}});
vm.runInContext(extract('physicsCycleIdFromUtc') + '\n' + extract('physicsPointerUrl'), pointer);
for (const [input, expected] of [
  ['2026-11-02T06:00:00Z', '20261102T0600Z'],
  ['2026-11-02T06:00:00.000Z', '20261102T0600Z'],
  ['2026-11-02T06:00:00.000000Z', '20261102T0600Z'],
  ['2026-11-02T06:00Z', '20261102T0600Z'],
  ['2026-11-02T01:00:00-05:00', '20261102T0600Z'],
  ['2026-11-01T23:00:00-01:00', '20261102T0000Z'],
  ['2026-11-02T12:00:00+06:00', '20261102T0600Z'],
  ['2026-11-02T11:30:00+05:30', '20261102T0600Z'],
  ['2024-02-29T00:00:00Z', '20240229T0000Z']
]) {
  pointer.forecastData.petssCycleUtc = input;
  const actual = new URL(pointer.physicsPointerUrl());
  assert.equal(decodeURI(actual.pathname), `/${model.bunny.remoteRoot}/${model.bunny.cyclePointerNameTemplate.replace('{cycleId}', expected)}`);
}
for (const input of [null, {}, 0, '', 'bad', '20261102T0600Z', '2026-11-02',
  '2026-11-02T06:00:00', '2026-02-30T06:00:00Z', '2026-02-29T06:00:00Z',
  '2026-13-01T06:00:00Z', '2026-11-02T24:00:00Z', '2026-11-02T06:60:00Z',
  '2026-11-02T06:00:60Z', '2026-11-02T06:00:00+24:00',
  '2026-11-02T06:00:00+00:60', '2026-11-02T06:15:00Z',
  '2026-11-02T06:00:01Z', '2026-11-02T06:00:00.001Z',
  '2026-11-02T06:00:00.0001Z', '9999-12-31T23:00:00-01:00']) {
  pointer.forecastData.petssCycleUtc = input;
  assert.equal(pointer.physicsCycleIdFromUtc(input), '', String(input));
  assert.equal(new URL(pointer.physicsPointerUrl()).pathname, '/current.json.png');
}
pointer.PHYSICS_FORECAST_POINTER_URL = null;
assert.equal(pointer.physicsPointerUrl(), '');

const grid = vm.createContext({Number, Math});
vm.runInContext(extract('latLngToPhysicsQueryPixel'), grid);
const manifest = {status: 'complete', schema: 'north-wildwood-physics-forecast-v2',
  image: {width: 100, height: 100, crs: 'EPSG:3857', coordinateSystem: 'web-mercator'},
  boundsWgs84: [[30, -75], [60, -74]]};
const mercY = latitude => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
const fromMercY = value => (2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180 / Math.PI;
for (const [x, y] of [[0, 0], [99, 0], [0, 99], [99, 99], [50, 50]]) {
  const lat = fromMercY(mercY(60) + (mercY(30) - mercY(60)) * (y + .5) / 100);
  const lon = -75 + (x + .5) / 100;
  const actual = grid.latLngToPhysicsQueryPixel(manifest, lat, lon, 100, 100);
  assert.deepEqual({...actual}, {x, y}, 'Query must use the same projected pixel as the map image');
}
for (const [lat, lon, width, height] of [[NaN, -74.5, 100, 100], [45, Infinity, 100, 100],
  [30, -74.5, 100, 100], [45, -74, 100, 100], [61, -74.5, 100, 100], [45, -74.5, 0, 100]]) {
  assert.equal(grid.latLngToPhysicsQueryPixel(manifest, lat, lon, width, height), null);
}
for (const invalid of [
  {...manifest, schema: 'north-wildwood-physics-forecast-v1'},
  {...manifest, image: {...manifest.image, crs: 'EPSG:6347'}},
  {...manifest, image: {...manifest.image, coordinateSystem: 'geographic'}},
  {...manifest, boundsWgs84: [[60, -75], [30, -74]]},
  {...manifest, boundsWgs84: [[30, -75], [90, -74]]}
]) assert.equal(grid.latLngToPhysicsQueryPixel(invalid, 45, -74.5, 100, 100), null);

let activeManifest = manifest, imageLoads = 0, drawn = null;
const image = {naturalWidth: 100, naturalHeight: 100};
const sample = vm.createContext({Number, Math, Promise,
  getActivePhysicsManifest: () => activeManifest,
  preloadPhysicsQueryImage: async () => {imageLoads++; return image;},
  document: {createElement: () => ({getContext: () => ({
    drawImage: (_image, x, y) => {drawn = {x, y};},
    getImageData: () => ({data: [1, 44, 1, 255]})
  })})}});
vm.runInContext(extract('latLngToPhysicsQueryPixel') + '\n' + extract('samplePhysicsDepth'), sample);
const middleLat = fromMercY((mercY(60) + mercY(30)) / 2);
const sampled = await sample.samplePhysicsDepth({query: {url: 'query.png'}}, middleLat, -74.495);
assert.deepEqual({...sampled}, {wet: true, depthM: .3});
assert.deepEqual(drawn, {x: 50, y: 50});
activeManifest = {...manifest, schema: 'north-wildwood-physics-forecast-v1'};
assert.equal(await sample.samplePhysicsDepth({query: {url: 'old.png'}}, 45, -74.5), null);
assert.equal(imageLoads, 1, 'Unsupported native grids must fail before image loading');
activeManifest = manifest;
image.naturalWidth = 99;
assert.equal(await sample.samplePhysicsDepth({query: {url: 'wrong-shape.png'}}, 45, -74.5), null);

for (const invalid of [{...manifest, schema: 'north-wildwood-physics-forecast-v1'},
  {...manifest, image: {...manifest.image, crs: 'EPSG:6347'}}]) {
  const c = vm.createContext({Promise, URL, Map, archiveGeneration: 1,
    PHYSICS_FORECAST_POINTER_URL: 'pointer.json', PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE: '',
    physicsForecastManifests: {}, physicsQueryImageCache: new Map(),
    physicsPointerUrl: () => 'https://example.test/pointer.json',
    getActivePhysicsManifest: () => null, hydratePhysicsManifest: value => value,
    fetchJson: async url => url.endsWith('pointer.json')
      ? {status: 'complete', manifestUrls: {mean: 'manifest.json'}}
      : {...invalid, frames: [{visible: {path: 'v'}, impact: {path: 'i'}, query: {path: 'q'}}],
        dailyMaximums: [{visible: {path: 'v'}, impact: {path: 'i'}, query: {path: 'q'}}]}});
  vm.runInContext(extract('loadPhysicsForecast'), c);
  await assert.rejects(c.loadPhysicsForecast(), /manifest is invalid/);
  assert.deepEqual(Object.keys(c.physicsForecastManifests), []);
}

// The GDAL regression provides independently projected cell centers so this
// exact browser helper is also checked against real raster georeferencing.
const fixtureFlag = process.argv.indexOf('--grid-fixture');
if (fixtureFlag >= 0) {
  const fixture = JSON.parse(fs.readFileSync(process.argv[fixtureFlag + 1], 'utf8'));
  for (const point of fixture.points) {
    const actual = grid.latLngToPhysicsQueryPixel(fixture.manifest, point.lat, point.lon,
      fixture.manifest.image.width, fixture.manifest.image.height);
    assert.deepEqual({...actual}, {x: point.x, y: point.y});
  }
}
console.log('PASS physics producer pointer names, strict dates, v2 grid rejection, Mercator query and depth sampling.');
