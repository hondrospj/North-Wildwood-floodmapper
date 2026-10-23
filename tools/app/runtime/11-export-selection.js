    function setDownloadStatus(message = "", isError = false) {
      const el = document.getElementById("downloadStatus");
      if (el) {
        el.textContent = message;
        el.classList.toggle("error", Boolean(isError));
      }
      if (exportInProgress || isExportProgressOpen()) {
        setExportProgress(message, null, isError);
      }
    }

    function isExportProgressOpen() {
      return document.getElementById("exportProgressOverlay")?.classList.contains("open") || false;
    }

    function setExportProgressVisible(isVisible) {
      const overlay = document.getElementById("exportProgressOverlay");
      if (!overlay) return;
      overlay.hidden = !isVisible;
      overlay.classList.toggle("open", Boolean(isVisible));
      overlay.setAttribute("aria-busy", String(Boolean(isVisible)));
    }

    function setExportProgress(message = "", percent = null, isError = false) {
      const messageEl = document.getElementById("exportProgressMessage");
      const fillEl = document.getElementById("exportProgressFill");
      const pctEl = document.getElementById("exportProgressPercent");
      if (messageEl) {
        messageEl.textContent = message || (isError ? "Export failed." : "Working...");
        messageEl.classList.toggle("error", Boolean(isError));
      }
      if (Number.isFinite(percent)) {
        const pct = Math.max(0, Math.min(100, Math.round(percent)));
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct}%`;
      }
    }

    function finishExportProgress(message = "", isError = false) {
      setExportProgress(message, isError ? null : 100, isError);
      window.setTimeout(() => {
        if (!exportInProgress) setExportProgressVisible(false);
      }, isError ? 5200 : 1600);
    }

    function makeExportCancelledError() {
      const err = new Error("Export cancelled.");
      err.name = "AbortError";
      return err;
    }

    function isExportCancelledError(err) {
      const raw = String(err?.message || err || "");
      return err?.name === "AbortError" || /export (?:cancelled|canceled|aborted)|gif export was aborted/i.test(raw);
    }

    function throwIfExportCancelled() {
      if (exportCancelRequested) throw makeExportCancelledError();
    }

    function finishCancelledExportProgress(message = "Export cancelled.") {
      setExportProgress(message, null, false);
      window.setTimeout(() => {
        if (!exportInProgress) setExportProgressVisible(false);
      }, 900);
    }

    function cancelCurrentExport() {
      if (!exportInProgress) {
        setExportProgressVisible(false);
        return;
      }
      exportCancelRequested = true;
      const closeBtn = document.getElementById("exportProgressCloseBtn");
      if (closeBtn) closeBtn.disabled = true;
      setExportProgress("Cancelling export...", null, false);
      if (activeGifExport && typeof activeGifExport.abort === "function") {
        try { activeGifExport.abort(); } catch (_) {}
      }
    }

    function getExportBaseName(frameItems = []) {
      const mode = currentOverlayMode === "dynamic" ? "impact-thresholds" : "flood-depth";
      const firstItem = Array.isArray(frameItems) ? frameItems[0] : null;
      const view = firstItem?.mode === "observed"
        ? (firstItem.entry?.observedDate || "observed")
        : currentViewType === "forecast"
          ? "forecast"
          : currentViewType === "return-interval"
            ? `${currentReturnIntervalYears}-year-return-interval`
          : currentViewType === "observed-day"
            ? (selectedObservedDate || "observed")
            : "historic-crest";
      const aspect = getDownloadAspectValue().replace(":", "x");
      const interval = getDownloadIntervalValue();
      const townSlug = TOWN_CONFIG?.exportSlug || TOWN_CONFIG?.site?.slug || TOWN_CONFIG?.site?.name || "flood-map";
      return `${townSlug}-${view}-${mode}-${interval}-${aspect}`.replace(/[^a-z0-9\-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    }

    function getSafeFrameStamp(entry, sequence) {
      const raw = String(entry?.displayTimeEST || entry?.timeEST || entry?.timeEst || entry?.timeUtc || `frame-${sequence + 1}`);
      return raw.replace(/[:\s]/g, "-").replace(/[^a-z0-9\-_]+/gi, "").toLowerCase();
    }

    function isDownloadModalOpen() {
      return document.getElementById("downloadModal")?.classList.contains("open") || false;
    }

    function getObservedArchiveDateBounds() {
      const days = getObservedDays();
      if (!days.length) return null;

      const firstDay = days[0];
      const lastDay = days[days.length - 1];
      const firstHours = Array.isArray(firstDay?.hours) ? firstDay.hours : [];
      const lastHours = Array.isArray(lastDay?.hours) ? lastDay.hours : [];

      const firstDate = firstHours.length ? getEntryESTDate(firstHours[0]) : parseStoredLocalNyToDate(`${firstDay.date}T00:00`);
      const lastDate = lastHours.length ? getEntryESTDate(lastHours[lastHours.length - 1]) : parseStoredLocalNyToDate(`${lastDay.date}T23:00`);

      if (!firstDate || !lastDate) return null;
      return { firstDate, lastDate };
    }

    function getForecastExportEntries() {
      const activeForecastHours = getActiveForecastHours();
      const source = activeForecastHours.length
        ? activeForecastHours
        : currentDataMode === "forecast"
          ? currentSeriesHours
          : [];
      return source.map(entry => ({
        ...entry,
        exportSourceMode: "forecast"
      }));
    }

    function getReturnIntervalExportEntries() {
      const source = Array.isArray(currentRawSeriesHours) && currentRawSeriesHours.length
        ? currentRawSeriesHours
        : currentSeriesHours;
      return source.map(entry => ({
        ...entry,
        exportSourceMode: "return-interval"
      }));
    }

    function getCurrentExportSourceMode() {
      if (currentDataMode === "observed") return "observed";
      if (currentDataMode === "return-interval") return "return-interval";
      return "forecast";
    }

    function getObservedRangeExportEntries(startDate, endDate) {
      if (!startDate || !endDate) return [];

      const minMs = Math.min(startDate.getTime(), endDate.getTime()) - 2 * 60 * 60 * 1000;
      const maxMs = Math.max(startDate.getTime(), endDate.getTime()) + 2 * 60 * 60 * 1000;

      const startParts = getNyParts(new Date(minMs));
      const endParts = getNyParts(new Date(maxMs));
      if (!startParts || !endParts) return [];

      const startKey = `${startParts.year}-${startParts.month}-${startParts.day}`;
      const endKey = `${endParts.year}-${endParts.month}-${endParts.day}`;
      const candidates = [];

      getObservedDays().forEach(day => {
        const dateKey = String(day?.date || "");
        if (!dateKey || dateKey < startKey || dateKey > endKey) return;

        const hours = getObservedSourceHoursForDay(day);
        hours.forEach((hour, idx) => {
          const t = entryTimeMs(hour);
          if (t == null || t < minMs || t > maxMs) return;
          candidates.push({
            ...hour,
            observedDate: day.date,
            classification: day.classification || "none",
            peakNAVD88: day.peakNAVD88,
            sourceHourIndex: idx,
            exportSourceMode: "observed"
          });
        });
      });

      return candidates
        .filter(entry => Number.isFinite(getStageValue(entry)))
        .sort((a, b) => entryTimeMs(a) - entryTimeMs(b))
        .map(entry => ({
        ...entry,
        exportSourceMode: "observed"
      }));
    }

    function getDownloadSourceEntries(includeHistorical = false, startDate = null, endDate = null) {
      if (currentDataMode === "return-interval") {
        const modeled = getReturnIntervalExportEntries();
        if (!startDate || !endDate) return modeled;
        const minMs = Math.min(startDate.getTime(), endDate.getTime());
        const maxMs = Math.max(startDate.getTime(), endDate.getTime());
        return modeled.filter(entry => {
          const time = entryTimeMs(entry);
          return Number.isFinite(time) && time >= minMs && time <= maxMs;
        });
      }

      if (!includeHistorical) {
        const sourceMode = getCurrentExportSourceMode();
        return currentSeriesHours.map(entry => ({ ...entry, exportSourceMode: sourceMode }));
      }

      if (startDate && endDate) {
        const combined = [
          ...getObservedRangeExportEntries(startDate, endDate),
          ...getForecastExportEntries().filter(entry => {
            const t = entryTimeMs(entry);
            if (t == null) return false;
            const minMs = Math.min(startDate.getTime(), endDate.getTime()) - 2 * 60 * 60 * 1000;
            const maxMs = Math.max(startDate.getTime(), endDate.getTime()) + 2 * 60 * 60 * 1000;
            return t >= minMs && t <= maxMs;
          })
        ].filter(entry => entryTimeMs(entry) != null);

        if (!combined.length) return [];

        const byHour = new Map();
        combined.forEach(entry => {
          const d = getEntryESTDate(entry);
          const key = d ? formatNyLocalIso(d) : String(entryTimeMs(entry));
          const existing = byHour.get(key);
          if (!existing || entry.exportSourceMode === "forecast") {
            byHour.set(key, entry);
          }
        });

        return Array.from(byHour.values()).sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      }

      return currentSeriesHours.map(entry => ({
        ...entry,
        exportSourceMode: getCurrentExportSourceMode()
      }));
    }

    function getDownloadCurrentEntry() {
      const entry = currentSeriesHours[currentHourIndex] || null;
      if (!entry) return null;
      return {
        ...entry,
        exportSourceMode: getCurrentExportSourceMode()
      };
    }

    function getDownloadFrameItemFromEntry(entry, fallbackIndex = 0, sourceSeries = new Map()) {
      if (!entry) return null;
      const sourceMode = entry.exportSourceMode || currentDataMode;
      const dateStr = entry.observedDate || selectedObservedDate || "";
      const key = sourceMode === "observed" ? `observed:${dateStr}` : sourceMode;
      if (!sourceSeries.has(key)) {
        let series;
        if (sourceMode === "observed") {
          series = buildObservedCanonicalSeries(getObservedDayRecord(dateStr), dateStr);
        } else if (sourceMode === "return-interval") {
          series = annotateHydraulicSeries(currentRawSeriesHours);
        } else if (physicsForecastApplies()) {
          series = annotateHydraulicSeries(getActivePhysicsManifest().frames.map(physicsFrameToForecastEntry));
        } else {
          series = buildForecastCanonicalSeries(getActiveForecastHours());
        }
        sourceSeries.set(key, series);
      }
      let series = sourceSeries.get(key);
      let index = findClosestEntryIndex(series, entry);
      let canonical = series[index];
      if (!canonical || entryTimeMs(canonical) !== entryTimeMs(entry) ||
          Math.abs(getStageValue(canonical) - getStageValue(entry)) > 0.0001) {
        // Keep an off-grid measured peak at its actual time and water level.
        series = annotateHydraulicSeries([
          ...series.filter(row => entryTimeMs(row) !== entryTimeMs(entry)), entry
        ].sort((a, b) => entryTimeMs(a) - entryTimeMs(b)));
        index = findClosestEntryIndex(series, entry);
        canonical = series[index];
      }
      const resolvedEntry = { ...entry };
      for (const field of ["hydraulicPhase", "hydraulicPhaseCanonical", "hydraulicCrestIndex",
        "hydraulicCrestTimeUtc", "hydraulicCrestStageFt", "hydraulicElapsedMinutes"]) {
        resolvedEntry[field] = canonical?.[field];
      }
      // Export cadence and the visible timeline must never replace tide history.
      return {
        mode: sourceMode,
        ...(sourceMode === "observed" ? { dateStr } : {}),
        index,
        entry: resolvedEntry,
        series
      };
    }

