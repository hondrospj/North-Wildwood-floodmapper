import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL('../tools/app/runtime/' + name + '.js', import.meta.url), 'utf8');
const geometry = {
  type: 'Polygon',
  coordinates: [
    [[-.25, 0], [1, 0], [1, .75], [-.25, .75], [-.25, 0]],
    [[.25, .25], [.5, .25], [.5, .5], [.25, .5], [.25, .25]]
  ]
};
const ctx = vm.createContext({
  latLngToWorldFileUv: (lat, lon) => ({ u: lon, v: lat }),
  DRAINAGE_DEPTH_COLORS: [[125, 249, 255], [93, 231, 255]],
  DRAINAGE_DEPTH_BREAKS_FT: [.1, .25],
  escapeTownAddressHtml: String,
});
vm.runInContext(source('08-filling-and-drainage'), ctx);
vm.runInContext(source('25-structures-and-parcels'), ctx);
const footprint = ctx.getParcelRasterRows({ geometry }, 4, 4);
assert.equal(footprint.total, 14, 'The whole polygon includes cells outside the grid and excludes its hole');
assert.deepEqual(JSON.parse(JSON.stringify([...footprint.rows])), [[0, [[0, 4]]], [1, [[0, 1], [2, 4]]], [2, [[0, 4]]]]);
const rgba = new Uint8ClampedArray(64);
rgba.set([99, 212, 113, 205], 0); // Green diagnostic is dry.
rgba.set([93, 231, 255, 225], 4); // First resolvable wet band.
rgba.set([100, 130, 160, 225], 8); // Wet interpolation without a discrete band.
rgba.set([93, 231, 255, 225], 20); // In the polygon hole.
const packed = new Uint8ClampedArray(64);
packed.fill(128);
packed[12] = packed[13] = 0; // Missing model cell is excluded from the denominator.
const grid = { width: 4, height: 4, values: packed };
const metrics = ctx.measureParcelFloodPixels(footprint, grid, {
  getImageData(x, y, width) { return { data: rgba.subarray((y * 4 + x) * 4, (y * 4 + x + width) * 4) }; }
});
assert.equal(metrics.total, 14);
assert.equal(metrics.covered, 10);
assert.equal(metrics.wet, 2);
assert.equal(metrics.deepest, 1);
assert.equal(metrics.unresolvedDepth, true);
assert.equal(ctx.formatParcelDepthBand(metrics), '≥0.1 ft');
assert.match(ctx.buildParcelAreaPopup({ properties: { address: 'Test parcel' } }, metrics, false),
  /Maximum Flood Depth<\/span><strong>≥0\.1 ft/);

const stages = JSON.parse(fs.readFileSync(new URL('../assets/parcel-history-v2/NorthWildwoodParcelAreaStages.json', import.meta.url)));
const config = JSON.parse(fs.readFileSync(new URL('../floodmapper_v2.json', import.meta.url)));
assert.equal(stages.catalogVersion, config.overlays.cacheVersions.hydraulic, 'Precomputed projections must match the deployed hydraulic atlas');
assert.deepEqual(stages.stagesInTenthsFtNavd88['518840'], [73, 78, 84], '901 Atlantic Ave model area stages');
assert.deepEqual(stages.endpointSharesPercent, [0, 100]);
assert.deepEqual(stages.endpointStagesInTenthsFtNavd88['518840'], [67, 96], '901 Atlantic Ave first and last wet cell');
assert.deepEqual(Object.keys(stages.endpointStagesInTenthsFtNavd88), Object.keys(stages.stagesInTenthsFtNavd88));
for (const [id, stage] of Object.entries(stages.stagesInTenthsFtNavd88)) {
  assert.equal(stage.length, stages.sharesPercent.length);
  const endpoints = stages.endpointStagesInTenthsFtNavd88[id];
  assert.equal(endpoints.length, 2);
  const upper = [endpoints[0], ...stage, endpoints[1]].map(value => value ?? Infinity);
  assert.ok(upper.every((value, index) => value >= 0 && (!index || value >= upper[index - 1])));
}

const cdf = JSON.parse(fs.readFileSync(new URL('../assets/parcel-history-v2/NorthWildwoodHouseAlertCDF.json', import.meta.url)));
ctx.PARCEL_AREA_STAGES_URL = 'area.json';
ctx.OVERLAY_CACHE_VERSIONS = { hydraulic: stages.catalogVersion };
ctx.fetchJson = async () => stages;
vm.runInContext(source('24-alerts-and-projections'), ctx);
const options = await ctx.getParcelProjectionOptions({ id: 518840 }, cdf);
assert.deepEqual(JSON.parse(JSON.stringify(options)), [
  { share: 0, stage: 6.7, elevationIndex: 66 },
  { share: 25, stage: 7.3, elevationIndex: 72 },
  { share: 50, stage: 7.8, elevationIndex: 77 },
  { share: 75, stage: 8.4, elevationIndex: 83 },
  { share: 100, stage: 9.6, elevationIndex: 95 },
]);
const waterfront = await ctx.getParcelProjectionOptions({ id: 515857 }, cdf);
assert.deepEqual(JSON.parse(JSON.stringify(waterfront[0])), { share: 0, stage: 0, elevationIndex: -1 },
  'Existing water can place the first wet cell below the CDF coverage');
