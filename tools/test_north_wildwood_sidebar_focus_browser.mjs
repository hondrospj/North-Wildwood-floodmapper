import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const output = process.env.NWW_AUDIT_OUTPUT;
const forward = engine === "webkit" ? "Alt+Tab" : "Tab";
const reverse = engine === "webkit" ? "Shift+Alt+Tab" : "Shift+Tab";
const targetIds = ["forecastHighBtn", "forecastMeanBtn", "forecastLowBtn", "forecastTypeHelpBtn"];
const report = { engine, viewport: [901, 561], observations: [], pageErrors: [] };

try {
  const page = await browser.newPage({ viewport: { width: 901, height: 561 }, reducedMotion: "reduce" });
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#observedDataBtn").focus();
  for (let step = 0; step < 32; step++) {
    if (await page.locator("#legendHelpBtn:focus").count()) break;
    await page.keyboard.press(forward);
  }
  assert.equal(await page.locator("#legendHelpBtn:focus").count(), 1, "Keyboard reaches the map key");
  report.scrollAtMapKey = await page.locator("#leftPanel").evaluate(panel => panel.scrollTop);
  assert.ok(report.scrollAtMapKey > 0, "Map key focus scrolled the desktop sidebar");

  for (let step = 0; step < 24; step++) {
    await page.keyboard.press(reverse);
    const focus = await page.evaluate(ids => {
      const target = document.activeElement;
      if (!ids.includes(target.id)) return null;
      const panel = document.getElementById("leftPanel");
      const sticky = panel.querySelector(":scope > .data-source-card");
      const box = target.getBoundingClientRect();
      const header = sticky.getBoundingClientRect();
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { id: target.id, focusVisible: target.matches(":focus-visible"), reachable: target.contains(hit),
        hit: hit?.id || hit?.className, top: box.top, headerBottom: header.bottom,
        sticky: getComputedStyle(sticky).position, scrollPadding: getComputedStyle(panel).scrollPaddingTop };
    }, targetIds);
    if (focus) report.observations.push(focus);
    if (report.observations.length === targetIds.length) break;
  }
  assert.deepEqual(report.observations.map(row => row.id), targetIds);
  for (const row of report.observations) {
    assert.equal(row.sticky, "sticky", "The Flood Data card stays pinned");
    assert.ok(row.focusVisible && row.reachable && row.top >= row.headerBottom, JSON.stringify(row));
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `sidebar-focus-${engine}.json`), JSON.stringify(report, null, 2) + "\n");
  }
}
