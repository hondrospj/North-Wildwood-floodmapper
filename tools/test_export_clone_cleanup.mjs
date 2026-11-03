// Exercise the actual capture helper against canvas/document ownership and
// overlapping captures. Large clone buffers must not survive the capture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('app/runtime/16-export-map.js', import.meta.url), 'utf8');
const helper = source.match(/^    async function captureExportElement\([^\n]*\) \{\n.*?^    \}/ms)?.[0];
assert.ok(helper, 'Use the shipped capture helper');
const dimensions = canvas => [canvas.width, canvas.height];
const canvas = (ownerDocument, width = 2592, height = 4025) => ({ ownerDocument, width, height });
function cloneFor(sourceDocument) {
  const nodes = [];
  const clone = { querySelectorAll(selector) { assert.equal(selector, 'canvas'); return nodes; } };
  const frame = { ownerDocument: sourceDocument, contentDocument: clone, removes: 0,
    remove() { this.removes++; this.contentDocument = null; } };
  clone.defaultView = { frameElement: frame };
  return { clone, frame, nodes, add() { const value = canvas(clone); nodes.push(value); return value; } };
}
function context(html2canvas) {
  const ctx = vm.createContext({ html2canvas, Set });
  vm.runInContext(helper, ctx);
  return ctx;
}

