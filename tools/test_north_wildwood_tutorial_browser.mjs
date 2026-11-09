import assert from "node:assert/strict";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.NWW_BROWSER || "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.NWW_TEST_URL || "http://127.0.0.1:8765/index.html";
const desktop = { width: 1100, height: 760 };
const portrait = { width: 390, height: 844 };
const landscape = { width: 568, height: 320 };
const titles = [
  "Welcome to the Floodmapper", "Start with the forecast", "Switch to observations",
  "Choose a historic flood", "Move through time", "Control map layers",
  "Jump to the largest floods", "Export and share"
];

async function ready(page) {
  page.setDefaultTimeout(15000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => document.body.classList.contains("nw-app-ready") &&
    document.getElementById("nwSiteLoader").hidden, null, { timeout: 90000 });
  await page.evaluate(() => document.fonts.ready);
}

async function expectReachableFocus(page, id) {
  await page.waitForFunction(id => {
    const element = document.getElementById(id);
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return document.activeElement === element && element.contains(hit);
  }, id);
}

try {
  for (const touch of [false, true]) {
    const page = await browser.newPage({
      viewport: touch ? landscape : desktop,
      hasTouch: touch, isMobile: touch, reducedMotion: "reduce"
    });
    try {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await ready(page);
      const openTour = async () => {
        if (touch) {
          const controls = page.locator("#mobileControlsToggle");
          if (await controls.getAttribute("aria-expanded") !== "true") await controls.tap();
          const tools = page.getByRole("tab", { name: "Tools" });
          if (await tools.getAttribute("aria-selected") !== "true") await tools.tap();
        }
        await activate("#mapperTutorialBtn");
        await expectStep(0);
      };
      const activate = selector => touch ? page.locator(selector).tap() : page.locator(selector).press("Enter");
      const expectStep = async index => {
        await page.waitForFunction(({ progress, title }) => document.getElementById("mapperTutorialProgress").textContent === progress &&
          document.getElementById("mapperTutorialTitle").textContent === title,
        { progress: `${index + 1} of ${titles.length}`, title: titles[index] });
      };
      const card = page.locator("#mapperTutorialCard");
      const next = page.locator("#mapperTutorialNext");
      await openTour();
      assert.equal(await card.getAttribute("aria-describedby"), "mapperTutorialBody");
      assert.deepEqual(await next.evaluate(el => {
        const style = getComputedStyle(el);
        return [style.color, style.backgroundColor];
      }), ["rgb(255, 255, 255)", "rgb(37, 99, 235)"], "tour primary text has sufficient contrast");

      await activate("#mapperTutorialNext");
      await expectStep(1);
      const announcement = card.getByRole("status");
      assert.equal(await announcement.getAttribute("aria-atomic"), "true");
      assert.equal(await announcement.textContent(), "2 of 8. Start with the forecast");
      if (touch) {
        await page.locator("#mapperTutorialBack").focus();
        await page.keyboard.press("Enter");
      } else {
        await activate("#mapperTutorialBack");
      }
      await expectStep(0);
      await expectReachableFocus(page, "mapperTutorialNext");
      if (!touch) {
        await page.keyboard.press("ArrowRight");
        await expectStep(1);
        await page.keyboard.press("ArrowLeft");
        await expectStep(0);
      }

      for (let index = 0; index < titles.length; index++) {
        await expectStep(index);
        if (index === 2) {
          const label = await page.locator("#observedDataBtn").textContent();
          assert.ok((await page.locator("#mapperTutorialBody strong").allTextContents()).includes(label),
            "tour uses the current Past control label");
        }
        if (index === 5 && !touch) {
          for (const viewport of [portrait, landscape]) {
            await page.setViewportSize(viewport);
            await page.waitForFunction(() => {
              const drawer = document.getElementById("leftPanel");
              const target = drawer.querySelector(".layers-card")?.getBoundingClientRect();
              const spot = document.getElementById("mapperTutorialSpotlight").getBoundingClientRect();
              return drawer.dataset.nwwSection === "map" && document.body.classList.contains("mobile-controls-open") &&
                target?.width > 0 && target.top < innerHeight && target.bottom > 0 &&
                spot.width >= target.width && spot.left <= target.left && spot.bottom <= innerHeight;
            });
            await expectReachableFocus(page, "mapperTutorialNext");
          }
          await page.setViewportSize(desktop);
          await page.waitForFunction(() => document.body.dataset.unifiedLayout === "desktop" &&
            !document.body.classList.contains("mobile-controls-open"));
        }
        await activate("#mapperTutorialNext");
      }
      await card.waitFor({ state: "hidden" });
      await expectReachableFocus(page, "mapperTutorialBtn");

      await openTour();
      await activate("#mapperTutorialNext");
      await expectStep(1);
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "hidden" });
      await expectReachableFocus(page, "mapperTutorialBtn");
      if (touch) assert.equal(await page.getByRole("tab", { name: "Tools" }).getAttribute("aria-selected"), "true");

      await openTour();
      if (!touch) await page.setViewportSize(portrait);
      await page.waitForFunction(() => document.body.dataset.unifiedLayout === "mobile");
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "hidden" });
      await expectReachableFocus(page, touch ? "mapperTutorialBtn" : "mobileControlsToggle");
      assert.deepEqual(errors, []);
      console.log(`${engine} ${touch ? "touch" : "keyboard"} tour completed, reversed, reopened, and restored focus.`);
    } finally {
      await page.close();
    }
  }

  const cameraPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await ready(cameraPage);
    await cameraPage.locator("#webcamsToggle").press("Space");
    await cameraPage.locator('[data-webcam-marker="north-beach"]').press("Enter");
    const camera = cameraPage.locator("#webcamPanel");
    await camera.waitFor();
    // Camera opening transfers focus on the next frame. Wait for that handoff
    // before starting the keyboard action on the tour button.
    await expectReachableFocus(cameraPage, "webcamClose");
    await cameraPage.locator("#mapperTutorialBtn").press("Enter");
    await cameraPage.locator("#mapperTutorialCard").waitFor();
    await cameraPage.keyboard.press("Escape");
    await cameraPage.locator("#mapperTutorialCard").waitFor({ state: "hidden" });
    assert.equal(await camera.isVisible(), true, "tour Escape leaves the underlying camera open");
    assert.equal(await camera.getAttribute("data-player-state"), "external");
    await expectReachableFocus(cameraPage, "mapperTutorialBtn");
    await cameraPage.keyboard.press("Escape");
    await camera.waitFor({ state: "hidden" });
    console.log(`${engine} tour and camera each handled their own Escape.`);
  } finally {
    await cameraPage.close();
  }
} finally {
  await browser.close();
}
