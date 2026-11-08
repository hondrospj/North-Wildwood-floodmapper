// A real browser verifies the shared pill theme without changing the slider's size.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const name = process.env.NWW_BROWSER || "chromium";
const engine = playwright[name === "edge" ? "chromium" : name];
const browser = await engine.launch({
  headless: true,
  ...(name === "edge" ? { channel: "msedge" } : {}),
  ...(name === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  ...(name === "chromium" && process.env.NWW_CHROMIUM_CHANNEL ? { channel: process.env.NWW_CHROMIUM_CHANNEL } : {}),
  ...(["chromium", "edge"].includes(name) ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {})
});
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8792/index.html";
const evidence = [];
const output = process.env.NWW_AUDIT_OUTPUT;
const profiles = [
  { name: "desktop", width: 1512, height: 945, touch: false },
  { name: "laptop", width: 1366, height: 768, touch: false },
  { name: "tablet portrait", width: 820, height: 1180, touch: true },
  { name: "tablet landscape", width: 1180, height: 820, touch: true },
  { name: "compact phone", width: 360, height: 780, touch: true }
];

try {
  for (const profile of profiles) {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      hasTouch: profile.touch,
      ...(name === "firefox" ? {} : { isMobile: profile.touch })
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => document.body.classList.contains("nw-app-ready")
      && document.querySelectorAll("#topTideList .top-tide-item").length === 10, {}, { timeout: 90000 });
    await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(() => {
      const show = selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
      const css = selector => getComputedStyle(document.querySelector(selector));
      const dock = document.getElementById("timelineDock");
      const keys = show("#timelineFloodKey .timeline-key-label");
      const keyRects = keys.map(el => el.getBoundingClientRect());
      const dockRect = dock.getBoundingClientRect();
      return {
        dockHeight: dockRect.height,
        box: { x: dockRect.x, y: dockRect.y, right: dockRect.right, bottom: dockRect.bottom },
        viewport: [innerWidth, innerHeight],
        wideEnough: keyRects.every(rect => rect.left >= dockRect.left && rect.right <= dockRect.right),
        overlap: keyRects.some((rect, i) => i > 0 && rect.left < keyRects[i-1].right),
        labels: keys.map(el => [el.textContent, getComputedStyle(el).fontSize, getComputedStyle(el).fontFamily]),
        swatch: css("#timelineFloodKey .timeline-key-swatch").width,
        dockTheme: [css("#timelineDock").backgroundColor, css("#timelineDock").borderTopColor],
        inter: [...document.fonts].some(font => font.family === "Inter" && font.status === "loaded"),
        labelsOrder: [...document.querySelectorAll(".layers-card .layer-name")].map(el => el.textContent),
        activeRailTides: show("#topTideList .top-tide-item").length,
        hasRootScroll: document.documentElement.scrollWidth > innerWidth + 1
      };
    });
    assert.deepEqual(state.dockTheme, ["rgb(17, 24, 38)", "rgba(191, 219, 254, 0.22)"]);
    assert.equal(state.dockHeight, profile.touch ? 180 : 112);
    assert.equal(state.swatch, profile.touch ? "10px" : "12px");
    assert.ok(state.inter && state.wideEnough && !state.overlap && !state.hasRootScroll, JSON.stringify(state));
    assert.ok(state.box.x >= 0 && state.box.y >= 0 && state.box.right <= state.viewport[0] && state.box.bottom <= state.viewport[1]);
    assert.deepEqual(state.labels.map(row => row[0]), ["No Flooding", "Minor", "Moderate", "Major"]);
    assert.ok(state.labels.every(row => row[1] === (profile.touch ? "11px" : "14px") && row[2].includes("Inter")));
    assert.deepEqual(state.labelsOrder.slice(-4), ["Structural Impacts", "Road Impacts", "Road Names", "Cameras"]);
    if (!profile.touch) {
      assert.equal(state.activeRailTides, 10);
      const dateFits = await page.locator("#topTideList .top-tide-main").evaluateAll(items =>
        items.every(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1));
      assert.ok(dateFits, "The ten flood dates fit without wrapping or covering their water levels");
    }
    if (profile.touch) {
      await page.locator("#mobileControlsToggle").click();
      if (profile.width >= 768) {
        await page.getByRole("tab", { name: "Flood data" }).click();
        await page.locator("#observedDataBtn").click();
        const tides = page.locator("#topTideListMobile .top-tide-item:visible");
        await tides.first().waitFor({ state: "visible", timeout: 15000 });
        assert.equal(await tides.count(), 10);
        const fit = await tides.evaluateAll(items => {
          const panel = document.getElementById("leftPanel");
          const bounds = panel.getBoundingClientRect();
          return { height: bounds.height, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
            max: Math.max(...items.map(item => item.getBoundingClientRect().bottom)),
            bottom: bounds.bottom };
        });
        assert.ok(fit.max <= fit.bottom + 1 && fit.scrollHeight <= fit.clientHeight + 2, JSON.stringify(fit));
      }
      await page.getByRole("tab", { name: "Tools" }).click();
    }
    await page.locator("#openDownloadModalBtn").click();
    const controls = await page.evaluate(() => {
      const card = document.querySelector(".download-modal-card");
      const close = document.getElementById("downloadModalCloseBtn");
      const closeStyle = getComputedStyle(close, "::before");
      const rect = card.getBoundingClientRect();
      const hit = close.getBoundingClientRect();
      return {
        visible: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
        closeWidth: closeStyle.width, closeStroke: closeStyle.height,
        reachable: close.contains(document.elementFromPoint(hit.x + hit.width/2, hit.y + hit.height/2)),
        theme: [getComputedStyle(card).backgroundColor, getComputedStyle(card).borderTopColor]
      };
    });
    assert.ok(controls.visible && controls.reachable, JSON.stringify(controls));
    assert.equal(controls.closeWidth, "14px");
    assert.equal(controls.closeStroke, "2px");
    assert.deepEqual(controls.theme, state.dockTheme);
    await page.locator("#downloadModalCloseBtn").click();
    evidence.push({ profile: profile.name, ...state, export: controls });
    await context.close();
  }
} finally {
  await browser.close();
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `overnight-pills-${name}.json`), JSON.stringify(evidence, null, 2));
  }
}
console.log(`Checked the shared pill theme, fixed dock size, labels, and export at ${evidence.length} ${name} viewports.`);
