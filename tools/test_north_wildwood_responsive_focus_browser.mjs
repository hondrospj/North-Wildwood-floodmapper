import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const compact = { width: 390, height: 844 };
const desktop = { width: 1100, height: 750 };
const report = { engine, pageErrors: [] };
try {
  const page = await browser.newPage({ viewport: compact, reducedMotion: "reduce" });
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#mobileControlsToggle").press("Enter");
  await page.locator('#nwwMobileControlHeader [data-group="tools"]').click();
  await page.locator("#openDownloadModalBtn").focus();
  const focusAfterLayout = async viewport => {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
    return page.evaluate(() => {
      const focus = document.activeElement;
      const box = focus.getBoundingClientRect();
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { focus: focus.id, reachable: focus.contains(hit), drawerOpen: document.body.classList.contains("mobile-controls-open") };
    });
  };
  report.desktop = await focusAfterLayout(desktop);
  await page.locator("#townAddressSearchBtn").focus();
  report.compact = await focusAfterLayout(compact);
  assert.deepEqual(report.desktop, { focus: "openDownloadModalBtn", reachable: true, drawerOpen: false });
  assert.deepEqual(report.compact, { focus: "mobileControlsToggle", reachable: true, drawerOpen: false });
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
