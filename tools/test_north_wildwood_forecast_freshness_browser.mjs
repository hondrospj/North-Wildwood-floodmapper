import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const forecast = JSON.parse(await readFile(new URL("../forecast.json", import.meta.url), "utf8"));
const expiry = Date.parse(forecast.forecastEndUtc);
assert.ok(Number.isFinite(expiry));

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(expiry + 60000));
  await page.route("**/forecast.json*", route => route.fulfill({ json: forecast }));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    floodFrameState === "ready", null, { timeout: 90000 });

  const status = page.locator("#floodFrameStatus");
  await status.filter({ hasText: "Forecast expired" }).waitFor();
  for (const [width, height] of [[568, 320], [320, 240], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => document.body.dataset.unifiedLayout === "mobile");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await status.evaluate(element => {
      const box = element.getBoundingClientRect();
      const key = document.getElementById("timelineFloodKey").getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth &&
        box.top >= 0 && box.bottom < key.top && getComputedStyle(element).pointerEvents === "none";
    }), true, `Expired forecast should stay visible at ${width}×${height}`);
  }

  await page.locator("#mobileControlsToggle").press("Enter");
  await page.locator("#observedDataBtn").press("Enter");
  await status.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(`${engine} keeps the expired forecast warning readable during compact resize and clears it in Past.`);
} finally {
  await browser.close();
}
