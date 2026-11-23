import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app/runtime/09-raster-lifecycle.js', import.meta.url), 'utf8');
const extract = name => {
  const match = source.match(new RegExp('    (?:async )?function ' + name + '\\([^]*?\\n    }'));
  assert.ok(match, `Missing ${name}`);
  return match[0];
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const encodings = [];
  const retired = [];
  let cancellation;
  const context = vm.createContext({
    Number, JSON, Promise, Error, console:{warn() {}},
    TOWN_CONFIG: {overlays: {bathtubStagePngPrefix: 'stage_'}},
    stageToCode: stage => String(stage),
    retainRasterObjectUrl: () => () => {},
    retireRasterObjectUrl: url => { if (url) retired.push(url); },
    getDepthQueryGrid: async () => ({width:1,height:1,values:new Uint8ClampedArray([128,0,0,255])}),
    applyBathtubStagePixels: () => {},
    document: {createElement: () => ({
      getContext: () => ({createImageData: () => ({data:new Uint8ClampedArray(4)}), putImageData() {}})
    })},
    canvasToDrainageObjectUrl: () => {const encoding = deferred(); encodings.push(encoding); return encoding.promise;},
    awaitRasterRequest: request => cancellation ? Promise.race([request, cancellation.promise]) : request
  });
  vm.runInContext('let bathtubStageOverlayCache = new Map();\n' +
    ['cacheBathtubStageOverlay', 'getBathtubStageOverlayRecord'].map(extract).join('\n'), context);
  return {
    context, encodings, retired,
    cache: () => vm.runInContext('bathtubStageOverlayCache', context),
    replaceCache: () => vm.runInContext('bathtubStageOverlayCache = new Map()', context),
    cancelNextWait: () => {cancellation = deferred(); return () => {
      const error = Object.assign(new Error('Cancelled waiter'), {name:'AbortError'});
      cancellation.reject(error);
    };},
    resumeWaits: () => {cancellation = null;}
  };
}

// Cancel only a waiter. Its shared encoder must still promote the completed
// record into the bounded cache even when nobody is awaiting it any longer.
{
  const f = fixture();
  const cancel = f.cancelNextWait();
  const pending = f.context.getBathtubStageOverlayRecord(4);
  await flush();
  assert.equal(f.encodings.length, 1);
  cancel();
  await assert.rejects(pending, {name:'AbortError'});
  f.encodings[0].resolve('blob:completed-after-cancellation');
  await flush();
  const record = [...f.cache().values()][0];
  assert.equal(record?.url, 'blob:completed-after-cancellation', 'Completion must not leave a raw promise in the stage cache');
  f.resumeWaits();
  assert.equal(await f.context.getBathtubStageOverlayRecord(4), record, 'A later renderer reuses the completed stage');
}

// If data refresh replaces the cache while encoding continues, its finished
// object URL belongs to the old generation and must be retired.
{
  const f = fixture();
  const cancel = f.cancelNextWait();
  const pending = f.context.getBathtubStageOverlayRecord(5);
  await flush();
  cancel();
  await assert.rejects(pending, {name:'AbortError'});
  f.replaceCache();
  f.encodings[0].resolve('blob:old-generation');
  await flush();
  assert.deepEqual(f.retired, ['blob:old-generation']);
  assert.equal(f.cache().size, 0);
}

// Canceled waiters must not bypass the existing 48-record retention limit.
{
  const f = fixture();
  for (let stage = 1; stage <= 50; stage += 1) {
    const cancel = f.cancelNextWait();
    const pending = f.context.getBathtubStageOverlayRecord(stage);
    await flush();
    cancel();
    await assert.rejects(pending, {name:'AbortError'});
    f.encodings.at(-1).resolve(`blob:stage-${stage}`);
    await flush();
  }
  assert.equal(f.cache().size, 48);
  assert.deepEqual(f.retired, ['blob:stage-1', 'blob:stage-2']);
}
// An encoder failure stays retryable; it must not leave a fulfilled-null
// promise permanently occupying this stage's cache entry.
{
  const f = fixture();
  const pending = f.context.getBathtubStageOverlayRecord(6);
  await flush();
  f.encodings[0].reject(new Error('Encoder failed'));
  assert.equal(await pending, null);
  assert.equal(f.cache().size, 0);
  const retry = f.context.getBathtubStageOverlayRecord(6);
  await flush();
  assert.equal(f.encodings.length, 2);
  f.encodings[1].resolve('blob:retry');
  assert.equal((await retry).url, 'blob:retry');
}
console.log('PASS canceled stage waiter completion, cache replacement and bounded retention');
