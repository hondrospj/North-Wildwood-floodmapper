// Native export controls, real archive/library transports, and a real retry ZIP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium',isChromium=['chromium','edge'].includes(name);
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
  ...(isChromium&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:
    name==='edge'?{channel:'msedge'}:name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(isChromium?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const retained=process.env.NWW_AUDIT_OUTPUT,output=retained||fs.mkdtempSync(path.join(os.tmpdir(),'nww-preparation-'));
fs.mkdirSync(output,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],states:[],requests:[],errors:[]};
const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York',acceptDownloads:true});
page.setDefaultTimeout(30000);page.on('pageerror',error=>result.errors.push(error.message));
let phase='preview',archiveRoute=null,libraryRoute=null,archiveReleased=false,libraryReleased=false,downloads=0;
page.on('download',()=>downloads++);
const state=label=>page.evaluate(label=>({label,busy:exportInProgress,cancelRequested:exportCancelRequested,
  disabled:document.getElementById('exportProgressCloseBtn').disabled,
  message:document.getElementById('exportProgressMessage').textContent,status:document.getElementById('downloadStatus').textContent,
  appInert:document.getElementById('app').inert,focus:document.activeElement.id}),label);
async function chooseRange(dates){
  for(const[index,cap]of ['Start','End'].entries()){
    await page.locator(`#download${cap}DateText`).fill(dates[index].date);
    await page.locator(`#download${cap}DateText`).press('Tab');
    await page.locator(`#download${cap}TimeButton`).click();
    await page.locator(`#nwwExportDateTimePicker [data-value="${dates[index].time}"]`).click();
  }
}
async function review(){
  await page.waitForFunction(()=>['ready','empty','error'].includes(document.getElementById('exportPreview').dataset.state),{},{timeout:180000});
  assert.equal((await page.locator('#downloadBtnLabel').textContent()).trim(),'More options');
  await page.locator('#downloadBtn').click();
}
async function cancelWhileHeld(label){
  await page.locator('#exportProgressCloseBtn').click();
  await page.waitForFunction(()=>!exportInProgress,{},{timeout:3000,polling:25});
  await page.waitForFunction(()=>document.getElementById('exportProgressOverlay').hidden,{},{timeout:3000});
  const snapshot=await state(label);result.states.push(snapshot);
  assert.equal(snapshot.message,'Export cancelled.');assert.equal(snapshot.appInert,false);assert.equal(snapshot.focus,'openDownloadModalBtn');
  assert.equal(downloads,0,'A cancelled export must not download');
}
try{
  await page.route('**/observed_archive/stone-harbor/2025.json*',route=>{
    result.requests.push({kind:'archive',phase,url:route.request().url()});
    if(phase==='archive-export'){assert.equal(archiveRoute,null);archiveRoute=route;return;}
    return route.fulfill({status:503,body:'Deliberate archive outage'});
  });
  await page.route('**/stone_harbor_observed15min.json*',route=>route.fulfill({status:503,body:'Deliberate fallback outage'}));
  await page.route('**/jszip@3.10.1/dist/jszip.min.js',route=>{
    result.requests.push({kind:'library',phase,url:route.request().url()});
    if(!libraryReleased){assert.equal(libraryRoute,null);libraryRoute=route;return;}
    return route.continue();
  });
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  if(await page.locator('#roadsToggle').getAttribute('aria-checked')==='true')await page.locator('#roadsToggle').click();
  await page.locator('#openDownloadModalBtn').click();
  await page.locator('#exportFormatPngBtn').click();
  await chooseRange([{date:'11/02/2025',time:'12:00'},{date:'11/02/2025',time:'12:00'}]);
  await review();assert.ok(result.requests.some(request=>request.kind==='archive'&&request.phase==='preview'));
  phase='archive-export';await page.locator('#downloadBtn').click();
  for(let i=0;i<100&&!archiveRoute;i++)await page.waitForTimeout(50);
  assert.ok(archiveRoute,'Real Download must reach the held archive retry');
  await cancelWhileHeld('archive cancelled before response');assert.equal(archiveReleased,false);
  result.checks.push('Native Cancel completes while the actual archive request remains held and restores keyboard access');

  phase='library-export';await page.locator('#openDownloadModalBtn').click();
  const dates=await page.evaluate(()=>getForecastExportEntries().slice(5,7).map(entry=>{
    const date=getEntryESTDate(entry),parts=getNyParts(date);
    return{date:`${parts.month}/${parts.day}/${parts.year}`,time:formatNyLocalIso(date).slice(11)};
  }));
  await chooseRange(dates);await review();
  assert.equal(await page.evaluate(()=>getDownloadFrameItems().length),2);
  await page.locator('#downloadBtn').click();
  for(let i=0;i<100&&!libraryRoute;i++)await page.waitForTimeout(50);
  assert.ok(libraryRoute,'The next export must reach the real JSZip request');
  const beforeLate=await state('new export waiting for library');assert.equal(beforeLate.busy,true);
  archiveReleased=true;await archiveRoute.fulfill({status:503,body:'Late archive failure'});
  await page.waitForTimeout(200);
  const afterLate=await state('old archive rejected during newer export');result.states.push(afterLate);
  assert.equal(afterLate.busy,true);assert.equal(afterLate.status,beforeLate.status);assert.equal(afterLate.message,beforeLate.message);
  result.checks.push('A late failed archive from a cancelled attempt cannot clear or overwrite the newer export');
  await cancelWhileHeld('library cancelled before response');assert.equal(libraryReleased,false);
  result.checks.push('Native Cancel also completes while the actual optional-library request remains held');
  const cancelledStatus=await page.locator('#downloadStatus').textContent();
  libraryReleased=true;await libraryRoute.fulfill({status:503,body:'Late JSZip failure'});
  await page.waitForFunction(()=>document.body.dataset.exportLibraries==='unavailable',{},{timeout:5000});
  assert.equal(await page.evaluate(()=>exportInProgress),false);assert.equal(await page.locator('#downloadStatus').textContent(),cancelledStatus);assert.equal(downloads,0);
  result.checks.push('A late optional-library rejection is handled without a download or stale export state');

  phase='retry';await page.locator('#openDownloadModalBtn').click();await chooseRange(dates);await review();
  const downloading=page.waitForEvent('download',{timeout:240000});downloading.catch(()=>{});
  await page.locator('#downloadBtn').click();const download=await downloading;
  const file=path.join(output,download.suggestedFilename());await download.saveAs(file);assert.equal(await download.failure(),null);
  const bytes=fs.readFileSync(file);assert.equal(bytes.readUInt32LE(0),0x04034b50,'Retry must produce a real ZIP');
  assert.equal(bytes.readUInt16LE(bytes.length-12),2,'ZIP must contain both selected PNG frames');
  await page.waitForFunction(()=>!exportInProgress,{},{timeout:90000});assert.equal(downloads,1);
  result.download={file:path.basename(file),bytes:bytes.length};result.states.push(await state('retry complete'));
  result.checks.push('The same page retries the failed library and downloads both selected PNG frames');
  assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.stack;result.states.push(await state('failure').catch(()=>({label:'page unavailable'})));if(retained)await page.screenshot({path:path.join(output,`${name}-preparation-failure.png`)}).catch(()=>{});throw error;}
finally{await browser.close();if(retained)fs.writeFileSync(path.join(output,`${name}-preparation-browser.json`),JSON.stringify(result,null,2));else fs.rmSync(output,{recursive:true,force:true});console.log(JSON.stringify(result,null,2));}
