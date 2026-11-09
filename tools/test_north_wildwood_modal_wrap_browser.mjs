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
const report = { engine, viewport: [568, 320], pageErrors: [] };

try {
  const page = await browser.newPage({ viewport: { width: 568, height: 320 }, reducedMotion: "reduce" });
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#mobileControlsToggle").click();
  await page.locator('#nwwMobileControlHeader [data-group="tools"]').click();
  await page.locator("#mapperTutorialBtn").click();
  const next = page.locator("#mapperTutorialNext");
  await next.click();
  await next.focus();
  await next.evaluate(button => button.scrollIntoView({ block: "nearest" }));

  const snapshot = () => page.locator("#mapperTutorialCard").evaluate(card => {
    const focus = document.activeElement;
    const box = focus.getBoundingClientRect();
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    return { focus: focus.id, reachable: focus.contains(hit), cardScroll: card.scrollTop, pageScroll: [scrollX, scrollY] };
  });
  report.before = await snapshot();
  assert.equal(report.before.focus, "mapperTutorialNext");
  assert.equal(report.before.reachable, true);
  assert.ok(report.before.cardScroll > 0, "The card scrolled to reveal Next");

  await page.keyboard.press(forward);
  report.wrapped = await snapshot();
  assert.equal(report.wrapped.focus, "mapperTutorialClose");
  assert.equal(report.wrapped.reachable, true, "Tab wrap reveals the focused Close button");
  assert.ok(report.wrapped.cardScroll < report.before.cardScroll);
  assert.deepEqual(report.wrapped.pageScroll, report.before.pageScroll);

  await page.keyboard.press(reverse);
  report.reversed = await snapshot();
  assert.equal(report.reversed.focus, "mapperTutorialNext");
  assert.equal(report.reversed.reachable, true, "Reverse wrap reveals the focused Next button");
  assert.deepEqual(report.reversed.pageScroll, report.before.pageScroll);
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
    fs.writeFileSync(path.join(output, `modal-wrap-${engine}.json`), JSON.stringify(report, null, 2) + "\n");
  }
}
