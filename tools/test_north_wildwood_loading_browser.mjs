#!/usr/bin/env node
// Quiet startup/readiness coverage; browser environment follows the full-app suite.
import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit' ? webkit : chromium;
const browser=await engine.launch({headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(engine===chromium ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const url=process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const twoPaints=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function earlyPreviewScenario() {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();
  let releaseStyles,receiveStyles;
  const stylesReleased=new Promise(resolve=>{releaseStyles=resolve;});
  const stylesRequested=new Promise(resolve=>{receiveStyles=resolve;});
  let navigation;
  try {
    await page.route('**/assets/styles/app-01.css*',async route=>{
      receiveStyles();await stylesReleased;await route.continue();
    });
    navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    void navigation.catch(()=>{});
    await Promise.race([stylesRequested,navigation.then(()=>{throw new Error('The real startup stylesheet was not held');})]);
    await page.waitForFunction(()=>{
      const image=document.getElementById('startupMapPreview');
      return image?.complete&&image.naturalWidth>0&&getComputedStyle(image).position==='fixed';
    },null,{polling:25});
    const early=await page.locator('#startupMapPreview').evaluate(image=>{
      const style=getComputedStyle(image),rect=image.getBoundingClientRect();
      return {visibility:style.visibility,display:style.display,opacity:Number(style.opacity),
        coversViewport:rect.left===0&&rect.top===0&&rect.width>=innerWidth&&rect.height>=innerHeight,
        mounted:document.body.dataset.mapInitialized==='true'};
    });
    assert.deepEqual(early,{visibility:'visible',display:'block',opacity:1,coversViewport:true,mounted:false},
      'The geographic preview must fill the first viewport before the real stylesheet or map runtime can finish');
    console.log('PASS geographic preview while the real startup stylesheet is held');
  } finally {
    releaseStyles();await navigation?.catch(()=>{});await context.close();
  }
}

async function scenario({mobile=false,reduced=false,timeout=false,fail=false,cached=false}) {
  const name=timeout?'stalled mobile timeout':fail?'forecast network error':mobile?'mobile reduced motion':'desktop normal motion';
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1512,height:945},
    hasTouch:mobile,isMobile:mobile,reducedMotion:reduced?'reduce':'no-preference'});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let release,received,requestedCount=0;
  const released=new Promise(resolve=>{release=resolve;});
  const requested=new Promise(resolve=>{received=resolve;});
  let releaseController,receiveController;
  const controllerReleased=new Promise(resolve=>{releaseController=resolve;});
  const controllerRequested=new Promise(resolve=>{receiveController=resolve;});
  let pending,final,audit;
  try {
    await page.addInitScript(()=>{
      const audit=window.__loaderBrowserAudit={frames:0,samples:[],playClicks:0};
      document.addEventListener('click',event=>{if(event.target.closest?.('#playBtn'))audit.playClicks++;},true);
      window.__captureLoaderBrowser=()=>{
        const loader=document.getElementById('nwSiteLoader'),app=document.getElementById('app');
        if(!loader)return null;
        const style=getComputedStyle(loader),r=loader.getBoundingClientRect();
        const card=loader.querySelector('.nw-loader-card')?.getBoundingClientRect();
        const visible=!loader.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0;
        const appStyle=app&&getComputedStyle(app);
        const mapElement=document.getElementById('map');
        const preview=document.getElementById('startupMapPreview');
        const paints=element=>{
          if(!element?.getClientRects().length||getComputedStyle(element).visibility!=='visible')return false;
          for(let node=element;node;node=node.parentElement) {
            const css=getComputedStyle(node);
            if(css.display==='none'||Number(css.opacity)===0)return false;
          }
          return true;
        };
        const mountedMap=typeof map==='undefined'?null:map;
        const center=mountedMap?._loaded?mountedMap.getCenter():null;
        const basePane=center&&mountedMap.getPane('basemapColorPane');
        const liveBase=basePane&&[...basePane.querySelectorAll('canvas,img.leaflet-tile-loaded')].some(node=>
          paints(node)&&(node instanceof HTMLCanvasElement?node.width>0:node.complete&&node.naturalWidth>0));
        const earlyControls=['playBtn','hourSlider','openDownloadModalBtn','leftPanel','rightRail','nwwMobileUtilities','mobileControlsToggle','legendDock','topBanner'];
        return {visible,hidden:loader.hidden,loading:document.body.classList.contains('nw-app-loading'),
          ready:document.body.classList.contains('nw-app-ready'),reason:document.body.dataset.siteLoader,
          appInert:app?.inert,appBusy:app?.getAttribute('aria-busy'),appOpacity:appStyle&&Number(appStyle.opacity),
          appVisibility:appStyle?.visibility,appPointer:appStyle?.pointerEvents,
          toolbarInert:document.getElementById('nwwMobileUtilities')?.inert,
          toggleInert:document.getElementById('mobileControlsToggle')?.inert,
          legendInert:document.getElementById('legendDock')?.inert,
          mapInitialized:document.body.dataset.mapInitialized==='true',mapPainted:paints(mapElement),
          liveBase:Boolean(liveBase),
          camera:center&&{lat:center.lat,lng:center.lng,zoom:mountedMap.getZoom()},
          preview:preview&&{painted:paints(preview),decoded:preview.complete&&preview.naturalWidth>0,
            decorative:preview.alt===''&&preview.getAttribute('aria-hidden')==='true',insideMap:Boolean(mapElement?.contains(preview)),
            pointer:getComputedStyle(preview).pointerEvents},
          colorLayerActive:typeof basemapColorLayer!=='undefined'&&Boolean(basemapColorLayer&&mountedMap?.hasLayer(basemapColorLayer)),
          roadsActive:typeof roadsLayer!=='undefined'&&Boolean(roadsLayer&&mountedMap?.hasLayer(roadsLayer)),
          floodFrame:document.body.dataset.initialFloodFrame,
          visibleControls:earlyControls.filter(id=>paints(document.getElementById(id))),
          progress:Number(document.getElementById('nwLoaderProgress')?.dataset.progress || 0),
          status:document.getElementById('nwLoaderStatus')?.textContent,
          brand:loader.querySelector('.nw-loader-eyebrow')?.textContent,
          rect:{x:r.x,y:r.y,width:r.width,height:r.height},
          card:card&&{x:card.x,y:card.y,width:card.width,height:card.height},
          activeBehind:!!document.activeElement?.closest('#app,#nwwMobileUtilities,#mobileControlsToggle,#legendDock'),
          at:performance.now(),
        };
      };
      let previous;
      function sample(){
        if(audit.stopped)return;
        audit.frames++;
        const value=window.__captureLoaderBrowser();
        if(value){const signature=JSON.stringify({...value,at:0});if(signature!==previous){audit.samples.push({...value,frame:audit.frames});previous=signature;}}
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await page.route('**/forecast.json*',async route=>{
      requestedCount++;received();await released;
      if(fail)await route.abort('failed');else await route.continue();
    });
    await page.route('**/north-wildwood-loading.js*',async route=>{
      receiveController();await controllerReleased;await route.continue();
    });
    const navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    // Handle rejection immediately so a failed assertion followed by context
    // cleanup cannot mask its cause with an unhandled navigation rejection.
    void navigation.catch(()=>{});
    await Promise.race([controllerRequested,navigation.then(()=>{throw new Error('Navigation completed without the held readiness controller');})]);
    // Chromium can request this script through its preload scanner before the
    // parser reaches the app. Inspect only after its actual DOM position exists.
    await page.locator('script[src*="north-wildwood-loading.js"]').waitFor({state:'attached'});
    // WebKit exposes parsed DOM before preceding blocking stylesheets have
    // joined the active cascade. Wait for the quiet sheet to be active without
    // waiting for any expected visibility value.
    await page.waitForFunction(()=>{
      const sheet=document.getElementById('floodmapper-quiet-loading-20261119')?.sheet;
      return sheet&&Array.from(document.styleSheets).includes(sheet);
    },null,{polling:25});
    await page.waitForFunction(()=>{
      const image=document.getElementById('startupMapPreview');
      return image?.complete&&image.naturalWidth>0;
    },null,{polling:25});
    // WebKit may suppress animation frames while this parser-blocking response
    // is held. Computed layout and focus checks work before its first real paint.
    // The audit still checks every real frame, including the first eligible one.
    const beforeController=await page.evaluate(()=>{
      const roots=['app','topBanner','nwwMobileUtilities','mobileControlsToggle','legendDock'].map(id=>document.getElementById(id)).filter(Boolean);
      const controls=[...new Set(roots.flatMap(root=>[root,...root.querySelectorAll('button,a[href],input,select,[tabindex]')]))]
        .filter(element=>element.matches('button,a[href],input,select,[tabindex]'));
      const focusable=[];
      for(const element of controls){element.focus({preventScroll:true});if(document.activeElement===element)focusable.push(element.id||element.tagName);}
      return {snapshot:window.__captureLoaderBrowser(),focusable,controls:controls.length};
    });
    assert.ok(beforeController.controls>0,'Exercise the actual parsed controls before the readiness controller runs');
    assert.equal(beforeController.snapshot.visible,false,'No splash before the controller arrives');
    assert.equal(beforeController.snapshot.appOpacity,1,'Allow the geographic preview to paint before the controller arrives');
    assert.equal(beforeController.snapshot.appVisibility,'hidden','Keep unfinished controls hidden until the controller makes them inert');
    assert.equal(beforeController.snapshot.mapInitialized,false,'The geographic preview must not claim the live map is initialized');
    assert.equal(beforeController.snapshot.mapPainted,true);
    assert.deepEqual(beforeController.snapshot.preview,
      {painted:true,decoded:true,decorative:true,insideMap:true,pointer:'none'},
      'A real, non-interactive geographic image must be visible inside the map before application scripts run');
    assert.deepEqual(beforeController.snapshot.visibleControls,[],'No controls may paint with the geographic preview');
    assert.deepEqual(beforeController.focusable,[],'No pre-controller control, including visible descendants, may receive focus');
    const controllerReleasedAt=Date.now();
    releaseController();
    await navigation;
    assert.ok(requestedCount>0,'Hold the real initial forecast request, not a manufactured loading state');
    await requested;
    await twoPaints(page);
    pending=await page.evaluate(()=>window.__captureLoaderBrowser());
    assert.equal(pending.visible,false,`${name}: no loading splash may paint`);
    assert.equal(pending.brand,'ShorelySafe');
    assert.equal(pending.ready,false,'Pending initial data must not falsely signal readiness');
    assert.equal(pending.loading,true);assert.equal(pending.appBusy,'true');
    assert.equal(pending.appInert,true,'Pending app controls must be inert');
    assert.equal(pending.toolbarInert,true,'External mobile toolbar must also be inert');
    assert.equal(pending.toggleInert,true,'External mobile Controls button must also be inert');
    assert.equal(pending.legendInert,true,'Reparented legend must be isolated');
    assert.equal(pending.appVisibility,'hidden','Only the map underlay may be visible while the app is pending');
    assert.equal(pending.mapInitialized,true);
    assert.equal(pending.mapPainted,true,'The real map becomes eligible to paint before the held forecast resolves');
    assert.ok(pending.preview?.decoded||pending.liveBase,'Keep geographic imagery while waiting for the real forecast');
    assert.equal(pending.colorLayerActive,true,'Start the existing color basemap during the first map fit');
    assert.equal(pending.roadsActive,false,'Defer the optional road-name layer until the first flood frame');
    assert.equal(pending.floodFrame,'loading','An early basemap must not stand in for the real flood frame');
    assert.deepEqual(pending.visibleControls,[],'No unfinished controls may paint with the early basemap');
    const play=await page.locator('#playBtn').evaluate(button=>button.getBoundingClientRect().toJSON());
    await page.mouse.click(play.x+play.width/2,play.y+play.height/2);
    await page.locator('#dataSourceHelpBtn').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>window.__loaderBrowserAudit.playClicks),0,'Readiness guard prevents activation of unfinished controls');
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('#app,#nwwMobileUtilities,#mobileControlsToggle,#legendDock')),false,
      'Inert background must not receive keyboard focus');

    if(timeout) {
      // Use the original real deadline. A mocked animation clock can sample
      // incomplete WebKit styles before the browser is eligible to paint.
      await page.waitForFunction(()=>document.body.dataset.siteLoader==='timeout');
      assert.ok(Date.now()-controllerReleasedAt>=20000,'Exercise the actual 20-second controller deadline');
      assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('nw-app-ready')),false,
        'Timeout releases controls without claiming the forecast finished');
    } else {
      await page.waitForFunction(()=>Number(document.getElementById('nwLoaderProgress')?.dataset.progress)>=11);
      assert.equal(await page.evaluate(()=>window.__captureLoaderBrowser().visible),false,'Real pending startup stays quiet');
      release();
      await page.waitForFunction(()=>document.body.dataset.siteLoader==='complete',{},{timeout:90000});
    }
    await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
    final=await page.evaluate(()=>window.__captureLoaderBrowser());
    assert.equal(final.appInert,false);assert.equal(final.toolbarInert,false);assert.equal(final.toggleInert,false);assert.equal(final.legendInert,false);
    assert.equal(final.appBusy,'false');assert.equal(final.loading,false);
    assert.equal(final.appOpacity,1,'Reveal the finished app without a second blank/blur transition');
    assert.ok(final.preview?.decoded||final.liveBase,'Hydraulic readiness must not leave the basemap area blank');
    if(!timeout){assert.equal(final.progress,100);assert.equal(final.status,'Floodmapper ready');}
    if(!timeout&&!fail) {
      assert.ok(pending.camera&&final.camera,'Measure the genuine Leaflet camera on both sides of the handoff');
      assert.equal(final.camera.zoom,pending.camera.zoom,'The first flood frame must not change the startup zoom');
      assert.ok(Math.abs(final.camera.lat-pending.camera.lat)<0.00001&&Math.abs(final.camera.lng-pending.camera.lng)<0.00001,
        'The first flood frame must not recenter the startup map');
      if(final.preview) {
        await page.evaluate(()=>map.panBy([12,0],{animate:false}));
        assert.equal(await page.locator('#startupMapPreview').count(),0,'Retire the startup preview on the first real camera movement');
      }
    }
    if(fail)assert.notEqual(await page.locator('body').getAttribute('data-initial-flood-frame'),'ready','A forecast failure must not masquerade as a rendered flood frame');
    if(mobile) {
      await page.locator('#mobileControlsToggle').focus();await page.keyboard.press('Enter');
      await page.locator('#leftPanel').waitFor({state:'visible'});
      await page.locator('#mobileControlsClose').click();
      await page.locator('#leftPanel').waitFor({state:'hidden'});
    } else {
      await page.locator('#dataSourceHelpBtn').focus();
      assert.equal(await page.locator('#dataSourceHelpBtn').evaluate(node=>node===document.activeElement),true);
      await page.keyboard.press('Enter');await page.locator('#infoModal').waitFor({state:'visible'});
      await page.locator('#infoModalCloseBtn').click();
    }
    if(timeout) {
      release();
      await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
      assert.equal(await page.locator('body').getAttribute('data-site-loader'),'timeout','Late completion must not reopen/restart the splash');
      assert.equal(await page.locator('#nwSiteLoader').isVisible(),false);
    }
    audit=await page.evaluate(()=>{window.__loaderBrowserAudit.stopped=true;return window.__loaderBrowserAudit;});
    assert.equal(audit.samples[0].visible,false,'The first eligible document paint has no loader');
    assert.ok(audit.samples.some(sample=>sample.loading&&sample.mapPainted&&!sample.ready),
      'Observe the early basemap in a painted frame before the forecast becomes ready');
    for(const sample of audit.samples)if(sample.loading) {
      assert.equal(sample.visible,false,'No loading splash frame during startup');
      assert.ok(sample.appOpacity===null||sample.appVisibility==='hidden'||sample.appInert,
        'No interactive app may appear during startup');
      if(sample.mapPainted)assert.deepEqual(sample.visibleControls,[],'Only the map underlay may paint before readiness');
    }
    for(let index=1;index<audit.samples.length;index++)assert.ok(audit.samples[index].progress>=audit.samples[index-1].progress,'Loading progress must not move backward');
    if(cached) {
      await page.unroute('**/forecast.json*');
      await page.reload({waitUntil:'domcontentloaded',timeout:90000});
      await page.waitForFunction(()=>document.body.dataset.siteLoader==='complete',{},{timeout:90000});
      await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
      const fast=await page.evaluate(()=>window.__captureLoaderBrowser());
      assert.equal(fast.progress,100);assert.equal(fast.appBusy,'false');assert.equal(fast.appInert,false);
      assert.equal(fast.visible,false,'Fast cached startup cannot leave a stuck branded overlay');
    }
    assert.deepEqual(errors,[],'No uncaught errors during loader lifecycle/recovery');
    console.log(`PASS loading screen ${name}${cached?' + cached reload':''}: first paint, real pending data, inert controls, reveal and focus${timeout?', original timeout recovery':''}`);
  } catch(error) {
    console.error(JSON.stringify({name,error:error.stack||String(error),pending,final,requestedCount,errors,audit:audit||await page.evaluate(()=>window.__loaderBrowserAudit).catch(()=>null)},null,2));
    throw error;
  } finally {releaseController();release();await context.close();}
}
async function delayedLayoutScenario({timeout=false}={}) {
  const context=await browser.newContext({viewport:{width:1024,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let releaseLayout;
  const layoutReleased=new Promise(resolve=>{releaseLayout=resolve;});
  let navigation;
  try {
    await page.route('**/assets/app/unified-controller.js*',async route=>{
      await layoutReleased;await route.continue();
    });
    navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    void navigation.catch(()=>{});
    await page.waitForFunction(()=>document.body?.classList.contains('nw-app-ready'),null,{timeout:90000});
    const pending=await page.evaluate(()=>{
      const app=document.getElementById('app'),map=document.getElementById('map');
      return {reason:document.body.dataset.siteLoader,passes:Number(document.body.dataset.unifiedLayoutPasses||0),
        inert:app.inert,appVisibility:getComputedStyle(app).visibility,mapVisibility:getComputedStyle(map).visibility,
        busy:app.getAttribute('aria-busy')};
    });
    assert.equal(pending.passes,0,'Exercise actual delayed UI layout after actual core readiness');
    assert.notEqual(pending.reason,'complete');
    assert.equal(pending.inert,true);assert.equal(pending.appVisibility,'hidden');
    assert.equal(pending.mapVisibility,'visible');assert.equal(pending.busy,'true');
    await page.locator('#dataSourceHelpBtn').focus();
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('#app,#nwwMobileUtilities,#mobileControlsToggle,#legendDock')),false,
      'Core readiness must not allow keyboard focus into the unfinished layout');
    if(timeout) {
      await page.waitForFunction(()=>document.body.dataset.siteLoader==='timeout',null,{timeout:25000});
      assert.equal(await page.locator('#app').evaluate(app=>app.inert),false,'A missing layout controller retains the original bounded fallback');
      assert.equal(await page.locator('#app').getAttribute('aria-busy'),'false');
    }
    releaseLayout();await navigation;
    await page.waitForFunction(()=>Number(document.body.dataset.unifiedLayoutPasses)>0);
    if(!timeout)await page.waitForFunction(()=>document.body.dataset.siteLoader==='complete');
    assert.equal(await page.locator('body').getAttribute('data-site-loader'),timeout?'timeout':'complete',
      'Late layout after fallback must not restart the loader');
    assert.equal(await page.locator('#nwSiteLoader').isVisible(),false);
    assert.equal(await page.locator('#app').evaluate(app=>app.inert),false);
    assert.equal(await page.locator('#app').evaluate(app=>Number(getComputedStyle(app).opacity)),1);
    await page.locator('#dataSourceHelpBtn').focus();
    assert.equal(await page.locator('#dataSourceHelpBtn').evaluate(node=>node===document.activeElement),true);
    assert.deepEqual(errors,[]);
    console.log(`PASS core-ready delayed UI layout: hidden/inert until measured; ${timeout?'original20-second fallback and late recovery':'layout completion restores controls'}`);
  } finally {
    releaseLayout();await navigation?.catch(()=>{});await context.close();
  }
}

try {
  await earlyPreviewScenario();
  await scenario({cached:true});
  await scenario({mobile:true,reduced:true});
  await scenario({reduced:true,fail:true});
  await scenario({mobile:true,reduced:true,timeout:true});
  await delayedLayoutScenario();
  await delayedLayoutScenario({timeout:true});
} finally {await browser.close();}
