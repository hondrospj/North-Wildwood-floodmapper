// Browser checks for the Cameras map layer. Provider media is isolated from app behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const output=process.env.NWW_AUDIT_OUTPUT;
if(output)fs.mkdirSync(output,{recursive:true});
const results=[];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const width of [1440, 390, 320]) {
    const mobile = width < 900;
    const page = await browser.newPage({ viewport: { width, height: mobile ? 844 : 1000 }, isMobile: mobile, hasTouch: mobile });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/ipcamlive|magicbrain/.test(request.url())) requests.push(request.url()); });
    await page.route(/https:\/\/(g1\.ipcamlive\.com|streamer-1\.magicbrain\.io)\//,
      route => route.fulfill({ contentType: 'text/html', body: '<p>Test camera provider</p>' }));
    page.setDefaultTimeout(20000);
    await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('nw-app-ready'), {}, { timeout: 90000 });
    assert.equal(requests.length, 0, 'No camera media before selection');
    assert.equal(await page.locator('#webcamsBrowse').count(), 0);
    async function openControls() {
      if (mobile) {
        if (!await page.locator('body').evaluate(el => el.classList.contains('mobile-controls-open'))) {
          await page.locator('#mobileControlsToggle').click();
        }
        // The app owns this tab's markup. Exercise its visible semantics rather
        // than the optional ID supplied by the older mobile navigation module.
        await page.getByRole('tab', { name: 'Map layers', exact: true }).click();
      }
      await page.locator('#webcamsToggle').click({ trial: true });
    }
    async function enableCameras(key = 'Space') {
      await openControls();
      const before = requests.length;
      await page.locator('#webcamsToggle').focus();
      await page.keyboard.press(key);
      await page.waitForFunction(() => document.querySelectorAll('[data-webcam-marker]').length === 2);
      assert.equal(await page.locator('#webcamsToggle').getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('#webcamPanel').isVisible(), false, 'Switch shows locations, not a player');
      assert.equal(await page.locator('#webcamFrame iframe').count(), 0);
      assert.equal(requests.length, before, 'Switch does not request media');
      assert.equal(await page.locator('body').evaluate(el => el.classList.contains('mobile-controls-open')), false);
    }
    async function assertMarkerGeometry() {
      const rows = await page.locator('[data-webcam-marker]').evaluateAll(nodes => nodes.map(element => {
        const box = element.getBoundingClientRect(), svg = element.querySelector('svg').getBoundingClientRect(), style = getComputedStyle(element);
        return {width:box.width,height:box.height,iconWidth:svg.width,iconHeight:svg.height,radius:style.borderRadius,background:style.backgroundColor,transition:style.transitionDuration};
      }));
      assert.equal(rows.length, 2);
      results.push({width,kind:'marker-geometry',view:await page.locator('body').getAttribute('data-map-view-mode'),rows});
      for (const row of rows) {
        assert.equal(row.width,44,'Camera marker keeps a full pointer/touch target');
        assert.equal(row.height,44,'Global button sizing must not stretch the marker');
        assert.equal(row.iconWidth,20,'Global padding must not squeeze the camera icon');
        assert.equal(row.iconHeight,20);
        assert.equal(row.radius,'50%');
        assert.equal(row.background,'rgb(18, 73, 90)','Camera marker is opaque and distinct');
        assert.equal(row.transition,'0s','Map position changes must not animate through CSS');
      }
    }
    async function assertGlMarkerPosition() {
      try { await page.waitForFunction(() => {
        const gl=window.NORTH_WILDWOOD_3D?.getMap?.(),rect=gl?.getContainer().getBoundingClientRect();
        if(!gl||gl.isMoving())return false;
        const cameras=JSON.parse(document.getElementById('shorelysafeWebcamConfig').textContent).cameras;
        return [...document.querySelectorAll('.maplibregl-marker[data-webcam-marker]')].every(marker=>{
          const camera=cameras.find(c=>c.id===marker.dataset.webcamMarker),point=gl.project([camera.lng,camera.lat]),box=marker.getBoundingClientRect();
          return Math.abs(box.x+box.width/2-rect.x-point.x)<1.5&&Math.abs(box.y+box.height/2-rect.y-point.y)<1.5;
        });
      },null,{timeout:20000});
      } catch(error) {
        const diagnostic=await page.evaluate(()=>{
          const gl=window.NORTH_WILDWOOD_3D?.getMap?.(),container=gl?.getContainer().getBoundingClientRect(),cameras=JSON.parse(document.getElementById('shorelysafeWebcamConfig').textContent).cameras;
          return {view:document.body.dataset.mapViewMode,moving:gl?.isMoving(),container,pitch:gl?.getPitch(),bearing:gl?.getBearing(),zoom:gl?.getZoom(),markers:[...document.querySelectorAll('.maplibregl-marker[data-webcam-marker]')].map(marker=>{
            const camera=cameras.find(c=>c.id===marker.dataset.webcamMarker),point=gl?.project([camera.lng,camera.lat]),box=marker.getBoundingClientRect();return{id:camera.id,point,box,style:marker.getAttribute('style'),transform:getComputedStyle(marker).transform};
          })};
        });
        results.push({kind:'position-failure',width,diagnostic});
        throw error;
      }
    }
    async function openCamera(id, keyboard = false) {
      const external = id === 'north-beach';
      const marker = page.locator(`[data-webcam-marker="${id}"]`);
      const before = requests.length;
      // Software-rendered CI can finish its first terrain paint after the
      // ready class appears. Keep the existing 60-second 3D startup budget;
      // ordinary 2D actions retain the tighter 20-second budget.
      const is3dMarker = await marker.evaluate(el => el.classList.contains('maplibregl-marker'));
      await marker.click({ trial: true, timeout: is3dMarker ? 60000 : 20000 });
      if (keyboard) { await marker.focus(); await page.keyboard.press('Enter'); }
      else await marker.click();
      await page.waitForFunction(state => !document.getElementById('webcamPanel').hidden && document.getElementById('webcamPanel').dataset.playerState === state, external ? 'external' : 'player-open');
      assert.equal(requests.length, before + (external ? 0 : 1), 'Only an embeddable camera requests a feed');
      assert.equal(await page.locator('#webcamFrame iframe').count(), external ? 0 : 1);
      assert.equal(await page.locator('#webcamPanel').evaluate(el => el.parentElement.id), 'mapWrap');
      assert.equal(await page.locator('#webcamStatus').isVisible(), false,'Successful player does not repeat provider status text');
      assert.equal(await page.locator('#webcamTitle').innerText(),'Cameras');
      assert.equal(await page.locator('#webcamLocation,#webcamLocate,#webcamOtherSources,.webcam-disclaimer').count(),0,'Camera viewer omits redundant location and explanatory blocks');
      assert.match(await page.locator('.webcam-source').innerText(),/Current view · not map time/);
      assert.ok((await page.locator('#webcamPanel').innerText()).split(/\s+/).length<=35,'Camera viewer keeps its text concise');
      assert.equal(await page.locator('#webcamRetry').isVisible(), !external);
      if (external) {
        const link = page.locator('#webcamFrame .webcam-external a');
        assert.equal(await link.getAttribute('href'), 'https://northwildwood.com/north-wildwood-surf-cams/');
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.match(await link.getAttribute('rel'), /noopener/);
      }
      const box = await page.locator('#webcamPanel').boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0);
      const fonts=await page.evaluate(()=>{const family=n=>getComputedStyle(n).fontFamily;return [family(document.body),family(document.getElementById('webcamTitle')),family(document.getElementById('webcamChoice'))];});
      assert.equal(new Set(fonts).size,1,'Camera controls keep the mapper font family');
      results.push({width,kind:'viewer',id,view:await page.locator('body').getAttribute('data-map-view-mode'),box,fonts,text:await page.locator('#webcamPanel').innerText()});
      if(output)await page.screenshot({path:path.join(output,`camera-${width}-${await page.locator('body').getAttribute('data-map-view-mode')}-${id}.png`)});
    }
    async function assertViewerClosed() {
      assert.equal(await page.locator('#webcamPanel').isVisible(), false);
      assert.equal(await page.locator('#webcamFrame iframe').count(), 0, 'Close releases media');
      assert.equal(await page.locator('[data-webcam-marker]').count(), 2, 'Close preserves the camera layer');
      assert.equal(await page.locator('#webcamsToggle').getAttribute('aria-checked'), 'true');
    }
    async function disableCameras() {
      await openControls();
      await page.locator('#webcamsToggle').click();
      assert.equal(await page.locator('#webcamsToggle').getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('[data-webcam-marker]').count(), 0);
      assert.equal(await page.locator('#webcamFrame iframe').count(), 0);
      assert.equal(await page.locator('#webcamPanel').isVisible(), false);
    }
    await enableCameras();
    await assertMarkerGeometry();
    if(!mobile){
      await page.emulateMedia({media:'print'});
      assert.equal(await page.locator('[data-webcam-marker]:visible').count(),0,'Camera markers remain excluded from print');
      await page.emulateMedia({media:'screen'});
    }
    await openCamera('north-bay');
    assert.ok(requests.some(url => url.includes('ipcamlive')));
    const oldPlayer = await page.locator('#webcamFrame iframe').elementHandle();
    const beforeBeach = requests.length;
    await page.locator('#webcamChoice').selectOption('north-beach');
    await page.waitForFunction(() => document.getElementById('webcamPanel').dataset.playerState === 'external');
    assert.equal(await oldPlayer.evaluate(el => el.isConnected), false);
    assert.equal(await page.locator('#webcamFrame iframe').count(), 0);
    assert.equal(requests.length, beforeBeach, 'Restricted beach camera never requests an iframe');
    assert.equal(await page.locator('#webcamRetry').isVisible(), false);
    await page.locator('#webcamChoice').selectOption('north-bay');
    await page.waitForFunction(() => document.getElementById('webcamPanel').dataset.playerState === 'player-open');
    assert.equal(requests.length, beforeBeach + 1, 'Switching back opens the bay player lazily');
    assert.equal(await page.locator('#webcamRetry').isVisible(), true);
    await page.keyboard.press('Escape');
    await assertViewerClosed();
    await openCamera('north-beach', true);
    await page.locator('#webcamClose').click();
    await assertViewerClosed();
    await disableCameras();
    await enableCameras('Enter');
    await openCamera('north-bay', true);
    await disableCameras();
    if (!mobile) {
      await page.locator('.nw-simple-view').click();
      await page.waitForFunction(() => document.body.classList.contains('map-3d-ready'), {}, { timeout: 60000 });
      await enableCameras();
      assert.equal(await page.locator('.maplibregl-marker[data-webcam-marker]').count(), 2);
      await assertMarkerGeometry();
      await assertGlMarkerPosition();
      await page.locator('[data-webcam-marker="north-bay"]').hover();
      await assertGlMarkerPosition();
      await page.evaluate(()=>window.NORTH_WILDWOOD_3D.getMap().jumpTo({bearing:90,pitch:60}));
      await assertGlMarkerPosition();
      await assertMarkerGeometry();
      await page.evaluate(()=>window.NORTH_WILDWOOD_3D.getMap().jumpTo({bearing:0,pitch:45}));
      await assertGlMarkerPosition();
      await openCamera('north-bay');
      await page.locator('#webcamClose').click();
      await assertViewerClosed();
      await page.locator('.nw-simple-view').click();
      await page.waitForFunction(() => document.body.dataset.mapViewMode === '2d');
      await page.waitForFunction(() => document.querySelectorAll('[data-webcam-marker]').length === 2);
      await assertMarkerGeometry();
      await disableCameras();
    }
    assert.deepEqual(errors, []);
    results.push({width,kind:'profile-complete',pageErrors:errors,mediaRequests:requests.length});
    console.log(`Webcams: ${width}px location layer, marker player, keyboard and cleanup${mobile ? '' : ', 2D/3D'} passed`);
    await page.close();
  }
} finally { if(output)fs.writeFileSync(path.join(output,'webcam-result.json'),JSON.stringify({browser:browser.version(),results},null,2)+'\n');await browser.close(); }
