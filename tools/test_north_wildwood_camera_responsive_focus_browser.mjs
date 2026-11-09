import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const markerSelector = '[data-webcam-marker="north-bay"]';

async function expectFocus(page, selector) {
  await page.waitForFunction(selector => {
    const target = document.querySelector(selector);
    if (!target || document.activeElement !== target || target.closest("[inert]")) return false;
    const { x, y, width, height } = target.getBoundingClientRect();
    return target.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  }, selector);
}

async function mapState(page) {
  return page.evaluate(() => ({ center: map.getCenter(), zoom: map.getZoom(), scroll: [scrollX, scrollY] }));
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(12000);
  const errors = [];
  const playerRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://g1.ipcamlive.com/**", route => {
    playerRequests.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<p>Camera player fixture</p>" });
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  const panel = page.locator("#webcamPanel");
  const player = page.locator("#webcamFrame iframe");
  const marker = page.locator(markerSelector);
  const controls = page.locator("#mobileControlsToggle");
  const close = page.locator("#webcamClose");
  await page.locator("#webcamsToggle").press("Space");
  await marker.press("Enter");
  await page.waitForFunction(() => document.getElementById("webcamPanel").dataset.playerState === "embed-loaded");
  const originalPlayer = await player.elementHandle();
  await expectFocus(page, "#webcamClose");

  await page.setViewportSize({ width: 568, height: 320 });
  await page.waitForFunction(() => document.body.dataset.unifiedLayout === "mobile");
  await expectFocus(page, "#webcamClose");
  await controls.press("Enter");
  await page.locator("#dataSourceHelpBtn").press("Enter");
  await expectFocus(page, "#infoModalCloseBtn");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.body.dataset.unifiedLayout === "desktop");
  await page.keyboard.press("Escape");
  await page.locator("#infoModal").waitFor({ state: "hidden" });
  await expectFocus(page, "#dataSourceHelpBtn");
  assert.equal(await panel.isVisible(), true);
  assert.equal(await originalPlayer.evaluate(el => document.querySelector("#webcamFrame iframe") === el), true);
  assert.equal(playerRequests.length, 1);

  await close.focus();
  await page.setViewportSize({ width: 568, height: 320 });
  await page.waitForFunction(() => document.body.dataset.unifiedLayout === "mobile");
  await expectFocus(page, "#webcamClose");
  const compactState = await mapState(page);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  await expectFocus(page, "#mobileControlsToggle");
  assert.deepEqual(await mapState(page), compactState);
  assert.deepEqual(compactState.scroll, [0, 0]);
  assert.equal(await page.locator("#webcamChoice").inputValue(), "north-bay");
  assert.equal(await marker.count(), 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await marker.click();
  await page.waitForFunction(() => document.getElementById("webcamPanel").dataset.playerState === "embed-loaded");
  assert.equal(playerRequests.length, 2);
  const portraitState = await mapState(page);
  await close.click();
  await panel.waitFor({ state: "hidden" });
  await expectFocus(page, markerSelector);
  assert.deepEqual(await mapState(page), portraitState);
  assert.deepEqual(portraitState.scroll, [0, 0]);
  assert.deepEqual(errors, []);
  console.log(`${engine} kept the camera player and Help ownership through resize, then returned focus to Controls or the visible marker.`);
} finally {
  await browser.close();
}
