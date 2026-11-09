import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const engine = process.env.NWW_BROWSER || 'chromium';
const profile = process.env.NWW_PROFILE || 'desktop';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await playwright[engine === 'edge' ? 'chromium' : engine].launch({
  headless: true,
  ...(engine === 'edge' ? { channel: 'msedge' } : {}),
  ...(engine === 'chromium' && process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  ...(engine === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL && !process.env.CHROME_PATH
    ? { channel: process.env.NWW_CHROMIUM_CHANNEL }
    : {}),
  ...(['chromium', 'edge'].includes(engine)
    ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
    : {}),
});
const output = process.env.NWW_AUDIT_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'nww-webgl-fallback-'));
fs.mkdirSync(output, { recursive: true });
const result = { engine, version: browser.version(), profile, cases: [] };
const target = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';

async function snapshot(page) {
  return page.evaluate(() => {
    const native = NORTH_WILDWOOD_3D.getMap();
    const leaf = document.getElementById('map');
    const view = document.querySelector('.nw-simple-view');
    const frame = currentFloodLayer?._floodmapperFrame;
    const toggle = id => document.getElementById(id).getAttribute('aria-checked');
    return {
      mode: document.body.dataset.map3d,
      visibleLeaflet: getComputedStyle(leaf).display !== 'none' && leaf.clientWidth > 0,
      nativeCanvas: Boolean(native) && document.querySelector('#map3d canvas') !== null,
      visibleLabel: view.getAttribute('aria-label'),
      currentTime: currentSeriesHours[currentHourIndex]?.timeUtc,
      frameTime: frame?.entry?.timeUtc,
      overlayMode: frame?.overlayMode,
      overlayOpacity,
      frameState: floodFrameState,
      clickMode: mapClickMode,
      timeCanvasStage: document.body.dataset.map3dFloodTexture,
      leafletZoom: map.getZoom(),
      leafletCenter: [map.getCenter().lng, map.getCenter().lat],
      nativeZoom: native?.getZoom(),
      nativePitch: native?.getPitch(),
      nativeCenter: native && [native.getCenter().lng, native.getCenter().lat],
      layers: {
        roads: toggle('roadsToggle'), buildings: toggle('buildingsToggle'),
        parcels: toggle('parcelsToggle'), nsi: toggle('nsiStructuresToggle'),
        satellite: toggle('satelliteToggle')
      },
      attached: {
        basemap: Boolean(basemapColorLayer && map.hasLayer(basemapColorLayer)),
        roads: Boolean(roadsLayer && map.hasLayer(roadsLayer)),
        buildings: Boolean(buildingsLayer && map.hasLayer(buildingsLayer)),
        parcels: Boolean(parcelsLayer && map.hasLayer(parcelsLayer)),
        nsi: Boolean(nsiStructuresLayer && map.hasLayer(nsiStructuresLayer)),
        satellite: Boolean(satelliteLayer && map.hasLayer(satelliteLayer)),
        flood: Boolean(currentFloodLayer && map.hasLayer(currentFloodLayer)),
      },
      notice: document.getElementById('toastMessage')?.textContent,
      noticeVisible: document.getElementById('toast').classList.contains('show'),
      noticeRole: document.getElementById('toast').getAttribute('role'),
      noticeLive: document.getElementById('toast').getAttribute('aria-live'),
      events: window.__nwwGraphicsEvents || [],
    };
  });
}

async function waitForNative(page) {
  await page.waitForFunction(() => document.body.dataset.map3d === 'ready' &&
    document.querySelector('.nw-simple-view').getAttribute('aria-busy') === 'false' &&
    document.body.dataset.map3dFloodTexture === 'ready', null, { timeout: 30000 });
}

async function loseGraphics(page) {
  const supported = await page.evaluate(() => {
    const canvas = NORTH_WILDWOOD_3D.getMap().getCanvas();
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    window.__nwwGraphicsEvents = [];
    window.__nwwGraphicsExtension = extension;
    for (const type of ['webglcontextlost', 'webglcontextrestored']) {
      canvas.addEventListener(type, event => window.__nwwGraphicsEvents.push({ type, trusted: event.isTrusted }));
    }
    extension.loseContext();
    return true;
  });
  assert.ok(supported, 'This native regression requires WEBGL_lose_context capability');
  await page.waitForFunction(() => document.body.dataset.map3d === 'recovering' &&
    window.__nwwGraphicsEvents.some(event => event.type === 'webglcontextlost' && event.trusted),
    null, { timeout: 5000 });
}

async function setLayerPreferences(page) {
  if (profile === 'touch') {
    await page.locator('#mobileControlsToggle').click();
    await page.getByRole('tab', { name: 'Map layers', exact: true }).click();
  }
  for (const id of ['satelliteToggle', 'parcelsToggle', 'nsiStructuresToggle']) {
    const toggle = page.locator('#' + id);
    if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
  }
  if (profile === 'touch') await page.locator('#mobileControlsClose').click();
  await page.waitForFunction(() => {
    const native = NORTH_WILDWOOD_3D.getMap();
    return native.getLayer('nw-parcel-vector') && native.getLayer('nw-nsi-points');
  }, null, { timeout: 25000 });
  await page.locator('#mapClickDepthBtn').click();
}

