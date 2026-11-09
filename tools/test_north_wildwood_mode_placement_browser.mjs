import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const output = process.env.NWW_AUDIT_OUTPUT;
const results = [];
const profiles = [
  { name: "narrow desktop", width: 901, height: 760 },
  { name: "phone landscape", width: 568, height: 320, touch: true },
  { name: "phone with observed daily maximum", width: 390, height: 844, touch: true, observedDaily: true },
  { name: "140% desktop zoom equivalent", width: 914, height: 571, scale: 1.4 },
  { name: "150% desktop zoom equivalent", width: 853, height: 533, scale: 1.5 },
];

try {
  for (const profile of profiles) {
    const { name, width, height, touch, scale } = profile;
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce",
      isMobile: Boolean(touch), hasTouch: Boolean(touch), deviceScaleFactor: scale || 1 });
    const result = { name, width, height, pageErrors: [] };
    results.push(result);
    page.on("pageerror", error => result.pageErrors.push(error.message));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
        document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
      await page.evaluate(() => document.fonts.ready);
      const activate = selector => page.locator(selector)[touch ? "tap" : "click"]({ timeout: 10000 });
      const compact = await page.locator("#mobileControlsToggle").isVisible();
      if (compact) {
        await activate("#mobileControlsToggle");
        await activate('#nwwMobileControlHeader [data-group="map"]');
      }
      await activate("#parcelsToggle");
      if (profile.observedDaily) {
        await activate('#nwwMobileControlHeader [data-group="forecast"]');
        await activate("#observedDataBtn");
        await page.waitForFunction(() => document.getElementById("leftPanel").dataset.dataMode === "observed");
        await activate("#intervalDailyBtn");
      }
      if (compact) await activate("#mobileControlsClose");
      if (profile.observedDaily) await page.waitForFunction(() =>
        document.getElementById("timelineDock").dataset.singleTimelineTime === "true" &&
        document.querySelector("#timelineBubble .timeline-bubble-stage"));
      await page.locator("#mapClickModeControl").waitFor({ state: "visible" });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      result.geometry = await page.evaluate(() => {
        const measure = id => document.getElementById(id).getBoundingClientRect().toJSON();
        const hit = id => {
          const control = document.getElementById(id);
          const rect = control.getBoundingClientRect();
          const element = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
          return { id, target: element?.id || element?.className || null, reachable: control.contains(element) };
        };
        return {
          control: measure("mapClickModeControl"), dock: measure("timelineDock"),
          title: measure("mapTitleBadge"), reducedMotion: matchMedia("(prefers-reduced-motion:reduce)").matches,
          hits: [hit("mapClickParcelBtn"), hit("mapClickDepthBtn")],
        };
      });
      assert.equal(result.geometry.reducedMotion, true);
      assert.ok(result.geometry.hits.every(row => row.reachable), JSON.stringify(result.geometry));
      assert.ok(result.geometry.control.bottom <= result.geometry.dock.top - 5, "Mode controls clear the timeline");
      assert.ok(result.geometry.control.top >= result.geometry.title.bottom + 5, "Mode controls clear the title");
      await activate("#mapClickDepthBtn");
      assert.equal(await page.locator("#mapClickDepthBtn").getAttribute("aria-pressed"), "true");
      await activate("#mapClickParcelBtn");
      assert.equal(await page.locator("#mapClickParcelBtn").getAttribute("aria-pressed"), "true");
      assert.deepEqual(result.pageErrors, []);
      result.passed = true;
    } catch (error) { result.failure = error.stack; }
    finally { await page.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally {
  await browser.close();
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "mode-placement.json"), JSON.stringify(results, null, 2) + "\n");
  }
}
