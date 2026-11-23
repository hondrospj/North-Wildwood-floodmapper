import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(new URL('../assets/3d/north-wildwood-3d.js', import.meta.url), 'utf8');
const functions = [...source.matchAll(/^  (?:async )?function (\w+)\(/gm)].map(match => {
  const end = source.indexOf('\n  }', match.index) + 4;
  return { name: match[1], body: source.slice(match.index, end) };
});
export const flushAtomic3d = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const flush = flushAtomic3d;

function fixture(pitch = 60) {
  const timers = new Map(), intervals = new Map(), images = [], deleted = [], listeners = new Map();
  const layers = new Map(), sources = new Map(), draws = [];
  const gpu = { programs: [], deletedPrograms: [], images: [], geometryUploads: 0 };
  let nextTimer = 0, nextTexture = 0, boundTexture = null, activeTexture = 0;
  const gl = {
    ACTIVE_TEXTURE: 1, UNPACK_FLIP_Y_WEBGL: 2, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 3,
    TEXTURE_BINDING_2D: 4, TEXTURE0: 0, NO_ERROR: 0,
    VERTEX_ARRAY_BINDING: 5, ARRAY_BUFFER_BINDING: 6,
    getParameter: key => key === 1 ? activeTexture : key === 4 ? boundTexture : false,
    activeTexture: value => { activeTexture = value; },
    bindTexture: (_kind, value) => { boundTexture = value; },
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getProgramParameter: () => true,
    attachShader() {}, linkProgram() {}, deleteShader() {},
    createProgram() { const program = {}; gpu.programs.push(program); return program; },
    deleteProgram: program => gpu.deletedPrograms.push(program),
    getUniformLocation: (_program, name) => name,
    getAttribLocation: (_program, name) => name === 'a_position' ? 0 : 1,
    createVertexArray: () => ({}), createBuffer: () => ({}),
    bindBuffer() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
    bufferData() { gpu.geometryUploads += 1; },
    createTexture: () => ({ texture: ++nextTexture }),
    texParameteri() {}, pixelStorei() {}, generateMipmap() {},
    texImage2D(...args) { gpu.images.push(args.at(-1)); },
    getError: () => 0, isContextLost: () => false,
    deleteTexture: texture => { deleted.push(texture); },
    deleteVertexArray() {}, deleteBuffer() {},
    useProgram() {}, uniformMatrix4fv() {}, uniform1f() {}, bindVertexArray() {},
    uniform1i() {}, enable() {}, disable() {}, blendEquationSeparate() {},
    blendFuncSeparate() {}, depthFunc() {}, depthMask() {},
    drawArrays: () => { draws.push(boundTexture); }
  };
  const oldLayer = { _url: 'old', _worldFileAffine: true, _worldFileCorners: [
    { lng: 0, lat: 1 }, { lng: 1, lat: 1 }, { lng: 1, lat: 0 }, { lng: 0, lat: 0 }
  ] };
  const newLayer = { ...oldLayer, _url: 'new' };
  const body = { dataset: { map3d: 'ready' }, classList: { contains: value => value === 'map-3d-ready' } };
  const map3d = {
    getPitch: () => pitch, getZoom: () => 16,
    getSource: id => sources.get(id), getLayer: id => layers.get(id),
    getStyle: () => ({ layers: [...layers.values()] }),
    addSource(id, options) {
      const row = {
        ...options, image: null, ready: false, updates: 0,
        loaded() { return this.ready; },
        updateImage(next) { Object.assign(this, next); this.ready = false; this.updates++; }
      };
      sources.set(id, row);
    },
    addLayer(layer) {
      layers.set(layer.id, layer);
      if (layer.type === 'custom') layer.onAdd(map3d, gl);
    },
    removeLayer(id) {
      const layer = layers.get(id);
      layers.delete(id);
      if (layer?.onRemove) layer.onRemove(map3d, gl);
    },
    removeSource(id) { sources.delete(id); },
    setPaintProperty(id, name, value) {
      const layer = layers.get(id);
      if (layer) (layer.paint ||= {})[name] = value;
    },
    setLayoutProperty(id, name, value) {
      const layer = layers.get(id);
      if (layer) (layer.layout ||= {})[name] = value;
    },
    getLayoutProperty: (id, name) => layers.get(id)?.layout?.[name],
    moveLayer() {}, triggerRepaint() {},
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    off(name, callback) { listeners.get(name)?.delete(callback); }
  };
  const c = vm.createContext({
    console, queueMicrotask, Image: class { constructor() { images.push(this); } async decode() {} },
    maplibregl: {
      MercatorCoordinate: { fromLngLat: ({ lng, lat }, altitude) => ({ x: lng, y: lat, z: altitude }) }
    },
    window: {
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => timers.delete(id),
      setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; },
      clearInterval: id => intervals.delete(id)
    },
    document: { body, getElementById: () => null },
    map: { hasLayer: layer => layer === c.currentFloodLayer || layer === c.pendingFloodLayer },
    overlayOpacity: .75, lastRenderToken: 2, pendingFloodLayer: newLayer,
    currentFloodLayer: oldLayer, getSelectedStageNavd88: () => 1, floodLatLngBounds: null,
    imageLayerVersions: new WeakMap(), getComputedStyle: () => ({ getPropertyValue: () => '' })
  });
  const initialVars = source.slice(source.indexOf('  var TERRAIN_EXAGGERATION'), source.indexOf('  function schedulePersistentNavControlSync'));
  vm.runInContext(initialVars, c);
  for (const { body: declaration } of functions) vm.runInContext(declaration, c);
  Object.assign(c, { glMap: map3d, glStyleReady: true });
  c.syncBuildingWaterComposite3d = () => {};
  c.syncBuildingVisibilityForCamera = () => {};
  c.placeFloodForScaleDepthPass = () => {};
  c.syncFloodLayer3d();
  const oldPlane = c.floodPlaneLayer;
  const oldNative = sources.get('nw-flood-drape-source');
  async function finishImages(url, ready = true) {
    const pending = images.filter(image => image.src === url && (image.onload || image.onerror));
    assert.ok(pending.length, `No pending custom image for ${url}`);
    for (const image of pending) if (ready) await image.onload(); else image.onerror();
    await flush();
  }
  function finishNative(url, ready = true) {
    const matching = [...sources.entries()].filter(([, row]) => row.url === url);
    assert.ok(matching.length, `No native source for ${url}`);
    for (const [id, row] of matching) {
      row.ready = true;
      if (ready) {
        row.image = { url, width: 4, height: 4 };
        row.texture = { texture: { native: url }, size: [4, 4] };
      }
      for (const callback of [...(listeners.get(ready ? 'sourcedata' : 'error') || [])]) callback({ sourceId: id });
    }
  }
  function renderVisible() {
    const start = draws.length;
    for (const layer of layers.values()) if (layer.type === 'custom') {
      layer.render(gl, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
    return draws.slice(start);
  }
  return { c, body, layers, sources, oldLayer, newLayer, oldPlane, oldNative, gl, gpu,
    images, deleted, timers, intervals, finishImages, finishNative, renderVisible,
    fire(event) { for (const callback of [...(listeners.get(event) || [])]) callback(); },
    poll() { for (const { callback } of [...intervals.values()]) callback(); },
    setPitch(value) { pitch = value; c.syncFloodPresentationMode(); } };
}

export async function readyAtomic3dFixture(pitch) {
  const h = fixture(pitch);
  await h.finishImages('old');
  h.finishNative('old');
  h.oldTexture = h.oldPlane.texture;
  return h;
}

export async function testAtomic3dCommit() {
let checks = 0;
for (const first of ['gpu', 'native']) {
  const h = await readyAtomic3dFixture(first === 'gpu' ? 60 : 0);
  let settled = false;
  const job = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2).then(ready => { settled = true; return ready; });
  await flush();
  if (first === 'gpu') await h.finishImages('new'); else h.finishNative('new');
  await flush();
  assert.equal(settled, false, 'One renderer cannot certify the entire frame');
  assert.equal(h.c.currentFloodLayer, h.oldLayer);
  assert.equal(h.c.floodPlaneLayer, h.oldPlane, 'Candidate preparation must preserve the committed plane');
  assert.equal(h.oldPlane.committedUrl, 'old', 'Pending preparation must preserve visible water pixels');
  assert.equal(h.oldPlane.texture, h.oldTexture);
  assert.equal(h.oldNative.url, 'old', 'Pending preparation must preserve the committed native image');
  assert.ok(!h.deleted.includes(h.oldTexture), 'The displayed GPU texture must remain available for rollback');
  h.setPitch(60);
  assert.deepEqual(h.renderVisible(), [h.oldTexture], 'Pitch changes cannot expose a staging plane');
  h.setPitch(0);
  const visibleImages = [...h.layers.values()].filter(layer => layer.type === 'raster' &&
    layer.layout?.visibility !== 'none' && layer.paint?.['raster-opacity'] > 0);
  assert.equal(visibleImages.length, 1);
  assert.equal(h.sources.get(visibleImages[0].source).url, 'old', 'Top-down changes cannot expose a staging image');
  if (first === 'gpu') h.finishNative('new'); else await h.finishImages('new');
  assert.equal(await job, true);
  assert.equal(h.c.currentFloodLayer, h.oldLayer, 'Readiness must leave promotion to the frame owner');
  assert.equal(h.c.floodPlaneLayer, h.oldPlane);
  assert.equal(h.c.commitFloodFrame3d(h.newLayer, 2), true);
  assert.equal(h.c.floodPlaneLayer.committedUrl, 'new');
  assert.equal(h.c.floodPlaneLayer.altitudeMeters, 5 * .3048 * 4);
  assert.ok(h.deleted.includes(h.oldTexture));
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  checks++;
}

for (const failure of ['gpu', 'native']) {
  const h = await readyAtomic3dFixture(60);
  const job = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  if (failure === 'gpu') {
    h.finishNative('new');
    await h.finishImages('new', false);
  } else {
    await h.finishImages('new');
    h.finishNative('new', false);
  }
  assert.equal(await job, false);
  assert.equal(h.c.pendingFlood3dRequest, null);
  assert.equal(h.c.floodPlaneLayer, h.oldPlane);
  assert.equal(h.oldPlane.texture, h.oldTexture);
  assert.equal(h.oldNative.url, 'old');
  assert.ok(!h.deleted.includes(h.oldTexture));
  assert.equal(h.layers.size, 2, 'A rejected candidate cannot leave hidden renderers');
  assert.equal(h.sources.size, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  checks++;
}

for (const interruption of ['new-selection', 'removed-layer', 'replacement-map', 'clear', 'style-reset']) {
  const h = await readyAtomic3dFixture(60);
  const job = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  await h.finishImages('new');
  const oldCandidate = h.c.pendingFlood3dRequest;
  if (interruption === 'new-selection') h.c.lastRenderToken++;
  if (interruption === 'removed-layer') h.c.pendingFloodLayer = null;
  if (interruption === 'replacement-map') h.c.glMap = {};
  if (interruption === 'clear') {
    h.c.pendingFloodLayer = null;
    h.c.currentFloodLayer = null;
    h.c.syncFloodLayer3d();
  } else if (interruption === 'style-reset') {
    h.c.glStyleReady = false;
    h.c.disposePendingFloodFrame3d();
  } else h.c.discardObsoleteFloodFrame3d();
  h.poll();
  assert.equal(await job, false);
  assert.equal(h.c.pendingFlood3dRequest, null);
  assert.ok(oldCandidate.disposed);
  assert.equal(h.layers.size, interruption === 'clear' ? 0 : 2);
  assert.equal(h.sources.size, interruption === 'clear' ? 0 : 1);
  if (interruption !== 'clear') {
    assert.equal(h.c.floodPlaneLayer, h.oldPlane);
    assert.equal(h.oldPlane.texture, h.oldTexture);
    assert.equal(h.oldNative.url, 'old');
    assert.ok(!h.deleted.includes(h.oldTexture));
  }
  assert.equal(h.timers.size, 0);
  assert.equal(h.intervals.size, 0);
  checks++;
}

{
  const h = await readyAtomic3dFixture(60);
  const job = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  await h.finishImages('new');
  h.finishNative('new');
  assert.equal(await job, true);
  h.c.lastRenderToken++;
  assert.equal(h.c.commitFloodFrame3d(h.newLayer, 2), false, 'A superseded owner cannot promote certified renderers');
  assert.equal(h.c.floodPlaneLayer, h.oldPlane);
  h.c.discardObsoleteFloodFrame3d();
  assert.equal(h.layers.size, 2);
  assert.equal(h.sources.size, 1);
  checks++;
}

for (const reset of ['custom-removed', 'native-replaced', 'gpu-lost']) {
  const h = await readyAtomic3dFixture(60);
  const job = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  await h.finishImages('new');
  h.finishNative('new');
  assert.equal(await job, true);
  const candidate = h.c.pendingFlood3dRequest;
  if (reset === 'custom-removed') h.c.glMap.removeLayer(candidate.plane.id);
  if (reset === 'native-replaced') h.c.glMap.addSource(candidate.drape.sourceId, { url: 'replacement' });
  if (reset === 'gpu-lost') candidate.plane.gl = { isContextLost: () => true };
  assert.equal(h.c.commitFloodFrame3d(h.newLayer, 2), false, 'A style/context reset cannot promote stale GPU handles');
  assert.equal(h.c.floodPlaneLayer, h.oldPlane);
  assert.equal(h.oldPlane.texture, h.oldTexture);
  checks++;
}

{
  const h = await readyAtomic3dFixture(60);
  h.newLayer._url = 'old';
  const imageCount = h.images.length;
  assert.equal(await h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2), true);
  assert.equal(h.c.pendingFlood3dRequest.reuse, true);
  assert.equal(h.oldPlane.altitudeMeters, 1 * .3048 * 4, 'Same-URL geometry must wait for owner commit');
  h.c.overlayOpacity = .2;
  assert.equal(h.c.commitFloodFrame3d(h.newLayer, 2), true);
  assert.equal(h.c.floodPlaneLayer, h.oldPlane);
  assert.equal(h.oldPlane.altitudeMeters, 5 * .3048 * 4);
  assert.equal(h.oldPlane.opacity, .2, 'Promotion uses current opacity after a pending slider change');
  assert.equal(h.images.length, imageCount);
  assert.ok(!h.deleted.includes(h.oldTexture));
  assert.equal(h.layers.size, 2);
  assert.equal(h.sources.size, 1);
  checks++;
}

{
  const h = await readyAtomic3dFixture(60);
  for (const [index, url] of [[2, 'new'], [3, 'third'], [4, 'fourth']]) {
    const layer = { ...h.newLayer, _url: url, _floodmapperFrame: { stage: index } };
    h.c.lastRenderToken = index;
    h.c.pendingFloodLayer = layer;
    const job = h.c.prepareFloodFrame3d(layer, { stage: index }, index);
    await h.finishImages(url);
    h.finishNative(url);
    assert.equal(await job, true);
    assert.equal(h.c.commitFloodFrame3d(layer, index), true);
    h.c.currentFloodLayer = layer;
    h.c.pendingFloodLayer = null;
    h.c.getSelectedStageNavd88 = () => index;
    const active = h.c.floodPlaneLayer, drape = h.c.floodDrapeIds();
    h.c.syncFloodLayer3d();
    assert.equal(h.c.floodPlaneLayer, active, 'Ordinary refresh retains the promoted slot');
    assert.equal(h.sources.get(drape.sourceId).url, url);
    assert.equal(h.layers.size, 2);
    assert.equal(h.sources.size, 1);
  }
  assert.equal(h.c.floodPlaneLayer.id, 'nw-flood-overlay-next');
  // A lost custom-layer object must not make native recovery choose the other slot.
  const activeDrape = h.c.floodDrapeIds();
  h.c.glMap.removeLayer(h.c.floodPlaneLayer.id);
  h.c.floodPlaneLayer = null;
  h.c.syncFloodLayer3d();
  assert.equal(h.c.floodDrapeIds().sourceId, activeDrape.sourceId);
  await h.finishImages('fourth');
  assert.equal(h.layers.size, 2);
  assert.equal(h.sources.size, 1);
  checks++;
}

for (const nativeLoaded of [true, false]) {
  const h = await readyAtomic3dFixture(60);
  h.newLayer._url = 'old';
  h.oldNative.ready = nativeLoaded;
  const signature = h.c.imageLayerVersions.get(h.oldNative);
  const updates = h.oldNative.updates;
  const job = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  assert.equal(h.c.pendingFlood3dRequest.reuse, nativeLoaded,
    'A live source without a finished image must use isolated staging');
  h.c.lastRenderToken++;
  h.c.discardObsoleteFloodFrame3d();
  h.poll();
  assert.equal(await job, false);
  assert.equal(h.c.imageLayerVersions.get(h.oldNative), signature,
    'Rejecting a same-URL request cannot invalidate the committed source cache');
  h.c.syncFloodLayer3d();
  assert.equal(h.oldNative.updates, updates, 'Cancellation cannot refetch the unchanged active image');
  assert.equal(h.layers.size, 2);
  assert.equal(h.sources.size, 1);
  checks++;
}

{
  const h = await readyAtomic3dFixture(60);
  let finishDecode;
  const borrowed = {
    complete: true, naturalWidth: 32, currentSrc: 'new',
    onload() {}, onerror() {},
    decode: () => new Promise(resolve => { finishDecode = resolve; })
  };
  const handlers = [borrowed.onload, borrowed.onerror];
  h.newLayer.getElement = () => borrowed;
  const imageRequests = h.images.length;
  const initialGeometryUploads = h.gpu.geometryUploads;
  const oldProgram = h.oldPlane.pipeline.program;
  const pending = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  await flush();
  h.finishNative('new');
  const candidate = h.c.pendingFlood3dRequest.plane;
  assert.equal(candidate.pipeline.program, oldProgram, 'Both slots share the linked WebGL program');
  assert.notEqual(candidate.buffer, h.oldPlane.buffer);
  assert.notEqual(candidate.vertexArray, h.oldPlane.vertexArray);
  assert.equal(h.gpu.programs.length, 1);
  assert.equal(h.images.length, imageRequests, 'The custom plane reuses the mounted Leaflet image');
  assert.equal(candidate.textureReady, false);
  assert.deepEqual(h.renderVisible(), [h.oldTexture]);

  finishDecode();
  assert.equal(await pending, true);
  assert.equal(h.gpu.images.at(-1), borrowed, 'Upload receives the mounted image itself');
  assert.deepEqual([borrowed.onload, borrowed.onerror], handlers);
  assert.equal(h.c.commitFloodFrame3d(h.newLayer, 2), true);
  assert.deepEqual(h.gpu.deletedPrograms, [], 'Removing the previous plane keeps the active program');
  assert.equal(h.gpu.geometryUploads, initialGeometryUploads + 1, 'Preparing and promoting one unchanged geometry uploads its quad once');
  h.c.currentFloodLayer = null;
  h.c.syncFloodLayer3d();
  assert.deepEqual(h.gpu.deletedPrograms, [oldProgram], 'The final owner releases the shared program');
  checks++;
}

{
  const h = await readyAtomic3dFixture(0);
  h.newLayer.getElement = () => ({
    complete: true, naturalWidth: 4, currentSrc: 'another-frame',
    decode: () => assert.fail('Different pixels must be loaded from the selected URL')
  });
  const pending = h.c.prepareFloodFrame3d(h.newLayer, { stage: 5 }, 2);
  h.finishNative('new');
  await h.finishImages('new');
  assert.equal(await pending, true);
  assert.equal(h.gpu.images.at(-1).src, 'new');
  checks++;
}

{
  const h = await readyAtomic3dFixture(60);
  const oldProgram = h.oldPlane.pipeline.program;
  h.c.setStatus = () => {};
  h.c.wire3dContextRecovery(h.c.glMap);
  h.fire('webglcontextlost');
  assert.equal(h.c.floodPlanePrograms.has(h.gl), false);
  const restored = h.c.acquireFloodPlaneProgram(h.gl);
  assert.notEqual(restored.program, oldProgram, 'A restored context needs a newly linked program');
  h.c.glMap.removeLayer(h.oldPlane.id);
  assert.equal(h.c.floodPlanePrograms.get(h.gl), restored, 'Retiring an old layer preserves the restored program');
  assert.deepEqual(h.gpu.deletedPrograms, []);
  h.c.releaseFloodPlaneProgram(h.gl, restored);
  assert.deepEqual(h.gpu.deletedPrograms, [restored.program]);
  checks++;
}

console.log(`${checks} atomic 3D commit cases passed: stalled native/GPU renderers, pitch changes, failures, cancellation, clearing and obsolete owner promotion.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await testAtomic3dCommit();
