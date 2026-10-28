import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('app/runtime/15-export-capture.js',import.meta.url),'utf8');
const fn=source.match(/async function waitForExportChromeReady\([^]*?\n    }/)?.[0];
assert.ok(fn,'Test the authoring source directly');
const PNG='data:image/png;base64,prepared-logo',JPEG='https://example.test/brand.jpg';
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
function fixture({initial=JPEG,visible=true,decode=true}={}){
 let now=0,id=0,cancelled=false,settled=false;
 const timers=new Map(),events=new Map(),assignments=[],decodeStates=[],loads=[];
 const img={id:'exportPartnerLogo',dataset:{exportBrandSrc:JPEG},style:{display:visible?'':'none'},
  classList:{contains:()=>visible,add:()=>{visible=true;}},complete:true,naturalWidth:1614,naturalHeight:640,currentSrc:initial,
  getAttribute:name=>name==='src'?img.src:null,
  addEventListener(type,callback){if(!events.has(type))events.set(type,new Set());events.get(type).add(callback);},
  removeEventListener(type,callback){events.get(type)?.delete(callback);},
 };
 let assigned=initial;
 Object.defineProperty(img,'src',{get:()=>assigned,set:value=>{
  assignments.push({value,listening:events.get('load')?.size||0,errorListening:events.get('error')?.size||0});
  assigned=value;img.complete=false;
 }});
 const fire=type=>{for(const callback of [...events.get(type)||[]])callback();};
 const load=(value=img.src,width=1614,height=640)=>{img.currentSrc=value;img.complete=true;img.naturalWidth=width;img.naturalHeight=height;fire('load');};
 if(decode)img.decode=()=>{decodeStates.push({currentSrc:img.currentSrc,complete:img.complete,width:img.naturalWidth});return Promise.resolve();};
 const canvas={getContext:()=>({drawImage(){}}),toDataURL:()=>PNG};
 const ctx=vm.createContext({Promise,Error,
  setTimeout:(callback,delay)=>{const key=++id;timers.set(key,{callback,at:now+delay,delay,repeat:false});return key;},
  clearTimeout:key=>timers.delete(key),
  setInterval:(callback,delay)=>{const key=++id;timers.set(key,{callback,at:now+delay,delay,repeat:true});return key;},
  clearInterval:key=>timers.delete(key),
  document:{getElementById:key=>key==='exportPartnerLogo'?img:null,createElement:()=>canvas},
  throwIfExportCancelled(){if(cancelled)throw Object.assign(new Error('Cancelled'),{name:'AbortError'});},
  getExportImageElement:async url=>{loads.push(url);return{naturalWidth:1614,naturalHeight:640};},
  setExportLogoImage(key,value){assert.equal(key,img.id);img.src=value;visible=true;img.style.display='';},
 });
 vm.runInContext(fn,ctx);
 const run=()=>{settled=false;const promise=ctx.waitForExportChromeReady();promise.then(()=>{settled=true;},()=>{settled=true;});return promise;};
 function tick(amount){const until=now+amount;while(true){const due=[...timers].filter(([,timer])=>timer.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;const[key,timer]=due;now=timer.at;if(timer.repeat)timer.at+=timer.delay;else timers.delete(key);timer.callback();}now=until;}
 const cleanup=()=>{assert.equal(timers.size,0,'All timeout/cancel timers must be removed');for(const listeners of events.values())assert.equal(listeners.size,0,'All native image listeners must be removed');};
 return{ctx,img,canvas,run,tick,fire,load,cleanup,assignments,decodeStates,loads,timers,
  settled:()=>settled,cancel:()=>{cancelled=true;}};
}
// An existing JPEG remains current after assigning PNG. Old/wrong load events
// cannot start decode or resolve capture; listeners must predate assignment.
{
 const f=fixture(),job=f.run();await flush();
 assert.equal(f.assignments.length,1);assert.equal(f.assignments[0].value,PNG);
 assert.ok(f.assignments[0].listening&&f.assignments[0].errorListening);
 assert.equal(f.decodeStates.length,0);assert.equal(f.settled(),false);
 f.load(JPEG);await flush();assert.equal(f.decodeStates.length,0);assert.equal(f.settled(),false);
 f.load('data:image/png;base64,wrong');await flush();assert.equal(f.settled(),false);
 f.load();await job;assert.equal(f.decodeStates.length,1);assert.equal(f.decodeStates[0].currentSrc,PNG);f.cleanup();
 assert.equal(f.canvas.width,1);assert.equal(f.canvas.height,1);
 await f.run();assert.equal(f.loads.length,1,'A ready inlined logo must not refetch');assert.equal(f.assignments.length,1);f.cleanup();
}
// The empty partner is materialized first, so its live node never requests the
// raw JPEG and still receives the expected visibility/branding initialization.
{
 const f=fixture({initial:'',visible:false}),job=f.run();await flush();
 assert.deepEqual(f.loads,[JPEG]);assert.deepEqual(f.assignments.map(row=>row.value),[PNG]);
 assert.equal(f.img.classList.contains('is-visible'),true);f.load();await job;f.cleanup();
}
// Invalid source errors, a changed source, zero dimensions and a genuine native
// decode rejection remain failures. No EncodingError may be silently swallowed.
for(const mode of ['image-error','changed-source','decode-error','zero-size']){
 const f=fixture(),job=f.run();await flush();
 const encoding=new DOMException('Invalid image request.','EncodingError');
 if(mode==='image-error')f.fire('error');
 if(mode==='changed-source'){f.img.src='data:image/png;base64,changed';f.load();}
 if(mode==='decode-error'){f.img.decode=()=>Promise.reject(encoding);f.load();}
 if(mode==='zero-size'){f.load(PNG,0,0);f.tick(20000);}
 await assert.rejects(job,error=>mode==='decode-error'?error===encoding:/logo could not load/.test(error.message));f.cleanup();
}
// A stalled replacement and a stalled decoder each retain the existing 20s
// native image deadline. Neither old positive dimensions nor decode alone wins.
for(const decoding of [false,true]){
 const f=fixture(),job=f.run();await flush();
 if(decoding){f.img.decode=()=>new Promise(()=>{});f.load();}
 f.tick(19999);await flush();assert.equal(f.settled(),false);
 f.tick(1);await assert.rejects(job,/logo could not load/);f.cleanup();
}
for(const decoding of [false,true]){
 const f=fixture(),job=f.run();await flush();
 if(decoding){f.img.decode=()=>new Promise(()=>{});f.load();}
 f.cancel();f.tick(100);await assert.rejects(job,error=>error.name==='AbortError');f.cleanup();
}
// Without decode(), exact-source native load plus positive dimensions still
// satisfies readiness. A cached data URL can also already be loading.
for(const decode of [false,true]){
 const f=fixture({initial:PNG,decode});f.img.complete=false;f.img.currentSrc=JPEG;
 const job=f.run();await flush();assert.equal(f.settled(),false);assert.equal(f.assignments.length,0);
 f.load();await job;assert.equal(f.loads.length,0);f.cleanup();
}
{
 const f=fixture();f.ctx.getExportImageElement=async()=>null;
 await assert.rejects(f.run(),/logo could not load/);f.cleanup();
}
console.log('PASS export logo readiness: exact-source load before decode, inline-once branding, stale/wrong loads, native errors, 20s stalls, 100ms cancellation and cleanup.');
