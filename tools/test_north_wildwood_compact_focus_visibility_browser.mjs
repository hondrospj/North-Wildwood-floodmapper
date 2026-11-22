import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const forward = engine === "webkit" ? "Alt+Tab" : "Tab";
const reverse = engine === "webkit" ? "Shift+Alt+Tab" : "Shift+Tab";
const profiles = [
  { width: 568, height: 320, touch: true, group: "tools", key: forward, target: "tools" },
  { width: 1024, height: 460, touch: false, group: "forecast", key: reverse, target: "dataSourceHelpBtn" },
];
const results = [];
try {
  for (const { width, height, touch, group, key, target } of profiles) {
    const result = { engine, width, height, target, pageErrors: [] };
    results.push(result);
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    page.on("pageerror", error => result.pageErrors.push(error.message));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
        document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
      await page.locator("#mobileControlsToggle").press("Enter");
      const groupTab = page.locator(`#nwwMobileControlHeader [data-group="${group}"]`);
      await groupTab.click();
      await groupTab.focus();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (let step = 0; step < 30; step++) {
        await page.keyboard.press(key);
        const observation = await page.evaluate(() => {
          const active = document.activeElement;
          const box = active.getBoundingClientRect();
          const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
          return { id: active.id || active.dataset.group, focusVisible: active.matches(":focus-visible"),
            reachable: active.contains(hit), hit: hit?.id || hit?.className };
        });
        if (observation.id === target) { result.observation = observation; break; }
      }
      assert.equal(result.observation?.id, target);
      assert.ok(result.observation.focusVisible && result.observation.reachable, JSON.stringify(result.observation));
      assert.deepEqual(result.pageErrors, []);
      result.passed = true;
    } catch (error) { result.failure = error.stack; }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
