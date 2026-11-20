import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name].launch({
  headless: true,
  ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const candidate = process.env.NWW_PHONE_PREVIEW_HTML;
const viewports = [
  {width: 320, height: 640},
  {width: 390, height: 844},
  {width: 844, height: 390},
  {width: 568, height: 320},
  {width: 820, height: 1180},
];
const overlap = (a,b) => a && b && Math.min(a.right,b.right) - Math.max(a.x,b.x) > 1 &&
  Math.min(a.bottom,b.bottom) - Math.max(a.y,b.y) > 1;
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (candidate) {
      await page.route(url, route => route.fulfill({path:candidate, contentType:'text/html; charset=utf-8'}));
      await page.route(new URL('assets/**',url).href, async route => {
        const path=join(dirname(candidate),'assets',decodeURIComponent(new URL(route.request().url()).pathname.split('/assets/')[1]));
        if (!await stat(path).then(file=>file.isFile(),()=>false)) return route.continue();
        return route.fulfill({path, ...(path.endsWith('.js') ? {contentType:'application/javascript; charset=utf-8'} : {})});
      });
    }
    await page.goto(url, {waitUntil:'domcontentloaded', timeout:45_000});
    await page.waitForFunction(() => floodFrameState === 'ready' && document.body.dataset.siteLoader === 'complete' &&
      document.body.hasAttribute('data-nww-credits-ready'), {}, {timeout:45_000});
    const state = await page.evaluate(() => {
      const box = id => {
        const element = document.querySelector(id);
        return element?.getClientRects().length ? element.getBoundingClientRect().toJSON() : null;
      };
      return {
        title:box('#mapTitleText'), key:box('#legendDock'), controls:box('#mobileControlsToggle'),
        tour:box('#mobileMapperTutorialBtn'), credits:box('#mapCredits summary'),
        compass:box('#nwDefaultNavControl .nw-direction-wheel'), dock:box('#timelineDock'),
        time:box('#timelineBubble'), steps:['#timelineStepBack','#timelineStepForward','#playBtn'].map(box),
        days:box('#timelineDayTabs'), slider:box('#hourSlider'), legend:box('#timelineFloodKey'),
        width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      };
    });
    const layout = JSON.stringify({viewport,state});
    assert.equal(state.width,state.scrollWidth,layout);
    for (const part of [state.title,state.key,state.controls,state.tour,state.credits,state.compass,state.dock,
      ...state.steps,state.days,state.slider,state.legend]) {
      assert(part && part.x>=-1 && part.right<=state.width+1 && part.y>=0 && part.bottom<=state.height+1,layout);
    }
    assert.equal(state.dock.height,viewport.height<500 ? 106 : 154,layout);
    assert.ok(Math.abs(state.key.bottom-state.controls.bottom)<=1,layout);
    assert.ok(Math.abs(state.key.right-state.controls.left)<=1,layout);
    assert.ok(Math.abs(state.key.left-state.dock.left)<=2,layout);
    assert.ok(Math.abs(state.controls.bottom-state.dock.top+7)<=1,layout);
    assert.ok(state.title.bottom<state.controls.top,layout);
    assert.equal(await page.locator('#legendDock').evaluate(el=>getComputedStyle(el,'::after').content),'"Legend"');
    const controlsLabelFits = await page.locator('#mobileControlsToggle').evaluate(el => {
      const label = getComputedStyle(el,'::after');
      const context = document.createElement('canvas').getContext('2d');
      context.font = label.font;
      const space = parseFloat(label.width);
      return context.measureText('Controls').width < space && space < el.clientWidth - 20;
    });
    assert(controlsLabelFits,layout);
    for (const button of [state.key,state.controls,state.tour,state.credits,...state.steps]) {
      assert.ok(button.height>=44 && button.width>=44,layout);
    }
    for (const [a,b] of [[state.title,state.key],[state.key,state.controls],[state.tour,state.credits],
      [state.credits,state.compass],[state.time,state.steps[0]],[state.steps[0],state.steps[1]],
      [state.steps[1],state.steps[2]],[state.days,state.slider]]) {
      assert(!overlap(a,b),layout);
    }
    assert.equal(await page.locator('#mobileMapperTutorialBtn').textContent(),'Take the Flood Mapper Tour');
    await page.evaluate(()=>{ document.body.dataset.tourAttention='true'; });
    assert.equal(await page.locator('#mobileMapperTutorialBtn').evaluate(el=>getComputedStyle(el).animationName),'none');
    assert.equal(await page.locator('#map .leaflet-control-attribution').isVisible(),false);
    assert(!/\bLeaflet\b/.test(await page.locator('#mapCreditsSources').textContent()));
    await page.locator('#mapCredits summary').tap();
    await page.locator('#mapCredits a[href*="openstreetmap.org/copyright"]').waitFor({state:'visible'});
    assert.match(await page.locator('#mapCreditsSources').textContent(),/Esri/i);
    await page.locator('#mapCredits summary').press('Escape');
    assert.equal(await page.locator('#mapCredits').getAttribute('open'),null);

    await page.locator('#legendDock').tap();
    await page.waitForFunction(()=>document.getElementById('legendDock').getAttribute('aria-expanded')==='true');
    const legend = page.locator('#legendList');
    await legend.waitFor({state:'visible'});
    assert.match(await legend.textContent(),/Shallow|Minor/);
    assert((await legend.boundingBox()).y < state.key.top,layout);
    await page.locator('#legendDock').press('Escape');
    await page.waitForFunction(()=>document.getElementById('legendDock').getAttribute('aria-expanded')==='false');

    await page.locator('#mobileControlsToggle').tap();
    const drawer = page.locator('#leftPanel[aria-modal="true"]');
    await drawer.waitFor();
    const mapTab = drawer.getByRole('tab',{name:'Map layers'});
    await mapTab.tap();
    await page.waitForFunction(() => {
      const panel = document.getElementById('leftPanel');
      const layers = panel.querySelector('.layers-card');
      const address = panel.querySelector('#townAddressCard');
      return panel.dataset.nwwSection === 'map' &&
        panel.querySelector('[data-group="map"]').getAttribute('aria-selected') === 'true' &&
        (!address.getClientRects().length || layers.getBoundingClientRect().top < address.getBoundingClientRect().top);
    }, {}, {timeout:7_000});
    await drawer.getByRole('switch',{name:/roads with 6\+ inches of water/i}).waitFor();
    await drawer.getByRole('tab',{name:'Tools'}).tap();
    await page.locator('#townAddressCard').waitFor();
    await page.locator('#openDownloadModalBtn').tap();
    await page.locator('#downloadModal').waitFor();
    await page.locator('#downloadModalCloseBtn').tap();
    await page.locator('#downloadModal').waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);
    console.log(`${name} ${viewport.width}×${viewport.height}: header, credits, navigation, timeline, and drawer passed`);
    await context.close();
  }
} finally {
  await browser.close();
}
