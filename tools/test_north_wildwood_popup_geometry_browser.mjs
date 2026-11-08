import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const name = process.env.NWW_BROWSER || "chromium";
const engine = playwright[name === "edge" ? "chromium" : name];
const browser = await engine.launch({
  headless: true,
  ...(name === "edge" ? { channel: "msedge" } : {}),
  ...(name === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(["chromium", "edge"].includes(name) ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {})
});
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const profiles = [
  { width: 1366, height: 768, touch: false },
  { width: 1024, height: 576, touch: false },
  { width: 820, height: 1180, touch: true },
  { width: 390, height: 844, touch: true }
];
const popupTypes = [".building-info-card", ".parcel-area-popup", ".depth-query-popup", ".nsi-structure-popup"];
const closeButton = ":is(.leaflet-popup-close-button,.maplibregl-popup-close-button)";
const near = (actual, expected, description) => assert.ok(Math.abs(actual - expected) < 1, description);

async function readPlacement(close) {
  return close.evaluate(button => {
    const popup = button.closest(".leaflet-popup,.maplibregl-popup");
    const card = popup.querySelector(".leaflet-popup-content-wrapper,.maplibregl-popup-content");
    const edge = card.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const help = card.querySelector(".property-help summary")?.getBoundingClientRect();
    return {
      top: rect.top - edge.top,
      right: edge.right - rect.right,
      width: rect.width,
      height: rect.height,
      helpGap: help ? rect.left - help.right : null,
      reachable: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    };
  });
}

try {
  for (const { width, height, touch } of profiles) {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: touch,
      ...(name === "firefox" ? {} : { isMobile: touch })
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") && floodFrameState === "ready",
        {}, { timeout: 90000 });
      await page.evaluate(async () => {
        await ensureParcelAssets();
        await ensureNsiStructureAssets();
      });

      for (const renderer of ["leaflet", "maplibre"]) {
        if (renderer === "maplibre") {
          await page.locator(".nw-simple-view").click();
          await page.waitForFunction(() => NORTH_WILDWOOD_3D.state().ready, {}, { timeout: 45000 });
        }
        const popup = page.locator(renderer === "leaflet" ? ".shorely-flood-popup:visible" : ".maplibregl-popup:visible");
        for (const [kind, selector] of popupTypes.entries()) {
          // Use the actual popup entry points and normal map center to keep hit-testing repeatable.
          await page.evaluate(kind => {
            const point = map.getCenter();
            const parcel = parcelFeatures.find(feature => feature.id === 515857);
            const openers = [
              () => openParcelFloodPrompt(parcel, point),
              () => openParcelAreaPopup(parcel, point),
              () => openDepthQueryPopup(point, null),
              () => openNsiStructurePopup(nsiStructureFeatures[0], point)
            ];
            openers[kind]();
          }, kind);
          await popup.locator(selector).waitFor();
          const close = popup.locator(closeButton);
          assert.equal(await close.count(), 1);
          await close.click({ trial: true });

          const description = `${width}×${height} ${renderer} ${selector}`;
          const expectedSize = touch ? 44 : 36;
          const placement = await readPlacement(close);
          near(placement.top, 8, `${description} top offset: ${JSON.stringify(placement)}`);
          near(placement.right, 8, `${description} right offset: ${JSON.stringify(placement)}`);
          near(placement.width, expectedSize, `${description} close width`);
          near(placement.height, expectedSize, `${description} close height`);
          assert.ok(placement.reachable, `${description} close is at the top of the hit stack`);
          if (placement.helpGap !== null) assert.ok(placement.helpGap >= 5, `${description} Help clears close`);
          await close[touch ? "tap" : "click"]();
          await popup.waitFor({ state: "hidden" });
        }
        console.log(`${width}×${height} ${renderer}: all four close controls match and dismiss their popups.`);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log(`Matched the close offsets for ${popupTypes.length} popup types, two renderers and ${profiles.length} viewports in ${name}.`);
} finally {
  await browser.close();
}
