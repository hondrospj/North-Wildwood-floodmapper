    function physicsPointerUrl() {
      const forecastCycle = Date.parse(forecastData?.petssCycleUtc || "");
      const cycleId = Number.isFinite(forecastCycle)
        ? new Date(forecastCycle).toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z")
        : "";
      const cyclePointerPath = PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE && cycleId
        ? PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE.replaceAll("{cycleId}", cycleId)
        : "";
      const pointerPath = cyclePointerPath || PHYSICS_FORECAST_POINTER_URL;
      if (!pointerPath) return "";
      const url = new URL(pointerPath, window.location.href);
      url.searchParams.set("_cycle_check", String(Math.floor(Date.now() / 300000)));
      return url.href;
    }

    function resolvePhysicsFileRecord(record, manifestUrl) {
      if (!record?.path || !manifestUrl) return null;
      return { ...record, url: new URL(record.path, manifestUrl).href };
    }

    function hydratePhysicsManifest(manifest, manifestUrl) {
      const hydrate = record => ({
        ...record,
        visible: resolvePhysicsFileRecord(record.visible, manifestUrl),
        impact: resolvePhysicsFileRecord(record.impact, manifestUrl),
        query: resolvePhysicsFileRecord(record.query, manifestUrl)
      });
      return {
        ...manifest,
        frames: (Array.isArray(manifest?.frames) ? manifest.frames : []).map(hydrate),
        dailyMaximums: (Array.isArray(manifest?.dailyMaximums) ? manifest.dailyMaximums : []).map(hydrate)
      };
    }

    function getActivePhysicsManifest() {
      return physicsForecastManifests[currentForecastScenario] || null;
    }

    async function loadPhysicsForecast(force = false) {
      if (!PHYSICS_FORECAST_POINTER_URL && !PHYSICS_FORECAST_CYCLE_POINTER_TEMPLATE) return null;
      if (Object.keys(physicsForecastManifests).length && !force) {
        return getActivePhysicsManifest();
      }
      const pointerUrl = physicsPointerUrl();
      const pointer = await fetchJson(pointerUrl);
      const manifestUrls = pointer?.manifestUrls && typeof pointer.manifestUrls === "object"
        ? pointer.manifestUrls
        : (pointer?.manifestUrl ? { [pointer.scenario || "mean"]: pointer.manifestUrl } : {});
      if (pointer?.status !== "complete" || !Object.keys(manifestUrls).length) {
        throw new Error("The physics forecast pointer is not complete.");
      }
      const hydrated = await Promise.all(Object.entries(manifestUrls).map(async ([scenario, rawUrl]) => {
        const manifestUrl = new URL(rawUrl, pointerUrl).href;
        const manifest = await fetchJson(manifestUrl);
        const recordsValid = records => Array.isArray(records) && records.length &&
          records.every(record => record?.visible?.path && record?.impact?.path && record?.query?.path);
        if (
          manifest?.status !== "complete" ||
          manifest?.schema !== "north-wildwood-physics-forecast-v1" ||
          !Array.isArray(manifest?.boundsWgs84) ||
          !recordsValid(manifest?.frames) ||
          !recordsValid(manifest?.dailyMaximums)
        ) {
          throw new Error(`The ${scenario} physics forecast manifest is invalid.`);
        }
        if (pointer.cycleId && manifest.cycleId !== pointer.cycleId) {
          throw new Error("The physics pointer and manifest cycle do not match.");
        }
        if ((manifest.scenario || "mean") !== scenario) {
          throw new Error(`The ${scenario} physics manifest has the wrong scenario label.`);
        }
        return [scenario, hydratePhysicsManifest(manifest, manifestUrl)];
      }));
      physicsForecastManifests = Object.fromEntries(hydrated);
      physicsQueryImageCache = new Map();
      return getActivePhysicsManifest() || hydrated[0]?.[1] || null;
    }

    function physicsManifestMatchesForecastCycle(manifest = getActivePhysicsManifest()) {
      if (!manifest || !forecastData) return false;
      const physicsCycle = Date.parse(manifest?.petssSource?.cycleUtc || "");
      const dashboardCycle = Date.parse(forecastData?.petssCycleUtc || "");
      return Number.isFinite(physicsCycle) &&
        Number.isFinite(dashboardCycle) &&
        physicsCycle === dashboardCycle;
    }

    function physicsForecastApplies() {
      return Boolean(
        currentDataMode === "forecast" &&
        physicsManifestMatchesForecastCycle()
      );
    }

    function physicsFrameToForecastEntry(frame) {
      const stage = Number(frame?.boundaryStageNavd88Ft);
      return {
        timeUtc: frame.timeUtc,
        displayTimeUtc: frame.timeUtc,
        navd88StageFt: stage,
        stageFt: stage,
        value: stage,
        timelineIntervalMinutes: 15,
        observationInterval: "15min",
        physicsFrame: frame,
        physicsCycleId: getActivePhysicsManifest()?.cycleId || "",
        isPhysicsForecast: true
      };
    }

    function getPhysicsForecastDisplaySeries() {
      const manifest = getActivePhysicsManifest();
      if (!physicsForecastApplies() || !manifest) return null;
      const allFrames = annotateHydraulicSeries(manifest.frames.map(physicsFrameToForecastEntry));
      const interval = getTimelineIntervalMinutes();
      if (interval === 15) return allFrames;
      if (interval === 60) {
        return allFrames
          .filter(entry => entry.physicsFrame?.isHourlySourcePoint)
          .map(entry => ({ ...entry, timelineIntervalMinutes: 60, observationInterval: "1hour" }));
      }
      const entriesByLocalDate = new Map();
      allFrames.forEach(entry => {
        const parts = getNyParts(getEntryESTDate(entry));
        if (!parts) return;
        const key = `${parts.year}-${parts.month}-${parts.day}`;
        if (!entriesByLocalDate.has(key)) entriesByLocalDate.set(key, []);
        entriesByLocalDate.get(key).push(entry);
      });
      return manifest.dailyMaximums.map(daily => {
        const entries = entriesByLocalDate.get(daily.dateLocal) || [];
        const peak = entries.reduce((best, entry) => (
          !best || getStageValue(entry) > getStageValue(best) ? entry : best
        ), entries[0] || allFrames[0]);
        return {
          ...peak,
          observedDate: daily.dateLocal,
          observationInterval: "daily",
          timelineIntervalMinutes: 1440,
          isDailyMaximum: true,
          dailyMaximumKind: "forecast",
          physicsDailyMaximum: daily
        };
      });
    }

    function getPhysicsAssetForEntry(entry) {
      if (!physicsForecastApplies()) return null;
      return entry?.physicsDailyMaximum || entry?.physicsFrame || null;
    }

    function getPhysicsDisplayRecord(asset, mode = currentOverlayMode) {
      return mode === "dynamic" ? asset?.impact : asset?.visible;
    }

    let playTimer = null;
    let playbackInFlight = false;
    let playbackObservedDaysAdvanced = 0;
    let playbackPausedForConfirmation = false;
    let overlayOpacity = DEFAULT_OPACITY;
    let lastRenderToken = 0;
    let selectionGeneration = 0;
    let archiveGeneration = 0;
    let floodFrameState = "unavailable";
    let currentSelectionQualityNote = "";
    let nwsAlertRefreshTimer = null;
    let nwsAlertPromise = null;
    let lastSuccessfulNwsAlerts = null;
    let imageExistsCache = new Map();
    let overlayRecordCache = new Map();
    let preloadPromiseCache = new Map();
    let exportInProgress = false;
    let exportCancelRequested = false;
    let activeGifExport = null;
    let gifWorkerUrlPromise = null;
    let exportPngSelections = new Map();
    let exportCalendarCursorDate = null;
    let exportCalendarSelectedDayKey = "";
    let exportRangePickMode = "start";
    let exportStartCalendarCursorDate = null;
    let exportEndCalendarCursorDate = null;
    let exportStartCalendarViewMode = "month";
    let exportEndCalendarViewMode = "month";
    let exportImageElementCache = new Map();
    let exportAvailabilityCache = null;
    let exportAvailabilityDayMapCache = null;
    let exportAvailabilityMonthMapCache = null;
    let exportAvailabilityBoundsCache = null;
    let exportAvailabilityHourTotalCache = null;
    let exportEntriesForDayCache = new Map();
    let observedExportDayIndexCache = null;
    let exportTimePickerRenderRaf = null;
    let exportTimePickerLastSignature = "";

