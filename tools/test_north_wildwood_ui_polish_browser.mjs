import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const preview = process.env.NWW_UI_PREVIEW_HTML;

async function closeShape(locator, size) {
  await locator.waitFor();
  const shape = await locator.evaluate(button => {
    const { x, y, width, height } = button.getBoundingClientRect();
    const strokes = ['::before', '::after'].map(pseudo => getComputedStyle(button, pseudo));
    return { width, height, radius: getComputedStyle(button).borderTopLeftRadius,
      strokes: strokes.map(style => [style.width, style.height]),
      reachable: button.contains(document.elementFromPoint(x + width / 2, y + height / 2)) };
  });
  assert.deepEqual(shape, { width: size, height: size, radius: '8px', strokes: [['14px', '2px'], ['14px', '2px']], reachable: true });
}

try {
  for (const { width, height, isMobile } of [
    { width: 1440, height: 900, isMobile: false },
    { width: 320, height: 640, isMobile: true },
    { width: 568, height: 320, isMobile: true },
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile, hasTouch: isMobile });
    const page = await context.newPage();
    if (preview) {
      await page.route(url, route => route.fulfill({ path: preview, contentType: 'text/html' }));
      await page.route(new URL('assets/**', url).href, async route => {
        const relative = new URL(route.request().url()).pathname.split('/assets/')[1];
        const path = join(dirname(preview), 'assets', decodeURIComponent(relative));
        if (!await stat(path).then(file => file.isFile(), () => false)) return route.continue();
        return route.fulfill({ path, ...(path.endsWith('.js') ? { contentType: 'text/javascript' } : {}) });
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => document.body.dataset.siteLoader === 'complete' && floodFrameState === 'ready', null, { timeout: 90000 });
    const closeSize = isMobile ? 44 : 36;
    assert.equal(await page.locator('#mobileControlsClose').isVisible(), false);
    if (isMobile) {
      await page.locator('#mobileControlsToggle').click();
      await closeShape(page.locator('#mobileControlsClose'), closeSize);
    }
    assert.equal(await page.locator('#forecastScenarioCard h2').textContent(), 'Forecast Range');
    assert.deepEqual(await page.locator('#forecastScenarioCard [data-scenario]').allTextContents(), ['Best Case', 'Likely', 'Worst Case']);
    assert.equal(await page.locator('#returnIntervalDataBtn').textContent(), 'Modeled Floods');
    const forecastHelpOnRight = await page.locator('#forecastTypeHelpBtn').evaluate(help => {
      const label = help.closest('.title-with-help');
      return Math.abs(label.getBoundingClientRect().right - help.getBoundingClientRect().right) <= 1;
    });
    assert.ok(forecastHelpOnRight);
    if (isMobile) await page.getByRole('tab', { name: 'Map layers' }).click();

    const sizes = await page.locator('#datumMllwBtn,#datumNavd88Btn,#depthModeBtn,#dynamicModeBtn')
      .evaluateAll(buttons => buttons.map(button => getComputedStyle(button).fontSize));
    assert.equal(sizes.length, 4);
    assert.equal(new Set(sizes).size, 1, `Matching datum and overlay typography: ${sizes.join(', ')}`);
    const layers = page.locator('.layers-card');
    assert.equal(await layers.locator('.help-btn').count(), 1);
    const layerNames = await layers.locator('.layer-name').allTextContents();
    assert.ok(layerNames.includes('Roads With 6+ Inches of Water'));
    const layerHelp = layers.getByRole('button', { name: 'About map layers' });
    await layerHelp.click();
    const help = page.locator('#infoModal');
    await help.waitFor();
    assert.deepEqual(await help.locator('.layer-help-list dt').allTextContents(), layerNames);
    assert.ok((await help.locator('.layer-help-list dd').allTextContents()).every(text => text.trim().length > 0));
    const closeHelp = page.locator('#infoModalCloseBtn');
    await closeShape(closeHelp, closeSize);
    await closeHelp.click();
    await help.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement.id === 'layersHelpBtn');
    if (isMobile) await page.locator('#mobileControlsClose').click();

    await page.evaluate(() => {
      openParcelFloodPrompt({ properties: {
        address: '107 E 9TH AVE', parcelId: 'test-parcel', nsi2026FoundationHeightFt: 2,
        nsi2026ModeledFirstFloorNavd88Ft: 7.6,
      } }, map.getCenter());
    });
    const building = page.locator('.leaflet-popup .building-info-card');
    await building.waitFor();
    assert.equal(await building.locator('h3').textContent(), '107 E 9TH AVE');
    await building.getByRole('button', { name: 'See Flood History & Projections' }).waitFor();
    assert.doesNotMatch(await building.textContent(), /Crawlspace|garage depth|estimated occupied floor|2\.0 ft/i);
    const closeBuilding = page.locator('.leaflet-popup-close-button');
    await closeShape(closeBuilding, closeSize);
    await closeBuilding.click();
    await building.waitFor({ state: 'hidden' });

    const failure = await page.evaluate(() => {
      const previousLayer = currentFloodLayer;
      const previousTime = currentHourIndex;
      toast('');
      reportFloodFrameFailure();
      toast('Failed to fetch');
      updateFloodFrameStatus();
      return { retained: map.hasLayer(previousLayer) && currentFloodLayer === previousLayer,
        timeUnchanged: currentHourIndex === previousTime,
        rawToastVisible: document.getElementById('toast').classList.contains('show'),
        legacyMessage: document.getElementById('floodFrameStatus').textContent.includes('Could not load the selected flood image') };
    });
    assert.deepEqual(failure, { retained: true, timeUnchanged: true, rawToastVisible: false, legacyMessage: false });

    await page.evaluate(() => {
      const sample = currentSeriesHours.find(entry => getStageValue(entry) != null);
      const start = Date.parse('2026-11-20T05:00:00Z');
      currentSeriesHours = Array.from({ length: 97 }, (_, hour) => ({ ...sample,
        timeUtc: new Date(start + hour * 3600000).toISOString(),
      }));
      currentHourIndex = currentSeriesHours.length - 1;
      renderTimelineDays();
    });
    const tuesday = page.locator('#timelineDayTabs .timeline-day[aria-current="true"]');
    assert.equal(await tuesday.textContent(), 'Tue 24');
    await page.waitForFunction(() => {
      const strip = document.getElementById('timelineDayTabs');
      const day = strip.querySelector('.timeline-day[aria-current="true"]');
      const range = document.createRange();
      range.selectNodeContents(day);
      const text = range.getBoundingClientRect();
      const pill = day.getBoundingClientRect();
      const viewport = strip.getBoundingClientRect();
      return text.left >= Math.max(pill.left, viewport.left) - 1 && text.right <= Math.min(pill.right, viewport.right) + 1;
    }, null, { timeout: 8000 });
    console.log(`${engine} ${width}×${height} passed layout, help, popup, close controls, retained frame and partial Tuesday checks`);
    await context.close();
  }
} finally {
  await browser.close();
}
