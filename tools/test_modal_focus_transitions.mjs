// Actual modal-focus runtime, without map/network dependencies. Exercise both
// a demoted parent drawer and a nested child while native focus events run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name].launch({headless:true,
  ...(name==='chromium' && process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
const page = await browser.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.setContent(`<button id="launch">Controls</button>
    <div id="drawer" role="dialog" aria-modal="true"><button id="drawerFirst">First</button><button id="openChild">Export</button></div>
    <div id="child" role="dialog" aria-modal="true" hidden><button id="close">Close</button><input id="date"><button id="end">Last</button><button tabindex="-1" id="inactive">Inactive</button></div>
    <div id="nested" role="dialog" aria-modal="true" hidden><button id="warningClose">Warning</button></div>
    <div id="offscreen" inert><button>Never focus</button></div>`);
  await page.addScriptTag({content:fs.readFileSync(new URL('../assets/modal-focus.js',import.meta.url),'utf8')});
  await page.locator('#openChild').focus();
  assert.equal(await page.locator('#child').evaluate(el=>el.inert),true);
  await page.evaluate(()=>{
    document.getElementById('drawer').removeAttribute('aria-modal');
    document.getElementById('child').hidden=false;
    document.dispatchEvent(new Event('nww:modalchange'));
    document.getElementById('date').focus();
    document.getElementById('date').value='10/26/2026';
    document.getElementById('date').setSelectionRange(7,7);
  });
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.deepEqual(await page.locator('#date').evaluate(el=>({active:document.activeElement===el,caret:el.selectionStart,inert:!!el.closest('[inert]')})),{active:true,caret:7,inert:false});
  await page.locator('#end').focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'close');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'end');
  await page.evaluate(()=>{
    document.getElementById('nested').hidden=false;
    document.dispatchEvent(new Event('nww:modalchange'));
  });
  assert.equal(await page.evaluate(()=>document.activeElement.id),'warningClose');
  assert.equal(await page.locator('#child').evaluate(el=>el.inert),true);
  await page.evaluate(()=>{
    document.getElementById('nested').hidden=true;
    document.dispatchEvent(new Event('nww:modalchange'));
  });
  assert.equal(await page.evaluate(()=>document.activeElement.id),'end');
  assert.equal(await page.locator('#offscreen').evaluate(el=>el.inert),true);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${name}: nested modal isolation, current input focus/caret, sequential Tab and original inert state`);
} finally { await browser.close(); }
