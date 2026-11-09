import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const desktop = { width: 1440, height: 900 };
const landscape = { width: 568, height: 320 };
const portrait = { width: 390, height: 844 };
const popupSelector = ".leaflet-popup.shorely-flood-popup";
const historySelector = popupSelector + " .house-alert-cta";
const closeSelector = popupSelector + " .leaflet-popup-close-button";
const coordinate = { x: -74.797440504095, y: 38.994982381815 };
const address = "1601 Ocean Ave, Wildwood, New Jersey, 08260";

async function expectFocus(page, selector) {
  await page.waitForFunction(selector => {
    const target = document.querySelector(selector);
    if (!target || document.activeElement !== target || target.closest("[inert]")) return false;
    const { x, y, width, height } = target.getBoundingClientRect();
    return target.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  }, selector);
}

async function mapState(page) {
  await page.waitForFunction(() => !map._panAnim?._inProgress && !map._animatingZoom);
  return page.evaluate(() => ({
    center: map.getCenter(),
    zoom: map.getZoom(),
    scroll: [scrollX, scrollY],
    selectedAddress: townAddressMarker?.getLatLng()
  }));
}

try {
  const page = await browser.newPage({ viewport: desktop, reducedMotion: "reduce", timezoneId: "America/New_York" });
  page.setDefaultTimeout(12000);
  const errors = [];
  let geocodes = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://nominatim.openstreetmap.org/**", route => route.fulfill({ status: 503 }));
  await page.route("https://geocode.arcgis.com/**", route => {
    geocodes++;
    return route.fulfill({ json: { candidates: [{
      address, location: coordinate, score: 100,
      attributes: { Score: 100, Match_addr: address, Addr_type: "PointAddress" }
    }] } });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden && floodFrameState === "ready", null, { timeout: 90000 });

  const search = page.locator("#townAddressInput");
  const history = page.locator(historySelector);
  const close = page.locator(closeSelector);
  const backdrop = page.locator("#floodHistoryBackdrop");
  await search.fill("1601 Ocean Avenue");
  await search.press("Enter");
  await history.waitFor({ timeout: 45000 });
  assert.equal(geocodes, 1);
  const feature = await page.evaluate(() => {
    const properties = persistentDepthQueryContext.feature.properties;
    return { address: properties.address, lat: properties.centroidLat, lng: properties.centroidLon };
  });
  assert.equal(feature.address, "1601 OCEAN AVE");
  const openerOnly = process.env.NWW_HISTORY_OPENER_ONLY === "1";
  if (openerOnly) {
    await close.click();
  } else {
    const originalButton = await history.elementHandle();
    await history.press("Enter");
    await expectFocus(page, "#floodHistoryCloseBtn");
    await page.setViewportSize(landscape);
    await expectFocus(page, "#floodHistoryCloseBtn");
    await page.waitForFunction(() => {
      const content = document.querySelector(".nw-short-leaflet-popup .leaflet-popup-content");
      return content?.scrollHeight > content?.clientHeight;
    });
    assert.equal(await history.evaluate(button => !!button.closest("[inert]")), true);
    const compactState = await mapState(page);
    await page.keyboard.press("Escape");
    await backdrop.waitFor({ state: "hidden" });
    await expectFocus(page, historySelector);
    assert.equal(await originalButton.evaluate(button => button === document.activeElement), true);
    assert.ok(await history.evaluate(button => button.closest(".leaflet-popup-content").scrollTop > 0));
    assert.deepEqual(await mapState(page), compactState);
    assert.deepEqual(compactState.scroll, [0, 0]);

    await page.setViewportSize(portrait);
    await expectFocus(page, historySelector);
    await page.setViewportSize(desktop);
    await expectFocus(page, historySelector);
    await close.focus();
    await page.setViewportSize(landscape);
    await expectFocus(page, closeSelector);
    const beforeClose = await mapState(page);
    await page.keyboard.press("Enter");
    await close.waitFor({ state: "hidden" });
    assert.deepEqual(await mapState(page), beforeClose);
    assert.deepEqual(beforeClose.selectedAddress, { lat: coordinate.y, lng: coordinate.x });

    await page.setViewportSize(desktop);
  }
  await page.locator("#townAddressClearBtn").click();
  const point = await page.evaluate(({ lat, lng }) => {
    const point = map.latLngToContainerPoint([Number(lat), Number(lng)]);
    const bounds = map.getContainer().getBoundingClientRect();
    return { x: bounds.left + point.x, y: bounds.top + point.y };
  }, feature);
  await page.mouse.click(point.x, point.y);
  await history.waitFor();
  assert.equal(await page.evaluate(() => persistentDepthQueryContext.feature.properties.address), feature.address);
  await history.press("Enter");
  await expectFocus(page, "#floodHistoryCloseBtn");
  if (!openerOnly) {
    await page.setViewportSize(landscape);
    await expectFocus(page, "#floodHistoryCloseBtn");
    await page.waitForFunction(() => document.querySelector(".nw-short-leaflet-popup") !== null);
  }
  await page.keyboard.press("Escape");
  await expectFocus(page, historySelector);
  assert.deepEqual((await mapState(page)).scroll, [0, 0]);
  assert.equal(await page.evaluate(() => persistentDepthQueryContext.feature.properties.address), feature.address);
  assert.equal(geocodes, 1);
  assert.deepEqual(errors, []);
  console.log(openerOnly
    ? `${engine} returned History focus to the button after a pointer-selected building and keyboard activation.`
    : `${engine} kept the Leaflet address and clicked building selection through History and responsive popup focus.`);
} finally {
  await browser.close();
}
