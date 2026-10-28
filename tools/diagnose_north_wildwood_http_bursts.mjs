// Diagnostic branch only. Actual file bytes, no browser, mocks or retries.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {performance} from 'node:perf_hooks';

const output=path.resolve('http-burst-diagnostic');fs.mkdirSync(output,{recursive:true});
const files=['assets/north-wildwood-font.css','assets/export-road-labels.js','assets/hydraulic-v29/COGs/North Wildwood/NorthWildwoodHydraulicQuery5ft.png'];
const sources=files.map(file=>{const body=fs.readFileSync(file);return{file,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};});
const servers=[{name:'stock-python',port:Number(process.env.NWW_DIAGNOSTIC_STOCK_PORT||8771)},{name:'snapshot-server',port:Number(process.env.NWW_DIAGNOSTIC_SNAPSHOT_PORT||8772)}];
const result={startedAt:new Date().toISOString(),diagnosticSha:process.env.NWW_DIAGNOSTIC_SHA,baseline:'6405fe5c3fff7712ee9473d83033c17b4557d3e6',
  scope:'Fresh TCP32/64-way real file bursts. No browser, mocks, cache, retries or app changes. Outcomes compare CI server transport only and establish no application causality.',
  environment:{platform:process.platform,node:process.version,cpus:os.cpus().length,memory:os.totalmem()},sources,bursts:[]};
function request(server,source,index,burst){
  return new Promise(resolve=>{
    const started=performance.now(),record={index,startedAt:new Date().toISOString()};let settled=false;
    const finish=extra=>{if(settled)return;settled=true;clearTimeout(timer);resolve({...record,...extra,elapsedMs:performance.now()-started});};
    const resource='/'+source.file.split('/').map(encodeURIComponent).join('/')+'?diagnostic='+burst+'-'+index;
    const req=http.get({host:'127.0.0.1',port:server.port,path:resource,agent:false,headers:{Connection:'close'}},res=>{
      record.headersMs=performance.now()-started;record.status=res.statusCode;record.httpVersion=res.httpVersion;
      record.headers={'content-length':res.headers['content-length'],'content-type':res.headers['content-type'],'cache-control':res.headers['cache-control']};
      const hash=crypto.createHash('sha256');let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;hash.update(chunk);});
      res.on('error',error=>finish({ok:false,error:error.code||error.message,bytes}));
      res.on('aborted',()=>finish({ok:false,error:'RESPONSE_ABORTED',bytes}));
      res.on('end',()=>{const sha256=hash.digest('hex');finish({ok:res.statusCode===200&&bytes===source.bytes&&sha256===source.sha256,bytes,sha256,bodyMatches:bytes===source.bytes&&sha256===source.sha256});});
    });
    req.on('error',error=>finish({ok:false,error:error.code||error.message}));
    const timer=setTimeout(()=>{req.destroy(Object.assign(new Error('Diagnostic request deadline15s'),{code:'DIAGNOSTIC_TIMEOUT'}));},15000);
  });
}
try{
  let burst=0;
  for(const concurrency of [32,64])for(const source of sources){
    const order=burst%2?[...servers].reverse():servers;
    for(const server of order){
      const started=performance.now(),records=await Promise.all(Array.from({length:concurrency},(_,index)=>request(server,source,index,burst)));
      const item={server:server.name,port:server.port,file:source.file,concurrency,elapsedMs:performance.now()-started,success:records.filter(r=>r.ok).length,failed:records.filter(r=>!r.ok).length,
        errors:records.filter(r=>!r.ok).reduce((a,r)=>(a[r.error||('HTTP'+r.status+'-bodymatch'+r.bodyMatches)]=(a[r.error||('HTTP'+r.status+'-bodymatch'+r.bodyMatches)]||0)+1,a),{}),records};
      result.bursts.push(item);console.log(JSON.stringify({...item,records:undefined}));
    }
    burst++;
  }
}finally{
  result.completedAt=new Date().toISOString();result.totals=servers.map(server=>{const bursts=result.bursts.filter(b=>b.server===server.name);return{server:server.name,success:bursts.reduce((a,b)=>a+b.success,0),failed:bursts.reduce((a,b)=>a+b.failed,0),bursts:bursts.length};});
  result.allBodiesThatCompletedMatch=result.bursts.every(b=>b.records.every(r=>r.bodyMatches!==false));
  result.complete=result.bursts.length===12;
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({complete:result.complete,allBodiesThatCompletedMatch:result.allBodiesThatCompletedMatch,totals:result.totals}));
  if(!result.complete||!result.allBodiesThatCompletedMatch)process.exitCode=1;
}
