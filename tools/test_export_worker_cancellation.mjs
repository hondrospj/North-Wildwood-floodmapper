// Exercise the authoring source, including transports that ignore AbortSignal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=['11-export-selection','15-export-capture'].map(name=>
  fs.readFileSync(new URL(`app/runtime/${name}.js`,import.meta.url),'utf8')).join('\n');
const extract=name=>{
  const match=source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));
  assert.ok(match,`Missing ${name}`);return match[0];
};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

function harness(point='response'){
  const gate=deferred(),timers=new Map(),requests=[],created=[],revoked=[];
  let id=0;
  const ctx=vm.createContext({AbortController,Blob,
    exportInProgress:true,exportCancelRequested:false,activeGifExport:null,
    gifWorkerUrlPromise:null,gifWorkerLoadRequest:null,GIF_WORKER_CDN_URL:'worker.js',
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    URL:{createObjectURL:()=>{const url=`blob:worker-${created.length}`;created.push(url);return url;},revokeObjectURL:url=>revoked.push(url)},
    fetch:async(_url,options)=>{
      requests.push(options);
      if(point==='response')await gate.promise;
      return{ok:true,text:async()=>{if(point==='body')await gate.promise;return'worker source';}};
    },
    document:{getElementById:()=>({})},setExportProgress(){},setExportProgressVisible(){},
  });
  for(const name of ['makeExportCancelledError','cancelCurrentExport','getSameOriginWorkerUrl','cancelGifWorkerLoad','getGifWorkerUrl'])vm.runInContext(extract(name),ctx);
  return{ctx,gate,timers,requests,created,revoked};
}

for(const point of ['response','body']){
  for(const ending of ['cancel','timeout']){
    const h=harness(point);
    const pending=h.ctx.getGifWorkerUrl();
    const rejected=assert.rejects(pending,ending==='cancel'?/Export cancelled/:/took too long/);
    await flush();
    assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].signal.aborted,false);
    assert.equal(h.timers.size,1);
    assert.equal([...h.timers.values()][0].ms,12000,'Deadline covers response and body');
    if(ending==='cancel')h.ctx.cancelCurrentExport();
    else [...h.timers.values()][0].fn();
    await rejected;
    assert.equal(h.requests[0].signal.aborted,true);
    assert.equal(h.timers.size,0);
    assert.equal(h.ctx.gifWorkerUrlPromise,null);
    assert.equal(h.ctx.gifWorkerLoadRequest,null);
    h.gate.resolve();await flush();
    assert.deepEqual(h.created,[],'A late abandoned response/body cannot allocate an object URL');
    h.ctx.exportCancelRequested=false;
    const retry=await h.ctx.getGifWorkerUrl();
    assert.equal(retry,'blob:worker-0');
    assert.equal(await h.ctx.getGifWorkerUrl(),retry,'Successful worker is cached');
    assert.equal(h.requests.length,2);
    assert.equal(h.timers.size,0);
  }
}

// A superseded request must not clear the newer promise or retain a URL if its
// underlying implementation delivers a result after cancellation.
{
  const h=harness();
  const first=deferred(),second=deferred();let count=0;
  h.ctx.getSameOriginWorkerUrl=()=>++count===1?first.promise:second.promise;
  const old=h.ctx.getGifWorkerUrl();const rejected=assert.rejects(old,/Export cancelled/);
  h.ctx.cancelGifWorkerLoad();
  const current=h.ctx.getGifWorkerUrl();const currentPromise=h.ctx.gifWorkerUrlPromise;
  first.resolve('blob:abandoned');await rejected;
  assert.equal(h.ctx.gifWorkerUrlPromise,currentPromise);
  assert.deepEqual(h.revoked,['blob:abandoned']);
  second.resolve('blob:current');assert.equal(await current,'blob:current');
  assert.equal(await h.ctx.getGifWorkerUrl(),'blob:current');
}

// An already-aborted caller must not even start the request.
{
  const h=harness();const controller=new AbortController();controller.abort();
  await assert.rejects(h.ctx.getSameOriginWorkerUrl('worker.js',{signal:controller.signal}),/Export cancelled/);
  await flush();assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);
}

console.log('PASS export worker: response/body deadlines, immediate cancellation, abort-insensitive transports, retry/cache identity, late URL cleanup and already-cancelled callers.');