let checks = 0;
{
  const original = {}, stage = { ownerDocument: original }, owned = cloneFor(original);
  const live = canvas(original), first = owned.add(), removedByCallback = owned.add();
  const output = canvas(original, 640, 960), filter = () => false;
  let addedByCallback, callbackCalls = 0;
  const options = { scale: 0.25, width: 2160, height: 3840, removeContainer: true,
    ignoreElements: filter,
    async onclone(doc, element) {
      callbackCalls++;
      assert.equal(doc, owned.clone); assert.equal(element.id, 'cloned-stage');
      owned.nodes.splice(owned.nodes.indexOf(removedByCallback), 1);
      addedByCallback = owned.add();
      return 'callback-complete';
    } };
  const originalHook = options.onclone;
  owned.nodes.push(live); // A foreign/live buffer must never be released.
  const ctx = context(async (element, passed) => {
    assert.equal(element, stage);
    for (const key of ['scale', 'width', 'height', 'removeContainer', 'ignoreElements']) {
      assert.equal(passed[key], options[key], `Capture option ${key} must remain unchanged`);
    }
    assert.equal(await passed.onclone(owned.clone, { id: 'cloned-stage' }), 'callback-complete');
    // html2canvas normally removes its iframe before returning the output.
    owned.frame.remove();
    return output;
  });
  assert.equal(await ctx.captureExportElement(stage, options), output);
  assert.equal(callbackCalls, 1); assert.equal(options.onclone, originalHook);
  for (const clone of [first, removedByCallback, addedByCallback]) assert.deepEqual(dimensions(clone), [1, 1]);
  assert.deepEqual(dimensions(live), [2592, 4025]);
  assert.deepEqual(dimensions(output), [640, 960]);
  assert.equal(owned.frame.removes, 1, 'A frame already removed by the library remains detached');
  checks++;
}
{
  const original = {}, stage = { ownerDocument: original }, owned = cloneFor(original);
  const copy = owned.add(), failure = new Error('Actual renderer failure');
  const ctx = context(async (_element, passed) => {
    passed.onclone(owned.clone, {});
    throw failure; // Library cleanup after await render is skipped on rejection.
  });
  await assert.rejects(ctx.captureExportElement(stage), error => error === failure);
  assert.deepEqual(dimensions(copy), [1, 1]);
  assert.equal(owned.frame.removes, 1);
  checks++;
}
{
  const original = {}, stage = { ownerDocument: original }, owned = cloneFor(original);
  const copy = owned.add(), failure = new Error('Caller onclone failure');
  const ctx = context(async (_element, passed) => { await passed.onclone(owned.clone, {}); });
  await assert.rejects(ctx.captureExportElement(stage, { onclone: async () => { throw failure; } }),
    error => error === failure);
  assert.deepEqual(dimensions(copy), [1, 1]);
  assert.equal(owned.frame.removes, 1);
  checks++;
}
{
  const original = {}, stage = { ownerDocument: original }, owned = cloneFor(original);
  const output = owned.add();
  const ctx = context(async (_element, passed) => { passed.onclone(owned.clone, {}); return output; });
  assert.equal(await ctx.captureExportElement(stage), output);
  assert.deepEqual(dimensions(output), [2592, 4025], 'A returned canvas is retained even if it belongs to the clone');
  checks++;
}
{
  const original = {}, stage = { ownerDocument: original }, owned = cloneFor(original);
  const callerCanvas = owned.add(), failure = new Error('Failed caller-owned output');
  const ctx = context(async (_element, passed) => { passed.onclone(owned.clone, {}); throw failure; });
  await assert.rejects(ctx.captureExportElement(stage, { canvas: callerCanvas }), error => error === failure);
  assert.deepEqual(dimensions(callerCanvas), [2592, 4025], 'Caller-supplied output is retained on failure');
  assert.equal(owned.frame.removes, 1);
  checks++;
}
{
  const original = {}, stage = { ownerDocument: original }, one = cloneFor(original), two = cloneFor(original);
  const a = one.add(), b = two.add(), outputOne = canvas(original, 300, 200), outputTwo = canvas(original, 400, 250);
  let first, second, calls = 0;
  const ctx = context(async (_element, passed) => {
    const owned = calls++ === 0 ? one : two;
    passed.onclone(owned.clone, {});
    return new Promise(resolve => { if (owned === one) first = resolve; else second = resolve; });
  });
  const pendingOne = ctx.captureExportElement(stage), pendingTwo = ctx.captureExportElement(stage);
  first(outputOne); assert.equal(await pendingOne, outputOne);
  assert.deepEqual(dimensions(a), [1, 1]); assert.equal(one.frame.removes, 1);
  assert.deepEqual(dimensions(b), [2592, 4025]); assert.equal(two.frame.removes, 0);
  second(outputTwo); assert.equal(await pendingTwo, outputTwo);
  assert.deepEqual(dimensions(b), [1, 1]); assert.equal(two.frame.removes, 1);
  assert.deepEqual(dimensions(outputOne), [300, 200]); assert.deepEqual(dimensions(outputTwo), [400, 250]);
  checks++;
}
{
  const original = {}, live = canvas(original), frame = { removes: 0, remove() { this.removes++; } };
  original.querySelectorAll = () => [live]; original.defaultView = { frameElement: frame };
  const stage = { ownerDocument: original }, output = canvas(original, 100, 80);
  const ctx = context(async (_element, passed) => { passed.onclone(original, stage); return output; });
  assert.equal(await ctx.captureExportElement(stage), output);
  assert.deepEqual(dimensions(live), [2592, 4025]); assert.equal(frame.removes, 0);
  checks++;
}
{
  const original = {}, stage = { ownerDocument: original }, foreign = cloneFor({});
  const copy = foreign.add(), output = canvas(original, 20, 30);
  const ctx = context(async (_element, passed) => { passed.onclone(foreign.clone, {}); return output; });
  await ctx.captureExportElement(stage);
  assert.deepEqual(dimensions(copy), [2592, 4025], 'A canvas in an unowned frame is retained');
  assert.equal(foreign.frame.removes, 0, 'Cleanup cannot remove a frame belonging to another source document');
  checks++;
}
{
  const failure = new Error('Before onclone'), original = {}, live = canvas(original), unrelated = cloneFor(original);
  unrelated.add();
  const ctx = context(async () => { throw failure; });
  await assert.rejects(ctx.captureExportElement({ ownerDocument: original }), error => error === failure);
  assert.deepEqual(dimensions(live), [2592, 4025]); assert.equal(unrelated.frame.removes, 0,
    'An unowned frame must not be removed when capture fails before onclone');
  checks++;
}
console.log(JSON.stringify({ passed: true, checks, source: 'captureExportElement' }));
