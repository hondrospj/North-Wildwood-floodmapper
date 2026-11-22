import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const html = readAppSource(new URL('../index.html', import.meta.url));
const extract = name => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
const workers = [];
class TestWorker {
  constructor() { workers.push(this); this.requests = []; }
  postMessage(task, transfer) {
    this.requests.push(structuredClone(task, {transfer}));
    assert.equal(task.data.byteLength, 0, 'RGBA ownership transfers to the worker');
  }
  terminate() { this.terminated = true; }
  complete(bytes = [71, 73, 70]) {
    const task = this.requests.at(-1);
    this.onmessage({data:{index:task.index, data:[new Uint8Array([...bytes, 0, 0])], cursor:bytes.length, globalPalette:[0, 0, 0]}});
  }
}
const ctx = vm.createContext({Worker:TestWorker, Blob, setTimeout, clearTimeout, throwIfExportCancelled:()=>{}});
vm.runInContext(extract('createStreamingGifEncoder'), ctx);
const options = {width:2, height:2, quality:1, dither:false, globalPalette:[0,0,0], workerScript:'gif.worker.js'};
const canvas = {getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray(16)})})};
const encoder = ctx.createStreamingGifEncoder(options, 337);
const worker = workers.at(-1);
for (let index = 0; index < 337; index++) {
  let settled = false;
  const encoding = encoder.addFrame(canvas, {delay:500}).then(()=>{settled=true;});
  await Promise.resolve();
  assert.equal(settled, false, 'Compositing waits for the current frame to finish encoding');
  assert.equal(worker.requests.length, index + 1);
  assert.equal(worker.requests.at(-1).index, index);
  assert.equal(worker.requests.at(-1).last, index === 336);
  assert.equal(worker.requests.at(-1).delay, 500);
  await assert.rejects(encoder.addFrame(canvas, {delay:500}), /not ready/);
  worker.complete([index % 256]);
  await encoding;
  // The test harness must not retain transferred pixel buffers either.
  delete worker.requests.at(-1).data;
}
const blob = encoder.finish();
assert.equal(blob.type, 'image/gif');
assert.equal(blob.size, 337, 'Do not append worker page padding');
assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], Array.from({length:337}, (_,i)=>i%256));
encoder.dispose();
assert.ok(worker.terminated);
assert.equal(blob.size, 337, 'Disposing the worker preserves the downloadable Blob');

for (const failure of ['cancel', 'worker-error', 'message-error']) {
  const attempt = ctx.createStreamingGifEncoder(options, 2);
  const instance = workers.at(-1);
  const encoding = attempt.addFrame(canvas, {delay:1000});
  if (failure === 'cancel') attempt.abort();
  if (failure === 'worker-error') instance.onerror({preventDefault(){}});
  if (failure === 'message-error') instance.onmessageerror();
  await assert.rejects(encoding, /aborted|failed|Could not read/);
  assert.ok(instance.terminated);
  assert.throws(()=>attempt.finish(), /incomplete/);
  await assert.rejects(attempt.addFrame(canvas, {delay:1000}), /not ready/);
}

// Release every capture on both a failed composite and the affine-map fallback.
for (const fallback of [false, true]) {
  const captures = Array.from({length:5},()=>({width:100,height:200,getContext:()=>({drawImage(){}})}));
  const composite = vm.createContext({
    document:{createElement:()=>captures[4]},
    captureFastGifBaseCanvas:async()=>({baseCanvas:captures[0],mapForegroundCanvas:captures[1],roadLabelsCanvas:captures[2],chromeCanvas:captures[3],overlayRect:fallback?null:{x:0,y:0,width:100,height:200}}),
    throwIfExportCancelled(){}, setDownloadStatus(){}, setExportProgress(){},
    EXPORT_PROGRESS_UPDATE_EVERY:8, overlayOpacity:0.75,
    getExportFrameImage:async()=>{throw Error('image failed');},
    withExportFrames:async()=>{},
  });
  vm.runInContext(extract('addFastCompositeGifFrames'), composite);
  const result = composite.addFastCompositeGifFrames({}, [{entry:{}}]);
  if (fallback) await result;
  else await assert.rejects(result, /image failed/);
  assert.ok(captures.every(c=>c.width===1&&c.height===1), 'Release all large canvases on every exit');
}

