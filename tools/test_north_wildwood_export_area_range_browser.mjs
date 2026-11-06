// Real native inputs and the shipped area picker must preserve a custom range.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = process.env.NWW_BROWSER || 'chromium';
const browser = await playwright[name === 'edge' ? 'chromium' : name].launch({headless: true,
  ...(name === 'edge' ? {channel: 'msedge'} : {}),
  ...(name === 'chromium' && process.env.NWW_CHROMIUM_CHANNEL ? {channel: process.env.NWW_CHROMIUM_CHANNEL} : {}),
  ...(name === 'chromium' && process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}),
  ...(['chromium', 'edge'].includes(name) ? {args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']} : {})});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}, timezoneId: 'America/New_York'});
const result = {browser: name, version: browser.version(), checks: [], errors: [], ranges: []};
page.on('pageerror', error => result.errors.push(error.message));
const snapshot = () => page.evaluate(() => ({
  start: document.getElementById('downloadStartInput').value,
  end: document.getElementById('downloadEndInput').value,
  startText: document.getElementById('downloadStartDateText').value,
  endText: document.getElementById('downloadEndDateText').value,
  startTime: document.getElementById('downloadStartTimeSelect').value,
  endTime: document.getElementById('downloadEndTimeSelect').value,
  valid: validateDownloadRangeForExport().ok,
  frames: getDownloadFrameItems().map(item => item.entry.timeUtc),
  format: getDownloadFormatValue(), aspect: getDownloadAspectValue(),
  interval: document.getElementById('downloadIntervalSelect').value, speed: getDownloadSpeedValue(),
  step: document.getElementById('downloadModal').dataset.exportStep,
}));
try {
  await page.goto(process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html',
    {waitUntil: 'domcontentloaded', timeout: 90000});
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready'), {}, {timeout: 90000});
  const selected = await page.evaluate(() => {
    const entries = getForecastExportEntries().filter(entry => Number.isFinite(entryTimeMs(entry)))
      .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
    const dates = [getEntryESTDate(entries[12]), getEntryESTDate(entries[15])];
    return dates.map(date => { const parts = getNyParts(date); return {
      date: `${parts.month}/${parts.day}/${parts.year}`, time: formatNyLocalIso(date).slice(11)}; });
  });
  for (const [action, button, opener] of [
    ['Cancel', '#exportAreaCancelBtn', 'exportExtentCustomBtn'],
    ['Use this area', '#exportAreaApplyBtn', 'exportChangeAreaBtn'],
  ]) {
    await page.locator('#openDownloadModalBtn').click();
    const seeded = await snapshot();
    for (const [index, prefix] of ['Start', 'End'].entries()) {
      await page.locator(`#download${prefix}DateText`).fill(selected[index].date);
      await page.locator(`#download${prefix}DateText`).press('Tab');
      await page.locator(`#download${prefix}TimeButton`).click();
      const value = await page.locator(`#download${prefix}TimeSelect`).evaluate((select, time) =>
        [...select.options].find(option => option.value === time || option.value.startsWith(time + '|'))?.value,
      selected[index].time);
      assert.ok(value, `Native time option exists for ${prefix}`);
      await page.locator(`#nwwExportDateTimePicker [data-value="${value}"]`).click();
    }
    // Nondefault settings make unintended whole-form resets observable too.
    await page.locator('#downloadBtn').click();
    await page.locator('#exportAspectSquareBtn').click();
    await page.locator('#exportSpeedSlowBtn').click();
    const before = await snapshot();
    assert.equal(before.valid, true);
    assert.equal(before.frames.length, 4);
    await page.locator(`#${opener}`).click();
    await page.waitForFunction(() => !document.getElementById('exportAreaModal').hidden);
    await page.locator(button).click();
    await page.waitForFunction(() => isDownloadModalOpen());
    const after = await snapshot();
    result.ranges.push({action, before, after});
    assert.equal(await page.evaluate(() => document.activeElement.id), opener);
    await page.locator('#downloadModalCloseBtn').click();
    await page.locator('#openDownloadModalBtn').click();
    const reopened = await snapshot();
    assert.equal(reopened.start, seeded.start, 'Fresh open still seeds the current timeline start');
    assert.equal(reopened.end, seeded.end, 'Fresh open still seeds the current timeline end');
    assert.equal(reopened.step, 'area', 'Fresh open still starts on the basic step');
    result.checks.push(`${action}: fresh open reseeds the normal timeline range`);
    await page.locator('#downloadModalCloseBtn').click();
  }
  for (const {action, before, after} of result.ranges) {
    assert.deepEqual(after, before, `${action} must retain all date, time, and export settings`);
    result.checks.push(`${action} preserves the valid four-frame range and form settings`);
  }
  assert.deepEqual(result.errors, []);
} catch (error) {
  result.failure = error.stack;
  throw error;
} finally {
  await browser.close();
  if (process.env.NWW_AUDIT_OUTPUT) {
    fs.mkdirSync(process.env.NWW_AUDIT_OUTPUT, {recursive: true});
    fs.writeFileSync(path.join(process.env.NWW_AUDIT_OUTPUT, 'export-area-range.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
}
