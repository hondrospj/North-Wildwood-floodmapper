// Native controls must keep a visible nested warning above its export parent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({headless:true,
  ...(name === 'edge' ? {channel:'msedge'} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel:process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(['chromium','edge'].includes(name) ? {args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} : {})});
const page = await browser.newPage({viewport:{width:1440,height:900}, timezoneId:'America/New_York'});
page.setDefaultTimeout(20000);
const output = process.env.NWW_AUDIT_OUTPUT;
const result = {browser:name,version:browser.version(),checks:[],warnings:[],errors:[]};
page.on('pageerror', error => result.errors.push(error.message));
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function group(groupName) {
  if (!await page.locator('#mobileControlsToggle').isVisible()) return;
  if (await page.locator('#mobileControlsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#mobileControlsToggle').click();
  await page.locator(`#nwwMobileControlHeader [data-group="${groupName}"]`).click();
}
async function settings() {
  return page.locator('#downloadModal').evaluate(modal => ({
    values:Object.fromEntries(['downloadStartInput','downloadEndInput','downloadStartDateText','downloadEndDateText',
      'downloadStartTimeSelect','downloadEndTimeSelect','downloadIntervalSelect']
      .map(id => [id,document.getElementById(id)?.value])),
    selected:[...modal.querySelectorAll('button.active')].map(button => button.id).sort(),
  }));
}
async function modeState() {
  return page.locator('#forecastDataBtn,#observedDataBtn,#returnIntervalDataBtn,#depthModeBtn,#dynamicModeBtn')
    .evaluateAll(buttons => buttons.map(button => ({id:button.id,active:button.classList.contains('active'),pressed:button.getAttribute('aria-pressed')})));
}
async function checkModeState(label) {
  const states = await modeState();
  for (const button of states) assert.equal(button.pressed,String(button.active),`${label}: ${button.id} exposes its selected state`);
  assert.equal(states.slice(0,3).filter(button => button.pressed === 'true').length,1);
  assert.equal(states.slice(3).filter(button => button.pressed === 'true').length,1);
  result.checks.push(`${label}: one selected data mode and overlay are exposed to assistive technology`);
}
try {
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready'), {}, {timeout:90000});
  await checkModeState('Startup');
  for (const [selector,mode] of [['#observedDataBtn','observed'],['#returnIntervalDataBtn','return-interval'],['#forecastDataBtn','forecast']]) {
    await page.locator(selector).click();
    await page.waitForFunction(mode => document.getElementById('leftPanel').dataset.dataMode === mode,mode,{timeout:60000});
    await checkModeState(mode);
  }
  for (const selector of ['#dynamicModeBtn','#depthModeBtn']) {
    await page.locator(selector).click();
    await checkModeState(selector);
  }
  for (const [width,height] of [[1440,900],[1024,576],[390,844]]) {
    await page.setViewportSize({width,height});
    await settle();
    for (const action of ['Escape','OK','Close','Backdrop']) {
      await group('tools');
      await page.locator('#openDownloadModalBtn').click();
      const date = await page.locator('#downloadEndDateText').inputValue();
      const [month,day,year] = date.split('/').map(Number);
      const after = new Date(Date.UTC(year,month-1,day+1));
      const invalidStart = `${String(after.getUTCMonth()+1).padStart(2,'0')}/${String(after.getUTCDate()).padStart(2,'0')}/${after.getUTCFullYear()}`;
      await page.locator('#downloadStartDateText').fill(invalidStart);
      await page.locator('#downloadStartDateText').press('Enter');
      await page.locator('#downloadBtn').click();
      await page.locator('#exportAspectSquareBtn').click();
      await page.locator('#exportSpeedSlowBtn').click();
      const before = await settings();
      await page.locator('#downloadBtn').click();
      await page.waitForFunction(() => !document.getElementById('exportOrderModal').hidden);
      await settle();
      const warning = await page.evaluate(() => {
        const overlay = document.getElementById('exportOrderModal');
        const parent = document.getElementById('downloadModal');
        const card = overlay.querySelector('[role="dialog"]');
        const rect = card.getBoundingClientRect();
        return {warningZ:Number(getComputedStyle(overlay).zIndex),parentZ:Number(getComputedStyle(parent).zIndex),
          sameStackingParent:overlay.parentElement === parent.parentElement,
          warningFollowsParent:!!(parent.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING),
          overlayPosition:getComputedStyle(overlay).position,parentPosition:getComputedStyle(parent).position,
          visible:getComputedStyle(overlay).display !== 'none' && getComputedStyle(overlay).visibility === 'visible',
          fits:rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth+1 && rect.bottom <= innerHeight+1,
          parentInert:parent.inert,focusedInside:card.contains(document.activeElement)};
      });
      // Hit-testing alone cannot prove visibility: an inert covering parent is
      // skipped by elementFromPoint even when it visually obscures the warning.
      result.currentWarning = {viewport:{width,height},action,...warning};
      assert.equal(warning.sameStackingParent,true);
      assert.equal(warning.overlayPosition,'fixed');
      assert.equal(warning.parentPosition,'fixed');
      assert.ok(warning.warningZ > warning.parentZ ||
        (warning.warningZ === warning.parentZ && warning.warningFollowsParent),
        `Warning must paint above its export parent at ${width}x${height}`);
      assert.equal(warning.visible,true);
      assert.equal(warning.fits,true);
      assert.equal(warning.parentInert,true);
      assert.equal(warning.focusedInside,true);
      if (output && action === 'Escape') {
        fs.mkdirSync(output,{recursive:true});
        await page.screenshot({path:path.join(output,`range-warning-${width}x${height}.png`)});
      }
      for (let i=0;i<4;i++) {
        await page.keyboard.press(i%2 ? 'Shift+Tab' : 'Tab');
        assert.equal(await page.locator('#exportOrderModal').evaluate(modal => modal.contains(document.activeElement)),true);
      }
      if (action === 'Escape') await page.keyboard.press('Escape');
      else if (action === 'OK') await page.locator('#exportOrderModalOkBtn').click();
      else if (action === 'Close') await page.locator('#exportOrderModalCloseBtn').click();
      else await page.locator('#exportOrderModal').click({position:{x:4,y:4}});
      await settle();
      const restored = await page.evaluate(() => ({
        warningHidden:document.getElementById('exportOrderModal').hidden,
        parentOpen:!document.getElementById('downloadModal').hidden,
        parentInert:document.getElementById('downloadModal').inert,
        focus:document.activeElement.id,
      }));
      assert.deepEqual(restored,{warningHidden:true,parentOpen:true,parentInert:false,focus:'downloadBtn'});
      assert.deepEqual(await settings(),before,`${action} preserves dates and export choices`);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#downloadModal').evaluate(modal => modal.contains(document.activeElement)),true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#downloadModal').isVisible(),false,'A subsequent Escape still closes the export parent');
      result.warnings.push({viewport:{width,height},action,warning,restored});
      delete result.currentWarning;
      result.checks.push(`${width}x${height} ${action}: visible warning, trapped focus, retained export settings and usable parent`);
    }
  }
  assert.deepEqual(result.errors,[]);
  result.passed = true;
} catch (error) {
  result.failure = error.stack;
  throw error;
} finally {
  await browser.close();
  if (output) {
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'ui-dialogs.json'),JSON.stringify(result,null,2));
  }
  console.log(JSON.stringify(result,null,2));
}
