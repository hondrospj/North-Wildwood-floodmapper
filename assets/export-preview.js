/* Preview the same first frame and geographic framing used by PNG and GIF exports. */
(function () {
  "use strict";
  if (window.FLOODMAPPER_EXPORT_PREVIEW) return;

  let generation = 0;
  let timer = null;
  let pending = false;
  let activeJob = null;
  let exportRequested = false;

  const node = id => document.getElementById(id);
  const available = () => isDownloadModalOpen() && !exportRequested && !exportInProgress;
  const fresh = token => token === generation && available();
  const release = canvas => { if (canvas) canvas.width = canvas.height = 1; };

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
    node("exportPreviewFrameLabel").textContent = getDownloadFormatValue() === "gif" ? "First frame" : "PNG preview";
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
    schedulePreview();
    return result;
  };

  const originalOpen = setDownloadModalOpen;
  setDownloadModalOpen = function (open, ...args) {
    invalidate();
    const result = originalOpen(open, ...args);
    if (open) schedulePreview();
    else clearCanvas();
    return result;
  };

  const originalDownload = downloadCurrentSelection;
  downloadCurrentSelection = async function (...args) {
    if (exportRequested || exportInProgress) return;
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

  function init() {
    const modal = node("downloadModal");
    const grid = modal?.querySelector(".download-grid");
    if (!grid || node("exportPreview")) return;
    const style = document.createElement("style");
    style.id = "floodmapper-export-preview-style";
    style.textContent = `
      #downloadModal .export-preview-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
      #downloadModal #exportPreview{grid-row:1;margin:0;min-width:0;padding:12px;border:1px solid #40516b;border-radius:14px;background:#101c2d;color:#eaf0ff}
      #downloadModal .export-preview-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px;font-size:15px;font-weight:700}
      #downloadModal #exportPreviewFrameLabel{font-size:12px;font-weight:500;color:#bac8df}
      #downloadModal .export-preview-image{position:relative;display:grid;place-items:center;height:220px;border-radius:8px;overflow:hidden;background:#080f1a}
      #downloadModal #exportPreviewCanvas{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
      #downloadModal #exportPreviewCanvas canvas{display:block;width:100%!important;height:100%!important;min-width:0;object-fit:contain}
      #downloadModal #exportPreview:not([data-state="ready"]) canvas{visibility:hidden}
      #downloadModal #exportPreview[data-state="loading"] .export-preview-image::after{content:"";position:absolute;width:28px;height:28px;border:3px solid #40516b;border-top-color:#60a5fa;border-radius:50%;animation:export-preview-spin 1s linear infinite}
      #downloadModal .export-preview-caption{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;min-height:20px;font-size:12px;line-height:1.4;color:#bac8df}
      #downloadModal #exportPreviewRetryBtn{border:1px solid #60a5fa;border-radius:8px;background:transparent;color:#b8d8ff;padding:8px 12px;font:inherit;cursor:pointer;min-height:40px}
      #downloadModal #exportPreviewRetryBtn[hidden]{display:none!important}
      #downloadModal #exportPreviewRetryBtn:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
      @keyframes export-preview-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){#downloadModal #exportPreview .export-preview-image::after{animation:none}}
      @media(min-width:1000px){
        #downloadModal .download-modal-card{width:min(1120px,calc(100vw - 32px))!important}
        #downloadModal .export-preview-layout{grid-template-columns:minmax(0,1.55fr) minmax(280px,1fr);gap:20px}
        #downloadModal #exportPreview{grid-column:2;grid-row:1;position:sticky;top:0}
        #downloadModal .export-preview-layout>.download-grid{grid-column:1;grid-row:1}
        #downloadModal .export-preview-image{height:min(510px,56dvh)}
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
    preview.innerHTML = `<div class="export-preview-heading"><span>Preview</span><span id="exportPreviewFrameLabel">First frame</span></div><div class="export-preview-image"><div id="exportPreviewCanvas"></div></div><figcaption class="export-preview-caption"><span id="exportPreviewStatus" role="status" aria-live="polite">Preparing preview…</span><button id="exportPreviewRetryBtn" type="button" hidden>Retry</button></figcaption>`;
    layout.append(preview, grid);
    node("exportPreviewRetryBtn").addEventListener("click", schedulePreview);
    window.FLOODMAPPER_EXPORT_PREVIEW.ready = true;
    if (isDownloadModalOpen()) schedulePreview();
  }

  window.FLOODMAPPER_EXPORT_PREVIEW = { version: "20261023-1", ready: false };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
