// Full app: a pending worker request must cancel, restore keyboard access and
// permit an actual GIF download on the next attempt without reloading.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name=process.env.NWW_BROWSER || 'chromium';
const engine=playwright[name==='edge'?'chromium':name];
const browser=await engine.launch({headless:true,
  ...(name==='edge'?{channel:'msedge'}:{}),
  ...(name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
  ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const retained=process.env.NWW_AUDIT_OUTPUT;
const output=retained||fs.mkdtempSync(path.join(os.tmpdir(),'nww-worker-cancel-'));
fs.mkdirSync(output,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],states:[],errors:[],consoleErrors:[],consoleWarnings:[]};
const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
page.setDefaultTimeout(30000);page.on('pageerror',error=>result.errors.push(error.message));
const warningDetails=[];
page.on('console',message=>{
  if(message.type()==='error')result.consoleErrors.push(message.text());
  if(message.type()==='warning'){
    const entry={message:message.text(),errors:[]};result.consoleWarnings.push(entry);
    warningDetails.push(Promise.all(message.args().map(handle=>handle.evaluate(value=>
      value instanceof Error?{name:value.name,message:value.message,stack:value.stack}:null).catch(()=>null)))
      .then(errors=>{entry.errors=errors.filter(Boolean);}));
  }
});
let release;const gate=new Promise(resolve=>{release=resolve;});let requests=0;
const held=async route=>{requests++;await gate;await route.abort().catch(()=>{});};
await page.route('**/gif.worker.js',held);
const state=label=>page.evaluate(label=>({label,busy:exportInProgress,cancelled:exportCancelRequested,
  focus:document.activeElement.id,datum:currentDatum,message:document.getElementById('exportProgressMessage').textContent,
  appInert:document.getElementById('app').inert,buttonDisabled:document.getElementById('exportProgressCloseBtn').disabled,
  workerPending:!!gifWorkerLoadRequest,workerCached:!!gifWorkerUrlPromise,encoderPresent:!!activeGifExport,
  basemapLoading:exportBasemapColorLayer?.isLoading?.()??null,
  vectorLoaded:exportBasemapColorLayer?._maplibreGL?._glMap?.loaded?.()??null}),label);
async function requireReadyPreview(label){
  // A terminal preview error is actionable and must be diagnosed immediately,
  // rather than hidden behind a long wait for a state it cannot reach unaided.
  await page.waitForFunction(()=>['ready','error','empty'].includes(document.getElementById('exportPreview')?.dataset.state),{},{timeout:180000});
  const preview=await page.evaluate(()=>({state:document.getElementById('exportPreview')?.dataset.state,
    status:document.getElementById('exportPreviewStatus')?.textContent,
    retryVisible:!document.getElementById('exportPreviewRetryBtn')?.hidden,
    format:getDownloadFormatValue(),scope:getDownloadScopeValue(),range:validateDownloadRangeForExport(),
    libraries:document.body.dataset.exportLibraries}));
  result.states.push({label,...preview});
  await Promise.allSettled(warningDetails);
  assert.equal(preview.state,'ready',`Preview did not become ready: ${JSON.stringify({preview,warnings:result.consoleWarnings})}`);
}
const diagnostics=setInterval(()=>{
  state(`periodic-${Date.now()}`).then(snapshot=>{
    if(snapshot.busy)result.states.push(snapshot);
    if(retained)fs.writeFileSync(path.join(output,`${name}-worker-progress.json`),JSON.stringify(result,null,2));
  }).catch(()=>{});
},20000);
async function selectTwoFrameRange(){
  const end=await page.evaluate(()=>{
    const date=new Date(getRangeInputDate('downloadStartInput').getTime()+3600000),p=getNyParts(date);
    return{date:`${p.month}/${p.day}/${p.year}`,time:`${pad2(Number(p.hour24))}:${p.minute}`};
  });
  await page.locator('#downloadEndDateText').fill(end.date);
  await page.locator('#downloadEndTimeSelect').focus();
  await page.locator('#downloadEndTimeSelect').selectOption(end.time);
}
function inspectGif(bytes){
  assert.match(bytes.subarray(0,6).toString(),/^GIF8[79]a$/);
  const result={width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8),frames:[]};
  let offset=13+((bytes[10]&0x80)?3*(1<<((bytes[10]&7)+1)):0),delay=0;
  const blocks=()=>{while(offset<bytes.length){const length=bytes[offset++];if(!length)return;offset+=length;}throw Error('Truncated GIF');};
  while(offset<bytes.length){
    const marker=bytes[offset++];
    if(marker===0x3b)return result;
    if(marker===0x21){const type=bytes[offset++];if(type===0xf9)delay=bytes.readUInt16LE(offset+2)*10;blocks();}
    else if(marker===0x2c){const packed=bytes[offset+8];offset+=9;if(packed&0x80)offset+=3*(1<<((packed&7)+1));offset++;blocks();result.frames.push({delayMs:delay});delay=0;}
    else throw Error(`Unexpected GIF marker ${marker}`);
  }
  throw Error('Missing GIF trailer');
}
try{
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  // Isolate worker cancellation from the optional road-label provider. Use the
  // real UI; the basemap, flood renderer and downloaded GIF remain unmocked.
  if(await page.locator('#roadsToggle').getAttribute('aria-checked')==='true')await page.locator('#roadsToggle').click();
  assert.equal(await page.locator('#roadsToggle').getAttribute('aria-checked'),'false');
  await page.locator('#openDownloadModalBtn').click();
  await selectTwoFrameRange();
  await page.locator('#downloadBtn').click();
  await page.locator('#exportAspectSquareBtn').click();
  await requireReadyPreview('initial-preview');
  assert.equal(await page.evaluate(()=>getDownloadFrameItems().length),2);
  const datum=await page.evaluate(()=>currentDatum);
  await page.locator('#downloadBtn').click();
  for(let i=0;i<150&&!requests;i++)await page.waitForTimeout(100);
  assert.equal(requests,1);result.states.push(await state('worker-held'));
  assert.equal(await page.evaluate(()=>document.activeElement.id),'exportProgressCloseBtn');
  assert.equal(await page.locator('#exportProgressCloseBtn').textContent(),'Cancel');
  assert.ok(await page.locator('#exportProgressCloseBtn').evaluate(element=>parseFloat(getComputedStyle(element).fontSize)>0),'Cancel text must remain visible instead of a generic close glyph');
  for(let i=0;i<8;i++){
    await page.keyboard.press(i%2?'Shift+Tab':'Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'exportProgressCloseBtn');
  }
  await page.evaluate(()=>document.getElementById('datumNavd88Btn').focus());
  assert.equal(await page.evaluate(()=>document.activeElement.id),'exportProgressCloseBtn');
  assert.equal(await page.evaluate(()=>currentDatum),datum);
  result.checks.push('Blocking progress immediately focuses Cancel and prevents background keyboard/datum access');
  if(retained)await page.screenshot({path:path.join(output,`${name}-worker-held.png`)});
  await page.locator('#exportProgressCloseBtn').click();
  await page.waitForFunction(()=>!exportInProgress,{},{timeout:3000,polling:25});
  result.states.push(await state('cancelled'));
  assert.equal(await page.evaluate(()=>gifWorkerUrlPromise),null);
  assert.equal(await page.evaluate(()=>gifWorkerLoadRequest),null);
  await page.waitForFunction(()=>document.getElementById('exportProgressOverlay').hidden,{},{timeout:3000});
  assert.equal(await page.evaluate(()=>document.getElementById('app').inert),false);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'openDownloadModalBtn');
  result.checks.push('Cancel releases a stalled worker request within three seconds and restores focus/background access');
  release();await page.unroute('**/gif.worker.js',held);
  await page.locator('#openDownloadModalBtn').click();
  // Opening intentionally reseeds the range to the main timeline. Keep the
  // retry fixture at two frames as well, rather than encoding the full forecast.
  await selectTwoFrameRange();
  await page.locator('#downloadBtn').click();
  await requireReadyPreview('retry-preview');
  assert.equal(await page.evaluate(()=>getDownloadFrameItems().length),2);
  const downloading=page.waitForEvent('download',{timeout:240000});
  downloading.catch(()=>{});
  await page.locator('#downloadBtn').click();
  const failed=page.waitForFunction(()=>!exportInProgress &&
    !document.getElementById('downloadStatus').textContent.startsWith('Downloaded'),{},{timeout:240000,polling:100})
    .then(async()=>{throw new Error(`Retry export did not download: ${await page.locator('#downloadStatus').textContent()}`);});
  failed.catch(()=>{});
  const download=await Promise.race([downloading,failed]);
  const file=path.join(output,download.suggestedFilename());await download.saveAs(file);
  assert.equal(await download.failure(),null);
  const gif=inspectGif(fs.readFileSync(file));
  assert.deepEqual(gif,{width:1200,height:1200,frames:[{delayMs:1000},{delayMs:1000}]});
  result.gif={file:path.basename(file),bytes:fs.statSync(file).size,...gif};
  await page.waitForFunction(()=>!exportInProgress,{},{timeout:90000});
  result.states.push(await state('retry-downloaded'));
  result.checks.push('A fresh request after cancellation downloads a real two-frame GIF without reloading');
  assert.deepEqual(result.errors,[]);
}catch(error){
  result.failure=error.stack;
  result.states.push(await state('failure').catch(()=>({label:'page unavailable'})));
  if(retained)await page.screenshot({path:path.join(output,`${name}-failure.png`)}).catch(()=>{});
  throw error;
}
finally{
  clearInterval(diagnostics);
  await Promise.allSettled(warningDetails);
  release();await browser.close();
  if(retained)fs.writeFileSync(path.join(output,`${name}-worker-browser.json`),JSON.stringify(result,null,2));
  else fs.rmSync(output,{recursive:true,force:true});
  console.log(JSON.stringify(result,null,2));
}
