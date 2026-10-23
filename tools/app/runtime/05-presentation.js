    function setInfoModalOpen(isOpen, title = "Information", body = "") {
      const modal = document.getElementById("infoModal");
      const titleEl = document.getElementById("infoModalTitle");
      const bodyEl = document.getElementById("infoModalBody");
      if (!modal || !titleEl || !bodyEl) return;
      if (isOpen) {
        titleEl.textContent = title;
        bodyEl.innerHTML = body;
      }
      modal.hidden = !isOpen;
      modal.classList.toggle("open", !!isOpen);
      modal.setAttribute("aria-hidden", isOpen ? "false" : "true");
      if (isOpen) document.getElementById("infoModalCloseBtn")?.focus();
    }

    function showInfoModal(key) {
      const copy = HELP_COPY[key];
      if (!copy) return;
      setInfoModalOpen(true, copy.title, copy.body);
    }

    function showLegendInfoModal() {
      showInfoModal(currentOverlayMode === "dynamic" ? "stageLegend" : "depthLegend");
    }

    function setDownloadModalOpen(isOpen) {
      const modal = document.getElementById("downloadModal");
      const btn = document.getElementById("openDownloadModalBtn");
      if (!modal || !btn) return;

      modal.hidden = !isOpen;
      modal.classList.toggle("open", isOpen);
      btn.setAttribute("aria-expanded", String(isOpen));

      if (isOpen) {
        updateDownloadModeCopy();
        updateExportSegmentedUI();
        applyExportStageAspect(getDownloadAspectValue());
        syncDownloadRangeInputs(true);
        updateDownloadSummary();
        requestAnimationFrame(() => {
          const modalCard = modal.querySelector(".download-modal-card");
          if (modalCard) modalCard.scrollTop = 0;
          const compactTouchLayout = isCompactFloodmapperLayout();
          const focusTarget = compactTouchLayout
            ? document.getElementById("downloadModalCloseBtn")
            : currentDataMode === "return-interval"
              ? document.getElementById("downloadStartTimeSelect")
              : document.getElementById("downloadStartDateText");
          try {
            focusTarget?.focus({ preventScroll: true });
          } catch (_) {
            focusTarget?.focus();
          }
        });
      }
    }

    function updateDownloadModeCopy() {
      const launchMeta = document.getElementById("downloadLaunchMeta");
      const modalSub = document.getElementById("downloadModalSub");
      const modeled = currentDataMode === "return-interval";
      const modeledHours = Number(returnIntervalData?.windowHours || 24);
      if (launchMeta) {
        launchMeta.textContent = modeled
          ? `Create a shareable animation of the full ${modeledHours}-hour modeled storm.`
          : `Create an animation or high-resolution image sequence with North Wildwood centered.`;
      }
      if (modalSub) {
        modalSub.textContent = modeled
          ? `Choose a time range within this ${modeledHours}-hour storm. Map view preserves the area you are viewing.`
          : `Choose timing, layout, and framing for up to ${EXPORT_RANGE_MAX_HOURS} hours. Map view preserves the area you are viewing.`;
      }
    }

    function refreshCurrentDisplayText() {
      updateDatumUI();
      renderTopTides();
      if (currentDataMode === "observed" && observedData) {
        renderCalendar();
        updateDayNav();
      }
      const entry = currentSeriesHours[currentHourIndex];
      if (entry) {
        const rawStage = getStageValue(entry);
        const displayStage = getOverlayStage(rawStage);
        renderSelectionMeta(entry, rawStage, displayStage);
        renderTimelineMeta(entry);
        requestAnimationFrame(fitSnapshotTimeText);
      }
    }

    function updateModeButtons() {
      document.getElementById("depthModeBtn").classList.toggle("active", currentOverlayMode === "depth");
      document.getElementById("dynamicModeBtn").classList.toggle("active", currentOverlayMode === "dynamic");
      document.getElementById("overlayModePill").textContent =
        currentOverlayMode === "depth" ? "Flood Depth" : "Flood Stages";
      renderLegend();
    }

    function updateDataModeButtons() {
      document.getElementById("forecastDataBtn").classList.toggle("active", currentDataMode === "forecast");
      document.getElementById("observedDataBtn").classList.toggle("active", currentDataMode === "observed");
      document.getElementById("returnIntervalDataBtn")?.classList.toggle("active", currentDataMode === "return-interval");
      document.getElementById("dataModePill").textContent = currentDataMode === "forecast"
        ? getForecastScenarioLabel()
        : currentDataMode === "return-interval"
          ? getReturnIntervalLabel()
          : "Observed";
      const scenarioCard = document.getElementById("forecastScenarioCard");
      if (scenarioCard) scenarioCard.hidden = currentDataMode !== "forecast";
      const returnCard = document.getElementById("returnIntervalCard");
      if (returnCard) returnCard.style.display = currentDataMode === "return-interval" ? "" : "none";
      document.getElementById("calendarCard").classList.toggle("active", currentDataMode === "observed");
      if (currentDataMode !== "observed") setObservedCalendarOpen(false);
      const panel = document.getElementById("leftPanel");
      if (panel && panel.dataset.dataMode !== currentDataMode) {
        panel.dataset.dataMode = currentDataMode;
        panel.scrollTop = 0;
      }
      document.body.classList.toggle("observed-mode", currentDataMode === "observed");
      document.body.classList.toggle("return-interval-mode", currentDataMode === "return-interval");
      updateForecastScenarioButtons();
      updateReturnIntervalButtons();
      updateObservedResolutionUI();
      updateDownloadModeCopy();
      syncLeftPanelLayout();
    }

    function renderLegend() {
      const list = document.getElementById("legendList");
      const physicsActive = physicsForecastApplies();
      const depthLegendHasNote = currentOverlayMode === "depth" && physicsActive;
      const physicsDailyMaximumActive = depthLegendHasNote &&
        document.body.classList.contains("physics-daily-maximum-active");
      const legendKey = `${currentOverlayMode}:${physicsActive}:${physicsDailyMaximumActive}`;
      // Reuse unchanged markup without suppressing model or interval changes.
      if (list.dataset.renderedLegendKey === legendKey && list.childElementCount) return;
      list.dataset.renderedLegendKey = legendKey;
      const title = document.getElementById("legendTitle");
      const sub = document.getElementById("legendSub");
      const note = document.getElementById("legendNote");
      const legendDock = document.getElementById("legendDock");

      title.textContent = currentOverlayMode === "depth" ? "Flood Depth" : "Flood Stages";
      sub.textContent = "";
      if (legendDock) {
        legendDock.dataset.legendMode = currentOverlayMode;
        legendDock.dataset.previewText = currentOverlayMode === "depth"
          ? "Flood Depth Key"
          : "Flood Stages Key";
        // Desktop legend sizing is content-driven in north-wildwood-controls.css.
      }

      list.innerHTML = "";
      if (currentOverlayMode === "depth") {
        const physicsActive = depthLegendHasNote;
        list.innerHTML = physicsActive ? `
          <div class="depth-legend-scale" aria-label="${physicsDailyMaximumActive ? "Modeled daily maximum flood depth" : "Modeled flood depth at the selected time"} from shallow to deep">
            <div class="depth-legend-labels"><span>${physicsDailyMaximumActive ? "Daily Max" : "Current Time"}</span><span>Shallow</span><span>Deep</span></div>
            <div class="depth-legend-gradient" aria-hidden="true"></div>
          </div>
          <div class="depth-legend-uncertainty-note">
            <span>${physicsDailyMaximumActive
              ? "<strong>Physics daily max</strong> shows each cell's greatest modeled depth that day"
              : "<strong>Physics frame</strong> shows cells wet by this time"}</span>
          </div>
        ` : `
          <div class="depth-legend-scale" aria-label="Uncertainty areas followed by connected modeled flood depth from shallow to deep">
            <div class="depth-legend-labels"><span>Uncertain</span><span>Shallow</span><span>Deep</span></div>
            <div class="depth-legend-gradient" aria-hidden="true"></div>
          </div>
        `;
        list.querySelector("[data-legend-help='uncertainty']")?.addEventListener("click", event => {
          event.stopPropagation();
          showInfoModal("depthLegend");
        });
        note.textContent = "";
        return;
      }
      list.innerHTML = `
        <div class="stage-legend-scale" aria-label="${physicsActive ? "" : "Flood Depth uncertainty areas, separate from "}flood stages from minor through moderate to major">
          ${physicsActive ? "" : `<div class="stage-legend-uncertainty"><span>Uncertain</span><div class="stage-legend-green" aria-hidden="true"></div></div>`}
          <div class="stage-legend-levels">
            <div class="stage-legend-labels"><span>Minor</span><span>Moderate</span><span>Major</span></div>
            <div class="stage-legend-gradient" aria-hidden="true"></div>
          </div>
        </div>
      `;
      note.textContent = "";
    }

