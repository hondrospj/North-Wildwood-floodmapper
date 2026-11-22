import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const result = { engine, viewport, checks: [], pageErrors: [] };
    results.push(result);
    page.on("pageerror", error => result.pageErrors.push(error.message));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
        document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
      const controls = page.locator("#mobileControlsToggle");
      if (await controls.isVisible()) await controls.click();
      await page.locator("#observedDataBtn").click();
      await page.locator("#observedCalendarOpenBtn").click();
      const calendar = page.locator("#observedCalendarModal");
      const month = page.locator("#calendarPopover");
      const opener = page.locator("#calendarTitleBtn");
      await page.locator("#observedCalendarCloseBtn:focus").waitFor({ state: "visible" });
      for (const activation of ["pointer", "keyboard"]) {
        if (activation === "pointer") await opener.click();
        else await opener.press("Enter");
        await page.locator("#calendarPopoverCloseBtn:focus").waitFor({ state: "visible" });
        assert.equal(await calendar.evaluate(el => el.inert), true, "The month picker owns modal focus");
        await page.keyboard.press("Escape");
        await month.waitFor({ state: "hidden" });
        assert.equal(await calendar.isVisible(), true, "Escape keeps the Past date calendar open");
        assert.equal(await calendar.evaluate(el => el.inert), false);
        const focus = await page.evaluate(() => document.activeElement.id);
        result.checks.push({ activation, focus });
        assert.equal(focus, "calendarTitleBtn", `${activation} Escape restores the month opener`);
      }
      assert.deepEqual(result.pageErrors, []);
      result.passed = true;
    } catch (error) { result.failure = error.stack; }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
