import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const viewports = [
  { width: 1366, height: 768, touch: false },
  { width: 280, height: 653, touch: true },
  { width: 568, height: 320, touch: true }
];
const roadPath = "**/assets/roads/north-wildwood-road-centerlines.geojson";

try {
  for (const { width, height, touch } of viewports) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
    try {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      let requests = 0;
      let releaseOutage;
      const outage = new Promise(resolve => { releaseOutage = resolve; });
      await page.route(roadPath, async route => {
        if (++requests !== 1) return route.continue();
        await outage;
        return route.fulfill({ status: 503, contentType: "text/plain", body: "Injected transient road data outage" });
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
        document.getElementById("nwSiteLoader").hidden && floodFrameState === "ready", null, { timeout: 90000 });

      const toggle = page.locator("#roadImpactsToggle");
      const key = page.locator("#roadImpactsKey");
      const status = key.getByRole("status");
      const activate = () => touch ? toggle.tap() : toggle.press("Space");
      const openLayers = async () => {
        if (!touch) return;
        await page.locator("#mobileControlsToggle").tap();
        const tab = page.getByRole("tab", { name: "Map layers" });
        if (await tab.getAttribute("aria-selected") !== "true") await tab.tap();
      };
      const closeLayers = async () => {
        if (touch) await page.locator("#mobileControlsClose").tap();
      };
      const waitState = state => page.waitForFunction(value =>
        document.body.dataset.roadImpactsState === value, state, { timeout: 30000 });
      assert.equal(requests, 0, "road data remains lazy");
      assert.equal(await key.isVisible(), false);

      await openLayers();
      await activate();
      await waitState("loading");
      await closeLayers();
      await key.waitFor();
      assert.match(await status.textContent(), /Loading road impacts/);
      assert.ok(await status.evaluate(el => el.getBoundingClientRect().width > 1), "pending state is visible");
      assert.equal(await key.locator(".road-impacts-swatch").isVisible(), false);
      releaseOutage();
      await waitState("failed");
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.match(await status.textContent(), /Toggle off\/on to retry/);
      assert.equal(await status.evaluate(el => {
        const box = el.getBoundingClientRect();
        const parent = el.parentElement.getBoundingClientRect();
        return getComputedStyle(el).clip === "auto" && box.width > 1 && box.height > 1 &&
          box.left >= Math.max(0, parent.left) && box.right <= Math.min(innerWidth, parent.right) &&
          box.top >= parent.top && box.bottom <= parent.bottom;
      }), true, "failure warning is visible and fits the key");
      assert.equal(await key.locator(".road-impacts-swatch").isVisible(), false);
      assert.equal(await key.locator(".road-impacts-label").isVisible(), false);
      assert.equal(await key.locator(".road-impacts-label-mobile").isVisible(), false);
      assert.equal(requests, 1);

      await openLayers();
      await activate();
      await activate();
      await waitState("ready");
      await closeLayers();
      assert.equal(requests, 2);
      assert.equal(await key.locator(".road-impacts-swatch").isVisible(), true);
      assert.equal(await key.locator(touch ? ".road-impacts-label-mobile" : ".road-impacts-label").isVisible(), true);
      assert.equal(await status.evaluate(el => el.getBoundingClientRect().width), 1);

      await openLayers();
      const overlayHelp = page.locator("#overlayHelpBtn");
      if (touch) await overlayHelp.tap();
      else await overlayHelp.press("Enter");
      const info = page.locator("#infoModal");
      await info.waitFor();
      assert.match(await info.locator("#infoModalBody").textContent(), /Road Impacts.*modeled surface below the deck/s);
      await page.keyboard.press("Escape");
      await info.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
      console.log(`${engine} ${width}×${height} shows the road failure and restores the ordinary key after retry.`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
