import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = ['01-physics-manifests', '21-forecast-and-observed-loading', '23-refresh-and-playback']
  .map(name => fs.readFileSync(new URL(`./app/runtime/${name}.js`, import.meta.url), 'utf8')).join('\n');
function extract(name) {
  const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^\\n]*\\) \\{\\n.*?^    \\}`, 'ms'));
  assert.ok(match, name);
  return match[0];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const pointer = cycle => ({status: 'complete', cycleId: cycle, manifestUrls: {mean: `${cycle}.json`}});
const manifest = cycle => ({status: 'complete', schema: 'north-wildwood-physics-forecast-v1',
  cycleId: cycle, scenario: 'mean', boundsWgs84: [0, 0, 1, 1],
  frames: [{visible: {path: 'visible.png'}, impact: {path: 'impact.png'}, query: {path: 'query.png'}}],
  dailyMaximums: [{visible: {path: 'daily.png'}, impact: {path: 'daily-impact.png'}, query: {path: 'daily-query.png'}}]});
let cases = 0;

for (const phase of ['pointer', 'manifest']) {
  const held = deferred();
  const c = vm.createContext({URL, Promise, Map, console,
    archiveGeneration: 1, PHYSICS_FORECAST_POINTER_URL: 'pointer', PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE: '',
    physicsForecastManifests: {}, physicsQueryImageCache: new Map(),
    physicsPointerUrl: () => `https://example.test/${c.archiveGeneration}/pointer.json`,
    getActivePhysicsManifest: () => c.physicsForecastManifests.mean,
    hydratePhysicsManifest: value => value,
    async fetchJson(url) {
      if (url.endsWith('/1/pointer.json')) return phase === 'pointer' ? held.promise : pointer('old');
      if (url.endsWith('/1/old.json')) return phase === 'pointer' ? manifest('old') : held.promise;
      if (url.endsWith('/2/pointer.json')) return pointer('new');
      if (url.endsWith('/2/new.json')) return manifest('new');
      throw Error(url);
    }
  });
  vm.runInContext(extract('loadPhysicsForecast'), c);
  const old = c.loadPhysicsForecast();
  await tick();
  c.archiveGeneration++;
  await c.loadPhysicsForecast(true);
  const fresh = c.physicsForecastManifests;
  const freshCache = c.physicsQueryImageCache;
  assert.equal(fresh.mean.cycleId, 'new');
  held.resolve(phase === 'pointer' ? pointer('old') : manifest('old'));
  await assert.rejects(old, /superseded by Reload/);
  assert.equal(c.physicsForecastManifests, fresh, `Old ${phase} must not replace the latest physics forecast`);
  assert.equal(c.physicsQueryImageCache, freshCache, 'An old request must not clear current query images');
  assert.equal(await c.loadPhysicsForecast(), fresh.mean, 'A healthy current cache remains reusable');
  cases++;
}

{
  const held = deferred(), warnings = [];
  const c = vm.createContext({Promise, Map, console: {warn: message => warnings.push(message)},
    archiveGeneration: 1, selectionGeneration: 1, lastRenderToken: 1,
    forecastData: {}, physicsForecastManifests: {},
    loadPhysicsForecast: () => held.promise,
  });
  vm.runInContext(extract('loadForecast'), c);
  const old = c.loadForecast(null, {generation: 1});
  c.archiveGeneration++; c.selectionGeneration++; c.lastRenderToken++;
  const fresh = {mean: manifest('new')}; c.physicsForecastManifests = fresh;
  held.reject(Error('Old pointer failed'));
  await old;
  assert.equal(c.physicsForecastManifests, fresh, 'An old caller catch must not clear newer manifests');
  assert.deepEqual(warnings, [], 'An obsolete failure must not log a misleading current fallback');
  cases++;
}

for (const outcome of ['success', 'failure']) {
  const held = deferred(), starts = [], warnings = [];
  const c = vm.createContext({Promise, console: {warn: value => warnings.push(value)},
    archiveGeneration: 1, document: {body: {dataset: {initialFloodFrame: 'ready'}}},
    window: {requestIdleCallback(fn) {starts.push(fn);}}, loadPhysicsForecast: () => held.promise,
  });
  vm.runInContext(extract('scheduleForecastCatalogWarmup'), c);
  c.scheduleForecastCatalogWarmup();
  const old = starts.shift()();
  c.archiveGeneration++;
  c.document.body.dataset.forecastCatalog = 'ready';
  if (outcome === 'success') held.resolve(); else held.reject(Error('Old warmup failed'));
  await old;
  assert.equal(c.document.body.dataset.forecastCatalog, 'ready', 'Old warmup must not change current catalog state');
  assert.deepEqual(warnings, []);
  // Even an idle callback that has not started is cancelled by Reload.
  c.scheduleForecastCatalogWarmup();
  c.archiveGeneration++;
  c.document.body.dataset.forecastCatalog = 'waiting';
  await starts.shift()();
  assert.equal(c.document.body.dataset.forecastCatalog, 'waiting');
  cases++;
}
console.log(`${cases} physics-catalog Reload-race regression cases passed.`);
