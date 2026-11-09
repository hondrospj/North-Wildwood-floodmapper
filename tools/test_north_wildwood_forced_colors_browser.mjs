import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const viewports = [
  { name: "desktop", viewport: { width: 1366, height: 768 } },
  { name: "compact landscape", viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true }
];
const modes = [
  { forcedColors: "active", colorScheme: "light" },
  { forcedColors: "active", colorScheme: "dark" },
  { forcedColors: "none", colorScheme: "dark" }
];
const styles = (locator, properties, pseudo) => locator.evaluate((el, { properties, pseudo }) => {
  const style = getComputedStyle(el, pseudo);
  return properties.map(property => style[property]);
}, { properties, pseudo });
const isGradient = value => value.startsWith("linear-gradient(");

try {
  for (const { name, ...profile } of viewports) {
    for (const mode of modes) {
      const page = await browser.newPage({ ...profile, ...mode, userAgent, reducedMotion: "reduce" });
      try {
        const errors = [];
        page.setDefaultTimeout(15000);
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
          document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });

        const forced = mode.forcedColors === "active";
        const palette = await page.evaluate(() => {
          const sample = document.createElement("span");
          sample.style.forcedColorAdjust = "none";
          document.body.append(sample);
          const colors = Object.fromEntries(["ButtonFace", "ButtonText", "CanvasText", "Highlight", "HighlightText"].map(keyword => {
            sample.style.color = keyword;
            return [keyword, getComputedStyle(sample).color];
          }));
          sample.remove();
          return colors;
        });
        assert.equal(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), forced);

        const track = page.locator("#hourSlider");
        const [trackPaint] = await styles(track, ["backgroundImage"]);
        assert.ok(isGradient(trackPaint), "timeline slider paints the stage rail");
        const activeDay = page.locator('#timelineDayTabs .timeline-day[aria-current="true"]');
        if (forced) {
          const [dayPaint] = await styles(activeDay, ["backgroundImage"], "::after");
          assert.ok(isGradient(dayPaint), "day paints stage colors separately from its label");
          assert.deepEqual(await styles(activeDay, ["textDecorationLine"]), ["underline"]);
        }
        const swatchPaints = await page.locator("#timelineFloodKey .timeline-key-swatch").evaluateAll(swatches =>
          swatches.map(swatch => getComputedStyle(swatch).backgroundColor));
        assert.equal(swatchPaints.length, 4);
        assert.equal(new Set(swatchPaints).size, 4, "timeline categories retain four distinct swatches");
        await page.waitForFunction(() => floodFrameState === "ready" &&
          !pendingTimelineSelection && !requestedTimelineSelection);
        const [priorTime, min, max] = await track.evaluate(el => [el.value, el.min, el.max].map(Number));
        assert.ok(max > min, "forecast timeline has more than one selectable hour");
        const direction = priorTime > min ? -1 : 1;
        await track.press(direction < 0 ? "ArrowLeft" : "ArrowRight");
        await page.waitForFunction(expected => currentHourIndex === expected &&
          Number(document.getElementById("hourSlider").value) === expected &&
          floodFrameState === "ready", priorTime + direction);

        const triangle = page.locator("#playBtn .playTriangle");
        const [shape, glyphColor] = await styles(triangle, ["clipPath", "backgroundColor"]);
        assert.equal(shape.startsWith("polygon("), forced);
        if (forced) assert.equal(glyphColor, palette.ButtonText);
        const play = page.locator("#playBtn");
        await play.press("Enter");
        // Playback refreshes the icon element as frames advance. Sample both
        // pseudo-elements in the same browser task as the DOM lookup.
        const pause = await page.waitForFunction(() => {
          const icon = document.querySelector("#playBtn .pauseIcon");
          return icon && ["::before", "::after"].map(pseudo => getComputedStyle(icon, pseudo).backgroundColor);
        });
        if (forced) assert.deepEqual(await pause.jsonValue(), [palette.ButtonText, palette.ButtonText]);
        await pause.dispose();
        await play.press("Enter");
        await triangle.waitFor();

        const controls = page.locator("#mobileControlsToggle");
        const compact = await controls.isVisible();
        if (compact) {
          await page.locator("#legendDock").press("Enter");
          await page.locator('#legendDock[aria-expanded="true"]').waitFor();
        }
        const key = page.locator("#legendDock .depth-legend-gradient");
        await key.waitFor();
        const [keyPaint, keyOutline] = await styles(key, ["backgroundImage", "borderTopColor"]);
        assert.ok(isGradient(keyPaint), "map key retains the depth ramp");
        if (forced) assert.equal(keyOutline, palette.CanvasText);

        if (compact) {
          await page.keyboard.press("Escape");
          await controls.press("Enter");
        }
        const source = page.locator("#forecastDataBtn");
        const past = page.locator("#observedDataBtn");
        assert.equal(await source.getAttribute("aria-pressed"), "true");
        assert.deepEqual(await styles(source, ["textDecorationLine"]), [forced ? "underline" : "none"]);
        assert.deepEqual(await styles(past, ["textDecorationLine"]), ["none"]);

        const help = page.locator("#dataSourceHelpBtn");
        await help.press("Enter");
        const close = page.locator("#infoModalCloseBtn");
        await page.locator("#infoModalCloseBtn:focus").waitFor();
        if (forced) {
          for (const pseudo of ["::before", "::after"]) {
            assert.deepEqual(await styles(close, ["backgroundColor"], pseudo), [palette.ButtonText],
              "Help close glyph uses the forced palette");
          }
        }
        await page.keyboard.press("Tab");
        assert.equal(await close.evaluate(el => el.matches(":focus-visible")), true);
        await page.keyboard.press("Escape");
        await page.locator("#infoModal").waitFor({ state: "hidden" });
        assert.equal(await help.evaluate(el => el === document.activeElement), true, "Help restores its opener");

        const mapTab = page.getByRole("tab", { name: "Map layers" });
        if (compact) await mapTab.press("Enter");
        const floodStages = page.locator("#dynamicModeBtn");
        await floodStages.waitFor();
        await floodStages.press("Enter");
        await page.locator('#dynamicModeBtn[aria-pressed="true"]').waitFor();
        if (compact) {
          await page.keyboard.press("Escape");
          await page.locator("#legendDock").press("Enter");
        }
        const stageRamp = page.locator("#legendDock .stage-legend-gradient");
        await stageRamp.waitFor();
        const [stagePaint, stageOutline] = await styles(stageRamp, ["backgroundImage", "borderTopColor"]);
        assert.ok(isGradient(stagePaint), "map key retains the flood stages ramp");
        if (forced) assert.equal(stageOutline, palette.CanvasText);
        if (compact) {
          await page.keyboard.press("Escape");
          await controls.press("Enter");
        }
        const roads = page.locator("#roadsToggle");
        await roads.waitFor();
        assert.equal(await roads.getAttribute("aria-checked"), "true");
        const colors = ["backgroundColor", "borderTopColor"];
        if (forced) {
          assert.deepEqual(await styles(roads, colors), [palette.Highlight, palette.Highlight]);
          assert.deepEqual(await styles(roads, ["backgroundColor"], "::after"), [palette.HighlightText]);
        }
        await roads.press("Space");
        assert.equal(await roads.getAttribute("aria-checked"), "false");
        if (forced) {
          assert.deepEqual(await styles(roads, colors), [palette.ButtonFace, palette.ButtonText]);
          assert.deepEqual(await styles(roads, ["backgroundColor"], "::after"), [palette.ButtonText]);
          const [outlineStyle, outlineColor] = await styles(roads, ["outlineStyle", "outlineColor"]);
          assert.equal(outlineStyle, "solid");
          assert.equal(outlineColor, palette.Highlight);
        }
        assert.deepEqual(errors, []);
        console.log(`Passed forced-colors contract at ${name} (${mode.forcedColors}, ${mode.colorScheme}).`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
