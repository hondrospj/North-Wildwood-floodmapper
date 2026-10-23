    function makeExportBoundaryVector(style) {
      const boundaryStyle = {
        fill: false,
        fillOpacity: 0,
        stroke: true,
        ...style
      };

      if (municipalBoundaryFeature) {
        return L.geoJSON(municipalBoundaryFeature, {
          pane: "boundaryPane",
          interactive: false,
          style: () => boundaryStyle
        });
      }

      const fallbackRing = getPrimaryMunicipalBoundaryRing();
      return L.polygon(fallbackRing.length ? fallbackRing : ringFromLatLngBounds(getBoundaryDrivenOverlayBounds()), {
        pane: "boundaryPane",
        interactive: false,
        smoothFactor: 0,
        ...boundaryStyle
      });
    }

    function makeExportBoundaryMask() {
      return L.polygon(createBoundaryMaskGeometry(), {
        pane: "maskPane",
        interactive: false,
        smoothFactor: 0,
        stroke: false,
        fill: true,
        fillColor: "#d7d7d7",
        fillOpacity: 0.62,
        bubblingMouseEvents: false
      });
    }

    function ensureExportMap() {
      if (exportMap) return exportMap;

      exportMap = L.map("exportMap", {
        zoomControl: false,
        attributionControl: false,
        minZoom: 0,
        maxZoom: 24,
        zoomSnap: 0,
        zoomDelta: 1,
        preferCanvas: true,
        zoomAnimation: false,
        fadeAnimation: false,
        markerZoomAnimation: false
      });

      exportMap.createPane("basemapColorPane");
      exportMap.createPane("satellitePane");
      exportMap.createPane("boundaryPane");
      exportMap.createPane("floodPane");
      exportMap.createPane("parcelsPane");
      exportMap.createPane("buildingsPane");
      exportMap.createPane("roadsPane");
      exportMap.createPane("maskPane");
      exportMap.getPane("basemapColorPane").style.zIndex = 190;
      exportMap.getPane("satellitePane").style.zIndex = 200;
      exportMap.getPane("boundaryPane").style.zIndex = 640;
      exportMap.getPane("floodPane").style.zIndex = 500;
      exportMap.getPane("parcelsPane").style.zIndex = 610;
      exportMap.getPane("buildingsPane").style.zIndex = 620;
      exportMap.getPane("roadsPane").style.zIndex = 710;
      exportMap.getPane("maskPane").style.zIndex = 630;

      exportBasemapColorLayer = makeEsriBuildingBasemapLayer();
      if (exportBasemapColorLayer) {
        exportBasemapColorLayer.addTo(exportMap);
        const vectorBasemap = exportBasemapColorLayer;
        vectorBasemap.on("error load-error", () => useExportFallbackBasemap(vectorBasemap));
      } else {
        useExportFallbackBasemap();
      }

      exportSatelliteLayer = L.tileLayer(ESRI_WORLD_IMAGERY_URL, {
        attribution: "Tiles &copy; Esri",
        minZoom: 0,
        maxZoom: 24,
        maxNativeZoom: 19,
        crossOrigin: true,
        updateWhenIdle: true,
        keepBuffer: 1,
        pane: "satellitePane"
      });
      updateExportSatelliteLayer();

      exportRoadsLayer = createRoadLabelLayer(ROAD_LABELS_URL, {
        attribution: "Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
        minZoom: 0,
        maxZoom: 24,
        // A 512px tile from one source zoom lower covers the same geography
        // while making road names twice as large in both PNG and GIF exports.
        tileSize: 512,
        zoomOffset: -1,
        maxNativeZoom: 20,
        roadLabelFilter: "grayscale(1) contrast(1.15)",
        roadLabelHalo: 2,
        subdomains: "abcd",
        crossOrigin: true,
        opacity: 0,
        updateWhenIdle: true,
        keepBuffer: 1,
        className: "roads-layer",
        pane: "roadsPane"
      }).addTo(exportMap);

      updateExportBuildingsLayer();
      // Without a valid inner ring a world mask would gray out the entire town.
      // First-frame preparation waits for geometry before this map is captured.
      if (hasValidExportBoundaryGeometry()) updateExportBoundaryVisibility();
      fitExportMapToSelectedExtent(exportMap);
      return exportMap;
    }

    function updateExportSatelliteLayer() {
      if (!exportMap || !exportSatelliteLayer) return;
      const enabled = document.getElementById("satelliteToggle")?.classList.contains("on");
      if (enabled) {
        if (!exportMap.hasLayer(exportSatelliteLayer)) exportSatelliteLayer.addTo(exportMap);
      } else if (exportMap.hasLayer(exportSatelliteLayer)) {
        exportMap.removeLayer(exportSatelliteLayer);
      }
    }

    function updateExportBuildingsLayer() {
      if (!exportMap) return;
      const enabled = document.getElementById("buildingsToggle")?.classList.contains("on");
      if (enabled) {
        if (!exportBuildingsLayer) {
          exportBuildingsLayer = makeEsriBuildingForegroundLayer("buildingsPane");
        }
        if (exportBuildingsLayer && !exportMap.hasLayer(exportBuildingsLayer)) {
          exportBuildingsLayer.addTo(exportMap);
        }
      } else if (exportBuildingsLayer && exportMap.hasLayer(exportBuildingsLayer)) {
        exportMap.removeLayer(exportBuildingsLayer);
      }
    }

    async function updateExportParcelsLayer() {
      if (!exportMap) return;
      const enabled = document.getElementById("parcelsToggle")?.classList.contains("on");
      if (!enabled) {
        if (exportParcelsLayer && exportMap.hasLayer(exportParcelsLayer)) {
          exportMap.removeLayer(exportParcelsLayer);
        }
        return;
      }
      if (!exportParcelsLayer) {
        await preloadImage(PARCEL_BOUNDARY_PNG_URL);
        exportParcelsLayer = createHydraulicImageOverlay(
          PARCEL_BOUNDARY_PNG_URL,
          {
            pane: "parcelsPane",
            opacity: 0.78,
            interactive: false,
            crossOrigin: true,
            zIndex: 610
          }
        );
      }
      if (!exportMap.hasLayer(exportParcelsLayer)) exportParcelsLayer.addTo(exportMap);
    }

    function updateExportLegend(entry = null) {
      const source = document.getElementById("legendDock");
      const target = document.getElementById("exportLegendDock");
      if (!source || !target) return;
      const isDepthLegend = currentOverlayMode === "depth";
      const isPhysicsDepth = isDepthLegend && physicsForecastApplies();
      const isPhysicsDailyMaximum = isPhysicsDepth && Boolean(entry?.isDailyMaximum);
      target.dataset.exportLegendMode = isDepthLegend ? "depth" : "dynamic";
      target.innerHTML = isDepthLegend
        ? `
          <div class="export-depth-key">
            <div class="export-depth-key-heading">
              <strong>Flood Depth</strong>
            </div>
            <div class="export-depth-key-scale" aria-label="${isPhysicsDailyMaximum ? "Modeled daily maximum flood depth" : isPhysicsDepth ? "Modeled depth at this exact time" : "Uncertainty areas followed by connected modeled flood depth from shallow to deep"}">
              <div class="export-depth-key-gradient" aria-hidden="true"></div>
              <div class="export-depth-key-ends" aria-hidden="true">
                <span>${isPhysicsDailyMaximum ? "Daily Max" : isPhysicsDepth ? "Current Time" : "Uncertainty"}</span>${isPhysicsDepth ? "" : "<span>Shallow</span>"}<span>Deep</span>
              </div>
            </div>
            <div class="export-depth-key-note">${isPhysicsDailyMaximum ? "<strong>Physics daily max</strong> shows each cell's greatest modeled depth that day." : isPhysicsDepth ? "<strong>Physics frame</strong> shows cells wet by this time." : "<strong>Green</strong> means uncertainty."}</div>
          </div>
        `
        : `<div class="export-depth-key"><div class="export-depth-key-heading"><strong>Flood Stages</strong></div><div class="stage-legend-scale"><div class="stage-legend-uncertainty"><span>Uncertainty</span><div class="stage-legend-green"></div></div><div class="stage-legend-levels"><div class="stage-legend-labels"><span>Minor</span><span>Moderate</span><span>Major</span></div><div class="stage-legend-gradient"></div></div></div></div>`;

      target.querySelectorAll("button, .help-btn, #legendHelpBtn").forEach(el => el.remove());
      target.classList.remove("legend-collapsed", "legend-expanded", "legend-floating-user");
      target.style.background = "#1b2536";
      target.style.border = "1px solid rgba(191,219,254,.18)";
      target.style.boxShadow = "0 12px 24px rgba(0,0,0,.24)";
      target.style.backdropFilter = "none";
      target.style.webkitBackdropFilter = "none";
      target.style.overflow = "visible";

      const header = target.querySelector("#legendHeader, .legend-head, .legend-title-row");
      if (header) {
        header.style.cursor = "default";
      }

      target.querySelectorAll("[id]").forEach(el => {
        el.removeAttribute("id");
      });

      target.querySelectorAll(".legend-body, .legend-list, .legend-row, .legend-note").forEach(el => {
        el.style.background = "transparent";
        el.style.boxShadow = "none";
        el.style.filter = "none";
        el.style.backdropFilter = "none";
        el.style.webkitBackdropFilter = "none";
      });

      const sourceSwatches = Array.from(source.querySelectorAll(".legend-swatch"));
      const targetSwatches = Array.from(target.querySelectorAll(".legend-swatch"));
      targetSwatches.forEach((swatch, idx) => {
        const sourceSwatch = sourceSwatches[idx];
        if (!sourceSwatch) return;
        const styles = window.getComputedStyle(sourceSwatch);
        swatch.style.background = styles.backgroundImage && styles.backgroundImage !== "none" ? styles.backgroundImage : styles.backgroundColor;
        swatch.style.backgroundColor = styles.backgroundColor;
        swatch.style.borderColor = styles.borderColor;
        swatch.style.borderWidth = styles.borderWidth;
        swatch.style.borderStyle = styles.borderStyle;
        swatch.style.boxShadow = "none";
        swatch.style.filter = "none";
        swatch.style.opacity = styles.opacity;
      });

      target.querySelectorAll(".legend-row-boundary").forEach(row => row.remove());
    }

    function updateExportRoadLayerAppearance() {
      if (!exportMap || !exportRoadsLayer) return;
      const roadsEnabled = document.getElementById("roadsToggle")?.classList.contains("on");
      const zoom = exportMap.getZoom() || 0;
      const showLabels = roadsEnabled && zoom >= ROAD_LABEL_ZOOM;
      exportRoadsLayer.setOpacity(showLabels ? 0.98 : 0);
      const pane = exportMap.getPane("roadsPane");
      if (pane) pane.classList.toggle("roads-dark", showLabels);
    }

    function updateExportBoundaryVisibility() {
      if (!exportMap) return;
      if (!hasValidExportBoundaryGeometry()) {
        throw new Error("The town boundary is not ready for export.");
      }
      if (!exportBoundaryMask || !exportBoundaryOutline ||
          exportBoundaryGeometryRings !== municipalBoundaryRings ||
          exportBoundaryGeometryFeature !== municipalBoundaryFeature) {
        const nextMask = makeExportBoundaryMask();
        const nextOutline = makeExportBoundaryVector({
          color: getComputedStyle(document.documentElement).getPropertyValue("--boundary-color").trim() || "#000000",
          weight: 4.6, opacity: 1, lineCap: "round", lineJoin: "round"
        });
        [exportBoundaryMask, exportBoundaryOutline].filter(Boolean).forEach(layer => {
          if (exportMap.hasLayer(layer)) exportMap.removeLayer(layer);
        });
        exportBoundaryMask = nextMask;
        exportBoundaryOutline = nextOutline;
        exportBoundaryGeometryRings = municipalBoundaryRings;
        exportBoundaryGeometryFeature = municipalBoundaryFeature;
      }
      if (isTownBoundaryEnabled()) {
        if (!exportMap.hasLayer(exportBoundaryOutline)) exportBoundaryOutline.addTo(exportMap);
      } else if (exportMap.hasLayer(exportBoundaryOutline)) {
        exportMap.removeLayer(exportBoundaryOutline);
      }
      if (!exportMap.hasLayer(exportBoundaryMask)) exportBoundaryMask.addTo(exportMap);
    }

    async function setExportFloodLayer(mode, stageValue, phase = "slack", entry = null, series = currentRawSeriesHours) {
      ensureExportMap();
      const physicsRecord = mode === "depth" ? getPhysicsDisplayRecord(getPhysicsAssetForEntry(entry), mode) : null;
      let overlayUrl = "";
      if (physicsRecord?.url) {
        overlayUrl = physicsRecord.url;
        const bounds = getActivePhysicsManifest()?.boundsWgs84;
        if (!Array.isArray(bounds) || bounds.length !== 2) {
          throw new Error("Physics forecast bounds are unavailable.");
        }
        floodLatLngBounds = L.latLngBounds(bounds[0], bounds[1]);
        floodOverlayGeometryMode = "axis-aligned";
      } else {
        const match = await getHydraulicOverlayRecord(mode, stageValue, phase, entry, series);
        if (!match) {
          throw new Error(`Overlay missing for ${stageValue.toFixed(1)} ft. Check your folder path or file naming.`);
        }
        overlayUrl = match.url;
        await ensureOverlayBounds(overlayUrl);
      }
      if (!await preloadImage(overlayUrl)) {
        throwIfExportCancelled();
        throw new Error("The flood image could not load. Please try the export again.");
      }
      if (exportFloodLayer && exportMap.hasLayer(exportFloodLayer)) {
        exportMap.removeLayer(exportFloodLayer);
      }
      exportFloodLayer = physicsRecord?.url
        ? L.imageOverlay(overlayUrl, floodLatLngBounds, {
          opacity: overlayOpacity,
          interactive: false,
          crossOrigin: true,
          zIndex: 500,
          pane: "floodPane",
          className: currentDataMode === "return-interval" && mode === "depth"
            ? "return-interval-depth-overlay"
            : ""
        })
        : createHydraulicImageOverlay(overlayUrl, {
          opacity: overlayOpacity,
          interactive: false,
          crossOrigin: true,
          zIndex: 500,
          pane: "floodPane",
          className: currentDataMode === "return-interval" && mode === "depth"
            ? "return-interval-depth-overlay"
            : ""
        });
      await new Promise((resolve, reject) => {
        const layer = exportFloodLayer;
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(cancelTimer);
          layer.off("load", loaded);
          layer.off("error", failed);
          error ? reject(error) : resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error("The flood image could not load. Please try the export again."));
        const timer = setTimeout(failed, 20000);
        const cancelTimer = setInterval(() => {
          try { throwIfExportCancelled(); } catch (error) { finish(error); }
        }, 100);
        // Subscribe before adding: cached images may finish synchronously.
        layer.once("load", loaded);
        layer.once("error", failed);
        try {
          layer.addTo(exportMap);
          const img = layer.getElement();
          if (img?.complete) img.naturalWidth > 0 ? loaded() : failed();
        } catch (error) { finish(error); }
      });
    }

    function getExportFrameWaterLevelText(entry) {
      const rawStage = getStageValue(entry);
      const value = Number.isFinite(rawStage) ? formatStageForDisplay(rawStage) : "No data";
      return `${value} ${getDatumLabel()}`;
    }

    function stripExportTimeZoneLabel(value) {
      return String(value || "")
        .replace(/\s+(?:GMT(?:[+-]\d{1,2}(?::?\d{2})?)?|UTC|E[SD]T|ET)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function getExportFrameDateTimeText(entry) {
      if (entry?.isDailyPeakOnly) return `${formatSelectedObservedDate(entry.observedDate)} · Peak time unknown`;
      if (entry?.returnIntervalYears) {
        return getReturnIntervalStormLabel(entry.returnIntervalYears);
      }
      const date = getEntryESTDate(entry);
      const parts = date ? getNyParts(date) : null;
      if (!parts) {
        const fallback = formatHourEntryTime(entry);
        return fallback && fallback !== "--" ? stripExportTimeZoneLabel(fallback) : "Selected time";
      }
      const month = MONTH_NAMES[Number(parts.month) - 1] || parts.month;
      const time = `${parts.hour}:${parts.minute} ${parts.dayPeriod || ""}`
        .replace(/\s+/g, " ")
        .trim();
      return `${month} ${Number(parts.day)}, ${parts.year} · ${time}`;
    }

    function getExportFrameTimestampText(entry) {
      return `${decodeHtmlText(TOWN_CONFIG?.site?.name || TOWN_CONFIG?.brandTitleLine1 || "").trim()}\n${getExportFrameDateTimeText(entry)}\n${getExportFrameWaterLevelText(entry)}`;
    }

    function getExportTimestampRows(entry, layout) {
      const lines = String(getExportFrameTimestampText(entry) || "").split(/\n+/).filter(Boolean);
      let top = layout.timestamp.y;
      return lines.map((text, index) => {
        const size = Math.round((index === 0 ? 28 : index === 1 ? 20 : 24) * layout.unit);
        const height = Math.round(size * 1.15);
        const row = { text, x: layout.timestamp.x, y: top, width: layout.timestamp.width,
          size, height, weight: index === 0 ? 800 : index === 1 ? 550 : 750,
          color: index === 2 ? "#b8d8ff" : "#ffffff" };
        top += height + Math.round(5 * layout.unit);
        return row;
      });
    }

    function updateExportTimestampLabel(entry) {
      const label = document.getElementById("exportTimestampLabel");
      if (!label) return;
      const config = getExportAspectConfig();
      const layout = getExportFooterLayout(config.width, config.height);
      label.replaceChildren(...getExportTimestampRows(entry, layout).map(row => {
        const span = document.createElement("span");
        span.textContent = row.text;
        Object.assign(span.style, { top: `${row.y - layout.timestamp.y}px`, width: `${row.width}px`,
          height: `${row.height}px`, lineHeight: `${row.height}px`, fontSize: `${row.size}px`,
          fontWeight: String(row.weight), color: row.color });
        return span;
      }));
    }

    let exportFrameViewPrimed = false;
    async function prepareExportFrame(item, options = {}) {
      await ensureExportMunicipalBoundary();
      applyExportStageAspect(getDownloadAspectValue());
      const mapInstance = ensureExportMap();
      const isFirstFrame = !!options.isFirstFrame;
      mapInstance.invalidateSize(false);

      if (isFirstFrame || !exportFrameViewPrimed) {
        updateExportLegend(item.entry);
        updateExportBoundaryVisibility();
        await updateExportParcelsLayer();
        fitExportMapToSelectedExtent(mapInstance);
        exportFrameViewPrimed = true;
      }

      updateExportTimestampLabel(item.entry);
      updateExportRoadLayerAppearance();

      const rawStage = getStageValue(item.entry);
      const displayStage = getOverlayStage(rawStage);
      if (displayStage == null) {
        throw new Error("Stage is not numeric for the selected hour.");
      }

      const hydraulicPhase = getHydraulicPhaseForEntry(item.entry, item.index, item.series || currentSeriesHours);
      await setExportFloodLayer(currentOverlayMode, displayStage, hydraulicPhase, item.entry, item.series || currentRawSeriesHours);
      mapInstance.invalidateSize(false);
      await waitForExportMapReady(isFirstFrame ? 70 : 10);
      await waitForStableRender();
    }

    async function captureExportCanvas(options = {}) {
      if (typeof html2canvas !== "function") {
        throw new Error("html2canvas did not load, so map export is unavailable.");
      }
      const stage = document.getElementById("exportStageFrame");
      if (!stage) throw new Error("Export stage is unavailable.");
      await waitForExportChromeReady();
      const captureScale = Number.isFinite(options.scale) && options.scale > 0
        ? Math.min(options.scale, getExportCaptureScale())
        : getExportCaptureScale();
      return await html2canvas(stage, {
        backgroundColor: null,
        useCORS: true,
        allowTaint: false,
        logging: false,
        removeContainer: true,
        foreignObjectRendering: false,
        imageTimeout: 20000,
        ignoreElements: isOutsideExportStage,
        scale: captureScale
      });
    }

    async function captureExportLayerCanvas(options = {}) {
      if (typeof html2canvas !== "function") return null;
      const stage = document.getElementById("exportStageFrame");
      const mapEl = document.getElementById("exportMap");
      const timestamp = document.getElementById("exportTimestampLabel");
      const legend = document.getElementById("exportLegendDock");
      const logoStrip = document.getElementById("exportLogoStrip");
      if (!stage) return null;
      await waitForExportChromeReady();
      const footer = document.getElementById("exportFooter");
      const previousFooterVisibility = footer?.style.visibility || "";
      const previousMapVisibility = mapEl?.style.visibility || "";
      const previousTimestampVisibility = timestamp?.style.visibility || "";
      const previousLegendVisibility = legend?.style.visibility || "";
      const previousLogoVisibility = logoStrip?.style.visibility || "";
      const previousBackground = stage.style.background || "";
      const previousMapBackground = mapEl?.style.background || "";
      const hiddenPaneNames = Array.isArray(options.hiddenPaneNames) ? options.hiddenPaneNames : [];
      const hiddenPanes = hiddenPaneNames
        .map(name => exportMap?.getPane(name))
        .filter(Boolean)
        .map(pane => ({ pane, visibility: pane.style.visibility || "" }));
      try {
        hiddenPanes.forEach(({ pane }) => { pane.style.visibility = "hidden"; });
        if (options.hideFooter && footer) footer.style.visibility = "hidden";
        if (options.hideMap && mapEl) mapEl.style.visibility = "hidden";
        if (options.hideTimestamp !== false && timestamp) timestamp.style.visibility = "hidden";
        if (options.hideLegend && legend) legend.style.visibility = "hidden";
        if (options.hideLogo && logoStrip) logoStrip.style.visibility = "hidden";
        stage.style.background = "transparent";
        if (mapEl) mapEl.style.background = "transparent";
        const captureScale = getExportCaptureScale();
        return await html2canvas(stage, {
          backgroundColor: null,
          useCORS: true,
          allowTaint: false,
          logging: false,
          removeContainer: true,
          foreignObjectRendering: false,
          imageTimeout: 20000,
          ignoreElements: isOutsideExportStage,
          scale: captureScale
        });
      } finally {
        hiddenPanes.forEach(({ pane, visibility }) => { pane.style.visibility = visibility; });
        if (footer) footer.style.visibility = previousFooterVisibility;
        if (mapEl) mapEl.style.visibility = previousMapVisibility;
        if (timestamp) timestamp.style.visibility = previousTimestampVisibility;
        if (legend) legend.style.visibility = previousLegendVisibility;
        if (logoStrip) logoStrip.style.visibility = previousLogoVisibility;
        stage.style.background = previousBackground;
        if (mapEl) mapEl.style.background = previousMapBackground;
      }
    }

    async function captureExportMapForegroundCanvas() {
      return captureExportLayerCanvas({
        hiddenPaneNames: ["basemapColorPane", "satellitePane", "floodPane", "roadsPane"],
        hideTimestamp: true,
        hideLegend: true,
        hideLogo: true,
        hideFooter: true
      });
    }

    async function captureExportRoadLabelsCanvas() {
      return captureExportLayerCanvas({
        hiddenPaneNames: ["basemapColorPane", "satellitePane", "floodPane", "parcelsPane", "buildingsPane", "boundaryPane", "maskPane"],
        hideTimestamp: true,
        hideLegend: true,
        hideLogo: true,
        hideFooter: true
      });
    }

    async function captureExportChromeCanvas() {
      return captureExportLayerCanvas({
        hideMap: true,
        hideTimestamp: true
      });
    }

function findClosestExportEntryForSlot(entries, slotMs, usedKeys = new Set(), toleranceMs = 31 * 60 * 1000) {
      if (!Array.isArray(entries) || !entries.length || !Number.isFinite(slotMs)) return null;
      let best = null;
      let bestDiff = Infinity;
      entries.forEach((entry, idx) => {
        const t = entryTimeMs(entry);
        if (t == null) return;
        const diff = Math.abs(t - slotMs);
        const key = String(t);
        if (diff <= toleranceMs && diff < bestDiff && !usedKeys.has(key)) {
          best = { entry, idx, key, diff };
          bestDiff = diff;
        }
      });
      return best;
    }

