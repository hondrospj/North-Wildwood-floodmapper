#!/usr/bin/env node
// Real splash/readiness coverage; browser environment follows the full-app suite.
import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine=process.env.NWW_BROWSER==='webkit' ? webkit : chromium;
const browser=await engine.launch({headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(engine===chromium ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const url=process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const twoPaints=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function scenario({mobile=false,reduced=false,timeout=false,fail=false,cached=false}) {
  const name=timeout?'stalled mobile timeout':fail?'forecast network error':mobile?'mobile reduced motion':'desktop normal motion';
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1512,height:945},
    hasTouch:mobile,isMobile:mobile,reducedMotion:reduced?'reduce':'no-preference'});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let release,received,requestedCount=0;
  const released=new Promise(resolve=>{release=resolve;});
  const requested=new Promise(resolve=>{received=resolve;});
  let pending,final,audit;
  try {
    if(timeout)await page.clock.install();
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
        return {visible,hidden:loader.hidden,loading:document.body.classList.contains('nw-app-loading'),
          ready:document.body.classList.contains('nw-app-ready'),reason:document.body.dataset.siteLoader,
          appInert:app?.inert,appBusy:app?.getAttribute('aria-busy'),appOpacity:appStyle&&Number(appStyle.opacity),
          appPointer:appStyle?.pointerEvents,toggleInert:document.getElementById('mobileControlsToggle')?.inert,
          legendInert:document.getElementById('legendDock')?.inert,
          progress:Number(document.getElementById('nwLoaderProgress')?.dataset.progress || 0),
          status:document.getElementById('nwLoaderStatus')?.textContent,
          brand:loader.querySelector('.nw-loader-eyebrow')?.textContent,
          rect:{x:r.x,y:r.y,width:r.width,height:r.height},
          card:card&&{x:card.x,y:card.y,width:card.width,height:card.height},
          activeBehind:!!document.activeElement?.closest('#app,#mobileControlsToggle,#legendDock'),
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
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    assert.ok(requestedCount>0,'Hold the real initial forecast request, not a manufactured loading state');
    await requested;
    await twoPaints(page);
    pending=await page.evaluate(()=>window.__captureLoaderBrowser());
    assert.equal(pending.visible,true,`${name}: original ShorelySafe splash must actually paint`);
    assert.equal(pending.brand,'ShorelySafe');
    assert.equal(pending.ready,false,'Pending initial data must not falsely signal readiness');
    assert.equal(pending.loading,true);assert.equal(pending.appBusy,'true');
    assert.equal(pending.appInert,true,'Pending app controls must be inert');
    assert.equal(pending.toggleInert,true,'External mobile Controls button must also be inert');
    assert.equal(pending.legendInert,true,'Reparented legend must be isolated');
    assert.equal(pending.appOpacity,0,'No partially initialized app may show through the splash');
    assert.ok(pending.card.width>0&&pending.card.x>=-1&&pending.card.y>=-1&&
      pending.card.x+pending.card.width<=pending.rect.width+1&&pending.card.y+pending.card.height<=pending.rect.height+1,
    'The original loading card must fit the desktop or mobile viewport');
    const play=await page.locator('#playBtn').boundingBox();
    await page.mouse.click(play.x+play.width/2,play.y+play.height/2);
    await page.locator('#dataSourceHelpBtn').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>window.__loaderBrowserAudit.playClicks),0,'Overlay prevents pointer activation behind it');
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('#app,#mobileControlsToggle,#legendDock')),false,
      'Inert background must not receive keyboard focus');

    if(timeout) {
      // Advance the real controller's original 20-second deadline, without
      // replacing its code, readiness signal, or pending network operation.
      await page.clock.fastForward(20001);
      await page.waitForFunction(()=>document.body.dataset.siteLoader==='timeout');
      assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('nw-app-ready')),false,
        'Timeout releases controls without claiming the forecast finished');
    } else {
      await page.waitForFunction(()=>Number(document.getElementById('nwLoaderProgress')?.dataset.progress)>=11);
      assert.equal(await page.evaluate(()=>window.__captureLoaderBrowser().visible),true,'Splash stays visible while real startup is pending');
      release();
      await page.waitForFunction(()=>document.body.dataset.siteLoader==='complete',{},{timeout:90000});
    }
    await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
    final=await page.evaluate(()=>window.__captureLoaderBrowser());
    assert.equal(final.appInert,false);assert.equal(final.toggleInert,false);assert.equal(final.legendInert,false);
    assert.equal(final.appBusy,'false');assert.equal(final.loading,false);
    assert.equal(final.appOpacity,1,'Reveal the finished app without a second blank/blur transition');
    if(!timeout){assert.equal(final.progress,100);assert.equal(final.status,'Floodmapper ready');}
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
    assert.equal(audit.samples[0].visible,true,'The first eligible document paint must already show the loader');
    for(const sample of audit.samples)if(sample.loading) {
      assert.equal(sample.visible,true,'No missing or blank splash frame during startup');
      assert.ok(sample.appOpacity===null||sample.appOpacity===0||sample.appInert,
        'No interactive app may appear behind the pending splash');
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
    console.error(JSON.stringify({name,pending,final,requestedCount,errors,audit:audit||await page.evaluate(()=>window.__loaderBrowserAudit).catch(()=>null)},null,2));
    throw error;
  } finally {release();await context.close();}
}
try {
  await scenario({cached:true});
  await scenario({mobile:true,reduced:true});
  await scenario({reduced:true,fail:true});
  await scenario({mobile:true,reduced:true,timeout:true});
} finally {await browser.close();}
