// Browser behavior checks. Uses NWW_TEST_URL, PLAYWRIGHT_MODULE and CHROME_PATH.
// Mock only the third-party player so provider uptime cannot mask app regressions.
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
    await page.route('https://g1.ipcamlive.com/**', route => route.fulfill({contentType:'text/html',body:'<p>Test camera provider</p>'}));
    page.setDefaultTimeout(20000);
    await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.body.classList.contains('nw-app-ready'),{},{timeout:90000});
    assert.equal(requests.length,0,'Camera loads must wait for user selection');
    async function openControls() {
      if (mobile) {
        await page.locator('#mobileControlsToggle').click();
        await page.locator('#nwwMapTab').click();
      }
    }
    await openControls();
    await page.locator('#webcamsToggle').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelectorAll('[data-webcam-marker]').length === 2);
    assert.equal(requests.length,0,'Enabling markers must not load video');
    if (mobile) await page.locator('#webcamsBrowse').click();
    else {
      await page.locator('[data-webcam-marker="bay"]').focus();
      await page.keyboard.press('Enter');
    }
    await page.waitForFunction(() => document.getElementById('webcamPanel').dataset.playerState === 'player-open');
    assert.equal(await page.locator('#webcamFrame iframe').count(),1);
    assert.match(await page.locator('#webcamStatus').innerText(),/timestamp.*provider/,'Player load must not claim a verified live feed');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('mobile-controls-open')),false);
    const box = await page.locator('#webcamPanel').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0,'Viewer must fit viewport');
    const cameraRequestCount = requests.length;
    await page.locator('[data-camera="beach"]').click();
    assert.equal(await page.locator('#webcamFrame iframe').count(),0,'Switching away must release the old player');
    assert.equal(requests.length,cameraRequestCount,'Restricted beach player must not be embedded');
    assert.equal(await page.locator('#webcamFrame a').getAttribute('href'),'https://northwildwood.com/north-wildwood-surf-cams/');
    assert.equal(await page.locator('#webcamRetry').isVisible(),false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#webcamPanel').isVisible(),false);
    assert.equal(await page.evaluate(() => document.activeElement.id),mobile ? 'mobileControlsToggle' : '');
    if (!mobile) {
      assert.equal(await page.evaluate(() => document.activeElement.dataset.webcamMarker),'bay');
      await page.locator('.nw-simple-view').click();
      await page.waitForFunction(() => document.body.classList.contains('map-3d-ready'),{},{timeout:60000});
      await page.waitForFunction(() => document.querySelectorAll('.maplibregl-marker[data-webcam-marker]').length === 2);
      assert.equal(await page.locator('[data-webcam-marker]').count(),2,'3D must not duplicate markers');
      await page.locator('[data-webcam-marker="bay"]').click();
      await page.waitForFunction(() => document.getElementById('webcamPanel').dataset.playerState === 'player-open');
      await page.locator('#webcamClose').click();
      assert.equal(await page.locator('#webcamFrame iframe').count(),0);
      await page.locator('.nw-simple-view').click();
      await page.waitForFunction(() => document.body.dataset.mapViewMode === '2d');
      assert.equal(await page.locator('[data-webcam-marker]').count(),2);
    }
    await openControls();
    await page.locator('#webcamsToggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-webcam-marker]').count(),0);
    assert.equal(await page.locator('#webcamFrame iframe').count(),0);
    assert.equal(await page.locator('#webcamsBrowse').isVisible(),false);
    assert.deepEqual(errors,[],'No uncaught application errors');
    console.log(`Webcams: ${width}px keyboard, lazy loading, cleanup${mobile ? '' : ', 2D/3D'} passed`);
    await page.close();
  }
} finally { await browser.close(); }
