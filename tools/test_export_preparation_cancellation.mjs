// Exercise the actual export entry point and its existing shared-request wrapper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=['09-raster-lifecycle','17-export-encoding'].map(name=>fs.readFileSync(new URL(`app/runtime/${name}.js`,import.meta.url),'utf8')).join('\n');
function extract(name){const found=source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    }`));assert.ok(found,`Missing ${name}`);return found[0];}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
for(const phase of ['availability','archive','libraries'])for(const late of ['resolve','reject']){
  const old=deferred(),next=deferred(),timers=new Map(),events=[];let timerId=0,attempt=0,status='';
  const context=vm.createContext({Promise,Error,exportInProgress:false,exportCancelRequested:false,
    EXPORT_PNG_SELECTION_LIMIT:80,floodFrameState:'ready',window:{setInterval(fn,ms){assert.equal(ms,80);timers.set(++timerId,fn);return timerId;},clearInterval(id){timers.delete(id);}},
    document:{getElementById:()=>({get textContent(){return status;}})},console:{error:error=>{throw error;}},
    stopPlayback(){},getDownloadScopeValue:()=>phase==='libraries'?'current':'range',syncDownloadRangeInputs(){},getDownloadFormatValue:()=> 'png',
    validateDownloadRangeForExport:()=>({ok:true,range:{startDate:new Date(),endDate:new Date()}}),exportRangeNeedsObservedArchive:()=>true,
    setDownloadModalOpen(){},setDownloadBusy(busy,message){context.exportInProgress=busy;if(busy){context.exportCancelRequested=false;attempt++;}events.push({attempt,busy,message});},
    ensureExportArchiveAvailability:()=>phase==='availability'&&attempt===1?old.promise:Promise.resolve(),
    ensureObservedArchiveRange:()=>phase==='archive'&&attempt===1?old.promise:Promise.resolve(),
    ensureExportLibraries:()=>phase==='libraries'&&attempt===1?old.promise:Promise.resolve(),
    throwIfExportCancelled(){if(context.exportCancelRequested){const error=new Error('Export cancelled.');error.name='AbortError';throw error;}},
    getDownloadFrameItems:()=>[{entry:{}}],setExportProgress(){},getDownloadAspectValue:()=> '1:1',
    setDownloadStatus(message){status=message;},exportPng:()=>attempt===2?next.promise:Promise.resolve(),
    isExportCancelledError:error=>error.name==='AbortError',finishCancelledExportProgress:message=>events.push({attempt,cancelled:message}),
    finishExportProgress:message=>events.push({attempt,finished:message}),updateDownloadSummary(){},toast(){},
  });
  for(const name of ['awaitRasterRequest','downloadCurrentSelection'])vm.runInContext(extract(name),context);
  const first=context.downloadCurrentSelection();await flush();assert.equal(context.exportInProgress,true);assert.equal(timers.size,1);
  context.exportCancelRequested=true;for(const tick of [...timers.values()])tick();await first;
  assert.equal(context.exportInProgress,false,'Cancellation completes before the shared transport settles');assert.equal(timers.size,0,'Cancellation poll is cleared');assert.equal(status,'Export cancelled.');
  const second=context.downloadCurrentSelection();await flush();assert.equal(context.exportInProgress,true);const count=events.length;const nextStatus=status;
  late==='resolve'?old.resolve():old.reject(new Error('Late transport failure'));await flush();
  assert.equal(events.length,count,'An abandoned task cannot finish or clear the newer export');assert.equal(status,nextStatus);assert.equal(context.exportInProgress,true);assert.equal(timers.size,0);
  next.resolve();await second;assert.equal(context.exportInProgress,false);assert.equal(status,'Downloaded PNG export.');
}
console.log('PASS preparation cancellation: all three shared waits cancel before transport settlement, clear polls, absorb late failures, and preserve newer exports (six cases).');
