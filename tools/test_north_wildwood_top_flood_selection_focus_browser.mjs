import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const tab = engine === "webkit" ? "Alt+Tab" : "Tab";
const results = [];
try {
  for (const activation of ["keyboard", "pointer"]) {
    const result = { engine, activation, pageErrors: [] };
    results.push(result);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    page.on("pageerror", error => result.pageErrors.push(error.message));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
        document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
      const controls = page.locator("#mobileControlsToggle");
      await controls.press("Enter");
      await page.locator("#observedDataBtn").press("Enter");
      await page.waitForFunction(() => document.getElementById("leftPanel").dataset.dataMode === "observed");
      const more = page.locator("#topTideListMobile .top-tide-more-btn");
      await more.press("Enter");
      const modal = page.locator("#topTidesModal");
      await page.locator("#topTidesModalCloseBtn:focus").waitFor({ state: "visible" });
      const rows = modal.locator(".top-tide-item");
      let date;
      if (activation === "keyboard") {
        const focusedRow = modal.locator(".top-tide-item:focus");
        for (let step = 0; step < 4 && !await focusedRow.count(); step++) {
          await page.keyboard.press(tab);
        }
        assert.equal(await focusedRow.count(), 1, "The keyboard reaches a ranked flood");
        // Background observations may reorder the list during navigation.
        date = await focusedRow.getAttribute("data-flood-date");
        await page.keyboard.press("Enter");
      } else {
        date = await rows.first().getAttribute("data-flood-date");
        await rows.first().tap();
      }
      assert.ok(date);
      await modal.waitFor({ state: "hidden" });
      await page.waitForFunction(selected => [...document.querySelectorAll(".top-tide-item.active")]
        .some(item => item.dataset.floodDate === selected), date, { timeout: 60000 });
      await page.waitForFunction(() => document.activeElement.id === "mobileControlsToggle", null, { timeout: 5000 });
      result.focus = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
      assert.equal(await controls.isVisible(), true, "Selecting a flood closes the compact drawer");
      assert.equal(result.focus, "mobileControlsToggle", "The closed drawer restores focus to Controls");
      assert.deepEqual(result.pageErrors, []);
      result.passed = true;
    } catch (error) { result.failure = error.stack; }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
