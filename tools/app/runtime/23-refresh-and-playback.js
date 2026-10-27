    async function warmBackgroundData() {
      if (backgroundDataPromise) return backgroundDataPromise;
      const generation = archiveGeneration;
      const request = (async () => {
        const [observedCompact, canonical] = await Promise.all([
          ensureObserved15MinuteArchive().catch(() => null),
          ensureCanonicalDailyArchive().catch(() => null)
        ]);
        if (generation !== archiveGeneration) return null;
        observed15MinuteData = observedCompact;
        observedData = canonical ? buildObservedIndexFromCanonical(canonical) : (observedCompact ? buildObservedIndexFrom15MinuteArchive(observedCompact) : null);
        if (observedCompact) mergeObservedArchiveIndex(observedCompact, "stone-harbor");
        observedDaysCache = null;
        observedMonthKeys = [];
        observedFlatHours = [];
        observedHourIndexByDateHour = new Map();
        topTideEvents = [];
        if (observedData) {
          await loadObserved();
        } else {
          topTideEvents = buildTopTideEvents();
          renderTopTides();
        }
        return observedData;
      })().then(result => {
        // Both optional source failures are converted to null above. Do not
        // retain that resolved-null request as a permanent successful warmup.
        if (!result && backgroundDataPromise === request) backgroundDataPromise = null;
        return result;
      }).catch(error => {
        if (backgroundDataPromise === request) backgroundDataPromise = null;
        console.warn("Background flood history loading will retry when requested.", error);
        return null;
      });
      backgroundDataPromise = request;
      return request;
    }

    function scheduleTopTidesListWarmup() {
      const start = async () => {
        try {
          await Promise.all([
            loadHistoricalTopTides(),
            ensureObserved15MinuteArchive().catch(() => null)
          ]);
          topTideEvents = buildTopTideEvents();
          renderTopTides();
        } catch (error) {
          console.warn("Historical high-tide summary will retry when requested.", error);
        }
      };
      start();
    }

    function scheduleBackgroundDataWarmup() {
      // Download the small calendar index while the forecast is visible, but
      // leave JSON parsing and archive construction on demand. Past can then
      // reuse the same in-flight response without delaying map interaction.
      document.body.dataset.backgroundDataWarmup = "index-download-only";
      preloadObservedArchiveIndexText().catch(() => null);
    }

    function waitForInitialFramePaint() {
      return new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        window.setTimeout(finish, 160);
        window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
      });
    }

    function scheduleForecastCatalogWarmup() {
      const start = async () => {
        if (document.body.dataset.initialFloodFrame !== "ready") return;
        document.body.dataset.forecastCatalog = "loading";
        try {
          await loadPhysicsForecast(false);
          document.body.dataset.forecastCatalog = "ready";
        } catch (error) {
          document.body.dataset.forecastCatalog = "unavailable";
          console.warn("Forecast catalog will load when it is next requested.", error);
        }
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(start, { timeout: 1200 });
      } else {
        window.setTimeout(start, 220);
      }
    }

    async function reloadAll() {
      const generation = ++selectionGeneration;
      checkNwsAlerts().catch(error => console.warn("Flood alert refresh failed.", error));
      ++archiveGeneration;
      ++lastRenderToken;
      stopPlayback();
      const floodSelectionToken = cancelPendingFloodFrame();
      cancelPendingFloodFrame(false);
      toast("");
      imageExistsCache = new Map();
      overlayRecordCache = new Map();
      preloadPromiseCache = new Map();
      exportImageElementCache = new Map();
      houseAlertCdfData = null;
      houseAlertCdfPromise = null;
      physicsForecastManifests = {};
      physicsQueryImageCache = new Map();
      bathtubStageOverlayCache.forEach(record => {
        retireRasterObjectUrl(record?.url);
      });
      bathtubStageOverlayCache = new Map();
      forecastData = null;
      returnIntervalData = null;
      observed15MinuteData = null;
      observedArchiveIndexTextPromise = null;
      observed15MinuteDaysByDate = new Map();
      lewesHourlyDaysByDate = new Map();
      observedArchiveUnavailableYears = new Set();
      canonicalDailyData = null;
      lewesHourlyData = null;
      lewesArchiveIndexData = null;
      lewesArchiveIndexPromise = null;
      lewesArchiveIndexWarmupScheduled = false;
      observedArchiveYearPromises = new Map();
      observedArchiveLoadedYears = new Set();
      observedData = null;
      historicTopTideEntries = [];
      historicalTopTidesPromise = null;
      backgroundDataPromise = null;
      historicalTopTideWarmupScheduled = false;
      historicalTopTideWarmupGeneration += 1;
      observedDaysCache = null;
      clearExportAvailabilityCache();
      observedMonthKeys = [];
      observedFlatHours = [];
      observedHourIndexByDateHour = new Map();
      topTideEvents = [];
      currentDataMode = "forecast";
      currentViewType = "forecast";
      updateDataModeButtons();
      renderTopTides();
      await loadForecast(null, { selectCurrent: true, forceRefresh: true, deferPhysicsCatalog: true, generation });
      if (floodSelectionToken !== lastRenderToken) return false;
      if (generation !== selectionGeneration) return;
      try {
        await renderHour(currentHourIndex);
      } finally {
        if (document.body.dataset.initialFloodFrame === "loading") markInitialFloodFrameFailed();
        await waitForInitialFramePaint();
        activateDeferredMapLayers();
      }
      scheduleForecastCatalogWarmup();
      scheduleTopTidesListWarmup();
      scheduleBackgroundDataWarmup();
    }

    function updatePlayPauseButton() {
      const playBtn = document.getElementById("playBtn");
      if (!playBtn) return;
      const isPlaying = Boolean(playTimer);


      playBtn.innerHTML = isPlaying
        ? '<span class="playIcon pauseIcon" aria-hidden="true"></span>'
        : '<span class="playIcon playTriangle" aria-hidden="true"></span>';
      playBtn.classList.toggle("is-playing", isPlaying);
      playBtn.setAttribute("aria-label", isPlaying ? "Pause animation" : "Play animation");
      playBtn.removeAttribute("title");
    }

    function setPlaybackStillThereOpen(isOpen) {
      const modal = document.getElementById("playbackStillThereModal");
      if (!modal) return;
      modal.hidden = !isOpen;
      modal.classList.toggle("open", !!isOpen);
      modal.setAttribute("aria-hidden", isOpen ? "false" : "true");
      if (isOpen) document.getElementById("playbackStillThereContinueBtn")?.focus();
    }

    let playbackGeneration = 0;
    function clearPlaybackTimer() {
      ++playbackGeneration;
      if (playTimer) {
        clearTimeout(playTimer);
        clearInterval(playTimer);
        playTimer = null;
      }
      playbackInFlight = false;
      updatePlayPauseButton();
    }

    function stopPlayback(options = {}) {
      clearPlaybackTimer();
      if (options.resetDayGuard !== false) playbackObservedDaysAdvanced = 0;
      playbackPausedForConfirmation = false;
      if (options.closePrompt !== false) setPlaybackStillThereOpen(false);
    }

    function pausePlaybackForDayConfirmation() {
      clearPlaybackTimer();
      playbackPausedForConfirmation = true;
      setPlaybackStillThereOpen(true);
    }

    function continuePlaybackAfterDayConfirmation() {
      setPlaybackStillThereOpen(false);
      playbackPausedForConfirmation = false;
      playbackObservedDaysAdvanced = 0;
      startPlayback();
    }

    function togglePlayback(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (playTimer) {
        stopPlayback();
      } else {
        playbackObservedDaysAdvanced = 0;
        playbackPausedForConfirmation = false;
        startPlayback();
      }
    }

    async function stepSeriesBy(delta) {
      if (!currentSeriesHours.length) return;

      const navigationIndex = getTimelineNavigationIndex();
      const nextIndex = navigationIndex + delta;
      if (nextIndex >= 0 && nextIndex < currentSeriesHours.length) {
        await renderHour(nextIndex);
        return;
      }

      if (currentViewType === "observed-day" && selectedObservedDate) {
        const dailyMaximum = getTimelineIntervalMinutes() === 1440;
        const displayedDate = dailyMaximum
          ? currentSeriesHours[navigationIndex]?.observedDate || selectedObservedDate
          : selectedObservedDate;
        const neighborDate = getNeighborObservedDate(displayedDate, delta > 0 ? 1 : -1);
        if (neighborDate) {
          const wasPlaying = Boolean(playTimer);
          await loadObservedDay(neighborDate, !dailyMaximum && delta > 0 ? 0 : null, null, { preservePlayback: wasPlaying });
          if (!dailyMaximum && delta < 0 && currentSeriesHours.length) {
            await renderHour(currentSeriesHours.length - 1);
          }
          if (delta > 0 && wasPlaying) {
            playbackObservedDaysAdvanced += 1;
            if (playbackObservedDaysAdvanced >= PLAYBACK_DAY_CONFIRMATION_INTERVAL) {
              pausePlaybackForDayConfirmation();
            }
          }
          return;
        }
      }

      if (delta > 0) {
        await renderHour(0);
      } else {
        await renderHour(Math.max(0, currentSeriesHours.length - 1));
      }
    }

    async function stepPlaybackForward() {
      await stepSeriesBy(1);
    }

    function getPlaybackFrameDurationMs() {
      const intervalMinutes = getTimelineIntervalMinutes();
      if (intervalMinutes === 1440) return PLAYBACK_SIMULATED_HOUR_MS;
      return PLAYBACK_SIMULATED_HOUR_MS * (intervalMinutes / 60);
    }

