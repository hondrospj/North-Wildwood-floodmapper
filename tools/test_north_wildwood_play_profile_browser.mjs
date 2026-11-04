// Combine actual animation, replaced property popups and modal close. A stable
// fixture alone cannot cover the map's asynchronous popup refreshes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const playwright=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name=process.env.NWW_BROWSER || 'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
  ...(name==='edge'?{channel:'msedge'}:{}),
  ...(name==='chromium'&&!process.env.CHROME_PATH&&process.env.NWW_CHROMIUM_CHANNEL?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
  ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
const result={browser:name,version:browser.version(),checks:[],errors:[]};
const output=process.env.NWW_AUDIT_OUTPUT;
try{
  const page=await browser.newPage({viewport:{width:1440,height:900},timezoneId:'America/New_York'});
  page.on('pageerror',error=>result.errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&currentSeriesHours.length>5,{}, {timeout:90000});
  if(process.env.NWW_PROFILE_RENDERER==='3d'){
    await page.locator('#nwDefaultNavControl .nw-simple-view').click();
    await page.waitForFunction(()=>document.body.classList.contains('map-3d-ready'),{}, {timeout:60000});
  }
  result.renderer=await page.evaluate(()=>document.body.classList.contains('map-3d-ready')?'3d':'2d');
  const profile=()=>page.locator(`${result.renderer==='3d'?'.maplibregl-popup':'.leaflet-popup'} .house-alert-cta`);
  for(const [label,options,playing]of [['held-primary',{delay:400},true],['right',{button:'right'},false],['middle',{button:'middle'},false]]){
    await page.evaluate(()=>stopPlayback());await page.waitForTimeout(260);
    await page.locator('#playBtn').click(options);
    assert.equal(await page.evaluate(()=>!!playTimer),playing,`${label} has one appropriate activation`);
    result.checks.push(`${label}: expected playing=${playing}`);
  }
  await page.evaluate(async()=>{
    stopPlayback();await ensureParcelAssets();
    const feature=parcelFeatures.find(feature=>feature.properties.parcelId==='0507_128_23');
    if(!feature)throw Error('Real property fixture is missing');
    openParcelFloodPrompt(feature,L.latLng(feature.properties.centroidLat,feature.properties.centroidLon));
    window.profileGesture=[];
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      const opener=event.target.closest?.('.house-alert-cta');
      if(type==='pointerdown'&&opener)window.actualProfileOpener=opener;
      if(window.actualProfileOpener)profileGesture.push({type,isTrusted:event.isTrusted,
        targetIsCta:!!opener,originalConnected:actualProfileOpener.isConnected});
    },true);
  });
  await profile().focus();
  await page.evaluate(()=>updatePersistentDepthQueryPopup());
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('house-alert-cta')),true,'A focused CTA survives a standalone popup refresh');
  await page.locator('#playBtn').focus();
  await page.evaluate(()=>updatePersistentDepthQueryPopup());
  assert.equal(await page.evaluate(()=>document.activeElement.id),'playBtn','Popup refresh cannot steal focus from another control');
  result.checks.push('Standalone popup refresh preserves its focused CTA and leaves external focus untouched');
  await page.locator('#playBtn').click();
  assert.equal(await page.evaluate(()=>!!playTimer),true);
  await profile().click({delay:700});
  await page.waitForFunction(()=>!document.getElementById('floodHistoryBackdrop').hidden);
  result.heldGesture=await page.evaluate(()=>profileGesture.slice(0,3));
  assert.deepEqual(result.heldGesture.map(event=>event.type),['pointerdown','pointerup','click']);
  assert.ok(result.heldGesture.every(event=>event.isTrusted&&event.targetIsCta&&event.originalConnected),'The original CTA must survive the held native gesture');
  await page.waitForFunction(()=>!window.actualProfileOpener.isConnected,{}, {timeout:15000});
  result.beforeClose=await page.evaluate(()=>({playing:!!playTimer,oldConnected:actualProfileOpener.isConnected,index:currentHourIndex}));
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.getElementById('floodHistoryBackdrop').hidden);
  const focused=()=>page.evaluate(()=>{
    const active=document.activeElement;
    return {isCta:active.classList.contains('house-alert-cta'),key:active.getAttribute('data-focus-restore-key'),tag:active.tagName};
  });
  result.afterClose=await focused();
  assert.equal(result.afterClose.isCta,true,'Closing a profile restores its current replaced opener');
  assert.equal(result.afterClose.key,'parcel-profile:0507_128_23');
  result.afterFrames=[];
  for(let update=0;update<3;update++){
    const index=await page.evaluate(()=>currentHourIndex);
    await page.waitForFunction(index=>currentHourIndex!==index&&floodFrameState==='ready',index,{timeout:15000});
    const state=await focused();result.afterFrames.push(state);
    assert.equal(state.isCta,true,'Later playback refreshes retain the restored property focus');
    assert.equal(state.key,'parcel-profile:0507_128_23');
  }
  await profile().evaluate(button=>{window.cancelledProfileOpener=button;});
  const box=await profile().boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>cancelledProfileOpener.isConnected),true,'A held CTA stays connected during animation');
  await page.mouse.move(5,5);await page.mouse.up();
  await page.waitForFunction(()=>!cancelledProfileOpener.isConnected,{}, {timeout:15000});
  assert.equal(await page.locator('#floodHistoryBackdrop').evaluate(element=>element.hidden),true,'Release outside cancels opening the profile');
  result.checks.push('Release outside cancels the property gesture; later playback refresh resumes');
  await page.evaluate(()=>stopPlayback());
  result.checks.push('Actual property opener replaced during playback; Escape restores same-property CTA and three later frames preserve focus');
  assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){result.failure=error.stack;throw error;}
finally{
  await browser.close();
  if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'play-profile.json'),JSON.stringify(result,null,2));}
  console.log(JSON.stringify(result,null,2));
}
