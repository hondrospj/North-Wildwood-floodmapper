export async function revealMapViewControl(page) {
  const phoneView = page.locator('#nwwDrawerViewMode .nw-simple-view');
  if (!await phoneView.count() || await phoneView.isVisible()) return false;
  await page.locator('#mobileControlsToggle').click();
  await phoneView.waitFor();
  return true;
}

export async function changeMapView(page, button = page.locator('.nw-simple-view')) {
  const opened = await revealMapViewControl(page);
  await button.click();
  if (opened) await page.locator('#mobileControlsClose').click();
}

export async function touchMapGesture(page, { moveX = 0, moveY = 0, spread = 0, fingers = 2, origin, session } = {}) {
  const { width, height } = page.viewportSize();
  const centerX = Math.round(origin?.x ?? width / 2);
  const centerY = Math.round(origin?.y ?? height / 2);
  const client = session ?? await page.context().newCDPSession(page);
  const send = (type, touchPoints) => client.send('Input.dispatchTouchEvent', { type, touchPoints });
  const points = fraction => (fingers === 1 ? [0] : [-1, 1]).map((side, id) => ({
    id,
    x: centerX + moveX * fraction + side * (43 + spread * fraction),
    y: centerY + moveY * fraction,
  }));
  try {
    await send('touchStart', points(0));
    for (const fraction of [0.2, 0.4, 0.6, 0.8, 1]) await send('touchMove', points(fraction));
    await send('touchEnd', []);
  } finally {
    if (!session) await client.detach();
  }
}