assert.equal(waterfront.at(-1).elevationIndex, 53);
const projectionBody = { style: { setProperty() {} }, innerHTML: '' };
ctx.document = { getElementById: id => id === 'floodHistoryBody' ? projectionBody : null };
ctx.renderFloodHistoryProjection({ id: 518840 }, cdf, options);
assert.match(projectionBody.innerHTML, /value="25" selected>At least 25%/);
ctx.renderFloodHistoryProjection({ id: 518840 }, cdf, options, 0, 40);
assert.match(projectionBody.innerHTML, /value="0" selected>Any Flooding \(&gt;0%\)/);
assert.match(projectionBody.innerHTML, /<span>2066<\/span>/);
ctx.renderFloodHistoryProjection({ id: 518840 }, cdf, options, 100, 40);
assert.match(projectionBody.innerHTML, /value="100" selected>Entire Parcel \(100%\)/);
assert.match(projectionBody.innerHTML, /<span>2066<\/span>/);
ctx.renderFloodHistoryProjection({ id: 515857 }, cdf, waterfront);
assert.match(projectionBody.innerHTML, /value="0" disabled>Any Flooding \(&gt;0%\) \(unavailable\)/);

const { endpointSharesPercent, endpointStagesInTenthsFtNavd88, ...previousStages } = stages;
vm.runInContext('parcelAreaStagesPromise = null', ctx);
ctx.fetchJson = async () => previousStages;
const previousOptions = await ctx.getParcelProjectionOptions({ id: 518840 }, cdf);
assert.deepEqual(JSON.parse(JSON.stringify(previousOptions)), [
  { share: 0, stage: null, elevationIndex: -1 },
  ...JSON.parse(JSON.stringify(options.slice(1, 4))),
  { share: 100, stage: null, elevationIndex: -1 },
], 'Older projection data retains the three original choices');
assert.equal((await ctx.getParcelProjectionOptions({ id: 'uncovered' }, cdf)).length, 0);
ctx.OVERLAY_CACHE_VERSIONS.hydraulic = 'new-atlas';
await assert.rejects(ctx.getParcelProjectionOptions({ id: 518840 }, cdf), /needs to be refreshed/);
let areaRequests = 0;
ctx.fetchJson = async () => ++areaRequests === 1 ? stages : { ...stages, catalogVersion: 'new-atlas' };
await assert.rejects(ctx.getParcelProjectionOptions({ id: 518840 }, cdf), /needs to be refreshed/);
assert.deepEqual(JSON.parse(JSON.stringify(await ctx.getParcelProjectionOptions({ id: 518840 }, cdf))),
  JSON.parse(JSON.stringify(options)), 'Corrected HTTP 200 area data must succeed on retry');
assert.equal(areaRequests, 2);

const corruptCdf = structuredClone(cdf);
corruptCdf.annualFloodEventCount.intermediate.estimate[32][24] = null;
let cdfRequests = 0;
Object.assign(ctx, { HOUSE_ALERT_CDF_URL: 'cdf.json', houseAlertCdfData: null, houseAlertCdfPromise: null,
  fetchJson: async () => ++cdfRequests === 1 ? corruptCdf : cdf });
assert.equal(ctx.hasValidFloodProjectionData(cdf), true);
await assert.rejects(ctx.ensureFloodProjectionData(), /needs to be refreshed/);
assert.equal(ctx.houseAlertCdfData, null, 'A missing annual estimate must never be cached as zero');
assert.equal(await ctx.ensureFloodProjectionData(), cdf);
assert.equal(await ctx.ensureFloodProjectionData(), cdf);
assert.equal(cdfRequests, 2, 'A corrected CDF is cached only after validation');

const selectedEntry = { stage: 3.16 };
const selectedSeries = [selectedEntry];
const popup = {};
const parcelContext = { popup, feature: { geometry } };
const depthRequests = [];
Object.assign(ctx, {
  currentOverlayMode: 'depth', // A different mode requested while the old image remains visible.
  currentFloodLayer: {
    _worldFileAffine: {},
    _floodmapperFrame: { overlayMode: 'dynamic', overlayStage: 3.1, phase: 'draining', entry: selectedEntry, series: selectedSeries },
    getElement() { assert.fail('Do not measure the retained flood-stage raster as depth'); }
  },
  persistentDepthQueryContext: parcelContext,
  map: { hasLayer: candidate => candidate === popup },
  async getHydraulicOverlayRecord(...args) { depthRequests.push(args); return { url: 'selected-depth.png' }; },
  async getDrainageRasterImage(url) { assert.equal(url, 'selected-depth.png'); return null; },
  async getDepthQueryGrid() { return grid; },
});
const updates = [];
ctx.updatePropertyPopup = (target, html) => updates.push({ target, html });
await ctx.refreshParcelFloodPopup(parcelContext);
await ctx.refreshParcelFloodPopup(parcelContext);
assert.deepEqual(depthRequests, [['depth', 3.1, 'draining', selectedEntry, selectedSeries]], 'Only the committed frame supplies the matching depth raster');
assert.equal(updates.length, 2, 'A deferred control update can reuse the measurement without a new raster request');
assert.deepEqual(updates[0], updates[1]);
console.log('Parcel area geometry, selected raster depth, and projection stage checks passed.');
