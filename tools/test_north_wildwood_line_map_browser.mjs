// Actual image deadlines, GPU commit ordering, graphics restoration and playback.
// Uses NWW_BROWSER, PLAYWRIGHT_MODULE, CHROME_PATH, NWW_CHROMIUM_CHANNEL,
// NWW_TEST_URL and NWW_AUDIT_OUTPUT like the other maintained browser suites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const engine = playwright[name === 'edge' ? 'chromium' : name];
if (!engine) throw new Error(`Unsupported browser: ${name}`);
const browser = await engine.launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {})
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8773/index.html';
const output = process.env.NWW_AUDIT_OUTPUT;
if (output) fs.mkdirSync(output,{recursive:true});
const checks = [], observations = [], errors = [];
let playbackTelemetry = null;
async function newPage() {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(90000);
  page.on('pageerror',error=>errors.push(error.stack || error.message));
  return page;
}
async function ready(page) {
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.body.classList.contains('nw-app-ready') && floodFrameState==='ready',{}, {timeout:90000});
  await page.locator('#nwSiteLoader').waitFor({state:'hidden'});
}
async function modeledFlood(page) {
  // Await the complete selection operation, including its final render, so
  // the fixture cannot supersede a deliberately stalled query immediately.
  await page.evaluate(async()=>{await switchDataMode('return-interval');});
  await page.waitForFunction(()=>currentDataMode==='return-interval' && floodFrameState==='ready',{}, {timeout:90000});
}
const snapshot = page => page.evaluate(()=>{
  const layer = window.NORTH_WILDWOOD_3D?.getMap()?.style?.getLayer('nw-flood-overlay');
  const plane = layer?.implementation || layer;
  const status = document.getElementById('floodFrameStatus');
  return {index:currentHourIndex,stage:document.getElementById('stageText').textContent,
    time:document.getElementById('timeText').textContent,url:plane?.url,committedUrl:plane?.committedUrl,
    flood:floodFrameState,status:status.textContent,statusVisible:!!status.getClientRects().length};
});
const differentIndex = (page,excluded) => page.evaluate(excluded=>{
  const stages = excluded.map(index=>Math.max(0,getStageValue(currentSeriesHours[index])));
  return currentSeriesHours.findIndex((entry,index)=>{
    const stage = getStageValue(entry);
    return !excluded.includes(index) && stage>0.2 && stages.every(previous=>Math.abs(stage-previous)>0.2);
  });
},excluded).then(index=>{assert.ok(index>=0,'Modeled flood needs a distinct wet frame to test texture changes');return index;});
const start = (page,index) => page.evaluate(index=>{
  const job = window.__mapTestJob = (window.__mapTestJob || 0)+1;
  window.__mapTestDone = false;
  renderHour(index).then(()=>{if (job===window.__mapTestJob) window.__mapTestDone=true;});
},index);
const waitDone = page => page.waitForFunction(()=>window.__mapTestDone,{}, {timeout:65000});
// Hold only the custom plane's native Image transport; the hidden Leaflet
// image still loads normally, exposing the original premature metadata commit.
const holdTextures = page => page.evaluate(()=>{
  window.__mapNativeImage = window.Image;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  window.__mapHeldImages = [];
  window.Image = function(...args) {
    const image = new window.__mapNativeImage(...args);
    if ((new Error().stack || '').includes('loadTexture')) {
      Object.defineProperty(image,'src',{get(){return descriptor.get.call(image);},
        set(value){window.__mapHeldImages.push({image,value});}});
    }
    return image;
  };
  window.Image.prototype = window.__mapNativeImage.prototype;
});
const releaseTextures = page => page.evaluate(()=>{
  window.Image = window.__mapNativeImage;
  const setter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set;
  for (const {image,value} of window.__mapHeldImages) setter.call(image,value);
});
async function screenshot(page,label) {
  if (output) await page.screenshot({path:path.join(output,`${name}-map-${label}.png`)});
}
try {
  {
    const page = await newPage();
    try {
      await page.clock.install();
      await ready(page);
      // Install before navigation so every app timer shares this clock. The
      // pause precedes the race; later GPU/query pages retain their real clocks.
      await page.clock.pauseAt(await page.evaluate(()=>Date.now()+60000));
      await page.evaluate(()=>{
        window.__mapPlaybackOriginal={start:startPlayback,step:stepPlaybackForward,clear:clearPlaybackTimer};
        window.__mapPlaybackTrace={events:[],sessions:[]};
        clearPlaybackTimer=function(...args){
          __mapPlaybackTrace.events.push({action:window.__mapPlaybackAction||'external',
            generation:playbackGeneration,timer:playTimer,at:performance.now(),stack:new Error().stack});
          return __mapPlaybackOriginal.clear.apply(this,args);
        };
      });
      const sessions=[];
      for(const mutant of [false,true]){
        const delay=await page.evaluate(async mutant=>{
          window.__mapPlaybackAction='prepare';stopPlayback();
          for(const item of window.__mapSteps||[])item.resolve();
          await Promise.all((window.__mapSteps||[]).map(item=>item.promise));
          startPlayback=__mapPlaybackOriginal.start;
          if(mutant){
            const source=startPlayback.toString();
            if((source.match(/generation !== playbackGeneration/g)||[]).length!==3)
              throw new Error('Playback negative control needs the three maintained generation guards');
            startPlayback=(0,eval)(`(${source.replaceAll(' || generation !== playbackGeneration','')
              .replace('if (generation !== playbackGeneration) return;','')})`);
          }
          window.__mapSteps=[];
          stepPlaybackForward=()=>{
            let resolve;const promise=new Promise(done=>resolve=done);
            __mapSteps.push({resolve,promise});return promise;
          };
          window.__mapPlaybackAction='start-old';startPlayback();
          window.__mapPlaybackAction='pause-old';stopPlayback();
          window.__mapPlaybackAction='start-new';startPlayback();
          window.__mapPlaybackAction=null;
          const held=__mapSteps.slice();held.forEach(item=>item.resolve());
          await Promise.all(held.map(item=>item.promise));
          return Math.max(PLAYBACK_MINIMUM_FRAME_DELAY_MS,getPlaybackFrameDurationMs());
        },mutant);
        await page.clock.runFor(delay-1);
        assert.equal(await page.evaluate(()=>__mapSteps.length),2,'Held frame continuations must wait for their controlled deadline');
        await page.clock.runFor(1);
        const state=await page.evaluate(mutant=>{
          const state={mutant,requests:__mapSteps.length,generation:playbackGeneration,timer:playTimer,
            at:performance.now(),visibility:document.visibilityState,frame:floodFrameState,
            externalStops:__mapPlaybackTrace.events.filter(event=>event.action==='external')};
          __mapPlaybackTrace.sessions.push(state);return state;
        },mutant);
        assert.deepEqual(state.externalStops,[],`Playback session was externally stopped: ${JSON.stringify(state)}`);
        assert.equal(state.requests,mutant?4:3,`Wrong playback loop count at the controlled frame deadline: ${JSON.stringify(state)}`);
        sessions.push({...state,delay});
      }
      checks.push({scenario:'controlled-clock pause/restart keeps one playback loop',requests:sessions[0].requests,
        oldGenerationNegativeControlRequests:sessions[1].requests,sessions});
    } finally {
      playbackTelemetry=await page.evaluate(async()=>{
        if(!window.__mapPlaybackOriginal)return null;
        window.__mapPlaybackAction='cleanup';stopPlayback();
        for(const item of window.__mapSteps||[])item.resolve();
        await Promise.all((window.__mapSteps||[]).map(item=>item.promise));
        startPlayback=__mapPlaybackOriginal.start;stepPlaybackForward=__mapPlaybackOriginal.step;
        clearPlaybackTimer=__mapPlaybackOriginal.clear;
        return __mapPlaybackTrace;
      }).catch(error=>({captureError:error.message}));
      await page.close();
    }
  }
  {
    const page = await newPage();
    try {
      await ready(page);
      // Built-in storm shapes are stable across daily forecast refreshes.
      await modeledFlood(page);

      let graphicsReady = false;
      try {
        const available = await page.evaluate(async()=>!!await NORTH_WILDWOOD_3D.ensure());
        if (!available) throw new Error('The map reports that 3D is unavailable');
        if (await page.locator('body').getAttribute('data-map-view-mode')!=='3d') await page.locator('.nw-simple-view').click();
        await page.waitForFunction(()=>document.body.dataset.mapViewMode==='3d' && document.body.dataset.map3dFloodTexture==='ready',{}, {timeout:45000});
        graphicsReady = true;
      } catch (error) {
        const graphicsCapable = await page.evaluate(()=>{
          try {return !!document.createElement('canvas').getContext('webgl2');}
          catch (_) {return false;}
        });
        const fallback = await page.evaluate(()=>({mode:document.body.dataset.mapViewMode,
          graphics:document.body.dataset.map3d,texture:document.body.dataset.map3dFloodTexture,
          status:document.getElementById('map3dStatus')?.textContent,
          flood:floodFrameState,retained:!!currentFloodLayer && map.hasLayer(currentFloodLayer)}));
        assert.ok(fallback.retained && fallback.flood==='ready','Graphics fallback must retain the working map');
        observations.push({scenario:'GPU cases skipped: 3D unavailable in this browser environment',reason:error.message,fallback});
        // Windows Firefox can expose WebGL2 while its headless backend cannot
        // run MapLibre. Usable graphics on the other tested engines must not
        // silently turn a new 3D startup regression into a passing skip.
        if (graphicsCapable && !(name==='firefox' && process.platform==='win32')) throw error;
      }
      if (graphicsReady) {
        let before = await snapshot(page);
        let target = await differentIndex(page,[before.index]);
        await holdTextures(page);await start(page,target);
        await page.waitForFunction(()=>window.__mapHeldImages.length>0);
        const pending = await snapshot(page);
        for (const key of ['index','stage','time','committedUrl']) assert.equal(pending[key],before[key],key);
        assert.equal(pending.flood,'loading');
        await releaseTextures(page);await waitDone(page);
        let after = await snapshot(page);
        assert.equal(after.index,target);assert.equal(after.url,after.committedUrl);assert.equal(after.flood,'ready');
        checks.push({scenario:'held texture and selection commit together',before,pending,after});

        before = after;target = await differentIndex(page,[before.index]);
        await holdTextures(page);const started=Date.now();await start(page,target);
        await page.waitForFunction(()=>window.__mapHeldImages.length>0);
        await waitDone(page);after = await snapshot(page);
        for (const key of ['index','stage','time','committedUrl']) assert.equal(after[key],before[key],key);
        assert.equal(after.flood,'failed');assert.ok(after.statusVisible);
        assert.match(after.status,/previous image and time are still shown/i);
        assert.ok(Date.now()-started<65000,'GPU deadlines exceeded the bounded frame retry budget');
        checks.push({scenario:'actual GPU deadlines retain the old selection with visible failure',elapsedMs:Date.now()-started,after});
        await screenshot(page,'gpu-failed');
        await releaseTextures(page);await start(page,target);await waitDone(page);after = await snapshot(page);
        assert.equal(after.index,target);assert.equal(after.flood,'ready');assert.equal(after.url,after.committedUrl);
        checks.push({scenario:'failed GPU frame retries without reload',after});

        before = after;target = await differentIndex(page,[before.index]);
        const latestTarget = await differentIndex(page,[before.index,target]);
        await holdTextures(page);await start(page,target);
        await page.waitForFunction(()=>window.__mapHeldImages.length>0);
        await page.evaluate(()=>window.Image=window.__mapNativeImage);
        await start(page,latestTarget);await waitDone(page);const latest = await snapshot(page);
        assert.equal(latest.index,latestTarget);assert.equal(latest.url,latest.committedUrl);
        await releaseTextures(page);await page.waitForTimeout(1000);after = await snapshot(page);
        assert.deepEqual(after,latest);
        checks.push({scenario:'obsolete held texture cannot overwrite a newer selection',after});

        const canLoseContext = await page.evaluate(()=>{
          const layer = NORTH_WILDWOOD_3D.getMap().style.getLayer('nw-flood-overlay');
          window.__mapLoseContext=(layer.implementation || layer).gl.getExtension('WEBGL_lose_context');
          return !!window.__mapLoseContext;
        });
        if (canLoseContext) {
          before = after;target = await differentIndex(page,[before.index]);
          await holdTextures(page);await start(page,target);
          await page.waitForFunction(()=>window.__mapHeldImages.length>0);
          await page.evaluate(()=>window.__mapLoseContext.loseContext());
          await page.waitForFunction(()=>document.body.dataset.map3d==='recovering');await waitDone(page);
          const lost = await snapshot(page);
          for (const key of ['index','stage','time']) assert.equal(lost[key],before[key],key);
          assert.equal(lost.flood,'failed');
          await page.evaluate(()=>{window.Image=window.__mapNativeImage;window.__mapLoseContext.restoreContext();});
          await page.waitForFunction(()=>document.body.dataset.map3d==='ready' && document.body.dataset.map3dFloodTexture==='ready',{}, {timeout:50000});
          after = await snapshot(page);assert.equal(after.index,before.index);assert.equal(after.committedUrl,before.committedUrl);
          checks.push({scenario:'native context loss during pending upload restores the previous frame',lost,after});
          await start(page,target);await waitDone(page);after = await snapshot(page);
          assert.equal(after.index,target);assert.equal(after.url,after.committedUrl);assert.equal(after.flood,'ready');
          checks.push({scenario:'new selection succeeds after native graphics restoration',after});
        } else observations.push({scenario:'native context-loss case skipped',reason:'WEBGL_lose_context extension unavailable'});
        await screenshot(page,'gpu-recovered');
      }
    } finally {await page.close();}
  }
  {
    const page = await newPage(), held = [];
    const pattern = '**/NorthWildwoodHydraulicQuery5ft.png*';
    const faultNonce = `${Date.now()}-${Math.random()}`;
    let signalHeld;
    const faultIntercepted = new Promise(resolve=>signalHeld=resolve);
    try {
      await ready(page);await modeledFlood(page);
      // Preparing the modeled frame may already decode this URL. Resetting
      // only the application promise does not guarantee a network request in
      // every engine: use an uncached URL and establish interception explicitly.
      await page.route(pattern,route=>{
        if (new URL(route.request().url()).searchParams.get('_map_deadline_fixture')!==faultNonce) return route.continue();
        held.push(route);signalHeld();
      });
      const before=await snapshot(page);
      const started=Date.now();
      await page.evaluate(nonce=>{
        const queryUrl=new URL(DEPTH_QUERY_PNG_URL);queryUrl.searchParams.set('_map_deadline_fixture',nonce);
        DEPTH_QUERY_PNG_URL=queryUrl.href;depthQueryGridPromise=null;bathtubStageOverlayCache=new Map();
        window.__mapQueryDone=false;switchOverlayMode('dynamic').then(()=>window.__mapQueryDone=true);
      },faultNonce);
      let interceptionDeadline;
      try {
        await Promise.race([faultIntercepted,new Promise((_,reject)=>{
          interceptionDeadline=setTimeout(()=>reject(new Error('Query deadline fixture never intercepted its fresh image request')),15000);
        })]);
      } finally {clearTimeout(interceptionDeadline);}
      await page.waitForFunction(()=>!!depthQueryGridPromise);
      await page.waitForFunction(()=>window.__mapQueryDone,{}, {timeout:65000});
      const failed=await snapshot(page);
      assert.equal(failed.flood,'failed',JSON.stringify({heldRequests:held.length,...failed}));assert.ok(held.length>0);assert.ok(failed.statusVisible);
      for (const key of ['index','stage','time']) assert.equal(failed[key],before[key],key);
      assert.match(failed.status,/previous image and time are still shown/i);
      assert.equal(await page.evaluate(()=>depthQueryGridPromise),null);
      assert.ok(Date.now()-started<65000,'Query deadlines exceeded the bounded frame retry budget');
      checks.push({scenario:'held query has actual deadlines, visible failure and a cleared cache',elapsedMs:Date.now()-started,heldRequests:held.length,before,failed});
      await screenshot(page,'query-failed');
      await page.unroute(pattern);for (const route of held) await route.continue().catch(()=>{});
      await start(page,before.index);await waitDone(page);const after=await snapshot(page);
      assert.equal(after.flood,'ready');assert.equal(after.index,before.index);
      assert.equal(await page.evaluate(()=>currentOverlayMode),'dynamic');
      checks.push({scenario:'timed-out query retries without reload',after});await screenshot(page,'query-recovered');
    } finally {await page.close();}
  }
  assert.deepEqual(errors,[]);
} finally {
  const result={browser:name,version:browser.version(),checks,observations,errors,playbackTelemetry};
  if (output) fs.writeFileSync(path.join(output,`${name}-line-map-browser.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));await browser.close();
}
