import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "America/New_York" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html", {
    waitUntil: "domcontentloaded", timeout: 90000
  });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") && floodFrameState === "ready",
    null, { timeout: 90000 });
  await page.locator("#observedDataBtn").click();
  await page.waitForFunction(() => currentDataMode === "observed" && floodFrameState === "ready", null, { timeout: 90000 });
  await page.locator("#intervalDailyBtn").click();
  const date = page.locator("#observedDateInput");
  await date.fill("2020-01-12");
  await date.press("Enter");
  await page.waitForFunction(() => currentSeriesHours[currentHourIndex]?.observedDate === "2020-01-12" &&
    getTimelineIntervalMinutes() === 1440 && floodFrameState === "ready");

  const play = page.locator("#playBtn");
  await play.click();
  // The 20th date is also the first frame after a month rollover.
  await page.waitForFunction(() => playbackPausedForConfirmation ||
    currentSeriesHours[currentHourIndex]?.observedDate >= "2020-02-03", null, { timeout: 65000 });
  const status = await page.evaluate(() => ({
    date: currentSeriesHours[currentHourIndex]?.observedDate,
    advanced: playbackObservedDaysAdvanced,
    playing: Boolean(playTimer),
    focused: document.activeElement.id
  }));
  assert.deepEqual(status, {
    date: "2020-02-01", advanced: 20, playing: false, focused: "playbackStillThereContinueBtn"
  });
  await page.locator("#playbackStillThereContinueBtn").click();
  await page.waitForFunction(() => currentSeriesHours[currentHourIndex]?.observedDate >= "2020-02-02" &&
    playbackObservedDaysAdvanced > 0);
  await play.click();
  assert.equal(await page.evaluate(() => Boolean(playTimer)), false);
  assert.deepEqual(errors, []);
  console.log("Daily Max playback pauses after 20 displayed dates across a month rollover and resumes from the next date.");
} finally {
  await browser.close();
}
