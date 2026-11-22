import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { touchMapGesture } from './browser_map_view.mjs';

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
        title:box('#mapTitleBadge'), key:box('#nwwMobileLegendToggle'), controls:box('#mobileControlsToggle'),
        tour:box('#mobileMapperTutorialBtn'), credits:box('#mapCredits summary'),
        toolbar:box('#nwwMobileUtilities'), dock:box('#timelineDock'),
        nav:['#nwDefaultNavControl','.leaflet-control-zoom','.nw-direction-wheel','.nw-simple-zoom'].map(box),
        time:box('#timelineBubble'), steps:['#timelineStepBack','#timelineStepForward','#playBtn'].map(box),
        days:box('#timelineDayTabs'), slider:box('#hourSlider'), legend:box('#timelineFloodKey'),
        width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      };
    });
    const layout = JSON.stringify({viewport,state});
    assert.equal(state.width,state.scrollWidth,layout);
    for (const part of [state.title,state.key,state.controls,state.tour,state.toolbar,state.dock,
      ...state.steps,state.days,state.slider,state.legend]) {
      assert(part && part.x>=-1 && part.right<=state.width+1 && part.y>=0 && part.bottom<=state.height+1,layout);
    }
    assert.equal(state.dock.height,viewport.height<500 ? 106 : 154,layout);
    assert(state.nav.every(box => box === null),layout);
    assert.equal(state.credits,null,'Credits are available in the Controls drawer');
    assert.ok(state.toolbar.height === 50 && state.toolbar.bottom < state.dock.top,layout);
    assert.ok(state.title.left >= state.toolbar.left && state.title.right <= state.tour.left,layout);
    const actions = [state.tour,state.controls,state.key];
    for (const [index,button] of actions.entries()) {
      assert.ok(button.top >= state.toolbar.top && button.bottom <= state.toolbar.bottom,layout);
      assert.ok(Math.abs(button.top - state.tour.top) <= 1,layout);
      assert.ok(index === 0 || actions[index - 1].right <= button.left,layout);
    }
    for (const button of [...actions,...state.steps]) {
      assert.ok(button.height>=44 && button.width>=44,layout);
    }
    const header = await page.locator('#nwwMobileUtilities').evaluate(toolbar => {
      const rect = toolbar.getBoundingClientRect();
      const title = toolbar.querySelector('#mapTitleBadge').getBoundingClientRect();
      const actions = toolbar.querySelector('.nww-mobile-actions').getBoundingClientRect();
      const gapHit = document.elementFromPoint((title.right + actions.left) / 2, (title.top + title.bottom) / 2);
      const labels = toolbar.querySelectorAll('.nww-mobile-title strong,.nww-mobile-title > span,.nww-mobile-actions button > span:last-child');
      const actionTextTops = [...labels].slice(-3).map(label => label.getBoundingClientRect().top);
      return {
        strings: [...labels].map(label => label.textContent),
        aligned: Math.max(...actionTextTops) - Math.min(...actionTextTops) <= .5,
        clearGap: actions.left - title.right >= 8 && !toolbar.contains(gapHit),
        fits: [...labels].every(label => {
          const style = getComputedStyle(label);
          if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
          const text = document.createRange();
          text.selectNodeContents(label);
          const textRects = [...text.getClientRects()];
          return textRects.length === 1 && textRects.every(box => box.left >= rect.left && box.right <= rect.right &&
            box.top >= rect.top && box.bottom <= rect.bottom);
        }),
        reachable: [...toolbar.querySelectorAll('.nww-mobile-actions button')].every(button => {
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      };
    });
    assert.deepEqual(header.strings,['North Wildwood','Flood Mapper','Tour','Controls','Legend']);
    assert.ok(header.fits && header.reachable && header.clearGap && header.aligned,layout);
    for (const [a,b] of [[state.time,state.steps[0]],[state.steps[0],state.steps[1]],
      [state.steps[1],state.steps[2]],[state.days,state.slider]]) {
      assert(!overlap(a,b),layout);
    }
    assert.ok(state.time.bottom <= state.dock.top && state.time.left >= state.dock.left &&
      state.time.right <= state.dock.right, 'The reading follows the thumb above the dock without clipping');
    const painted = await page.locator('#timelineBubble').evaluate(pill=>new Promise(resolve=>{
      const observer=new IntersectionObserver(([entry])=>{
        observer.disconnect();
        resolve(entry.intersectionRatio);
      });
      observer.observe(pill);
    }));
    assert.ok(painted > .99, 'The dock does not clip the floating reading');
    const decoration = await page.locator('#timelineBubble').evaluate(pill=>{
      const level=getComputedStyle(pill.querySelector('.timeline-bubble-stage'));
      return {pointer:getComputedStyle(pill,'::before').display,background:level.backgroundColor,border:level.borderTopWidth};
    });
    assert.deepEqual(decoration,{pointer:'none',background:'rgba(0, 0, 0, 0)',border:'0px'},
      'Compact slider readings have plain text and no pointer decoration');
    if (viewport.width === 390) {
      const slider=page.locator('#hourSlider');
      const ends=await slider.evaluate(input=>({min:Number(input.min),max:Number(input.max),value:input.valueAsNumber}));
      assert.ok(ends.max > ends.min);
      const factor=ends.value >= (ends.max + ends.min)/2 ? .12 : .88;
      await page.touchscreen.tap(state.slider.left + state.slider.width * factor,
        state.slider.top + state.slider.height/2);
      await page.waitForFunction(start=>{
        const range=document.getElementById('hourSlider');
        return range.valueAsNumber !== start && range.valueAsNumber === currentHourIndex &&
          !pendingTimelineSelection && !requestedTimelineSelection;
      },ends.value);
      const moved=await page.locator('#timelineBubble').boundingBox();
      assert.ok(Math.abs(moved.x - state.time.x) > 16,'Touch changes the position of the same time and level pill');
    }
    const timeline = await page.locator('#timelineDock').evaluate(dock => ({
      labels: [...dock.querySelectorAll('.timeline-key-item > .timeline-key-label')].map(label => ({
        size: parseFloat(getComputedStyle(label).fontSize),
        rect: label.getBoundingClientRect().toJSON(),
      })),
      dates: [...dock.querySelectorAll('.timeline-day')].map(day => ({
        colored: getComputedStyle(day).backgroundImage !== 'none',
        stripe: getComputedStyle(day, '::after').content,
      })),
    }));
    assert.equal(timeline.labels.length,4);
    assert(timeline.labels.every(({size,rect}, index, labels) => size >= 13 && rect.left >= state.dock.left &&
      rect.right <= state.dock.right && (!index || rect.left > labels[index - 1].rect.right)),layout);
    assert(timeline.dates.length > 0 && timeline.dates.every(date => date.colored && date.stripe === 'none'),layout);
    assert.equal(await page.locator('#mobileMapperTutorialBtn').getAttribute('aria-label'),'Take the Flood Mapper Tour');
    await page.evaluate(()=>{ document.body.dataset.tourAttention='true'; });
    assert.equal(await page.locator('#mobileMapperTutorialBtn').evaluate(el=>getComputedStyle(el).animationName),'none');
    assert.equal(await page.locator('#map .leaflet-control-attribution').isVisible(),false);
    assert(!/\bLeaflet\b/.test(await page.locator('#mapCreditsSources').textContent()));
    const key = page.getByRole('button',{name:'Legend',exact:true});
    await key.tap();
    await page.waitForFunction(()=>document.getElementById('nwwMobileLegendToggle').getAttribute('aria-expanded')==='true');
    for (const attr of ['role','tabindex','aria-expanded']) {
      assert.equal(await page.locator('#legendDock').getAttribute(attr),null,'Only the native Legend button owns disclosure state');
    }
    const legend = page.locator('#legendList');
    await legend.waitFor({state:'visible'});
    assert.match(await legend.textContent(),/Shallow|Minor/);
    assert((await legend.boundingBox()).y > state.key.bottom,layout);
    const panel = await page.locator('#legendDock').boundingBox();
    assert.ok(Math.abs(panel.x + panel.width / 2 - (state.toolbar.x + state.toolbar.width / 2)) <= 1,
      'The open legend is centered inside the toolbar’s safe area');
    assert.deepEqual(await key.boundingBox(),{x:state.key.x,y:state.key.y,width:state.key.width,height:state.key.height});
    const controlsWhileOpen = await page.locator('#mobileControlsToggle').boundingBox();
    assert.ok(Math.abs(controlsWhileOpen.x-state.controls.x) <= 1,layout);
    const depthSpacing = await legend.locator('.depth-legend-labels').evaluate(labels => {
      const shallow = labels.children[1].getBoundingClientRect();
      const deep = labels.children[2].getBoundingClientRect();
      return { gap: deep.left - shallow.right, font: parseFloat(getComputedStyle(labels).fontSize) };
    });
    assert(depthSpacing.gap >= 16 && depthSpacing.font >= 13,JSON.stringify({viewport,depthSpacing}));
    if (name === 'chromium' && viewport.width === 390 && viewport.height === 844) {
      assert.equal(await page.locator('#legendDock').evaluate(el => getComputedStyle(el).pointerEvents),'none');
      const origin = {x:panel.x + panel.width / 2, y:panel.y + 35};
      const session = await page.context().newCDPSession(page);
      try {
        for (const [moveX,moveY,axis,sign] of [[70,0,'lng',-1],[-70,0,'lng',1],[0,70,'lat',1],[0,-45,'lat',-1]]) {
          const center = await page.evaluate(() => {
            window.mobilePanSettled = false;
            map.once('moveend', () => { window.mobilePanSettled = true; });
            return map.getCenter();
          });
          await touchMapGesture(page,{moveX,moveY,fingers:1,origin,session});
          await page.waitForFunction(() => window.mobilePanSettled,null,{timeout:5000});
          const next = await page.evaluate(() => map.getCenter());
          assert.ok((next[axis]-center[axis])*sign>0.0001,JSON.stringify({moveX,moveY,center,next}));
        }
      } finally {
        await session.detach();
      }
      assert.equal(await key.getAttribute('aria-expanded'),'true','Panning preserves the open legend');
    }
    await key.tap();
    await legend.waitFor({state:'hidden'});
    await key.press('Space');
    await legend.waitFor({state:'visible'});
    await key.press('Escape');
    await legend.waitFor({state:'hidden'});
    assert.equal(await key.getAttribute('aria-expanded'),'false');
    assert(await key.evaluate(button=>document.activeElement===button));

    await page.getByRole('button',{name:'Take the Flood Mapper Tour'}).tap();
    await page.locator('#mapperTutorialCard').waitFor();
    await page.locator('#mapperTutorialClose').tap();
    await page.locator('#mapperTutorialCard').waitFor({state:'hidden'});

    if (name === 'chromium' && viewport.width === 390 && viewport.height === 844) {
      const start = await page.evaluate(() => ({ center: map.getCenter(), zoom: map.getZoom() }));
      await touchMapGesture(page, { moveX: 48, moveY: 28 });
      await page.waitForFunction(center => !map._animatingZoom && !map.touchZoom._zooming &&
        map.getCenter().distanceTo(center) > 5,start.center);
      await touchMapGesture(page, { spread: 60 });
      await page.waitForFunction(zoom => map.getZoom() > zoom,start.zoom);
    }
    await page.locator('#mobileControlsToggle').tap();
    const drawer = page.locator('#leftPanel[aria-modal="true"]');
    await drawer.waitFor();
    const view = drawer.locator('#nwwDrawerViewMode .nw-simple-view');
    await view.waitFor();
    assert.match(await view.getAttribute('aria-label'),/2D view active/);
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
    const credits = drawer.getByText('Map credits',{exact:true});
    await credits.tap();
    await drawer.locator('#mapCredits a[href*="openstreetmap.org/copyright"]').waitFor({state:'visible'});
    assert.match(await drawer.locator('#mapCreditsSources').textContent(),/Esri/i);
    await credits.press('Escape');
    assert.equal(await page.locator('#mapCredits').getAttribute('open'),null);
    assert(await drawer.isVisible(),'Closing credits keeps the Controls drawer open');
    await page.locator('#townAddressCard').waitFor();
    await page.locator('#openDownloadModalBtn').tap();
    await page.locator('#downloadModal').waitFor();
    await page.locator('#downloadModalCloseBtn').tap();
    await page.locator('#downloadModal').waitFor({state:'hidden'});
    if (viewport.width === 390 && viewport.height === 844) {
      await view.tap();
      await page.waitForFunction(() => window.NORTH_WILDWOOD_3D?.state().ready && document.body.dataset.mapViewMode === '3d' &&
        document.querySelector('.nw-simple-view').getAttribute('aria-busy') === 'false',null,{timeout:90_000});
      await page.locator('#mobileControlsClose').tap();
      if (name === 'chromium') {
        const initial = await page.evaluate(() => {
          const map3d = NORTH_WILDWOOD_3D.getMap();
          return {center:map3d.getCenter().toArray(),zoom:map3d.getZoom()};
        });
        await touchMapGesture(page,{moveX:48,moveY:28});
        await page.waitForFunction(center => {
          const map3d = NORTH_WILDWOOD_3D.getMap();
          const revised = map3d.getCenter().toArray();
          return !map3d.isMoving() && (Math.abs(revised[0]-center[0])+Math.abs(revised[1]-center[1])) > 0.0001;
        },initial.center);
        await touchMapGesture(page,{spread:60});
        await page.waitForFunction(zoom => NORTH_WILDWOOD_3D.getMap().getZoom() > zoom,initial.zoom);
      }
    }
    assert.deepEqual(errors,[]);
    console.log(`${name} ${viewport.width}×${viewport.height}: header, credits, navigation, timeline, and drawer passed`);
    await context.close();
  }
} finally {
  await browser.close();
}
