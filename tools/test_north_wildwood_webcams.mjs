// Browser behavior checks. Uses NWW_TEST_URL, PLAYWRIGHT_MODULE and CHROME_PATH.
// Mock only third-party players so provider uptime cannot mask app regressions.
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  for (const width of [1440, 390, 320]) {
    const mobile = width < 900;
    const page = await browser.newPage({viewport:{width,height:mobile ? 844 : 1000},isMobile:mobile,hasTouch:mobile});
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/ipcamlive|magicbrain/.test(request.url())) requests.push(request.url()); });
    await page.route(/https:\/\/(g1\.ipcamlive\.com|streamer-1\.magicbrain\.io)\//, route => route.fulfill({contentType:'text/html',body:'<p>Test camera provider</p>'}));
    page.setDefaultTimeout(20000);
    await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
    assert.equal(requests.length,0,'Cameras off must not load camera media');
    assert.equal(await page.locator('#webcamsBrowse').count(),0,'No separate View cameras action');
    async function openControls() {
      if (mobile) {
        await page.locator('#mobileControlsToggle').click();
        const mapTab = page.locator('#nwwMapTab');
        if (await mapTab.isVisible()) await mapTab.click();
      }
    }
    async function enableCameras(key = 'Space') {
      await openControls();
      await page.locator('#webcamsToggle').focus();
      await page.keyboard.press(key);
      await page.waitForFunction(() => document.getElementById('webcamPanel').dataset.playerState === 'player-open');
      assert.equal(await page.locator('#webcamsToggle').getAttribute('aria-checked'),'true');
      assert.equal(await page.locator('#webcamFrame iframe').count(),1,'One switch must immediately open one feed');
      assert.equal(await page.locator('#webcamPanel').evaluate(el => el.parentElement.id),'mapWrap','Viewer must stay in the shared map overlay');
      assert.equal(await page.locator('body').evaluate(el => el.classList.contains('mobile-controls-open')),false,'Camera view must dismiss mobile controls');
      assert.ok((await page.locator('#webcamLocation').innerText()).length > 10,'Camera view must identify its location');
      assert.match(await page.locator('#webcamStatus').innerText(),/availability shown by provider/,'Player load must not claim a verified live feed');
      const box = await page.locator('#webcamPanel').boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0,'Viewer must fit viewport');
      await page.waitForFunction(() => document.querySelectorAll('[data-webcam-marker]').length === 2);
    }
    async function assertOff() {
      assert.equal(await page.locator('#webcamsToggle').getAttribute('aria-checked'),'false');
      assert.equal(await page.locator('#webcamPanel').isVisible(),false);
      assert.equal(await page.locator('[data-webcam-marker]').count(),0,'Cameras off must clear map markers');
      assert.equal(await page.locator('#webcamFrame iframe').count(),0,'Cameras off must release the player');
    }
    await enableCameras();
    assert.ok(requests.some(url => url.includes('ipcamlive')),'Switching on must load the default bay feed');
    const oldPlayer = await page.locator('#webcamFrame iframe').elementHandle();
    await page.locator('#webcamChoice').selectOption('north-beach');
    await page.waitForFunction(() => document.getElementById('webcamPanel').dataset.playerState === 'player-open');
    assert.equal(await oldPlayer.evaluate(el => el.isConnected),false,'Changing cameras must release the previous iframe');
    assert.equal(await page.locator('#webcamFrame iframe').count(),1);
    assert.match(await page.locator('#webcamFrame iframe').getAttribute('src'),/magicbrain/);
    assert.ok(requests.some(url => url.includes('magicbrain')),'Published beach embed must load after camera selection');
    await page.keyboard.press('Escape');
    await assertOff();
    assert.equal(await page.evaluate(() => document.activeElement.id),mobile ? 'mobileControlsToggle' : 'webcamsToggle');

    await enableCameras('Enter');
    await page.locator('#webcamClose').click();
    await assertOff();
    if (!mobile) {
      await page.locator('.nw-simple-view').click();
      await page.waitForFunction(() => document.body.classList.contains('map-3d-ready'),{},{timeout:60000});
      await enableCameras();
      assert.equal(await page.locator('.maplibregl-marker[data-webcam-marker]').count(),2,'3D must have exactly one marker per camera');
      await page.locator('#webcamClose').click();
      await assertOff();
      await page.locator('.nw-simple-view').click();
      await page.waitForFunction(() => document.body.dataset.mapViewMode === '2d');
      await assertOff();
    }
    assert.deepEqual(errors,[],'No uncaught application errors');
    console.log(`Webcams: ${width}px automatic feed, location, keyboard, cleanup${mobile ? '' : ', 2D/3D'} passed`);
    await page.close();
  }
} finally { await browser.close(); }
