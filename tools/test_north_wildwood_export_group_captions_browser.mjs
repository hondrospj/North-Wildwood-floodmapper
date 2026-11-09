import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const output = process.env.NWW_AUDIT_OUTPUT;
const rows = [], errors = [];
page.on("pageerror", error => errors.push(error.message));

async function probe(selector, controlId, settingId) {
  const field = page.locator(selector);
  await page.locator("#" + controlId).click();
  await field.scrollIntoViewIfNeeded();
  const before = await field.evaluate((element, settingId) => {
    const rect = element.getBoundingClientRect();
    const belongs = (x, y) => {
      const target = document.elementFromPoint(x, y);
      return element.contains(target) && !target.closest("button,input,select,a");
    };
    const caption = [...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
    let point;
    if (caption) {
      const range = document.createRange();
      const start = caption.textContent.search(/\S/);
      range.setStart(caption, start);
      range.setEnd(caption, start + caption.textContent.trim().length);
      const text = range.getBoundingClientRect();
      point = { x: (text.left + text.right) / 2, y: (text.top + text.bottom) / 2 };
    } else {
      // The current file-type group has no visible caption. Its gap is still
      // ordinary field background and should never activate either button.
      const [first, second] = [...element.querySelectorAll("button")].map(button => button.getBoundingClientRect());
      point = { x: (first.right + second.left) / 2, y: (first.top + first.bottom) / 2 };
    }
    return { value: document.getElementById(settingId).value, element: element.tagName,
      associatedControl: element.control?.id || null, bare: belongs(point.x, point.y),
      position: { x: point.x - rect.left, y: point.y - rect.top } };
  }, settingId);
  await page.evaluate(() => { window.groupCaptionClicks = []; });
  await field.click({ position: before.position });
  const after = await page.evaluate(settingId => ({
    value: document.getElementById(settingId).value, clicks: window.groupCaptionClicks
  }), settingId);
  rows.push({ selector, before, after });
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.locator("#observedDataBtn").click();
  await page.waitForFunction(() => currentDataMode === "observed" && currentSeriesHours.length > 0);
  await page.locator("#openDownloadModalBtn").click();
  await page.evaluate(() => {
    document.addEventListener("click", event => {
      window.groupCaptionClicks?.push({ tag: event.target.tagName, id: event.target.id, trusted: event.isTrusted });
    }, true);
  });
  await probe(".export-filetype-field", "exportFormatPngBtn", "downloadFormatSelect");
  await page.locator("#exportFormatGifBtn").click();
  await page.getByRole("button", { name: "More options", exact: true }).click();
  await probe(".export-layout-field", "exportAspectSquareBtn", "downloadAspectSelect");
  await probe(".export-interval-field", "exportIntervalQuarterBtn", "downloadIntervalSelect");
  await probe(".export-framing-field", "exportExtentCurrentBtn", "downloadExtentSelect");
  await probe("#gifSpeedField", "exportSpeedFastBtn", "downloadSpeedSelect");
  for (const { selector, before, after } of rows) {
    assert.equal(before.bare, true, `${selector} has a noninteractive click point`);
    assert.equal(after.value, before.value, `${selector} caption must preserve the selected setting`);
    assert.ok(after.clicks.some(click => click.trusted), `${selector} uses a native click`);
    assert.ok(after.clicks.every(click => click.tag !== "BUTTON"), `${selector} caption must not activate a button`);
    assert.equal(before.element, "DIV", `${selector} is a group wrapper`);
    assert.equal(before.associatedControl, null);
  }
  assert.deepEqual(errors, []);
  console.log("All five grouped export captions preserve selection after native clicks.");
} finally {
  await browser.close();
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "export-group-captions.json"), JSON.stringify({ rows, errors }, null, 2) + "\n");
  }
}
