// Real local municipal geometry, actual controls and isolated browser contexts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const name=process.env.NWW_BROWSER||'chromium';
const browser=await playwright[name==='edge'?'chromium':name].launch({headless:true,
  ...(name==='edge'?{channel:'msedge'}:{}),
  ...(name==='chromium'&&process.env.NWW_CHROMIUM_CHANNEL&&!process.env.CHROME_PATH?{channel:process.env.NWW_CHROMIUM_CHANNEL}:{}),
  ...(name==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),
  ...(['chromium','edge'].includes(name)?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
const output=process.env.NWW_AUDIT_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'nww-building-visibility-'));
fs.mkdirSync(output,{recursive:true});
const result={browser:name,version:browser.version(),checks:[],views:[],errors:[],fallbacks:[],passed:false};
const url=process.env.NWW_TEST_URL||'http://127.0.0.1:9046/index.html';
async function frame(page){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function snapshot(page,label){
  const row=await page.evaluate(label=>{
    const gl=window.NORTH_WILDWOOD_3D.getMap(),toggle=document.getElementById('buildingsToggle');
    return{label,enabled:toggle.classList.contains('on'),checked:toggle.getAttribute('aria-checked'),
      visibility:gl?.getLayer('nw-3d-buildings')?gl.getLayoutProperty('nw-3d-buildings','visibility'):null,
      source:gl?.getLayer('nw-3d-buildings')?.source,
      flatVisibility:gl?.getLayer('nw-2d-buildings')?gl.getLayoutProperty('nw-2d-buildings','visibility'):null,
      flatRendered:gl?.getLayer('nw-2d-buildings')?gl.queryRenderedFeatures({layers:['nw-2d-buildings']}).length:0,
      count:window.NORTH_WILDWOOD_3D.getBuildingData()?.features?.length,
      rendered:gl?.getLayer('nw-3d-buildings')?gl.queryRenderedFeatures({layers:['nw-3d-buildings']}).length:0,
      pitch:gl?.getPitch(),bearing:gl?.getBearing(),zoom:gl?.getZoom(),center:gl?.getCenter(),
      index:currentHourIndex,time:currentSeriesHours[currentHourIndex]?.timeUtc};
  },label);
  result.views.push(row);return row;
}
async function mode(page,threeD){
  const before=await page.evaluate(()=>NORTH_WILDWOOD_3D.state().pitch>10);
  if(before!==threeD)await page.locator('.nw-simple-view').click();
  await page.waitForFunction(wanted=>{
    const control=document.querySelector('.nw-simple-view'),state=NORTH_WILDWOOD_3D.state();
    return control.getAttribute('aria-busy')==='false'&&state.ready&&(state.pitch>10)===wanted;
  },threeD,{timeout:30000});await frame(page);
}
async function clickBuildings(page,hasTouch){
  if(hasTouch){
    await page.locator('#mobileControlsToggle').click();
    await page.getByRole('tab',{name:'Map layers',exact:true}).click();
  }
  await page.locator('#buildingsToggle').click();
  if(hasTouch)await page.locator('#mobileControlsClose').click();
}
try{
  for(const profile of [
    {name:'desktop',viewport:{width:1440,height:1000}},
    {name:'touch-phone',viewport:{width:390,height:844},hasTouch:true}
  ]){
    const context=await browser.newContext({viewport:profile.viewport,hasTouch:Boolean(profile.hasTouch),timezoneId:'America/New_York'});
    const page=await context.newPage();page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.errors.push(error.message));
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&
      !document.getElementById('app').inert&&floodFrameState==='ready',null,{timeout:90000});
    const before=await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom(),index:currentHourIndex,time:currentSeriesHours[currentHourIndex]?.timeUtc}));
    await clickBuildings(page,profile.hasTouch);
    await page.waitForFunction(()=>buildingsLayer&&map.hasLayer(buildingsLayer),null,{timeout:10000});
    assert.equal(await page.evaluate(()=>NORTH_WILDWOOD_3D.getMap()),null);
    assert.equal(await page.locator('#buildingsToggle').getAttribute('aria-checked'),'true');
    assert.deepEqual(await page.evaluate(()=>({center:map.getCenter(),zoom:map.getZoom(),index:currentHourIndex,time:currentSeriesHours[currentHourIndex]?.timeUtc})),before);
    result.checks.push(profile.name+' Buildings enables the Leaflet layer while preserving 2D');
    await page.locator('.nw-simple-view').click();
    await page.waitForFunction(()=>document.querySelector('.nw-simple-view').getAttribute('aria-busy')==='false'&&
      (NORTH_WILDWOOD_3D.state().ready||document.body.dataset.map3d==='fallback'),null,{timeout:30000});
    if(!await page.evaluate(()=>NORTH_WILDWOOD_3D.state().ready)){
      assert.equal(await page.evaluate(()=>NORTH_WILDWOOD_3D.getMap()),null);
      assert.equal(await page.locator('#buildingsToggle').getAttribute('aria-checked'),'true');
      assert.equal(await page.evaluate(()=>map.hasLayer(buildingsLayer)),true);
      assert.equal(await page.evaluate(()=>document.body.classList.contains('map-3d-ready')),false);
      result.fallbacks.push({profile:profile.name,message:'Native 3D unavailable: usable 2D retained; building render cases not exercised.'});
      await context.close();continue;
    }
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().areTilesLoaded(),null,{timeout:30000});await frame(page);
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().queryRenderedFeatures({layers:['nw-3d-buildings']}).length>0,null,{timeout:10000});
    const first=await snapshot(page,profile.name+' first 3D');
    assert.equal(first.enabled,true);assert.equal(first.checked,'true');assert.equal(first.visibility,'visible');
    assert.equal(first.flatVisibility,'none');
    assert.equal(first.source,'nw-buildings-source');assert.ok(first.count>4000);assert.ok(first.rendered>0);
    assert.equal(first.zoom,before.zoom,'3D entry does not teleport to a close building');
    assert.ok(Math.abs(first.center.lng-before.center.lng)<1e-6&&Math.abs(first.center.lat-before.center.lat)<1e-6);
    assert.equal(first.index,before.index);assert.equal(first.time,before.time);
    await page.screenshot({path:path.join(output,`${name}-${profile.name}-initial-3d-buildings.png`)});
    result.checks.push(profile.name+' first 3D shows the municipal buildings and preserves view/time');
    if(profile.name==='desktop'){
      for(const zoom of [14.5,17])for(const bearing of [0,90,180,270]){
        await page.evaluate(({zoom,bearing})=>{NORTH_WILDWOOD_3D.getMap().jumpTo({zoom,bearing,pitch:60});},{zoom,bearing});
        await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().areTilesLoaded(),null,{timeout:30000});await frame(page);
        const view=await snapshot(page,`zoom ${zoom} bearing ${bearing}`);
        assert.equal(view.visibility,'visible');assert.ok(view.rendered>0,'Enabled buildings cannot disappear above the former 1,000 m cutoff');
        assert.equal(view.count,first.count,'Camera navigation never replaces the complete municipal collection');
        assert.equal(view.index,first.index);assert.equal(view.time,first.time);
      }
      result.checks.push('Eight overview/street bearings retain visible complete municipal geometry and selected time');
      await page.setViewportSize({width:1024,height:600});await frame(page);
      assert.equal((await snapshot(page,'short laptop resize')).visibility,'visible');
      await page.setViewportSize(profile.viewport);await frame(page);
      result.checks.push('Laptop resize retains enabled 3D geometry');
    }
    await mode(page,false);
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().queryRenderedFeatures({layers:['nw-2d-buildings']}).length>0,null,{timeout:10000});
    const flat=await snapshot(page,profile.name+' native 2D');
    assert.equal(flat.enabled,true);assert.equal(flat.visibility,'none');assert.equal(flat.flatVisibility,'visible');
    assert.ok(flat.flatRendered>0);
    await clickBuildings(page,profile.hasTouch);
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().getLayoutProperty('nw-2d-buildings','visibility')==='none');
    await clickBuildings(page,profile.hasTouch);
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().getLayoutProperty('nw-2d-buildings','visibility')==='visible');
    const flatEnabled=await snapshot(page,profile.name+' Buildings re-enabled in native 2D');
    assert.equal(flatEnabled.pitch,0);assert.equal(flatEnabled.visibility,'none');
    assert.equal(flatEnabled.zoom,flat.zoom);assert.equal(flatEnabled.bearing,flat.bearing);
    assert.deepEqual(flatEnabled.center,flat.center);assert.equal(flatEnabled.index,flat.index);
    await mode(page,true);
    const pitched=await snapshot(page,profile.name+' returned 3D');
    assert.equal(pitched.visibility,'visible');assert.equal(pitched.flatVisibility,'none');
    result.checks.push(profile.name+' native 2D toggles flat footprints in place and manual 3D restores walls');
    await clickBuildings(page,profile.hasTouch);
    await page.waitForFunction(()=>!document.getElementById('buildingsToggle').classList.contains('on'));
    await mode(page,false);await mode(page,true);
    const disabled=await snapshot(page,profile.name+' explicit off survives 3D return');
    assert.equal(disabled.enabled,false);assert.equal(disabled.checked,'false');assert.equal(disabled.visibility,'none');
    assert.equal(disabled.flatVisibility,'none');
    result.checks.push(profile.name+' explicit Buildings off remains off after 2D/3D changes');
    await page.screenshot({path:path.join(output,`${name}-${profile.name}-building-visibility.png`)});
    await context.close();
  }
  // A failed manual 3D start keeps the existing Leaflet selection usable.
  if(result.fallbacks.length===0){
    const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/New_York'});
    const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>result.errors.push(error.message));
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready')&&!document.getElementById('app').inert&&floodFrameState==='ready',null,{timeout:90000});
    const pattern='**/NorthWildwoodBuildings3D.geojson*';let failures=0;
    const fail=route=>{failures++;return route.fulfill({status:503,contentType:'application/json',body:'{}'});};
    await page.route(pattern,fail);
    await clickBuildings(page,false);
    await page.waitForFunction(()=>buildingsLayer&&map.hasLayer(buildingsLayer));
    assert.equal(failures,0,'Buildings in Leaflet must not request native building assets');
    await page.locator('.nw-simple-view').click();
    await page.waitForFunction(()=>document.body.dataset.map3d==='fallback'&&document.querySelector('.nw-simple-view').getAttribute('aria-busy')==='false',null,{timeout:30000});
    assert.ok(failures>0,'The configured building data request must genuinely fail');
    assert.equal(await page.locator('#buildingsToggle').getAttribute('aria-checked'),'true');
    assert.equal(await page.evaluate(()=>map.hasLayer(buildingsLayer)),true);
    await page.unroute(pattern,fail);await page.locator('.nw-simple-view').click();
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.state().ready&&NORTH_WILDWOOD_3D.state().pitch>10&&document.querySelector('.nw-simple-view').getAttribute('aria-busy')==='false',null,{timeout:30000});
    await page.waitForFunction(()=>NORTH_WILDWOOD_3D.getMap().queryRenderedFeatures({layers:['nw-3d-buildings']}).length>0,null,{timeout:20000});
    const retried=await snapshot(page,'failed manual 3D start then retry');
    assert.equal(retried.enabled,true);assert.equal(retried.checked,'true');assert.equal(retried.visibility,'visible');assert.ok(retried.rendered>0);
    result.checks.push('A failed manual 3D start leaves Leaflet Buildings on and permits a successful manual retry');
    await context.close();
  }
  assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){result.failure=error.stack;throw error;}
finally{await browser.close();fs.writeFileSync(path.join(output,`${name}-building-visibility.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}
