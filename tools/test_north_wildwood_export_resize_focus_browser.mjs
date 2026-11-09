import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const picker = "#nwwExportDateTimePicker";
const card = "#downloadModal .download-modal-card";
const list = `${picker} [role="listbox"]`;
const nextFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const scrollState = page => page.evaluate(({ card, picker, list }) =>
  [card, picker, list].map(selector => document.querySelector(selector)?.scrollTop ?? null), { card, picker, list });

async function ready(page) {
  page.setDefaultTimeout(12000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
}

async function expectFocus(page, selector, value) {
  await page.waitForFunction(({ selector, value }) => {
    const target = document.activeElement;
    if (!target.matches(selector) || (value !== undefined && target.dataset.value !== value)) return false;
    const box = target.getBoundingClientRect();
    return target.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) &&
      !target.closest("[inert]");
  }, { selector, value });
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, reducedMotion: "reduce" });
  try {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await ready(page);
    await page.locator("#openDownloadModalBtn").press("Enter");
    // This case tests scrolling and resize focus. Use a full forecast day so
    // loading historical times cannot replace the list during the wheel input.
    const forecastDate = await page.evaluate(() => {
      const days = new Set(getForecastExportEntries().map(entry => getExportDayKeyFromDate(new Date(entryTimeMs(entry)))));
      for (const day of days) {
        if (!day) continue;
        const startDate = parseStoredLocalNyToDate(`${day}T00:00`);
        const endDate = parseStoredLocalNyToDate(`${day}T23:59`);
        if (!exportRangeNeedsObservedArchive({ startDate, endDate })) {
          const [year, month, date] = day.split("-");
          return `${month}/${date}/${year}`;
        }
      }
      return null;
    });
    assert.ok(forecastDate, "Expected a fully covered forecast day for the time list");
    await page.locator("#downloadStartDateText").fill(forecastDate);
    await page.locator("#downloadStartDateText").press("Tab");
    await page.locator("#downloadStartTimeButton").press("Enter");
    const option = `${picker} [role="option"]:not(:disabled)`;
    await page.locator(option).first().waitFor();
    const lastValue = await page.locator(option).last().getAttribute("data-value");
    await page.keyboard.press("End");
    await expectFocus(page, option, lastValue);
    const endScroll = await scrollState(page);
    if (endScroll[2] > 0) {
      await page.locator(list).hover();
      await page.mouse.wheel(0, -160);
      await page.waitForFunction(({ list, top }) => document.querySelector(list)?.scrollTop < top, { list, top: endScroll[2] });
      await nextFrames(page);
      assert.ok((await scrollState(page))[2] < endScroll[2], "ordinary time list scrolling stays where the user left it");
      await page.keyboard.press("Home");
      await page.keyboard.press("End");
      await expectFocus(page, option, lastValue);
    }

    for (const viewport of [
      { width: 900, height: 561 }, { width: 901, height: 560 },
      { width: 568, height: 320 }, { width: 280, height: 653 }
    ]) {
      await page.setViewportSize(viewport);
      await expectFocus(page, option, lastValue);
    }
    await page.keyboard.press("Escape");
    await page.locator(picker).waitFor({ state: "hidden" });
    await expectFocus(page, "#downloadStartTimeButton");
    assert.equal(await page.locator("#downloadModal").isVisible(), true);

    await page.locator("#downloadStartCalendarBtn").press("Enter");
    await page.locator(picker).waitFor();
    await page.setViewportSize({ width: 568, height: 320 });
    await nextFrames(page);
    const calendarBefore = await scrollState(page);
    assert.equal(await page.locator("#downloadStartCalendarBtn").evaluate(el => el.getBoundingClientRect().top >= innerHeight), true);
    await page.keyboard.press("Escape");
    await page.locator(picker).waitFor({ state: "hidden" });
    await expectFocus(page, "#downloadStartCalendarBtn");
    assert.ok((await scrollState(page))[0] > calendarBefore[0], "the offscreen calendar opener scrolls above the sticky footer");

    await page.keyboard.press("Escape");
    await page.locator("#downloadModal").waitFor({ state: "hidden" });
    await expectFocus(page, "#mobileControlsToggle");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }

  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  try {
    await ready(touch);
    await touch.locator("#mobileControlsToggle").tap();
    await touch.getByRole("tab", { name: "Tools" }).tap();
    await touch.locator("#openDownloadModalBtn").tap();
    await touch.locator("#downloadStartCalendarBtn").tap();
    await touch.locator(picker).waitFor();
    await touch.setViewportSize({ width: 568, height: 320 });
    await nextFrames(touch);
    await touch.getByRole("button", { name: "Close date and time picker" }).tap();
    await expectFocus(touch, "#downloadStartCalendarBtn");
    await touch.locator("#downloadModalCloseBtn").tap();
    await touch.locator("#downloadModal").waitFor({ state: "hidden" });
    await expectFocus(touch, "#openDownloadModalBtn");
  } finally {
    await touch.close();
  }
  console.log(`${engine} preserved the export time option and opener focus across resize and touch orientation.`);
} finally {
  await browser.close();
}
