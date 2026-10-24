#!/usr/bin/env node
// Run against a preview with NWW_TEST_URL, PLAYWRIGHT_MODULE, CHROME_PATH and
// NWW_BROWSER=webkit (otherwise Chromium), as in the responsive browser suite.
import assert from 'node:assert/strict';

const {chromium,webkit} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.NWW_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({
  headless:true,
  ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(engine === chromium ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {}),
});
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const tolerance = 1;
const twoPaints = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

function assertNear(actual,expected,label) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual.toFixed(3)} differs from ${expected.toFixed(3)} by more than ${tolerance}px`);
}

async function checkStartup(width,height=1000,mobile=false) {
  const context = await browser.newContext({
    viewport:{width,height}, hasTouch:mobile, isMobile:mobile,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  let releaseController,receivedController;
  const release = new Promise(resolve => { releaseController = resolve; });
  const held = new Promise(resolve => { receivedController = resolve; });
  let initial,final,audit;
  let navigation;
  try {
    await page.addInitScript(() => {
      const selectors = {
        data:'.data-source-card', forecast:'#forecastScenarioCard',
        overlay:'.overlay-card', datum:'.datum-card',
        opacity:'.opacity-card', interval:'#timelineIntervalCard',
      };
      const audit = window.__paneStartupAudit = {frames:0,visibleSamples:[],stopped:false};
      const visible = element => {
        if (!element?.getClientRects().length) return false;
        for (let node=element;node;node=node.parentElement) {
          const style=getComputedStyle(node);
          if (style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0) return false;
        }
        return true;
      };
      const bounds = element => {
        const rect=element.getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      };
      const text = element => element?.textContent.replace(/\s+/g,' ').trim() || '';
      window.__capturePaneStartup = () => {
        const panel=document.getElementById('leftPanel');
        if (!visible(panel)) return null;
        const cards={};
        for (const [key,selector] of Object.entries(selectors)) {
          const element=panel.querySelector(selector);
          if (visible(element)) cards[key]={
            ...bounds(element), heading:text(element.querySelector('h2')),
            buttons:[...element.querySelectorAll('button:not(.help-btn)')].map(text),
          };
        }
        return {
          pane:bounds(panel),cards,ready:!!document.body?.dataset.unifiedUiReady,
          paneSizing:{
            maxHeight:getComputedStyle(panel).maxHeight,height:getComputedStyle(panel).height,
            bottom:getComputedStyle(panel).bottom,overflowY:getComputedStyle(panel).overflowY,
            clientHeight:panel.clientHeight,scrollHeight:panel.scrollHeight,
            timeline:document.getElementById('timelineDock') && bounds(document.getElementById('timelineDock')),
            bubble:document.getElementById('timelineBubble') && bounds(document.getElementById('timelineBubble')),
          },
          at:performance.now(),frame:audit.frames,
        };
      };
      function sample() {
        if (audit.stopped) return;
        audit.frames++;
        const state=window.__capturePaneStartup();
        if (state) audit.visibleSamples.push(state);
        requestAnimationFrame(sample);
      }
      // Start before any page scripts: recording only the held-controller state
      // would miss an earlier painted CSS width or obsolete heading.
      requestAnimationFrame(sample);
    });
    await page.route('**/assets/app/unified-controller.js*',async route => {
      receivedController();
      await release;
      await route.continue();
    });
    navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    // Attach the rejection handler while the parser-blocking script is held.
    navigation.catch(()=>{});
    await Promise.race([
      held,
      new Promise((_,reject) => {
        const deadline=setTimeout(() => reject(new Error('The unified controller was not requested')),30000);
        held.finally(() => clearTimeout(deadline));
      }),
    ]);
    await page.waitForFunction(() => document.getElementById('leftPanel') &&
      document.getElementById('timelineIntervalCard'));
    await twoPaints(page);
    initial=await page.evaluate(() => window.__capturePaneStartup());
    assert.equal(await page.evaluate(() => !!document.body.dataset.unifiedUiReady),false,
      'The initial snapshot must precede the held controller');
    if (mobile) {
      assert.equal(initial,null,'Mobile controls must start hidden before the controller is available');
      assert.equal(await page.evaluate(() => window.__paneStartupAudit.visibleSamples.length),0,
        'The closed mobile drawer must never flash on an earlier startup frame');
    } else {
      assert.ok(initial,'Desktop controls must paint while the controller request is held');
      assertNear(initial.pane.width,300,`${width}px initial pane width`);
      assert.equal(initial.cards.forecast?.heading,'Forecast range',
        'The first painted heading must already use the final label');
    }

    releaseController();
    await navigation;
    await page.waitForFunction(() => !!document.body.dataset.unifiedUiReady &&
      Number(document.body.dataset.unifiedLayoutPasses)>0);
    await twoPaints(page);
    final=await page.evaluate(() => window.__capturePaneStartup());
    audit=await page.evaluate(() => {
      window.__paneStartupAudit.stopped=true;
      return window.__paneStartupAudit;
    });

    if (mobile) {
      assert.equal(final,null,'Mobile controls remain closed after initial layout');
      assert.equal(audit.visibleSamples.length,0,'No startup frame may expose the closed mobile pane');
      await page.locator('#mobileControlsToggle').click();
      await page.waitForFunction(() => document.body.classList.contains('mobile-controls-open'));
      await page.locator('#leftPanel').waitFor({state:'visible'});
      assert.equal(await page.locator('#leftPanel').isVisible(),true);
      for (const [group,selector] of [
        ['map','.overlay-card'],['tools','#townAddressCard'],['forecast','#forecastScenarioCard'],
      ]) {
        const tab=page.locator(`#nwwMobileControlHeader [data-group="${group}"]`);
        await tab.click();
        await page.waitForFunction(expected => document.getElementById('leftPanel')?.dataset.nwwSection===expected,group);
        await page.locator(selector).waitFor({state:'visible'});
        assert.equal(await tab.getAttribute('aria-selected'),'true',`${group} tab must select`);
        assert.equal(await page.locator(selector).isVisible(),true,`${group} controls must remain usable`);
      }
      await page.locator('#mobileControlsClose').click();
      await page.waitForFunction(() => !document.body.classList.contains('mobile-controls-open'));
      await page.locator('#leftPanel').waitFor({state:'hidden'});
      assert.equal(await page.locator('#leftPanel').isVisible(),false);
    } else {
      assert.ok(final);
      assertNear(final.pane.width,300,`${width}px final pane width`);
      const staticCards=['data','forecast','overlay','datum','opacity','interval'];
      for (const key of staticCards) {
        assert.ok(initial.cards[key],`${width}px ${key} card must paint before controller`);
        assert.ok(final.cards[key],`${width}px ${key} card must remain visible`);
      }
      assert.ok(audit.visibleSamples.some(sample => !sample.ready),
        'The document-start probe must record a painted pre-controller frame');
      assert.ok(audit.visibleSamples.some(sample => sample.ready),
        'The probe must continue through the controller layout');
      for (const sample of audit.visibleSamples) {
        assertNear(sample.pane.width,300,`${width}px frame ${sample.frame} pane width`);
        for (const coordinate of ['x','y']) {
          assertNear(sample.pane[coordinate],final.pane[coordinate],`${width}px frame ${sample.frame} pane ${coordinate}`);
        }
        for (const key of staticCards) {
          // Parsing may yield before a later card exists. Any card that has
          // already painted must nevertheless have its final geometry/copy.
          const card=sample.cards[key];
          if (!card) continue;
          for (const coordinate of ['x','y','width','height']) {
            assertNear(card[coordinate],final.cards[key][coordinate],
              `${width}px frame ${sample.frame} ${key} ${coordinate}`);
          }
          assert.equal(card.heading,final.cards[key].heading,`${width}px ${key} heading must not rewrite after paint`);
          assert.deepEqual(card.buttons,final.cards[key].buttons,`${width}px ${key} button labels must not rewrite after paint`);
        }
      }
      // The wrapper may clip vertically as real forecast timestamp metadata
      // establishes the bubble height. That must only reserve clear space;
      // it must not resize/reflow the cards or leave the drawer unscrollable.
      const {timeline,bubble} = final.paneSizing;
      assert.ok(timeline && bubble,'The finished pane must share the actual timeline geometry');
      const clearanceBottom=Math.min(timeline.y - 28,bubble.height ? bubble.y - 12 : Infinity);
      const availableHeight=Math.max(100,clearanceBottom - final.pane.y);
      assertNear(parseFloat(final.paneSizing.maxHeight),availableHeight,
        `${width}x${height} pane reserve must follow the real timestamp/dock clearance`);
      assert.ok(final.pane.y + final.pane.height <= clearanceBottom + tolerance,
        `${width}x${height} clipped pane must clear the timestamp bubble and timeline dock`);
      if (final.paneSizing.scrollHeight > final.paneSizing.clientHeight + tolerance) {
        assert.equal(final.paneSizing.overflowY,'auto','Clipped controls must remain vertically scrollable');
        await page.locator('#leftPanel').hover();
        await page.mouse.wheel(0,200);
        await page.waitForFunction(() => document.getElementById('leftPanel').scrollTop > 0);
        await page.locator('#leftPanel').evaluate(element => { element.scrollTop=0; });
      }
    }
    assert.deepEqual(errors,[],'No uncaught browser errors during startup or drawer interactions');
    console.log(`PASS pane startup ${width}x${height}: ${mobile ? 'closed drawer never flashes; tabs work' : 'first paint and delayed controller share 300px pane, card geometry and labels'} (${audit.frames} frames)`);
  } catch (error) {
    console.error(JSON.stringify({viewport:{width,height},mobile,initial,final,audit:audit ||
      await page.evaluate(() => window.__paneStartupAudit).catch(()=>null),errors},null,2));
    throw error;
  } finally {
    releaseController();
    await navigation?.catch(()=>{});
    await context.close();
  }
}

try {
  for (const width of [1440,1200,1024]) await checkStartup(width);
  await checkStartup(1200,650);
  await checkStartup(390,1000,true);
} finally {
  await browser.close();
}
