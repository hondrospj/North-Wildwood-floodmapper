import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {setNativeExportRange,reviewNativeExport,exportSelectionSnapshot,findNativeBuildingRoof,retryNativeParcelSource3d} from './helpers/north_wildwood_deep_export_browser.mjs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
  ...(name==='edge'?{channel:'msedge'}:{}),
  ...(name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
  ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
const output=process.env.NWW_AUDIT_OUTPUT;const result={browser:name,version:browser.version(),checks:[],errors:[],downloads:[]};
const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
page.on('pageerror',error=>result.errors.push(error.message));
try{
  await page.goto(process.env.NWW_TEST_URL||'http://127.0.0.1:9022/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&floodFrameState==='ready',{},{timeout:90000});
  if(await page.locator('#roadsToggle').evaluate(el=>el.classList.contains('on')))await page.locator('#roadsToggle').click();
  const range=await page.evaluate(()=>{
    const rows=getForecastExportEntries().filter(entry=>entryTimeMs(entry)%3600000===0);
    const date=getEntryESTDate(rows[3]),time=date.getTime();
    return {start:new Date(time+15*60000).toISOString(),emptyEnd:new Date(time+45*60000).toISOString(),end:new Date(time+3600000).toISOString(),gifEnd:new Date(time+2*3600000).toISOString()};
  });
  await page.locator('#openDownloadModalBtn').click();await page.locator('#exportFormatPngBtn').click();
  await setNativeExportRange(page,range.start,range.emptyEnd);await reviewNativeExport(page);
  await page.locator('#exportIntervalHourlyBtn').click();
  await page.waitForFunction(()=>exportPreview.dataset.state==='empty',{},{timeout:180000});
  result.empty=await exportSelectionSnapshot(page);assert.deepEqual(result.empty.items,[]);assert.match(result.empty.previewMessage,/No frames/);
  const unexpected=[];const onDownload=file=>unexpected.push(file.suggestedFilename());page.on('download',onDownload);
  await page.locator('#downloadBtn').click();
  await page.waitForFunction(()=>!exportInProgress&&downloadStatus.textContent.includes('No frames'),{},{timeout:30000});
  assert.match(await page.locator('#downloadStatus').textContent(),/No frames/);assert.deepEqual(unexpected,[]);page.off('download',onDownload);
  result.checks.push('No clock-hour range shows an empty preview and rejects download without producing a file');
  await page.waitForFunction(()=>exportProgressOverlay.hidden,{},{timeout:10000});
  for(const [format,end] of [['png',range.end],['gif',range.gifEnd]]){
    await page.locator('#openDownloadModalBtn').click();await page.locator(format==='png'?'#exportFormatPngBtn':'#exportFormatGifBtn').click();
    await setNativeExportRange(page,range.start,end);await reviewNativeExport(page);await page.locator('#exportIntervalHourlyBtn').click();
    await page.waitForFunction(()=>['ready','error'].includes(exportPreview.dataset.state),{},{timeout:180000});
    const snapshot=await exportSelectionSnapshot(page);assert.equal(snapshot.preview,'ready');
    assert.equal(snapshot.items.length,format==='png'?1:2);assert.equal(Date.parse(snapshot.items[0].time),Date.parse(range.end));
    assert.ok(snapshot.items.every(item=>Date.parse(item.time)>=Date.parse(range.start)&&Date.parse(item.time)<=Date.parse(end)));
    result[format]=snapshot;
    const receive=page.waitForEvent('download',{timeout:240000});await page.locator('#downloadBtn').click();const file=await receive;
    result.downloads.push(file.suggestedFilename());if(output){fs.mkdirSync(output,{recursive:true});await file.saveAs(path.join(output,file.suggestedFilename()));}
    await page.waitForFunction(()=>!exportInProgress,{},{timeout:30000});await page.waitForFunction(()=>exportProgressOverlay.hidden,{},{timeout:10000});
    result.checks.push(`${format.toUpperCase()} exports only native hourly readings inside fractional start and inclusive end`);
  }
  result.capability=await page.evaluate(()=>{
    const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2');
    if(gl)gl.getExtension('WEBGL_lose_context')?.loseContext();
    return {webgl2:!!gl};
  });
  await page.locator('#buildingsToggle').click();
  await page.locator('.nw-simple-view').click();
  if(result.capability.webgl2){
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.state().buildingsVisible,{},{timeout:90000});
    // Frame the target roof explicitly for the hit test.
    await page.evaluate(()=>NORTH_WILDWOOD_3D.getMap().jumpTo({center:[-74.7970066,39.011446],zoom:18}));
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().areTilesLoaded(),{},{timeout:90000});
    const roof=await findNativeBuildingRoof(page,'34009_118023');assert.ok(roof,'327 W Chestnut roof is rendered');assert.equal(roof.properties.address,'327 W CHESTNUT AVE');
    await page.mouse.click(...roof.point);await page.waitForFunction(()=>document.querySelector('.maplibregl-popup')?.textContent.includes('327 W CHESTNUT AVE'),{},{timeout:30000});
    result.building={roof,popup:await page.locator('.maplibregl-popup').innerText()};assert.doesNotMatch(result.building.popup,/329 W CHESTNUT/);
    if(output)await page.screenshot({path:path.join(output,'correct-3d-building.png')});
    result.checks.push('Native pitched-roof click opens 327 W Chestnut rather than its neighboring parcel');
    const retryPage=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
    retryPage.on('pageerror',error=>result.errors.push(error.message));
    result.parcelRetry=await retryNativeParcelSource3d(retryPage,process.env.NWW_TEST_URL||'http://127.0.0.1:9022/index.html');
    assert.ok(result.parcelRetry.after.imageWidth>0);assert.equal(result.parcelRetry.after.visibility,'visible');
    assert.ok(result.parcelRetry.requests.length>=3,'Failed GL request, decoded Leaflet image, and same-URL GL retry are distinct requests');
    await retryPage.close();result.checks.push('A failed hidden 3D parcel image retries the same URL on native Parcels enable');
  }else{
    await page.waitForFunction(()=>document.body.dataset.map3d==='fallback'&&!document.body.classList.contains('map-3d-ready')&&floodFrameState==='ready'&&map.hasLayer(currentFloodLayer),{},{timeout:90000});
    result.capability.reason='This isolated headless engine does not expose WebGL2; 3D roof and GPU-source tests were not run.';
    result.capability.geometryInvariants='Covered by tools/test_north_wildwood_deep_export.mjs; this fallback does not count as a 3D roof-click pass.';
    result.checks.push('WebGL2 unavailable: verified the usable 2D flood-map fallback');
  }
  assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.stack;result.finalState=await page.evaluate(()=>({status:downloadStatus.textContent,busy:exportInProgress,preview:exportPreview.dataset.state,progress:exportProgressMessage.textContent})).catch(()=>null);throw error;}finally{await browser.close();if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'deep-export-browser.json'),JSON.stringify(result,null,2));}console.log(JSON.stringify(result,null,2));}
