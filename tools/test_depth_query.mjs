import { readAppSource } from './app_source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=readAppSource(path.join(root,'index.html'));
const extract=name=>{
  const match=html.match(new RegExp('    (?:async )?function '+name+'\\([^]*?\\n    }'));
  assert.ok(match,`Missing ${name}`);return match[0];
};
// Parse the actual town configuration without evaluating the whole application.
const marker='TOWN_CONFIG = {';
const start=html.lastIndexOf(marker)+marker.length-1;
assert.ok(start>=marker.length-1,'Town configuration is missing');
let depth=0,quoted=false,escaped=false,end=-1;
for(let i=start;i<html.length;i++){
  const c=html[i];
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
  else if(c==='"')quoted=true;
  else if(c==='{')depth++;
  else if(c==='}'&&!--depth){end=i+1;break;}
}
const config=JSON.parse(html.slice(start,end));
const overlay=config.overlays||{};
assert.ok(overlay.depthQueryPngPath,'Clickable depth requires a configured packed query grid');
assert.ok(overlay.worldFileCornersWgs84||overlay.boundsWgs84,'Query grid georeferencing is missing');
assert.match(extract('samplePackedDepthGrid'),/latLngToDepthQueryPixel\(lat, lon, grid.width, grid.height\)/);
const rgba=new Uint8ClampedArray(4*4*4);
for(let i=0;i<16;i++){rgba[i*4]=128;rgba[i*4+1]=23;rgba[i*4+2]=85;rgba[i*4+3]=255;}
let affineCalls=0;
const context=vm.createContext({Number,Math,Promise,URL,Date,console,
  TOWN_CONFIG:{overlays:{boundsWgs84:{west:-75,east:-73,south:38,north:42}}},
  floodLatLngBounds:{},getDepthQueryGrid:async()=>({width:4,height:4,values:rgba}),
  getDevelopedQueryGrid:async()=>null,
  latLngToWorldFilePixel:()=>{affineCalls++;return{x:2,y:1,u:.5,v:.25};}
});
vm.runInContext(extract('latLngToDepthQueryPixel')+'\n'+extract('samplePackedDepthGrid'),context);
const mercY=lat=>Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
const fromMercY=y=>(2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;
const lat=fromMercY(mercY(42)*.625+mercY(38)*.375);
let point=context.latLngToDepthQueryPixel(lat,-74.25,4,4);
assert.equal(point.x,1);assert.equal(point.y,1);assert.equal(affineCalls,0);
let sample=await context.samplePackedDepthGrid(lat,-74.25);
assert.equal(sample.elevation,2.3);assert.equal(sample.connectionStage,3.5);
assert.equal(sample.developedFlag,false,'A site without a developed-land grid keeps its configured default');
context.getDevelopedQueryGrid=async()=>({width:3,height:4,values:rgba});
assert.equal((await context.samplePackedDepthGrid(lat,-74.25)).developedFlag,null,'A misaligned companion is unknown');
context.getDevelopedQueryGrid=async()=>{throw Error('Deliberate companion outage');};
assert.equal((await context.samplePackedDepthGrid(lat,-74.25)).developedFlag,null,'A failed companion is unknown');
context.getDevelopedQueryGrid=async()=>null;
vm.runInContext(extract('getDepthQueryDisplayDepth'),context);
context.normalizeStageValue=value=>value;
assert.equal(context.getDepthQueryDisplayDepth({developedFlag:null},3.9,{flooded:true}),null);
assert.equal(context.getDepthQueryDisplayDepth({developedFlag:null},3.9,{flooded:false}),0);
assert.equal(await context.samplePackedDepthGrid(45,-74.25),null);
assert.equal(context.latLngToDepthQueryPixel(NaN,-74.25,4,4),null);
assert.equal(context.latLngToDepthQueryPixel(lat,-73,4,4),null);
assert.equal(context.latLngToDepthQueryPixel(38,-74,4,4),null);
assert.equal(context.latLngToDepthQueryPixel(lat,-74,0,4),null);
rgba[(1*4+1)*4]=0;rgba[(1*4+1)*4+1]=0;
assert.equal(await context.samplePackedDepthGrid(lat,-74.25),null,'No-data must not become dry/zero depth');
context.TOWN_CONFIG.overlays.worldFileCornersWgs84={northWest:[42,-75]};
point=context.latLngToDepthQueryPixel(lat,-74.25,4,4);
assert.equal(point.x,2);assert.equal(point.y,1);assert.equal(affineCalls,1);
delete context.TOWN_CONFIG.overlays.worldFileCornersWgs84;
context.TOWN_CONFIG.overlays.boundsWgs84={west:-73,east:-75,south:38,north:42};
assert.equal(context.latLngToDepthQueryPixel(lat,-74.25,4,4),null);
// A rejected fetch must not permanently poison the cached query promise.
let calls=0,fail=true;
const recovery=vm.createContext({URL,Date,Promise,Error,
  DEPTH_QUERY_PNG_URL:'https://example.test/query.png',
  loadDepthQueryPng:async()=>{calls++;if(fail)throw Error('transient failure');return{width:4,height:4};}
});
vm.runInContext('let depthQueryGridPromise=null;\n'+extract('awaitRasterRequest')+'\n'+extract('getDepthQueryGrid'),recovery);
await assert.rejects(recovery.getDepthQueryGrid(),/transient failure/);
assert.equal(calls,2);fail=false;
assert.equal((await recovery.getDepthQueryGrid()).width,4);
assert.equal(calls,3);await recovery.getDepthQueryGrid();assert.equal(calls,3);
// The GeoTIFF fallback uses physical distances, including non-square cells.
const cogLatitude = 39;
const cogLongitude = -74.81;
const cogXStep = 2 / (364000 * Math.cos(cogLatitude * Math.PI / 180));
const cogYStep = 1 / 364000;
const cogWidth = 48;
const cogHeight = 48;
let cogTimer;
let cogSignal;
let rasterStalled = false;
let openedCogs = 0;
const cogImage = {
  getBoundingBox: () => [
    cogLongitude, cogLatitude - cogHeight * cogYStep,
    cogLongitude + cogWidth * cogXStep, cogLatitude
  ],
  getWidth: () => cogWidth,
  getHeight: () => cogHeight,
  async readRasters({window: [left, top, right, bottom], signal}) {
    cogSignal = signal;
    if (rasterStalled) return new Promise(() => {});
    const values = [];
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const bulkhead = x === 20 && y === 20;
        values.push(bulkhead ? 12 : 2.25, 7, 3.6, 0, Number(bulkhead), 0, 1);
      }
    }
    return values;
  }
};
const cogLibrary = { async fromUrl() { openedCogs++; return { getImage: async () => cogImage }; } };
const cog = vm.createContext({
  AbortController, DEPTH_QUERY_PNG_URL: '', DEPTH_QUERY_COG_URL: 'https://example.test/query.tif',
  GeoTIFF: cogLibrary,
  window: { GeoTIFF: cogLibrary, setTimeout(callback) { cogTimer = callback; }, clearTimeout() {} }
});
vm.runInContext([
  'let depthQueryImagePromise = null;',
  ...['awaitRasterRequest', 'readDepthCogWithDeadline', 'getDepthQueryImage',
    'sampleDepthModelFromCog', 'sampleDepthModel'].map(extract)
].join('\n'), cog);
const sampleCog = (x, y) => cog.sampleDepthModel(
  cogLatitude - (y + 0.5) * cogYStep, cogLongitude + (x + 0.5) * cogXStep
);
assert.equal((await sampleCog(13,14)).elevation, 12, 'Nearby bulkhead remains selectable');
assert.equal((await sampleCog(13,10)).elevation, 2.25, 'Diagonal outside radius uses actual terrain');
assert.equal((await sampleCog(11,20)).featureDistanceFt, null, 'A nine-pixel horizontal offset can exceed 16 feet');
assert.equal((await sampleCog(20,20)).featureDistanceFt, 0);
assert.equal(await sampleCog(-1,20), null);
rasterStalled = true;
const stalledCog = sampleCog(20,20);
await new Promise(resolve => setImmediate(resolve));
cogTimer();
await assert.rejects(stalledCog, { name: 'TimeoutError' });
assert.equal(cogSignal.aborted, true);
assert.equal(openedCogs, 1, 'A full timeout is not retried automatically');
rasterStalled = false;
assert.equal((await sampleCog(20,20)).elevation, 12);
assert.equal(openedCogs, 2, 'A later user retry reopens the failed raster');

// Compile every inline script, so a small query fix cannot break application startup.
let scripts=0;
for(const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(/\bsrc\s*=|application\/(?:ld\+)?json/i.test(match[1]))continue;
  new vm.Script(match[2],{filename:`index.html:inline-${++scripts}`});
}
if(process.argv.includes('--assets')){
  const url=overlay.depthQueryPngPath;
  if(/^https:\/\//.test(url)){
    assert.equal(new URL(url).origin,'https://hondrospj.github.io');
    const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
    assert.ok(response.ok,`Remote query grid HTTP ${response.status}`);
    const bytes=new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0,8)),[137,80,78,71,13,10,26,10]);
  }else{
    const local=path.resolve(root,decodeURIComponent(url.split('?')[0]));
    assert.ok(local.startsWith(root+path.sep),'Query file must stay in repository');
    const bytes=fs.readFileSync(local);
    assert.deepEqual(Array.from(bytes.subarray(0,8)),[137,80,78,71,13,10,26,10]);
  }
}
console.log(`PASS depth-query geometry, sampling, no-data, fetch recovery, configuration, ${scripts} scripts`);
