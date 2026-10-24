/** Navigate the real two-step export dialog without bypassing its review gate. */
export async function revealExportControl(page, selector, { touch = false, timeout = 30000 } = {}) {
  const control = page.locator(selector);
  const step = await control.evaluate(element => element.closest('#exportReviewFields') ? 'review'
    : element.closest('#exportBasicFields') ? 'area' : null);
  if (!step || !await page.locator('#downloadModal').isVisible()) return;
  const current = await page.locator('#downloadModal').getAttribute('data-export-step');
  if (current !== step) {
    const navigation = page.locator(step === 'review' ? '#downloadBtn' : '#exportReviewBackBtn');
    // The real preview renderer permits 20 seconds for capture resources and
    // software compositing can delay input acknowledgement. Match the bounded
    // modal-control allowance; dispatch once, since repeating More options
    // after a delivered click would initiate an unintended download.
    await navigation[touch ? 'tap' : 'click']({ timeout });
  }
  await page.waitForFunction(expected =>
    document.getElementById('downloadModal')?.dataset.exportStep === expected,
  step, { timeout, polling: 50 });
  await control.waitFor({ state: 'visible', timeout });
}
