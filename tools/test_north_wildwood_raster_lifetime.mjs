import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('    const rasterObjectUrlUsers ='),html.indexOf('    function cacheBathtubStageOverlay('));
const callbacks=[],revoked=[];
const context=vm.createContext({Map,Set,window:{setTimeout(fn){callbacks.push(fn);return callbacks.length}},URL:{revokeObjectURL(url){revoked.push(url)}},currentFloodLayer:null,pendingFloodLayer:null,preloadPromiseCache:new Map(),drainageRasterImageCache:new Map(),exportImageElementCache:new Map()});
vm.runInContext(source,context);
const flush=()=>{while(callbacks.length)callbacks.shift()()};
// An evicted image can be handed between promise continuations before cleanup.
context.retireRasterObjectUrl('blob:handoff');
const first=context.retainRasterObjectUrl('blob:handoff');
const second=context.retainRasterObjectUrl('blob:handoff');
flush();assert.deepEqual(revoked,[]);
first();first();flush();assert.deepEqual(revoked,[],'One consumer cannot release another consumer’s image');
second();flush();assert.deepEqual(revoked,['blob:handoff']);
// Displayed and pending map layers remain valid even after their cache entry is gone.
for(const key of ['currentFloodLayer','pendingFloodLayer']){
 const url='blob:'+key;context[key]={_url:url};context.preloadPromiseCache.set(url,'loaded');context.drainageRasterImageCache.set(url,'decoded');context.exportImageElementCache.set(url,'decoded');
 context.retireRasterObjectUrl(url);flush();assert.ok(!revoked.includes(url));
 context[key]=null;context.scheduleRasterObjectUrlCleanup();flush();assert.ok(revoked.includes(url));
 for(const cache of ['preloadPromiseCache','drainageRasterImageCache','exportImageElementCache'])assert.equal(context[cache].has(url),false,'Retired URLs must not remain in a successful-load cache');
}
context.retireRasterObjectUrl('https://example.test/image.webp');flush();assert.equal(revoked.length,3);
console.log('Passed raster lifetime across concurrent consumers, cache eviction, active/pending layers, and cleanup');
