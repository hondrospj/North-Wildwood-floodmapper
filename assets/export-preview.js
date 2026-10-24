/* Preview the same first frame and geographic framing used by PNG and GIF exports. */
(function () {
  "use strict";
  if (window.FLOODMAPPER_EXPORT_PREVIEW) return;

  let generation = 0;
  let timer = null;
  let pending = false;
  let activeJob = null;
  let exportRequested = false;
  let settingsReviewed = false;

  const node = id => document.getElementById(id);
  const available = () => isDownloadModalOpen() && !exportRequested && !exportInProgress;
  const fresh = token => token === generation && available();
  const release = canvas => { if (canvas) canvas.width = canvas.height = 1; };

  function renderReviewStep() {
    const modal = node("downloadModal");
    if (modal) modal.dataset.exportStep = settingsReviewed ? "review" : "area";
    const basic = node("exportBasicFields");
    const review = node("exportReviewFields");
    const back = node("exportReviewBackBtn");
    const reset = node("downloadResetBtn");
    if (basic) basic.hidden = settingsReviewed;
    if (review) review.hidden = !settingsReviewed;
    if (back) back.hidden = !settingsReviewed;
    if (reset) reset.hidden = !settingsReviewed;
    const title = node("downloadModalTitle");
    if (title) title.textContent = settingsReviewed ? `Export ${getDownloadFormatValue().toUpperCase()}` : "Export";
    if (!exportInProgress && !exportRequested) {
      const label = node("downloadBtnLabel");
      if (label) label.textContent = settingsReviewed ? "Download" : "More options";
    }
    const area = node("exportPreviewAreaLabel");
    if (area) area.textContent = getDownloadExtentValue() === "custom" ? "Selected area"
      : getDownloadExtentValue() === "town" ? "Whole town" : "Current view";
    const areaStatus = node("exportAreaStatus");
    if (areaStatus) areaStatus.hidden = true;
    const custom = node("exportExtentCustomBtn");
    if (custom) custom.textContent = getDownloadExtentValue() === "custom" ? "Edit area" : "Choose area";
  }

  function reviewSettings() {
    settingsReviewed = true;
    updateExportSegmentedUI();
    node("exportReviewFields")?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }

  function clearCanvas() {
    const mount = node("exportPreviewCanvas");
    if (!mount) return;
    Array.from(mount.children).forEach(release);
    mount.replaceChildren();
  }

  function showState(state, message) {
    const preview = node("exportPreview");
    if (!preview) return;
    preview.dataset.state = state;
    preview.setAttribute("aria-busy", String(state === "loading"));
    node("exportPreviewStatus").textContent = message;
    node("exportPreviewRetryBtn").hidden = state !== "error";
    node("exportPreviewFrameLabel").textContent = getDownloadFormatValue() === "gif" ? "First frame" : "";
  }

  function invalidate() {
    generation++;
    pending = false;
    clearTimeout(timer);
    timer = null;
  }

  function schedulePreview() {
    if (!available()) return;
    generation++;
    pending = true;
    clearTimeout(timer);
    showState("loading", "Updating preview…");
    timer = setTimeout(() => {
      timer = null;
      startPreview();
    }, 250);
  }

  async function renderPreview(token) {
    if (getDownloadScopeValue() === "current" && floodFrameState !== "ready") {
      if (fresh(token)) showState("empty", "Wait for the map to finish loading.");
      return;
    }
    const validation = validateDownloadRangeForExport();
    if (!validation.ok) {
      if (fresh(token)) showState("empty", validation.message);
      return;
    }
    if (currentDataMode !== "return-interval" && getDownloadScopeValue() !== "current" && validation.range) {
      await ensureObservedArchiveRange(validation.range.startDate, validation.range.endDate);
      if (!fresh(token)) return;
    }
    const item = getDownloadFrameItems()[0];
    if (!item) {
      if (fresh(token)) showState("empty", "No frames are available for this time range.");
      return;
    }
    await ensureExportLibraries("png", 1);
    if (!fresh(token)) return;
    // A fresh first frame reapplies the chosen bounds, legend, layers and logos.
    await prepareExportFrame(item, { isFirstFrame: true });
    if (!fresh(token)) return;
    const config = getExportAspectConfig();
    const scale = Math.min(1, 800 / config.width, 600 / config.height);
    const canvas = await captureExportCanvas({ scale });
    if (!fresh(token)) { release(canvas); return; }
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Preview of the selected North Wildwood export area");
    clearCanvas();
    node("exportPreviewCanvas").appendChild(canvas);
    showState("ready", `${config.width} × ${config.height}`);
  }

  function startPreview() {
    if (activeJob || !pending || !available()) return;
    pending = false;
    const token = generation;
    activeJob = renderPreview(token).catch(error => {
      if (!fresh(token)) return;
      clearCanvas();
      showState("error", "Preview couldn’t load. Try again, or download your map.");
      console.warn("Export preview could not be rendered.", error);
    }).finally(() => {
      activeJob = null;
      if (pending && timer === null && available()) startPreview();
    });
  }

  const originalSummary = updateDownloadSummary;
  updateDownloadSummary = function (...args) {
    const result = originalSummary(...args);
    renderReviewStep();
    schedulePreview();
    return result;
  };

  const originalOpen = setDownloadModalOpen;
  setDownloadModalOpen = function (open, ...args) {
    invalidate();
    settingsReviewed = false;
    const result = originalOpen(open, ...args);
    renderReviewStep();
    if (open) schedulePreview();
    else clearCanvas();
    return result;
  };

  const originalDownload = downloadCurrentSelection;
  downloadCurrentSelection = async function (...args) {
    if (exportRequested || exportInProgress) return;
    // The first action always reveals the important settings, never downloads.
    if (!settingsReviewed) {
      reviewSettings();
      return;
    }
    // Both jobs use the same offscreen renderer. Never capture while downloading.
    exportRequested = true;
    invalidate();
    const button = node("downloadBtn");
    if (button) button.disabled = true;
    const label = node("downloadBtnLabel");
    if (label) label.textContent = "Preparing export…";
    const preview = activeJob;
    try {
      if (preview) await preview;
      return await originalDownload(...args);
    } finally {
      exportRequested = false;
      if (!exportInProgress) {
        if (button) button.disabled = false;
        updateExportSegmentedUI();
      }
      if (isDownloadModalOpen()) schedulePreview();
    }
  };

  const originalSegmentedUI = updateExportSegmentedUI;
  updateExportSegmentedUI = function (...args) {
    const result = originalSegmentedUI(...args);
    renderReviewStep();
    return result;
  };

  function init() {
    const modal = node("downloadModal");
    const grid = modal?.querySelector(".download-grid");
    if (!grid || node("exportPreview")) return;
    const style = document.createElement("style");
    style.id = "floodmapper-export-preview-style";
    style.textContent = `
      #downloadModal .export-preview-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
      #downloadModal #exportPreview{grid-row:1;margin:0;min-width:0;padding:12px;border:1px solid #40516b;border-radius:14px;background:#101c2d;color:#eaf0ff}
      #downloadModal .export-preview-heading{display:flex;justify-content:flex-end;margin-bottom:8px;min-height:16px}
      #downloadModal #exportPreviewFrameLabel{font-size:12px;font-weight:500;color:#bac8df}
      #downloadModal .export-preview-image{position:relative;display:grid;place-items:center;height:220px;border-radius:8px;overflow:hidden;background:#080f1a}
      #downloadModal #exportPreviewCanvas{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
      #downloadModal #exportPreviewCanvas canvas{display:block;width:100%!important;height:100%!important;min-width:0;object-fit:contain}
      #downloadModal #exportPreview:not([data-state="ready"]) canvas{visibility:hidden}
      #downloadModal #exportPreview[data-state="loading"] .export-preview-image::after{content:"";position:absolute;width:28px;height:28px;border:3px solid #40516b;border-top-color:#60a5fa;border-radius:50%;animation:export-preview-spin 1s linear infinite}
      #downloadModal .export-preview-caption{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;min-height:20px;font-size:12px;line-height:1.4;color:#bac8df}
      #downloadModal #exportPreview[data-state="ready"] .export-preview-caption{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      #downloadModal #exportPreviewRetryBtn{border:1px solid #60a5fa;border-radius:8px;background:transparent;color:#b8d8ff;padding:8px 12px;font:inherit;cursor:pointer;min-height:40px}
      #downloadModal #exportPreviewRetryBtn[hidden]{display:none!important}
      #downloadModal #exportPreviewRetryBtn:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
      #downloadModal .export-preview-layout>.download-grid{display:flex!important;flex-direction:column!important;gap:16px!important;min-width:0;align-self:stretch!important}
      #downloadModal .export-step-fields{display:flex;flex-direction:column;gap:16px;min-width:0}
      #downloadModal .export-preview-layout [hidden][hidden]{display:none!important}
      #downloadModal .export-step-fields>.download-field{display:flex!important;flex-direction:column!important;gap:8px!important;margin:0!important;min-width:0}
      #downloadModal #exportTimePicker{padding:0!important;background:none!important;border:0!important;box-shadow:none!important}
      #downloadModal #downloadRangeFields{display:flex!important;flex-direction:column!important;gap:14px!important}
      #downloadModal #exportDataRangeText,#downloadModal .export-extent-help,#downloadModal #downloadModalSub{display:none!important}
      #downloadModal .export-preview-area{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;padding-top:12px;border-top:1px solid #40516b;font-size:14px;color:#bac8df}
      #downloadModal #exportChangeAreaBtn{padding:8px 0;min-height:40px;border:0;background:none;color:#7bb5ff;font:inherit;font-weight:700;cursor:pointer}
      #downloadModal #exportChangeAreaBtn:focus-visible{outline:3px solid #93c5fd;outline-offset:3px;border-radius:4px}
      #downloadModal .download-actions{margin-top:auto!important;display:flex!important;flex-direction:column!important;align-items:stretch!important;width:100%!important;gap:10px!important;padding-top:8px!important}
      #downloadModal #exportReviewBackBtn{min-height:40px;border:0;border-radius:8px;padding:9px 12px;background:transparent;color:#c6d5ea;font:inherit;font-size:13px;cursor:pointer}
      #downloadModal #downloadBtn{width:100%!important;min-height:50px!important;color:white!important;background:#3b82f6!important;border:1px solid #76adff!important}
      #downloadModal #downloadBtn:disabled{opacity:.65!important}
      #downloadModal .download-modal-head{margin-bottom:14px!important;align-items:start!important}
      #downloadModal #downloadAspectControl{grid-template-columns:repeat(2,minmax(0,1fr))!important}
      #downloadModal #downloadAspectControl button:last-child{grid-column:1/-1}
      @keyframes export-preview-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){#downloadModal #exportPreview .export-preview-image::after{animation:none}}
      @media(min-width:1000px){
        #downloadModal .download-modal-card{width:min(1120px,calc(100vw - 32px))!important}
        #downloadModal .export-preview-layout{grid-template-columns:minmax(0,1.55fr) minmax(320px,1fr);gap:20px}
        #downloadModal #exportPreview{grid-column:1;grid-row:1;position:sticky;top:0}
        #downloadModal .export-preview-layout>.download-grid{grid-column:2;grid-row:1;min-height:min(590px,65dvh)}
        #downloadModal .export-preview-image{height:min(520px,57dvh)}
      }
    `;
    document.head.appendChild(style);
    const layout = document.createElement("div");
    layout.className = "export-preview-layout";
    grid.before(layout);
    const preview = document.createElement("figure");
    preview.id = "exportPreview";
    preview.dataset.state = "loading";
    preview.setAttribute("aria-label", "Export preview");
    preview.innerHTML = `<div class="export-preview-heading"><span id="exportPreviewFrameLabel">First frame</span></div><div class="export-preview-image"><div id="exportPreviewCanvas"></div></div><figcaption class="export-preview-caption"><span id="exportPreviewStatus" role="status" aria-live="polite">Preparing preview…</span><button id="exportPreviewRetryBtn" type="button" hidden>Retry</button></figcaption><div class="export-preview-area"><span id="exportPreviewAreaLabel">Current view</span><button id="exportChangeAreaBtn" type="button">Change area</button></div>`;
    layout.append(preview, grid);
    const basic = document.createElement("section");
    basic.id = "exportBasicFields";
    basic.className = "export-step-fields";
    basic.setAttribute("aria-label", "Export area and time");
    const review = document.createElement("section");
    review.id = "exportReviewFields";
    review.className = "export-step-fields";
    review.setAttribute("aria-label", "Required export settings");
    review.hidden = true;
    [".export-filetype-field", "#exportTimePicker"].forEach(selector => {
      const field = grid.querySelector(selector);
      if (field) basic.appendChild(field);
    });
    [".export-layout-field", ".export-interval-field", "#gifSpeedField", ".export-framing-field"].forEach(selector => {
      const field = grid.querySelector(selector);
      if (field) review.appendChild(field);
    });
    grid.prepend(basic, review);
    const actions = grid.querySelector(".download-actions");
    const back = document.createElement("button");
    back.id = "exportReviewBackBtn";
    back.type = "button";
    back.textContent = "Back";
    back.hidden = true;
    actions?.prepend(back);
    back.addEventListener("click", () => {
      settingsReviewed = false;
      updateExportSegmentedUI();
      node("exportFormatGifBtn")?.focus({ preventScroll: true });
    });
    node("exportChangeAreaBtn").addEventListener("click", () => node("exportExtentCustomBtn")?.click());
    node("downloadResetBtn")?.addEventListener("click", () => {
      settingsReviewed = false;
      updateExportSegmentedUI();
    });
    const compactLabels = {
      exportFormatGifBtn: "GIF", exportFormatPngBtn: "PNG", exportExtentTownBtn: "Whole town",
      exportAspectSocialBtn: "4:5", exportAspectLandscapeBtn: "16:9", exportAspectPortraitBtn: "9:16",
      exportAspectSquareBtn: "1:1", exportIntervalQuarterBtn: "15 min"
    };
    Object.entries(compactLabels).forEach(([id, text]) => {
      const element = node(id);
      if (!element) return;
      element.setAttribute("aria-label", id === "exportExtentTownBtn" ? "Whole town (North Wildwood)" : element.textContent.trim());
      element.textContent = text;
    });
    [[".export-filetype-field", ""], [".export-interval-field", "Interval"],
      ["#gifSpeedField", "Speed"], [".export-framing-field", "Area"]].forEach(([selector, text]) => {
      const field = grid.querySelector(selector);
      const label = Array.from(field?.childNodes || []).find(child => child.nodeType === 3 && child.textContent.trim());
      if (label) label.textContent = text;
    });
    const startLabel = node("downloadStartDateText")?.closest(".export-simple-datetime-field")?.querySelector("span");
    const endLabel = node("downloadEndDateText")?.closest(".export-simple-datetime-field")?.querySelector("span");
    if (startLabel) startLabel.textContent = "Start";
    if (endLabel) endLabel.textContent = "End";
    node("exportPreviewRetryBtn").addEventListener("click", schedulePreview);
    renderReviewStep();
    window.FLOODMAPPER_EXPORT_PREVIEW.ready = true;
    if (isDownloadModalOpen()) schedulePreview();
  }

  window.FLOODMAPPER_EXPORT_PREVIEW = { version: "20261023-3", ready: false };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