try {
  for (const kind of (process.env.NWW_CASES || 'transient-loss,permanent-loss').split(',')) {
    const context = await browser.newContext(profile === 'touch'
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'America/New_York' }
      : { viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const row = { kind, pageErrors: [], states: [] };
    result.cases.push(row);
    page.on('pageerror', error => row.pageErrors.push(error.message));
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') &&
        !document.getElementById('app').inert && floodFrameState === 'ready', null, { timeout: 90000 });
      const launcher = page.locator('.nw-simple-view');
      await launcher.click();
      await waitForNative(page);
      if (kind === 'permanent-loss') {
        if (profile === 'desktop') {
          await page.locator('#dynamicModeBtn').click();
          await page.waitForFunction(() => floodFrameState === 'ready' &&
            currentFloodLayer?._floodmapperFrame?.overlayMode === 'dynamic');
        }
        await setLayerPreferences(page);
        await page.locator('.nw-simple-zoom-in').click();
        await page.waitForFunction(() => NORTH_WILDWOOD_3D.getMap().getZoom() === map.getZoom());
      }
      const initial = await snapshot(page);
      row.states.push({ label: 'initial', ...initial });
      assert.ok(initial.nativePitch > 10);
      await loseGraphics(page);
      row.states.push({ label: 'recovering', ...await snapshot(page) });
      if (kind === 'transient-loss') {
        if (profile === 'desktop') await page.locator('#opacitySlider').press('ArrowRight');
        const expectedOpacity = await page.evaluate(() => overlayOpacity);
        if (profile === 'desktop') assert.ok(expectedOpacity > initial.overlayOpacity);
        await page.evaluate(() => { window.__nwwGraphicsExtension.restoreContext(); });
        await waitForNative(page);
        const restored = await snapshot(page);
        row.states.push({ label: 'restored', ...restored });
        assert.ok(restored.events.some(event => event.type === 'webglcontextrestored' && event.trusted));
        assert.equal(restored.nativeCanvas, true);
        assert.equal(restored.visibleLeaflet, false);
        assert.equal(restored.overlayOpacity, expectedOpacity);
        assert.equal(await page.evaluate(() => NORTH_WILDWOOD_3D.getMap()
          .getPaintProperty('nw-flood-drape', 'raster-opacity')), expectedOpacity);
        for (const key of ['currentTime', 'frameTime', 'overlayMode',
          'nativePitch', 'nativeZoom', 'nativeCenter', 'layers']) {
          assert.deepEqual(restored[key], initial[key], key);
        }
      } else {
        await page.waitForFunction(() => ['fallback', 'unavailable'].includes(document.body.dataset.map3d),
          null, { timeout: 24000 });
        const fallback = await snapshot(page);
        row.states.push({ label: 'recovery-timeout', ...fallback });
        assert.equal(fallback.mode, 'fallback', 'A permanently lost native renderer must return to Leaflet');
        assert.equal(fallback.nativeCanvas, false);
        assert.equal(fallback.visibleLeaflet, true);
        assert.match(fallback.visibleLabel, /2D view active/i);
        assert.equal(fallback.noticeVisible, true);
        assert.equal(fallback.noticeRole, 'status');
        assert.equal(fallback.noticeLive, 'polite');
        assert.match(fallback.notice, /2D map is active/i);
        assert.deepEqual(fallback.attached, {
          basemap: true, roads: true, buildings: true, parcels: true, nsi: true, satellite: true, flood: true,
        });
        assert.deepEqual(fallback.leafletCenter, initial.nativeCenter);
        assert.equal(fallback.leafletZoom, initial.nativeZoom);
        for (const key of ['currentTime', 'frameTime', 'overlayMode', 'overlayOpacity', 'clickMode', 'layers']) {
          assert.deepEqual(fallback[key], initial[key], key);
        }
        if (process.env.NWW_AUDIT_OUTPUT) {
          await page.screenshot({ path: path.join(output, `${profile}-leaflet-fallback.png`) });
        }
        await page.locator('.nw-simple-zoom-in').click();
        await page.waitForFunction(zoom => map.getZoom() > zoom, fallback.leafletZoom);
        const move = await page.evaluate(() => currentHourIndex < currentSeriesHours.length - 1 ? 'ArrowRight' : 'ArrowLeft');
        await page.locator('#hourSlider').press(move);
        await page.waitForFunction(time => floodFrameState === 'ready' &&
          currentSeriesHours[currentHourIndex]?.timeUtc !== time, fallback.currentTime);
        const updated = await snapshot(page);
        row.states.push({ label: 'leaflet-interaction', ...updated });
        assert.notEqual(updated.currentTime, fallback.currentTime);
        assert.equal(updated.frameTime, updated.currentTime);
        await launcher.click();
        await waitForNative(page);
        const relaunched = await snapshot(page);
        row.states.push({ label: 'fresh-native-relaunch', ...relaunched });
        assert.ok(relaunched.nativePitch > 10);
        assert.equal(relaunched.currentTime, updated.currentTime);
        assert.equal(relaunched.nativeZoom, updated.leafletZoom);
        assert.deepEqual(relaunched.layers, fallback.layers);
        assert.doesNotMatch(relaunched.notice || '', /2D map is active/i);
      }
      assert.deepEqual(row.pageErrors, []);
    } catch (error) {
      row.failure = error.stack || String(error);
      row.states.push({ label: 'failure', ...await snapshot(page).catch(() => ({})) });
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(output, 'native-webgl-fallback.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
