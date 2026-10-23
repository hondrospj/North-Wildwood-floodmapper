/** Navigate the real two-step export dialog without bypassing its review gate. */
export async function revealExportControl(page, selector, { touch = false } = {}) {
  const control = page.locator(selector);
  const step = await control.evaluate(element => element.closest('#exportReviewFields') ? 'review'
    : element.closest('#exportBasicFields') ? 'area' : null);
  if (!step || !await page.locator('#downloadModal').isVisible()) return;
  const current = await page.locator('#downloadModal').getAttribute('data-export-step');
  if (current !== step) {
    const navigation = page.locator(step === 'review' ? '#downloadBtn' : '#exportReviewBackBtn');
    await navigation[touch ? 'tap' : 'click']();
  }
  await control.waitFor({ state: 'visible' });
}
