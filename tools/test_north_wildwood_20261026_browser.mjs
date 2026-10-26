// Real-browser regressions for the October 26 UI audit fixes. Forecast,
// observations and flood rendering stay real; only the archive completion is
// held after its actual load to exercise preparation cancellation deterministically.
import assert from 'node:assert/strict';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.NWW_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({ headless: true,
  ...(engine === chromium && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(engine === chromium ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
  timezoneId: 'America/Los_Angeles' });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [], warnings = [], downloads = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (['warning', 'error'].includes(message.type())) {
    warnings.push(message.text());
    if (warnings.length > 10) warnings.shift();
  }
});
page.on('download', download => downloads.push(download.suggestedFilename()));
const url = process.env.NWW_TEST_URL || 'http://127.0.0.1:8765/index.html';
const ranking = () => page.evaluate(() => topTideEvents.map(event => ({
  date: event.dateKey, stage: event.peakStage, rank: event.rank,
})));
const selectedInstant = () => page.evaluate(() => getRangeInputDate('downloadStartInput')?.toISOString() || null);
async function fillDate(value) {
  await page.locator('#downloadStartDateText').fill(value);
  await page.locator('#downloadStartTimeSelect').focus();
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains('nw-app-ready') &&
    floodFrameState === 'ready' && topTideEvents.length === 10, {}, { timeout: 90000 });

  const before = await ranking();
  await page.locator('#observedDataBtn').click();
  await page.waitForFunction(() => currentDataMode === 'observed' && currentViewType === 'observed-day' &&
    floodFrameState === 'ready', {}, { timeout: 90000 });
  assert.deepEqual(await ranking(), before, 'Opening Past must not change the fresh Top 10 ranking');
  assert.ok(!before.some(event => ['2026-09-21', '2026-08-23'].includes(event.date)));
  checks.push('fresh Top 10 ranking remains stable after Past');
  await page.locator('#forecastDataBtn').click();
  await page.waitForFunction(() => currentDataMode === 'forecast' && floodFrameState === 'ready', {}, { timeout: 90000 });
  await page.locator('#openDownloadModalBtn').click();

  // Use actual keyboard deletion/insertion, including the mask's beforeinput
  // and caret handlers. Deleting and retyping the same digit is a no-op.
  const dateInput = page.locator('#downloadStartDateText');
  for (const id of ['downloadStartDateText', 'downloadEndDateText']) {
    assert.equal(await page.locator(`#${id}`).getAttribute('maxlength'), null,
      'A full placeholder mask must not make WebKit discard beforeinput text');
  }
  await dateInput.evaluate(input => {
    window.__auditDateEvents = [];
    for (const type of ['keydown', 'beforeinput', 'input', 'keyup']) input.addEventListener(type, event => {
      window.__auditDateEvents.push({ type, key: event.key, data: event.data, inputType: event.inputType,
        value: input.value, start: input.selectionStart, end: input.selectionEnd,
        active: document.activeElement?.id, prevented: event.defaultPrevented });
    });
  });
  await dateInput.fill('10/26/2026');
  await dateInput.press('End');
  await page.waitForFunction(() => document.getElementById('downloadStartDateText').selectionStart === 10);
  await dateInput.press('ArrowLeft');
  await dateInput.press('ArrowLeft');
  await dateInput.press('Backspace');
  assert.equal(await dateInput.inputValue(), '10/26/2Y26');
  await dateInput.press('0');
  assert.equal(await dateInput.inputValue(), '10/26/2026');
  await page.locator('#downloadStartTimeSelect').focus();
  assert.equal(await dateInput.inputValue(), '10/26/2026');
  checks.push('Backspace/retype preserves every untouched date digit');

  // Choose 02:30 on the preceding day, then edit the date to spring-forward.
  // The real blur/commit path must reject rather than change it to 03:30.
  await fillDate('03/07/2026');
  await page.locator('#downloadStartTimeSelect').selectOption('02:30');
  await fillDate('03/08/2026');
  assert.equal(await dateInput.getAttribute('aria-invalid'), 'true');
  assert.equal(await selectedInstant(), null);
  assert.equal(await dateInput.inputValue(), '03/08/2026');
  assert.equal(await page.locator('#downloadStartTimeSelect').evaluate(select => select.selectedOptions[0]?.textContent),
    '02:30 AM (unavailable)');
  assert.equal(await page.locator('#downloadStartTimeSelect option[value="02:30"]').evaluate(option => option.disabled), true);
  await page.locator('#downloadStartTimeSelect').selectOption('03:30');
  assert.equal(await selectedInstant(), '2026-03-08T07:30:00.000Z');
  checks.push('spring-forward 02:30 is rejected through the visible date/time editor');

  await fillDate('11/02/2025');
  const times = page.locator('#downloadStartTimeSelect');
  for (const [label, instant] of [
    ['01:30 AM EDT (first)', '2025-11-02T05:30:00.000Z'],
    ['01:30 AM EST (second)', '2025-11-02T06:30:00.000Z'],
  ]) {
    await times.selectOption({ label });
    await dateInput.focus();
    await times.focus();
    assert.equal(await selectedInstant(), instant);
    assert.equal(await times.evaluate(select => select.selectedOptions[0]?.textContent), label,
      'Blur/summary synchronization must retain the explicit occurrence');
  }
  checks.push('explicit first EDT / second EST selections retain their exact instants');

  // Begin a real one-frame export after a fresh settings session. The wrapper
  // waits for the real archive request first, then holds its completion only
  // while the export is preparing (previews continue through the normal path).
  await page.locator('#downloadModalCloseBtn').click();
  await page.locator('#openDownloadModalBtn').click();
  await page.locator('#exportFormatPngBtn').click();
  // Forecast-only ranges intentionally bypass history. Select a genuine
  // historical frame so this test still exercises archive preparation.
  await fillDate('12/31/2025');
  await page.locator('#downloadStartTimeSelect').selectOption('23:00');
  await page.locator('#downloadEndDateText').fill('12/31/2025');
  await page.locator('#downloadEndTimeSelect').focus();
  await page.locator('#downloadEndTimeSelect').selectOption('23:00');
  assert.equal(await selectedInstant(), '2026-01-01T04:00:00.000Z');
  await page.locator('#downloadBtn').click(); // Per-session settings review.
  await page.evaluate(() => {
    const original = ensureObservedArchiveRange;
    let held = false;
    ensureObservedArchiveRange = async (...args) => {
      const result = await original(...args);
      if (exportInProgress && !held) {
        held = true;
        window.__auditArchiveHeld = true;
        await new Promise(resolve => { window.__auditReleaseArchive = resolve; });
      }
      return result;
    };
  });
  await page.locator('#downloadBtn').click();
  await page.waitForFunction(() => window.__auditArchiveHeld && exportInProgress, {}, { timeout: 90000, polling: 50 });
  const cancel = page.getByRole('button', { name: 'Cancel export', exact: true });
  assert.equal(await cancel.isVisible(), true);
  assert.equal(await cancel.isEnabled(), true);
  const accessibility = await cancel.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return { inert: Boolean(button.closest('[inert]')),
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button')?.id,
      settingsHidden: document.getElementById('downloadModal').hidden };
  });
  assert.deepEqual(accessibility, { inert: false, hit: 'exportProgressCloseBtn', settingsHidden: true });
  await cancel.click();
  assert.equal(await page.evaluate(() => exportCancelRequested), true);
  assert.match(await page.locator('#exportProgressMessage').textContent(), /Cancelling export/);
  await page.evaluate(() => window.__auditReleaseArchive());
  await page.waitForFunction(() => !exportInProgress, {}, { timeout: 30000, polling: 50 });
  assert.equal(await page.locator('#downloadStatus').textContent(), 'Export cancelled.');
  assert.equal(await page.locator('#downloadBtn').isEnabled(), true);
  assert.deepEqual(downloads, [], 'Resolving a delayed archive after Cancel must not start a download');
  checks.push('archive-preparation Cancel remains actionable and prevents the later download');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine: engine === webkit ? 'webkit' : 'chromium', passed: true, checks, ranking: before }, null, 2));
} catch (error) {
  console.error('October 26 browser regression state', JSON.stringify(await page.evaluate(() => ({
    body: document.body.className, mode: typeof currentDataMode === 'undefined' ? null : currentDataMode,
    frame: typeof floodFrameState === 'undefined' ? null : floodFrameState,
    start: document.getElementById('downloadStartDateText')?.value,
    time: document.getElementById('downloadStartTimeSelect')?.value,
    status: document.getElementById('downloadStatus')?.textContent,
    preview: document.getElementById('exportPreview')?.dataset.state,
    progress: document.getElementById('exportProgressMessage')?.textContent,
    archiveHeld: window.__auditArchiveHeld,
    selectedOption: document.getElementById('downloadStartTimeSelect')?.selectedOptions[0]?.outerHTML,
    dateEvents: window.__auditDateEvents,
  }))), JSON.stringify({ errors, warnings, downloads }));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
