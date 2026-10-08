// Exercise real renderers with controlled network/decoding delays and request races.
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..'), results=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const handled=p=>{p.catch(()=>{});return p;};
function fixture(html){
 const plans=new Map(),layers=new Set(),nodes=new Map(),labels=[];
 class FakeImage {constructor(){this.complete=false;this.naturalWidth=0;this.style={opacity:'0'};this.decoded=false;}set src(url){this._src=url;const p=plans.get(url)||{};setTimeout(()=>{if(p.fail){this.onerror?.();return;}this.complete=true;this.naturalWidth=128;this.onload?.();},p.ms??20);}get src(){return this._src;}async decode(){const p=plans.get(this._src)||{};await sleep(p.decodeMs??20);if(p.decodeFail)throw Error('bad decode');this.decoded=true;}}
 class Layer{constructor(url,options={}){this._url=url;this.options=options;this.events=new Map();this._image=new FakeImage();this._image.style.opacity=String(options.opacity??0);}once(type,fn){return this.on(type,fn,true);}on(type,fn,once=false){const list=this.events.get(type)||[];list.push({fn,once});this.events.set(type,list);return this;}off(type,fn){this.events.set(type,(this.events.get(type)||[]).filter(v=>v.fn!==fn));}fire(type,arg){for(const v of [...(this.events.get(type)||[])]){if(v.once)this.off(type,v.fn);v.fn(arg);}return this;}addTo(map){layers.add(this);this._map=map;this._image.onload=()=>this.fire('load');this._image.onerror=()=>this.fire('error');this._image.src=this._url;return this;}getElement(){return this._image;}setOpacity(o){this._image.style.opacity=String(o);return this;}}
 const map={hasLayer:l=>layers.has(l),removeLayer(l){layers.delete(l);l._map=null;l.fire('remove');},fitBounds(){},setZoom(){},getZoom:()=>12,getMaxZoom:()=>22};
 const old=new Layer('old',{opacity:.75});old._image.complete=true;old._image.naturalWidth=128;old._image.decoded=true;layers.add(old);old._map=map;
 const ctx=vm.createContext({console,Image:FakeImage,setTimeout,clearTimeout,requestAnimationFrame:cb=>setTimeout(()=>cb(performance.now()),1),performance,
  window:{setTimeout,clearTimeout,setInterval,clearInterval},document:{body:{dataset:{initialFloodFrame:'ready'},classList:{contains:()=>false,toggle(){}}},getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'0',textContent:'',style:{},setAttribute(){},classList:{contains:()=>false,toggle(){}}});return nodes.get(id);}},
  currentSeriesHours:[{stage:0},{stage:1},{stage:2},{stage:null}],currentRawSeriesHours:[],currentHourIndex:0,lastRenderToken:0,currentFloodLayer:old,pendingFloodLayer:null,renderedFloodPixelCache:null,preloadPromiseCache:new Map(),exportCancelRequested:false,exportInProgress:false,
  map,mapHasFit:true,floodLatLngBounds:[[0,0],[1,1]],floodOverlayGeometryMode:'axis-aligned',overlayOpacity:.75,floodFrameState:'ready',currentDataMode:'forecast',currentOverlayMode:'depth',
  L:{imageOverlay:(url,bounds,options)=>new Layer(url,options),latLngBounds:b=>b},createHydraulicImageOverlay:(url,options)=>new Layer(url,options),getStageValue:e=>e.stage,getOverlayStage:s=>s,getHydraulicPhaseForEntry:()=> 'rising',getPhysicsAssetForEntry:()=>null,
  getOverlayRecord:async(mode,stage)=>({url:'frame-'+stage,filename:'frame-'+stage}),getHydraulicOverlayRecord:async(mode,stage)=>({url:'frame-'+stage,filename:'frame-'+stage}),
  retainRasterObjectUrl:()=>()=>{},scheduleRasterObjectUrlCleanup(){},cancelTimelineSelection(){},toast(){},ensureMap(){},ensureOverlayBounds:async()=>{},markInitialFloodFrameReady(){},markInitialFloodFrameFailed(){},setFloodFrameStatus(){},updatePersistentDepthQueryPopup(){},getBoundaryDrivenOverlayBounds:()=>null,fitConfiguredInitialMapView(){},
  renderSelectionMeta(e){labels.push(e.stage);},renderTimelineMeta(){},updateNsiStructureImpactLayer(){},updateSliderProgress(){},hasDisplayedLongGaugeOutage:()=>false,GAUGE_OUTAGE_THRESHOLD_HOURS:72,renderLegend(){},buildNotes:()=>'',scheduleOverlayCatalogWarmup(){},preloadAroundHour(){}});
 for(const name of ['decodeFloodFrameImage','preloadImage','clearFloodLayer','waitForFloodOverlayLoad','setFloodLayer','renderHour']){
  const match=html.match(new RegExp('    (?:async )?function '+name+'\\([^\\n]*\\) \\{[\\s\\S]+?\\n    }'));
  if(match)new vm.Script(match[0]).runInContext(ctx);
 }
 return {ctx,plans,layers,labels,old};
}
for(const row of [{repository:'North Wildwood'}]){
 try{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  let f=fixture(html);f.plans.set('frame-1',{ms:30,decodeMs:40});const task=handled(f.ctx.renderHour(1));await sleep(10);assert.equal(f.ctx.currentFloodLayer,f.old,'previous frame disappeared during loading');assert.equal(f.labels.length,0,'timestamp changed before frame');await sleep(35);assert.equal(f.ctx.currentFloodLayer,f.old,'previous frame disappeared during decoding');await task;assert.equal(f.ctx.currentFloodLayer._url,'frame-1');assert.equal(f.ctx.currentFloodLayer._image.decoded,true);assert.equal(f.labels.at(-1),1);
  f=fixture(html);f.plans.set('frame-1',{ms:60,decodeMs:30});f.plans.set('frame-2',{ms:5,decodeMs:5});const slow=handled(f.ctx.renderHour(1));await sleep(5);const fast=handled(f.ctx.renderHour(2));await Promise.all([slow,fast]);assert.equal(f.ctx.currentFloodLayer._url,'frame-2','late response replaced latest selection');assert.equal(f.labels.at(-1),2);
  f=fixture(html);f.plans.set('frame-1',{fail:true,ms:1});await f.ctx.renderHour(1);assert.equal(f.ctx.currentFloodLayer,null,'failed frame was presented as valid');
  f=fixture(html);await f.ctx.renderHour(3);assert.equal(f.ctx.currentFloodLayer,null,'missing data retained a misleading map');assert.equal(f.labels.at(-1),null);
  f=fixture(html);f.plans.set('retry',{fail:true,ms:1});assert.equal(await f.ctx.preloadImage('retry'),null);await sleep(1);f.plans.set('retry',{ms:1,decodeMs:1});assert.equal(await f.ctx.preloadImage('retry'),'retry','failed preload was permanently cached');
  results.push({repository:row.repository,passed:true});
 }catch(e){results.push({repository:row.repository,passed:false,error:e.stack});console.log('FAIL',row.repository,e.message);}
}
console.log('TRANSITIONS',results.filter(r=>r.passed).length,'/',results.length);if(results.some(r=>!r.passed))process.exitCode=1;