function startPlayback() {
      stopPlayback({ resetDayGuard: false, closePrompt: true });
      if (!currentSeriesHours.length) {
        toast("No timeline frames are available to play for this selection.");
        updatePlayPauseButton();
        return;
      }

      playTimer = setTimeout(() => {}, 0);
      updatePlayPauseButton();
      const generation = playbackGeneration;

      const loop = async () => {
        if (!playTimer || generation !== playbackGeneration) return;
        const frameStartedAt = performance.now();
        try {
          await stepPlaybackForward();
        } catch (err) {
          if (generation !== playbackGeneration) return;
          toast(err?.message || String(err));
          stopPlayback();
          return;
        }
        if (!playTimer || generation !== playbackGeneration) return;
        const renderDurationMs = performance.now() - frameStartedAt;
        const nextFrameDelayMs = Math.max(
          PLAYBACK_MINIMUM_FRAME_DELAY_MS,
          getPlaybackFrameDurationMs() - renderDurationMs
        );
        playTimer = setTimeout(loop, nextFrameDelayMs);
        updatePlayPauseButton();
      };

      loop();
    }

    async function goToCalendarSelection() {
      const year = document.getElementById("yearSelect").value;
      const month = pad2(document.getElementById("monthSelect").value);
      const key = `${year}-${month}`;
      if (!observedMonthKeys.includes(key)) {
        toast("No archive dates are available for that month.");
        return;
      }
      currentMonthKey = key;
      setCalendarPopoverOpen(false);
      await renderCalendar();
    }

