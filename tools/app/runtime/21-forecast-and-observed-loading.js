    async function loadForecast(preferredEntry = null, options = {}) {
      const forecastFailureToken = lastRenderToken;
      let forecastFailureGeneration = null;
      try {
      const floodSelectionToken = lastRenderToken;
      const generation = options.generation ?? ++selectionGeneration;
      forecastFailureGeneration = generation;
      if (!forecastData || options.forceRefresh) {
        const payload = await fetchJson(withFreshJsonUrl(FORECAST_URL));
        if (generation !== selectionGeneration) return;
        forecastData = payload;
      }
      if (!options.deferPhysicsCatalog && (!Object.keys(physicsForecastManifests).length || options.forceRefresh)) {
        await loadPhysicsForecast(Boolean(options.forceRefresh)).catch(error => {
          console.warn("Physics forecast is not published yet; using the phase-aware atlas.", error);
          physicsForecastManifests = {};
        });
      }
      if (generation !== selectionGeneration) return;
      if (floodSelectionToken !== lastRenderToken) return false;
      clearExportAvailabilityCache();
      const physicsSeries = getPhysicsForecastDisplaySeries();
      if (physicsSeries) {
        currentRawSeriesHours = annotateHydraulicSeries(
          getActivePhysicsManifest().frames.map(physicsFrameToForecastEntry)
        );
        currentSeriesHours = physicsSeries;
      } else {
        currentRawSeriesHours = buildForecastCanonicalSeries(getActiveForecastHours());
        currentSeriesHours = buildForecastDisplaySeries(currentRawSeriesHours);
      }
      currentViewType = "forecast";
      currentTopTideIndex = null;
      currentSelectedLabel = getForecastScenarioLabel();
      currentSelectedSubLabel = getForecastScenarioPercentileLabel();
      currentRangeLabel = currentSeriesHours.length
        ? `${formatHourEntryTime(currentSeriesHours[0])} to ${formatHourEntryTime(currentSeriesHours[currentSeriesHours.length - 1])}`
        : getForecastScenarioLabel();

      syncSliderBounds();
      if (!currentSeriesHours.length) {
        // Do not leave another scenario's flood image under this selection's label.
        currentHourIndex = 0;
        document.getElementById("hourSlider").value = "0";
        clearFloodLayer();
        renderSelectionMeta(null, null, null);
        document.getElementById("stageSubText").textContent = "No forecast available for this selection";
        renderTimelineMeta();
        toast(`${getForecastScenarioLabel()} forecast unavailable.`);
        return false;
      }
      const currentTimeEntry = options.selectCurrent ? { timeUtc: new Date().toISOString() } : null;
      currentHourIndex = preferredEntry
        ? findClosestEntryIndex(currentSeriesHours, preferredEntry)
        : currentTimeEntry
          ? findClosestEntryIndex(currentSeriesHours, currentTimeEntry)
          : getPeakHourIndex(currentSeriesHours);
      document.getElementById("hourSlider").value = String(currentHourIndex);
      } catch (error) {
        if (forecastFailureToken !== lastRenderToken) return false;
        if (forecastFailureGeneration !== null && forecastFailureGeneration !== selectionGeneration) return false;
        forecastData = null;
        currentRawSeriesHours = [];
        currentSeriesHours = [];
        currentHourIndex = 0;
        currentViewType = "forecast";
        currentTopTideIndex = null;
        currentSelectedLabel = getForecastScenarioLabel();
        currentSelectedSubLabel = getForecastScenarioPercentileLabel();
        currentRangeLabel = "";
        syncSliderBounds();
        document.getElementById("hourSlider").value = "0";
        clearFloodLayer();
        renderSelectionMeta(null, null, null);
        document.getElementById("stageSubText").textContent = "Forecast could not load";
        renderTimelineMeta();
        if (typeof reportFloodFrameFailure === "function") reportFloodFrameFailure();
        const message = "Forecast could not load. Try another selection or reload.";
        if (typeof setFloodFrameStatus === "function") setFloodFrameStatus(message, "error");
        toast(message);
        return false;
      }
    }


    function dateKeyToUtcMs(dateKey) {
      const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return NaN;
      return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    function addDaysToDateKey(dateKey, days) {
      const ms = dateKeyToUtcMs(dateKey);
      if (!Number.isFinite(ms)) return null;
      const d = new Date(ms + Number(days || 0) * 86400000);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }

    function compareDateKeys(a, b) {
      const ams = dateKeyToUtcMs(a);
      const bms = dateKeyToUtcMs(b);
      if (!Number.isFinite(ams) || !Number.isFinite(bms)) return String(a || "").localeCompare(String(b || ""));
      return ams - bms;
    }

    function getTodayNyDateKey() {
      const parts = getNyParts(new Date());
      if (!parts) return new Date().toISOString().slice(0, 10);
      return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function getObservedArchiveLatestDateKey() {
      const days = Array.isArray(observedData?.days) ? observedData.days : [];
      const dateKeys = days
        .map(day => String(day?.date || "").slice(0, 10))
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort(compareDateKeys);
      const archiveEnd = String(observedData?.archiveEndDate || observedData?.endDate || "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(archiveEnd)) dateKeys.push(archiveEnd);
      dateKeys.sort(compareDateKeys);
      return dateKeys.length ? dateKeys[dateKeys.length - 1] : null;
    }

    function makeObservedPlaceholderDay(dateKey) {
      return {
        date: dateKey,
        classification: "none",
        peakNAVD88: null,
        generatedPlaceholderDay: true,
        source: "frontend-calendar-fill",
        hours: []
      };
    }

    function addOrMergeObservedDayRecord(dayRecord) {
      if (!dayRecord || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayRecord.date || ""))) return;
      if (!observedData || typeof observedData !== "object") observedData = {};
      if (!Array.isArray(observedData.days)) observedData.days = [];

      const nextHours = Array.isArray(dayRecord.hours) ? dayRecord.hours : [];
      const existingIndex = observedData.days.findIndex(day => String(day?.date || "") === dayRecord.date);
      if (existingIndex < 0) {
        observedData.days.push(dayRecord);
        return;
      }

      const existing = observedData.days[existingIndex] || {};
      const existingHours = Array.isArray(existing.hours) ? existing.hours : [];
      const existingValid = existingHours.filter(hour => Number.isFinite(getStageValue(hour))).length;
      const nextValid = nextHours.filter(hour => Number.isFinite(getStageValue(hour))).length;

      if (existing.generatedPlaceholderDay || nextValid > existingValid) {
        observedData.days[existingIndex] = { ...existing, ...dayRecord };
      }
    }

    function getUsgsObservedParameterCd() {
      return TOWN_CONFIG?.observed?.usgsParameterCd || TOWN_CONFIG?.site?.usgsParameterCd || "";
    }

    function getUsgsObservedSiteId() {
      return TOWN_CONFIG?.observed?.usgsGaugeId || TOWN_CONFIG?.site?.usgsGaugeId || SITE_CONFIG?.usgsGaugeId || "";
    }

    function normalizeUsgsIvObservedDays(data) {
      const rows = [];
      const seriesList = Array.isArray(data?.value?.timeSeries) ? data.value.timeSeries : [];
      seriesList.forEach(series => {
        const noDataValue = normalizeStageValue(series?.variable?.noDataValue);
        const valueGroups = Array.isArray(series?.values) ? series.values : [];
        valueGroups.forEach(group => {
          const values = Array.isArray(group?.value) ? group.value : [];
          values.forEach(item => {
            const n = normalizeStageValue(item?.value);
            const dtRaw = item?.dateTime;
            const dt = dtRaw ? new Date(dtRaw) : null;
            if (!Number.isFinite(n) || n === noDataValue || !(dt instanceof Date) || Number.isNaN(dt.getTime())) return;
            const localIso = formatNyLocalIso(dt);
            const dateKey = localIso.slice(0, 10);
            const hourIndex = Number(localIso.slice(11, 13));
            const minuteIndex = Number(localIso.slice(14, 16));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Number.isInteger(hourIndex) || !Number.isInteger(minuteIndex)) return;
            rows.push({
              displayTimeEST: localIso,
              displayTimeUtc: dt.toISOString(),
              timeUtc: dt.toISOString(),
              observedDate: dateKey,
              hourIndex,
              minuteIndex,
              navd88StageFt: n,
              stageFt: n,
              value: n,
              observationInterval: "instantaneous",
              source: "usgs-iv-live",
              isLiveObservedBackfill: true,
              isMissingObservedHour: false
            });
          });
        });
      });

      const byDate = new Map();
      rows
        .sort((a, b) => String(a.displayTimeEST).localeCompare(String(b.displayTimeEST)))
        .forEach(row => {
          if (!byDate.has(row.observedDate)) byDate.set(row.observedDate, []);
          byDate.get(row.observedDate).push(row);
        });

      return Array.from(byDate.entries()).map(([date, hours]) => {
        const stages = hours.map(getStageValue).filter(Number.isFinite);
        const peak = stages.length ? Math.max(...stages) : null;
        return {
          date,
          classification: classifyFloodEntries(hours),
          peakNAVD88: peak,
          source: "usgs-iv-live",
          liveBackfilled: true,
          hours
        };
      });
    }

    async function fetchRecentUsgsObservedDays(startDate, endDate) {
      const site = getUsgsObservedSiteId();
      if (!site || !startDate || !endDate || compareDateKeys(startDate, endDate) > 0) return [];
      const url = new URL("https://waterservices.usgs.gov/nwis/iv/");
      const startInstant = parseStoredLocalNyToDate(startDate + "T00:00");
      const endOfDayInstant = parseStoredLocalNyToDate(endDate + "T23:59");
      const endInstant = endOfDayInstant && endOfDayInstant.getTime() < Date.now() ? endOfDayInstant : new Date();
      url.searchParams.set("format", "json");
      url.searchParams.set("sites", site);
      url.searchParams.set("parameterCd", getUsgsObservedParameterCd());
      const usgsIso = value => value.toISOString().replace(/\.\d{3}Z$/, "Z");
      url.searchParams.set("startDT", startInstant ? usgsIso(startInstant) : startDate);
      url.searchParams.set("endDT", usgsIso(endInstant));
      url.searchParams.set("siteStatus", "all");
      const data = await fetchJson(url.href);
      return normalizeUsgsIvObservedDays(data);
    }

    function ensureObservedDatePlaceholders(startDate, endDate) {
      if (!startDate || !endDate || compareDateKeys(startDate, endDate) > 0) return;
      const existing = new Set((Array.isArray(observedData?.days) ? observedData.days : []).map(day => String(day?.date || "")));
      let cursor = startDate;
      while (cursor && compareDateKeys(cursor, endDate) <= 0) {
        if (!existing.has(cursor)) {
          addOrMergeObservedDayRecord(makeObservedPlaceholderDay(cursor));
          existing.add(cursor);
        }
        cursor = addDaysToDateKey(cursor, 1);
      }
    }

    async function extendObservedArchiveThroughToday() {
      if (!observedData || typeof observedData !== "object") return;
      const today = getTodayNyDateKey();
      const latest = getObservedArchiveLatestDateKey();
      if (!today || (latest && compareDateKeys(latest, today) >= 0)) return;

      const startDate = addDaysToDateKey(latest, 1) || today;
      try {
        const liveDays = await fetchRecentUsgsObservedDays(startDate, today);
        liveDays.forEach(addOrMergeObservedDayRecord);
      } catch (err) {
        console.warn("Observed live USGS backfill failed; filling calendar placeholders through today.", err);
      }

      ensureObservedDatePlaceholders(startDate, today);

      observedData.archiveEndDate = today;
      observedData.endDate = today;
      observedDaysCache = null;
      clearExportAvailabilityCache();
    }

    async function loadObserved() {
      if (!observedData) {
        const compactArchive = await ensureObserved15MinuteArchive();
        observedData = buildObservedIndexFrom15MinuteArchive(compactArchive);
        observedDaysCache = null;
        clearExportAvailabilityCache();
      }


      await extendObservedArchiveThroughToday();

      if (!historicTopTideEntries.length) await loadHistoricalTopTides();
      mergeHistoricalCrestsIntoObservedIndex();
      rebuildObservedHourLookup();

      const days = getObservedDays();
      observedMonthKeys = buildObservedMonthKeysFromDays(days);
      observedFlatHours = [];
      topTideEvents = buildTopTideEvents();
      renderTopTides();

      if (!currentMonthKey) {
        currentMonthKey =
          observedData.archiveEndDate?.slice(0, 7) ||
          (days.length ? days[days.length - 1].date.slice(0, 7) : null) ||
          (observedMonthKeys.length ? observedMonthKeys[observedMonthKeys.length - 1] : null);
      }

      populateCalendarSelectors();
      scheduleLewesArchiveIndexWarmup();
    }


