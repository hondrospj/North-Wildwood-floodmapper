import assert from "node:assert/strict";
import fs from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const desktop = { width: 1440, height: 900 }, landscape = { width: 568, height: 320 };
const leaflet = ".leaflet-popup.shorely-flood-popup";
const maplibre = ".maplibregl-popup";
const cta = ".house-alert-cta";
const recorded = { url, states: [], errors: [], geocodes: 0 };
const address = "1601 Ocean Ave, Wildwood, New Jersey, 08260";

try {
  const page = await browser.newPage({ viewport: desktop, reducedMotion: "reduce" });
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => recorded.errors.push(error.message));
  await page.route("https://nominatim.openstreetmap.org/**", route => route.fulfill({ status: 503 }));
  await page.route("https://geocode.arcgis.com/**", route => {
    recorded.geocodes++;
    return route.fulfill({ json: { candidates: [{ address, location: { x: -74.797440504095, y: 38.994982381815 }, score: 100,
      attributes: { Score: 100, Match_addr: address, Addr_type: "PointAddress" } }] } });
  });
  async function record(label) {
    const state = await page.evaluate(() => {
      const el = selector => document.querySelector(selector);
      const box = selector => {
        const node = el(selector);
        const r = node?.getBoundingClientRect();
        const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r && { parent: node.parentElement.id || node.parentElement.tagName, class: node.className, rect: r.toJSON(), hit: node.contains(hit),
          blockedBy: !node.contains(hit) && (hit?.id || hit?.className), inert: !!node.closest("[inert]") };
      };
      return { viewport: [innerWidth, innerHeight], documentScroll: [scrollX, scrollY], mode: document.body.dataset.mapViewMode,
        native: document.body.dataset.map3d, leaflet: box(".leaflet-popup"), maplibre: box(".maplibregl-popup"),
        leafletClose: box(".leaflet-popup-close-button"), leafletCta: box(".leaflet-popup .house-alert-cta"), glClose: box(".maplibregl-popup-close-button"),
        selected: persistentDepthQueryContext?.feature?.properties?.address, sameLeaflet: window.auditLeaflet === persistentFloodPopup?.getElement(),
        address: townAddressMarker?.getLatLng(), active: document.activeElement.id || document.activeElement.className };
    });
    recorded.states.push({ label, ...state });
    console.log(label, state.mode, state.native, state.selected, state.leaflet?.parent, state.maplibre?.parent);
    return state;
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden && floodFrameState === "ready", null, { timeout: 90000 });
  await page.locator("#townAddressInput").fill("1601 Ocean Avenue");
  await page.locator("#townAddressInput").press("Enter");
  await page.locator(leaflet + " " + cta).waitFor();
  await page.evaluate(() => { window.auditLeaflet = persistentFloodPopup.getElement(); });
  const initial = await record("Leaflet desktop");

  const view = page.locator(".nw-simple-view");
  const expectMode = mode => page.waitForFunction(mode => window.NORTH_WILDWOOD_3D?.state().ready &&
    document.body.dataset.mapViewMode === mode && document.querySelector(".nw-simple-view").getAttribute("aria-busy") === "false",
  mode, { timeout: 90000 });
  await view.press("Enter");
  await expectMode("3d");
  await page.locator(maplibre + " " + cta).waitFor();
  const pitched = await record("Leaflet to MapLibre 3D");
  assert.equal(pitched.selected, initial.selected);
  assert.equal(pitched.sameLeaflet, true);
  assert.deepEqual(pitched.address, initial.address);

  await view.press("Enter");
  await expectMode("2d");
  assert.equal((await record("MapLibre top-down")).selected, initial.selected);
  await view.press("Enter");
  await expectMode("3d");
  assert.equal((await record("MapLibre pitched again")).selected, initial.selected);

  await page.setViewportSize(landscape);
  await page.waitForFunction(() => document.body.dataset.unifiedLayout === "mobile");
  await record("MapLibre compact before graphics loss");
  const lost = await page.evaluate(() => {
    const gl = window.NORTH_WILDWOOD_3D.getMap().getCanvas().getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    gl.canvas.addEventListener("webglcontextlost", event => { window.auditTrustedLoss = event.isTrusted; }, { once: true });
    extension.loseContext();
    return true;
  });
  assert.equal(lost, true);
  await page.waitForFunction(() => window.auditTrustedLoss && document.body.dataset.map3d === "fallback", null, { timeout: 30000 });
  await page.locator(leaflet + " " + cta).waitFor();
  const returned = await record("Native context loss returns to Leaflet");
  assert.equal(returned.sameLeaflet, true);
  assert.equal(returned.selected, initial.selected);
  assert.deepEqual(returned.address, initial.address);
  assert.deepEqual(returned.documentScroll, [0, 0]);
  assert.equal(returned.maplibre, undefined);
  assert.equal(recorded.geocodes, 1);
  assert.deepEqual(recorded.errors, []);
  await page.locator(leaflet + " " + cta).press("Enter");
  await page.locator("#floodHistoryBackdrop").waitFor();
  await page.keyboard.press("Escape");
  const afterHistory = await record("Fallback History Escape");
  assert.equal(afterHistory.active, "house-alert-cta");
  assert.deepEqual(afterHistory.documentScroll, [0, 0]);
  assert.equal(afterHistory.leafletCta?.hit, true, "Leaflet fallback must reveal the restored History control");
  assert.equal(afterHistory.leafletClose?.hit, true, "Leaflet fallback must keep the popup Close reachable");
  console.log("Leaflet and MapLibre kept the original address, and the graphics fallback restored reachable popup controls.");
} catch (error) {
  recorded.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (process.env.NWW_REPORT) await fs.writeFile(process.env.NWW_REPORT, JSON.stringify(recorded, null, 2) + "\n");
}