// Adjacent water levels and distinct physics frames must resolve independently.
const requested = [];
const images = vm.createContext({
  currentOverlayMode:'depth', getStageValue:e=>e.stage, getOverlayStage:()=>3.3,
  getHydraulicPhaseForEntry:()=> 'filling', getPhysicsAssetForEntry:e=>e.physics,
  getPhysicsDisplayRecord:a=>a, throwIfExportCancelled(){},
  getHydraulicOverlayRecord:async(mode,stage,phase,entry)=>({url:`stage-${entry.stage}`}),
  getExportImageElement:async url=>{requested.push(url);return{src:url};},
});
vm.runInContext(extract('getExportFrameImage'), images);
await images.getExportFrameImage({entry:{stage:3.31}});
await images.getExportFrameImage({entry:{stage:3.39}});
await images.getExportFrameImage({entry:{stage:3.31,physics:{url:'physics-specific-frame'}}});
assert.deepEqual(requested, ['stage-3.31','stage-3.39','physics-specific-frame']);
console.log('PASS bounded GIF encoding: 337 frames, transferred buffers, order, page lengths, cancellation/failure, canvas cleanup and raster identity.');

// Compare the published worker's output to the exact pinned upstream worker.
// Recover upstream from the vendored bundle without fetching a CDN in CI.
const optimizedWorker = fs.readFileSync(new URL('../assets/vendor/gif.worker.js', import.meta.url), 'utf8');
const upstreamWorker = optimizedWorker.split('// Upstream worker bundle, with the palette cache hook.\n')[1]
  .replace('r=i(1),installFixedPaletteCache(r),s=function(t)', 'r=i(1),s=function(t)').trimEnd()
  + '\n//# sourceMappingURL=gif.worker.js.map';
assert.equal(createHash('sha256').update(upstreamWorker).digest('hex'),
  'cba3bd1cc3c9bd3f2c93b5bced357169d904fec011c0c87bd74c38b1b0b46c15');

function workerHarness(source) {
  let result;
  const self = { postMessage: value => { result = value; } };
  vm.runInNewContext(source, { self });
  return task => {
    self.onmessage({ data: { ...task } });
    const bytes = Buffer.concat(result.data.map((page, index) => Buffer.from(index === result.data.length - 1
      ? page.subarray(0, result.cursor) : page)));
    return { bytes, palette: result.globalPalette };
  };
}

const upstream = workerHarness(upstreamWorker);
const optimized = workerHarness(optimizedWorker);
const width = 96, height = 64;
const rgba = new Uint8ClampedArray(width * height * 4);
for (let offset = 0; offset < rgba.length; offset += 4) {
  const pixel = offset / 4;
  const row = Math.floor(pixel / width);
  rgba.set([(pixel % 31) * 8, (row % 16) * 17, (row % 7) * 41, 255], offset);
}
const gifTask = { index: 0, last: true, width, height, quality: 1, dither: false,
  globalPalette: true, repeat: 0, transparent: null, delay: 500, canTransfer: true, data: rgba };
const originalFirst = upstream(gifTask);
const improvedFirst = optimized(gifTask);
assert.deepEqual(improvedFirst.bytes, originalFirst.bytes, 'The first-frame palette is unchanged');
assert.deepEqual([...improvedFirst.palette], [...originalFirst.palette]);
const palette = Array.from(originalFirst.palette);
const changedPalette = [...palette.slice(3), ...palette.slice(0, 3)];
for (const task of [
  { ...gifTask, globalPalette: palette, last: false },
  { ...gifTask, globalPalette: palette, index: 1, last: false, delay: 1000 },
  { ...gifTask, globalPalette: changedPalette, index: 2 },
  { ...gifTask, globalPalette: palette, index: 3, dither: 'FloydSteinberg' },
  { ...gifTask, globalPalette: palette, index: 4, transparent: 0 },
]) {
  assert.deepEqual(optimized(task).bytes, upstream(task).bytes,
    `Exact GIF bytes for fixed-palette frame ${task.index}`);
}
console.log('PASS exact GIF worker: first-frame palette, repeat and changed palettes, delays, dithering and transparency match upstream byte-for-byte.');
