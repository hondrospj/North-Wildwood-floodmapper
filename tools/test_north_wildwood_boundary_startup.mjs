#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readAppSource } from './app_source.mjs';

const source = readAppSource(new URL('../index.html', import.meta.url));
const officialBoundary = JSON.parse(fs.readFileSync(new URL('../Boundaries/North Wildwood.geojson', import.meta.url), 'utf8'));
const townConfig = JSON.parse(fs.readFileSync(new URL("./app/town-profile.json", import.meta.url), "utf8")).config;
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(townConfig.boundary.startupFeature), officialBoundary,
  'The synchronous boundary must be the same official polygon as the published GeoJSON, not an approximation');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing browser function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) {
      const asyncPrefix = source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
      return asyncPrefix + source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated browser function ${name}`);
}

function harness() {
  const added = [];
  const removed = [];
  const drawn = [];
  const warnings = [];
  const layers = new Set();
  const counters = { clip: 0, layout: 0, export: 0, legend: 0, fetch: 0 };
  const makeLayer = (kind, geometry, options) => {
    const layer = {
      kind, geometry, options,
      addTo(map) { map.addLayer(this); return this; },
      getBounds() {
        assert.equal(kind, 'geoJSON', 'Read municipal outline bounds from the actual GeoJSON layer');
        const coordinates = geometry.geometry.type === 'Polygon'
          ? geometry.geometry.coordinates.flat()
          : geometry.geometry.coordinates.flat(2);
        return context.L.latLngBounds(coordinates.map(([lng,lat]) => [lat,lng]));
      },
    };
    drawn.push(layer);
    return layer;
  };
  const map = {
    hasLayer(layer) { return layers.has(layer); },
    addLayer(layer) { layers.add(layer); added.push(layer); return this; },
    removeLayer(layer) { layers.delete(layer); removed.push(layer); return this; },
  };
  const context = vm.createContext({
    URL, URLSearchParams,
    document: { documentElement: {}, getElementById() { return null; } },
    getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
    console: { warn(...args) { warnings.push(args); } },
    APP_BASE: new URL('https://example.test/floodmapper/'),
    TOWN_CONFIG: null,
    map,
    L: {
      polygon: (geometry, options) => makeLayer('polygon', geometry, options),
      geoJSON: (geometry, options) => makeLayer('geoJSON', geometry, options),
      latLng: (lat, lng) => ({ lat, lng }),
      latLngBounds(first, second) {
        const points = (second ? [first,second] : first).map(point =>
          Array.isArray(point) ? {lat:point[0],lng:point[1]} : point);
        return {
          points,
          isValid() { return points.length >= 2 && points.every(point => Number.isFinite(point.lat) && Number.isFinite(point.lng)); },
          getSouthWest() { return {lat:Math.min(...points.map(point => point.lat)),lng:Math.min(...points.map(point => point.lng))}; },
          getNorthEast() { return {lat:Math.max(...points.map(point => point.lat)),lng:Math.max(...points.map(point => point.lng))}; },
        };
      },
    },
    municipalBoundaryFeature: null,
    municipalBoundaryRings: [],
    municipalBoundaryLoadPromise: null,
    FALLBACK_TOWN_MASK_RING: [],
    FALLBACK_LATLNG_BOUNDS: null,
    cityBoundaryOutline: null,
    cityBoundaryMask: null,
    cityBoundaryGuide: null,
    exportMap: null,
    optionalAppUrl(value) { return value || ''; },
    scheduleMapTitleFit() {},
    syncExportBrandLogos() {},
    buildOverlayRoots(value) { return value || []; },
    buildDynamicLegend() { return []; },
    renderLegend() { counters.legend += 1; },
    updateColorBasemapClip() { counters.clip += 1; },
    syncLeftPanelLayout() { counters.layout += 1; },
    updateExportBoundaryVisibility() { counters.export += 1; },
    getBoundaryDrivenOverlayBounds() {
      throw new Error('A municipal outline must never be synthesized from raster/map bounds');
    },
    fetchMunicipalBoundaryFeature: async () => {
      counters.fetch += 1;
      throw new Error('Unexpected boundary network request');
    },
  });
  for (const name of [
    'getPrimaryMunicipalBoundaryRing', 'approximateRingArea', 'normalizeLatLngRing',
    'normalizeRingsFromGeoJsonGeometry', 'pickBoundaryFeatureFromGeoJson',
    'latLngBoundsFromRing', 'seedMunicipalBoundary', 'makeBoundaryVector',
    'createBoundaryMaskGeometry', 'updateBoundaryMaskLayer', 'isTownBoundaryEnabled',
    'applyTownBoundaryVisibility', 'updateMunicipalBoundaryLayer',
    'hasValidExportBoundaryGeometry', 'loadMunicipalBoundary', 'applyTownConfig',
  ]) {
    vm.runInContext(extractFunction(name), context);
  }
  return { context, map, layers, drawn, added, removed, counters, warnings };
}

// The first Leaflet draw already has the exact town outline and its cutout.
{
  const h = harness();
  h.context.applyTownConfig(townConfig);
  assert.deepEqual(plain(h.context.municipalBoundaryFeature), officialBoundary);
  const ring = h.context.municipalBoundaryRings[0];
  assert.ok(ring.length > 100, 'The startup outline must retain the real shoreline, not a bounding rectangle');
  assert.deepEqual(plain(ring[0]), officialBoundary.geometry.coordinates[0][0].slice().reverse());
  assert.deepEqual(plain(h.context.FALLBACK_TOWN_MASK_RING), plain(ring));
  assert.ok(h.context.FALLBACK_LATLNG_BOUNDS?.isValid());
  h.context.updateMunicipalBoundaryLayer();
  assert.equal(h.context.cityBoundaryOutline.kind, 'geoJSON');
  assert.deepEqual(plain(h.context.cityBoundaryOutline.geometry), officialBoundary);
  assert.equal(h.context.cityBoundaryMask.geometry.length, h.context.municipalBoundaryRings.length + 1);
  assert.deepEqual(plain(h.context.cityBoundaryMask.geometry.slice(1)), plain(h.context.municipalBoundaryRings));
  const drawnBeforeLoad = h.drawn.length;
  const addedBeforeLoad = h.added.length;
  const layoutBeforeLoad = h.counters.layout;
  await h.context.loadMunicipalBoundary();
  await h.context.loadMunicipalBoundary();
  assert.equal(h.counters.fetch, 0, 'The bundled official boundary requires no network request');
  assert.equal(h.drawn.length, drawnBeforeLoad, 'A seeded boundary must not be destroyed and redrawn after loading');
  assert.equal(h.added.length, addedBeforeLoad);
  assert.equal(h.removed.length, 0, 'The startup outline and mask must remain mounted');
  assert.equal(h.counters.layout, layoutBeforeLoad, 'A seeded boundary needs no late layout update');

  // Reusing the runtime for another town cannot retain North Wildwood geometry.
  h.context.applyTownConfig({ site: { name: 'No boundary' } });
  assert.equal(h.context.municipalBoundaryFeature, null);
  assert.deepEqual(plain(h.context.municipalBoundaryRings), []);
  assert.deepEqual(plain(h.context.FALLBACK_TOWN_MASK_RING), []);
  assert.equal(h.context.FALLBACK_LATLNG_BOUNDS, null);
}

// Keep both the authoritative boundary fit and the configured preview/default extents.
{
  const h = harness();
  const extent = bounds => plain([bounds.getSouthWest(),bounds.getNorthEast()]);
  h.context.TOWN_CONFIG = townConfig;
  vm.runInContext(extractFunction('getBoundaryDrivenOverlayBounds'), h.context);
  const originalExtent = extent(h.context.getBoundaryDrivenOverlayBounds());
  const {lat,lon} = townConfig.map.center;
  assert.deepEqual(originalExtent, [
    {lat:lat - 0.03,lng:lon - 0.04},
    {lat:lat + 0.03,lng:lon + 0.04},
  ], 'Unseeded startup preserves the existing configured center extent');

  h.context.seedMunicipalBoundary(officialBoundary);
  const ringExtent = extent(h.context.getBoundaryDrivenOverlayBounds());
  assert.notDeepEqual(ringExtent, originalExtent, 'The authoritative municipal bounds differ from the configured preview extent');
  assert.deepEqual(ringExtent, extent(h.context.latLngBoundsFromRing(h.context.municipalBoundaryRings[0])),
    'Default geometry callers still prefer the authoritative ring before the outline is drawn');

  h.context.updateMunicipalBoundaryLayer();
  assert.equal(h.context.cityBoundaryOutline.kind, 'geoJSON');
  assert.deepEqual(extent(h.context.getBoundaryDrivenOverlayBounds()), ringExtent,
    'Default geometry callers retain the real outline extent after Leaflet draws it');
  assert.deepEqual(extent(h.context.getBoundaryDrivenOverlayBounds(false)), originalExtent,
    'The startup preview and missing-geometry case use the configured extent');

  h.context.cityBoundaryOutline = null;
  h.context.municipalBoundaryRings = [];
  h.context.FALLBACK_TOWN_MASK_RING = [];
  assert.deepEqual(extent(h.context.getBoundaryDrivenOverlayBounds()), ringExtent,
    'Default geometry callers still use valid fallback boundary bounds');
  assert.deepEqual(extent(h.context.getBoundaryDrivenOverlayBounds(false)), originalExtent);
}

// Exercise the actual startup branch and the guarded fit shared with the live frame.
const ensureMap = extractFunction('ensureMap');
const startupFit = ensureMap.match(/const previewBounds = getBoundaryDrivenOverlayBounds\(false\);[\s\S]+?(?=basemapColorLayer\.addTo\(map\);)/)?.[0];
assert.ok(startupFit, 'Choose and apply the first camera before mounting the color basemap');
for (const { seeded, compact } of [
  { seeded:true, compact:false }, { seeded:true, compact:true },
  { seeded:false, compact:false }, { seeded:false, compact:true },
]) {
  const { context, map } = harness();
  vm.runInContext(extractFunction('getBoundaryDrivenOverlayBounds'), context);
  vm.runInContext(extractFunction('fitInitialFloodView'), context);
  context.TOWN_CONFIG = townConfig;
  if (seeded) context.seedMunicipalBoundary(officialBoundary);
  const preferred = context.getBoundaryDrivenOverlayBounds();
  const configured = context.getBoundaryDrivenOverlayBounds(false);
  const fits = [], zooms = [], boundsZooms = [];
  map.fitBounds = (bounds, options) => fits.push({ bounds, options:plain(options) });
  map.getZoom = () => 14;
  map.getBoundsZoom = (bounds, inside, padding) => { boundsZooms.push({ bounds, inside, padding }); return 12; };
  map.getMaxZoom = () => 22;
  map.setZoom = (zoom, options) => zooms.push({ zoom, options:plain(options) });
  context.L.point = (x, y) => ({ x, y });
  context.mapHasFit = false;
  context.isCompactFloodmapperLayout = () => compact;
  vm.runInContext(startupFit, context);
  const corners = bounds => plain([bounds.getSouthWest(), bounds.getNorthEast()]);
  assert.deepEqual(corners(fits[0].bounds), corners(seeded ? preferred : configured));
  assert.deepEqual(fits[0].options, { padding:seeded ? [16,16] : [20,20], animate:false });
  assert.equal(context.mapHasFit, seeded, 'Only a seeded, authoritative first fit locks the live camera');
  if (!seeded) context.seedMunicipalBoundary(officialBoundary);
  const finalBounds = context.getBoundaryDrivenOverlayBounds();
  context.fitInitialFloodView(finalBounds);
  context.fitInitialFloodView(finalBounds);
  assert.equal(fits.length, seeded ? 1 : 2, 'Allow one late authoritative fit only when geometry was missing at startup');
  assert.deepEqual(corners(fits.at(-1).bounds), corners(finalBounds));
  if (!seeded) assert.deepEqual(fits.at(-1).options, { padding:[16,16] }, 'Keep the existing late-fit animation behavior');
  assert.deepEqual(zooms, compact ? [{ zoom:seeded ? 13 : 15, options:{ animate:false } }] : []);
  if (compact && seeded) {
    assert.equal(boundsZooms.length, 1, 'Derive the early compact zoom from the former provisional viewport');
    assert.deepEqual(corners(boundsZooms[0].bounds), corners(configured));
    assert.equal(boundsZooms[0].inside, false);
    assert.deepEqual(boundsZooms[0].padding, { x:40, y:40 });
  } else assert.deepEqual(boundsZooms, []);
}
for (const renderer of ['setFloodLayer', 'setPhysicsFloodLayer']) {
  assert.match(extractFunction(renderer), /if \(!mapHasFit(?: && floodLatLngBounds)?\) fitInitialFloodView\(getBoundaryDrivenOverlayBounds\(\) \|\| floodLatLngBounds\)/,
    `${renderer} must use the guarded first camera fit`);
}

// No valid polygon means no invented box outline and no world-only gray mask.
for (const invalid of [null, {}, { type: 'Point', coordinates: [-74.8, 39] }, {
  type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-74.8, 39], [-74.7, 39]]] },
}, {
  type: 'Polygon', coordinates: [[[NaN, 39], [-74.8, NaN], [NaN, NaN]]],
}]) {
  const h = harness();
  h.context.seedMunicipalBoundary(invalid);
  assert.equal(h.context.municipalBoundaryFeature, null);
  assert.deepEqual(plain(h.context.municipalBoundaryRings), []);
  assert.equal(h.context.makeBoundaryVector({ color: '#000' }), null);
  h.context.updateMunicipalBoundaryLayer();
  assert.equal(h.context.cityBoundaryOutline, null);
  assert.equal(h.context.cityBoundaryMask, null);
  assert.equal(h.drawn.length, 0, 'Invalid/missing geometry must not paint a rectangular stand-in or cover the map');
}
{
  const h = harness();
  h.context.municipalBoundaryRings = [[]];
  h.context.updateBoundaryMaskLayer();
  assert.equal(h.drawn.length, 0, 'An empty ring is not a municipal cutout');
  assert.equal(h.context.cityBoundaryMask, null);
}

// A failed unseeded request is safe and retryable; recovery mounts real geometry.
{
  const h = harness();
  let fetches = 0;
  h.context.fetchMunicipalBoundaryFeature = async () => {
    fetches += 1;
    if (fetches === 1) throw new Error('Temporary boundary outage');
    return { feature: officialBoundary, rings: h.context.normalizeRingsFromGeoJsonGeometry(officialBoundary.geometry) };
  };
  await h.context.loadMunicipalBoundary();
  assert.equal(fetches, 1);
  assert.equal(h.context.municipalBoundaryLoadPromise, null, 'A failed request must release the in-flight guard for retry');
  assert.equal(h.context.cityBoundaryOutline, null);
  assert.equal(h.context.cityBoundaryMask, null);
  assert.equal(h.drawn.length, 0);
  await h.context.loadMunicipalBoundary();
  assert.equal(fetches, 2);
  assert.deepEqual(plain(h.context.municipalBoundaryFeature), officialBoundary);
  assert.equal(h.context.cityBoundaryOutline.kind, 'geoJSON');
  assert.ok(h.context.cityBoundaryMask.geometry.length >= 2);
  const drawsAfterRecovery = h.drawn.length;
  await h.context.loadMunicipalBoundary();
  assert.equal(fetches, 2, 'Recovered geometry must be reused on subsequent calls');
  assert.equal(h.drawn.length, drawsAfterRecovery);
}

// Concurrent callers share one request and one successful boundary replacement.
{
  const h = harness();
  let fetches = 0;
  let resolveBoundary;
  h.context.fetchMunicipalBoundaryFeature = () => {
    fetches += 1;
    return new Promise(resolve => { resolveBoundary = resolve; });
  };
  const first = h.context.loadMunicipalBoundary();
  const second = h.context.loadMunicipalBoundary();
  assert.equal(fetches, 1);
  resolveBoundary({ feature: officialBoundary, rings: h.context.normalizeRingsFromGeoJsonGeometry(officialBoundary.geometry) });
  await Promise.all([first, second]);
  assert.equal(fetches, 1);
  assert.equal(h.drawn.length, 2, 'Only one mask and one official outline should be created');
  assert.equal(h.counters.layout, 1);
  assert.equal(h.context.municipalBoundaryLoadPromise, null);
}

// A late failed request must not erase valid geometry acquired meanwhile.
{
  const h = harness();
  let rejectBoundary;
  h.context.fetchMunicipalBoundaryFeature = () => new Promise((_, reject) => { rejectBoundary = reject; });
  const pending = h.context.loadMunicipalBoundary();
  h.context.seedMunicipalBoundary(officialBoundary);
  rejectBoundary(new Error('Old network request failed after a valid seed arrived'));
  await pending;
  assert.deepEqual(plain(h.context.municipalBoundaryFeature), officialBoundary);
  assert.deepEqual(plain(h.context.municipalBoundaryRings), plain(h.context.normalizeRingsFromGeoJsonGeometry(officialBoundary.geometry)));
}

// Unseeded configurations also request their boundary immediately, alongside data.
const main = extractFunction('main');
assert.ok(main.indexOf('loadMunicipalBoundary()') > main.indexOf('ensureMap()') &&
  main.indexOf('reloadAll()') > main.indexOf('loadMunicipalBoundary()'),
  'Boundary loading must start before waiting for the initial forecast render');
assert.doesNotMatch(main, /requestIdleCallback\([^)]*warmBoundary|setTimeout\(warmBoundary/,
  'The municipal boundary must not be postponed until an idle callback');

console.log('Passed exact synchronous municipal boundary, stable first draw and camera framing, absent/invalid geometry, retry/recovery, deduplicated loads, and startup ordering');
