import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
});
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const desktop = { width: 1440, height: 900 };
const landscape = { width: 568, height: 320 };
const address = "1601 Ocean Ave, Wildwood, New Jersey, 08260";
const popup = ".maplibregl-popup";
const action = `${popup} .house-alert-cta`;
const close = `${popup} .maplibregl-popup-close-button`;
const content = `${popup} .maplibregl-popup-content`;

async function expectFocus(page, selector) {
  await page.waitForFunction(selector => {
    const target = document.activeElement;
    if (!target.matches(selector)) return false;
    const box = target.getBoundingClientRect();
    return target.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) &&
      !target.closest("[inert]");
  }, selector);
}

try {
  const page = await browser.newPage({ viewport: desktop, timezoneId: "America/New_York", reducedMotion: "reduce" });
  const errors = [];
  let searches = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.route("https://nominatim.openstreetmap.org/**", route => route.fulfill({ status: 503 }));
  await page.route("https://geocode.arcgis.com/**", route => {
    searches++;
    return route.fulfill({ json: { candidates: [{
      address,
      location: { x: -74.797440504095, y: 38.994982381815 },
      score: 100,
      attributes: { Score: 100, Match_addr: address, Addr_type: "PointAddress" }
    }] } });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden && floodFrameState === "ready", null, { timeout: 90000 });
  await page.locator(".nw-simple-view").press("Enter");
  await page.waitForFunction(() => window.NORTH_WILDWOOD_3D?.state().ready &&
    document.body.dataset.mapViewMode === "3d" && document.querySelector(".nw-simple-view").getAttribute("aria-busy") === "false",
  null, { timeout: 90000 });

  const input = page.locator("#townAddressInput");
  await input.fill("1601 Ocean Avenue");
  await input.press("Enter");
  await page.locator(action).waitFor();
  await page.locator(action).press("Enter");
  await expectFocus(page, "#floodHistoryCloseBtn");
  await page.setViewportSize(landscape);
  await page.waitForFunction(() => document.querySelector("body > .maplibregl-popup"));
  await expectFocus(page, "#floodHistoryCloseBtn");
  const position = () => page.evaluate(() => {
    const center = window.NORTH_WILDWOOD_3D.getMap().getCenter();
    return [center.lng, center.lat, scrollX, scrollY];
  });
  const beforeReturn = await position();
  await page.keyboard.press("Escape");
  await page.locator("#floodHistoryBackdrop").waitFor({ state: "hidden" });
  await expectFocus(page, action);
  assert.ok(await page.locator(content).evaluate(el => el.scrollTop > 0), "the owning popup scrolls to the returned control");
  assert.deepEqual(await position(), beforeReturn, "restoring popup focus leaves the map center and page scroll alone");

  await page.setViewportSize(desktop);
  await page.waitForFunction(() => document.querySelector("#map3d .maplibregl-popup"));
  await page.locator(close).focus();
  await expectFocus(page, close);
  await page.setViewportSize(landscape);
  await page.waitForFunction(() => document.querySelector("body > .maplibregl-popup"));
  await expectFocus(page, close);
  await page.keyboard.press("Tab");
  await expectFocus(page, action);
  assert.match(await page.locator("#townAddressStatus").textContent(), /1601 Ocean Ave/);
  assert.equal(searches, 1, "popup reparenting leaves the current address result in place");
  await page.locator(close).press("Enter");
  await page.locator(popup).waitFor({ state: "hidden" });
  assert.equal(await page.locator(".nw-address-marker").count(), 1, "closing only dismisses the popup");
  assert.deepEqual(errors, []);
  console.log("MapLibre address popup kept focus through reparenting and revealed the History return control without panning.");
} finally {
  await browser.close();
}
