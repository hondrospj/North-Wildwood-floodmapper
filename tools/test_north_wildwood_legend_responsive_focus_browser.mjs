import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";

async function ready(page) {
  page.setDefaultTimeout(12000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
}

async function expectFocus(page, id) {
  await page.waitForFunction(id => {
    const target = document.getElementById(id);
    const box = target.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return document.activeElement === target && target.contains(hit) && !target.closest("[inert]");
  }, id);
}

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 561 }, reducedMotion: "reduce" });
  try {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await ready(page);
    const key = page.locator("#legendDock");
    const help = page.locator("#legendHelpBtn");
    await key.press("Enter");
    await expectFocus(page, "legendDock");
    await page.waitForFunction(() => document.getElementById("legendDock").getAttribute("aria-expanded") === "true");

    await page.setViewportSize({ width: 901, height: 561 });
    await page.waitForFunction(() => document.body.dataset.unifiedLayout === "desktop");
    await expectFocus(page, "legendHelpBtn");

    await page.keyboard.press("Enter");
    await expectFocus(page, "infoModalCloseBtn");
    await page.setViewportSize({ width: 901, height: 560 });
    await page.waitForFunction(() => document.body.dataset.unifiedLayout === "mobile");
    await expectFocus(page, "infoModalCloseBtn");
    assert.equal(await help.isVisible(), false);
    await page.keyboard.press("Escape");
    await page.locator("#infoModal").waitFor({ state: "hidden" });
    await expectFocus(page, "legendDock");
    assert.equal(await key.getAttribute("aria-expanded"), "false");

    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("legendDock").getAttribute("aria-expanded") === "true");
    await page.locator("#mobileControlsToggle").press("Enter");
    await page.waitForFunction(() => !document.body.classList.contains("mobile-legend-open") &&
      document.body.classList.contains("mobile-controls-open"));
    await page.keyboard.press("Escape");
    await expectFocus(page, "mobileControlsToggle");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }

  const touch = await browser.newPage({ viewport: { width: 568, height: 320 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  try {
    await ready(touch);
    await touch.locator("#mobileControlsToggle").tap();
    await touch.getByRole("tab", { name: "Map layers" }).tap();
    await touch.locator("#dynamicModeBtn").tap();
    await touch.locator("#mobileControlsClose").tap();
    await touch.locator("#legendDock").tap();
    await touch.locator("#legendHelpBtn").tap();
    await expectFocus(touch, "infoModalCloseBtn");
    await touch.setViewportSize({ width: 1370, height: 720 });
    await touch.waitForFunction(() => document.body.dataset.unifiedLayout === "desktop");
    await expectFocus(touch, "infoModalCloseBtn");
    await touch.keyboard.press("Escape");
    await expectFocus(touch, "legendHelpBtn");
  } finally {
    await touch.close();
  }
  console.log(`${engine} kept Key and Legend Help focus across compact boundaries and touch orientation.`);
} finally {
  await browser.close();
}
