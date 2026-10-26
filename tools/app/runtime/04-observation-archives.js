    function buildObservedIndexFromCanonical(payload) {
      const rows = Array.isArray(payload?.days) ? payload.days : [];
      const days = rows.map(row => {
        const date = String(row?.[0] || "");
        const peak = normalizeStageValue(row?.[1]);
        const pipelineSource = String(row?.[2] || "");
        const peakNAVD88 = Number.isFinite(peak) ? peak / 100 : null;
        return {
          date,
          classification: Number.isFinite(peakNAVD88) ? classifyFloodStage(peakNAVD88) : "none",
          peakNAVD88,
          hours: [],
          pipelineSource,
          isCanonicalPipelineTruth: true,
          isLewesSurrogate: pipelineSource === "N" || (pipelineSource === "C" && surrogateEnabled() && date < primaryArchiveStartDate()),
          surrogateStationId: pipelineSource === "N" ? surrogateStationId() : null,
          surrogateStationName: pipelineSource === "N" ? surrogateStationName() : null
        };
      }).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
      return {
        archiveStartDate: payload?.archive?.startDate || days[0]?.date || null,
        archiveEndDate: payload?.archive?.endDate || days[days.length - 1]?.date || null,
        datum: payload?.datum || "NAVD88",
        gaugeName: primaryGaugeName(),
        sourceType: "usgs-first-bias-corrected-noaa-usgs-crest-override",
        lewesCutoffDate: primaryArchiveStartDate(),
        sourcePrecedence: payload?.provenance?.sourcePrecedence || TOWN_CONFIG?.observed?.sourcePrecedence || [],
        provenance: payload?.provenance || {},
        days
      };
    }

    async function ensureCanonicalDailyArchive() {
      if (canonicalDailyData) return canonicalDailyData;
      const generation = archiveGeneration;
      const payload = await fetchJson(CANONICAL_DAILY_URL, { cache: "default" });
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      canonicalDailyData = payload;
      return canonicalDailyData;
    }

    function buildLewesObservedIndexDays(archive) {
      const cutoff = primaryArchiveStartDate();
      return (Array.isArray(archive?.days) ? archive.days : [])
        .filter(day => day?.d && String(day.d) < cutoff)
        .map(day => ({
          date: day.d,
          classification: Number.isFinite(decodeSurrogateHundredths(day.p)) ? classifyFloodStage(decodeSurrogateHundredths(day.p)) : "none",
          peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? decodeSurrogateHundredths(day.p) : null,
          hours: [],
          isLewesSurrogate: true,
          surrogateStationId: archive?.stationId || surrogateStationId(),
          surrogateStationName: archive?.stationName || surrogateStationName(),
          lewesCompactDay: Array.isArray(day?.v) ? day : null
        }));
    }

    function buildObservedIndexFrom15MinuteArchive(archive, lewesArchive = null) {
      const compactDays = Array.isArray(archive?.days) ? archive.days : [];
      const stoneHarborDays = compactDays.map(day => ({
        date: day.d,
        classification: day.c || "none",
        peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? Number(day.p) / 100 : null,
        hours: []
      }));
      const lewesDays = buildLewesObservedIndexDays(lewesArchive);
      const allDays = [...lewesDays, ...stoneHarborDays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {
        archiveStartDate: allDays[0]?.date || archive?.archiveStartDate || compactDays[0]?.d || null,
        archiveEndDate: archive?.archiveEndDate || compactDays[compactDays.length - 1]?.d || null,
        datum: archive?.datum || "NAVD88",
        gaugeName: archive?.gaugeName || primaryGaugeName(),
        sourceType: lewesDays.length ? "lewes-hourly-plus-stone-harbor-15-minute-index" : "compact-15-minute-index",
        lewesCutoffDate: lewesArchive?.stoneHarborCutoffDate || "2007-10-01",
        days: allDays
      };
    }

    function mergeObservedArchiveIndex(index, source = "stone-harbor") {
      if (!index || !Array.isArray(index.days)) return;
      const incoming = source === "lewes"
        ? buildLewesObservedIndexDays(index)
        : index.days.map(day => ({
            date: day.d,
            classification: day.c || "none",
            peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? Number(day.p) / 100 : null,
            hours: []
          }));

      // The canonical daily release can predate later USGS observations.
      // Reconcile the browser calendar with the primary replay index BEFORE
      // any year is loaded, so navigation order cannot change source policy.
      const primaryIndex = source === "stone-harbor" && String(index.stationId || index.site) === String(TOWN_CONFIG?.observed?.usgsGaugeId);

      if (!observedData) {
        observedData = buildObservedIndexFrom15MinuteArchive(
          source === "stone-harbor" ? index : { days: [] },
          source === "lewes" ? index : null
        );
      } else {
        const existing = new Map((observedData.days || []).map(day => [String(day?.date || ""), day]));
        incoming.forEach(day => {
          if (!day?.date) return;
          const current = existing.get(day.date);
          if (current) {
            current.isHistoricalCrestOnly = false;
            if (primaryIndex && Number.isFinite(normalizeStageValue(day.peakNAVD88))) {
              current.canonicalPeakNAVD88 ??= current.peakNAVD88;
              if (current.pipelineSource !== "C" && !current.officialCrestEntry) {
                current.peakNAVD88 = day.peakNAVD88;
                current.classification = classifyFloodStage(day.peakNAVD88);
                current.pipelineSource = "U";
              }
              current.isLewesSurrogate = false;
              current.surrogateStationId = null;
              current.surrogateStationName = null;
              return;
            }
            if (current.isCanonicalPipelineTruth) {
              return;
            }
            current.classification = day.classification || current.classification || "none";
            if (Number.isFinite(normalizeStageValue(day.peakNAVD88))) {
              current.peakNAVD88 = Number.isFinite(normalizeStageValue(current.peakNAVD88))
                ? Math.max(Number(current.peakNAVD88), Number(day.peakNAVD88))
                : Number(day.peakNAVD88);
            }
            if (source === "lewes") {
              current.isLewesSurrogate = true;
              current.surrogateStationId = current.surrogateStationId || surrogateStationId();
              current.surrogateStationName = current.surrogateStationName || surrogateStationName();
            }
            return;
          }
          observedData.days.push(day);
          existing.set(day.date, day);
        });
        observedData.days.sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
        observedData.archiveStartDate = observedData.days[0]?.date || observedData.archiveStartDate;
        if (source === "stone-harbor") {
          observedData.archiveEndDate = index.archiveEndDate || observedData.archiveEndDate;
        }
        if (source === "lewes") {
          observedData.lewesCutoffDate = index.stoneHarborCutoffDate || observedData.lewesCutoffDate || "2007-10-01";
        }
      }
      observedDaysCache = null;
      observedMonthKeys = buildObservedMonthKeysFromDays(getObservedDays());
      clearExportAvailabilityCache();
    }

    function preloadObservedArchiveIndexText(timeoutMs = 15000) {
      if (observedArchiveIndexTextPromise) return observedArchiveIndexTextPromise;
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          controller.abort();
          reject(new Error("The observed archive index timed out."));
        }, timeoutMs);
      });
      // Race the entire response body, not only the headers. A pending index
      // must yield to the compact fallback even if transport abort is delayed.
      const download = fetch(OBSERVED_ARCHIVE_INDEX_URL, {
        cache: "default",
        headers: { "Accept": "application/geo+json, application/json" },
        signal: controller.signal
      })
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status} for ${OBSERVED_ARCHIVE_INDEX_URL}`);
          return response.text();
        });
      const request = Promise.race([download, deadline])
        .catch(error => {
          if (observedArchiveIndexTextPromise === request) observedArchiveIndexTextPromise = null;
          throw error;
        })
        .finally(() => window.clearTimeout(timer));
      observedArchiveIndexTextPromise = request;
      return request;
    }

    async function ensureObserved15MinuteArchive() {
      const generation = archiveGeneration;
      let payload;
      if (observed15MinuteData) return observed15MinuteData;
      try {
        payload = JSON.parse(await preloadObservedArchiveIndexText());
        if (String(payload.stationId || payload.site) !== String(TOWN_CONFIG?.observed?.usgsGaugeId)) {
          throw new Error("The cached archive index does not use the primary USGS gauge.");
        }
      } catch (indexError) {
        console.warn("Optimized observed archive index unavailable; using the compact archive.", indexError);
        payload = await fetchJson(OBSERVED_15MIN_URL, { cache: "default" });
      }
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      // The compact fallback must satisfy the same gauge/cadence contract as
      // a year shard before it can populate the primary cache.
      addArchiveShardDays(payload, "stone-harbor");
      observed15MinuteData = payload;
      return observed15MinuteData;
    }

    async function ensureLewesHourlyArchive() {
      if (!surrogateEnabled() || !LEWES_HOURLY_URL) return null;
      if (lewesHourlyData && Array.isArray(lewesHourlyData.days)) return lewesHourlyData;
      const generation = archiveGeneration;
      const payload = await fetchJson(LEWES_HOURLY_URL, { cache: "default" });
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      lewesHourlyData = payload;
      return lewesHourlyData;
    }

    function refreshObservedArchiveUi() {
      if (!observedData) return;
      observedDaysCache = null;
      observedMonthKeys = buildObservedMonthKeysFromDays(getObservedDays());
      topTideEvents = buildTopTideEvents();
      renderTopTides();
      populateCalendarSelectors();
      if (currentDataMode === "observed") {
        renderCalendar().catch(error => console.warn("Observed calendar refresh failed.", error));
      }
    }

    async function ensureLewesArchiveIndex() {
      if (!surrogateEnabled() || !LEWES_ARCHIVE_INDEX_URL) return null;
      if (lewesArchiveIndexData) return lewesArchiveIndexData;
      if (lewesArchiveIndexPromise) return lewesArchiveIndexPromise;
      const generation = archiveGeneration;
      lewesArchiveIndexPromise = fetchJson(LEWES_ARCHIVE_INDEX_URL, { cache: "default" })
        .then(index => {
          if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
          lewesArchiveIndexData = index;
          lewesHourlyData = {
            stationId: index?.stationId || surrogateStationId(),
            stationName: index?.gaugeName || surrogateStationName(),
            stoneHarborCutoffDate: primaryArchiveStartDate()
          };
          mergeObservedArchiveIndex(index, "lewes");
          refreshObservedArchiveUi();
          return index;
        })
        .catch(error => {
          if (generation !== archiveGeneration) return null;
          lewesArchiveIndexPromise = null;
          console.warn(`${surrogateStationShort()} archive day index will retry when requested.`, error);
          return null;
        });
      return lewesArchiveIndexPromise;
    }

    function scheduleLewesArchiveIndexWarmup() {
      if (!surrogateEnabled()) return;
      if (lewesArchiveIndexWarmupScheduled || lewesArchiveIndexData) return;
      lewesArchiveIndexWarmupScheduled = true;
      const start = () => ensureLewesArchiveIndex().catch(() => null);
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(start, { timeout: 5000 });
      } else {
        window.setTimeout(start, 1800);
      }
    }

    function getObservedArchiveSourceForDate(dateStr) {
      const day = getObservedDayRecord(String(dateStr || ""));
      if (surrogateEnabled() && String(dateStr || "") < primaryArchiveStartDate()) return "lewes";
      if (day?.pipelineSource === "N") return "lewes";
      if (day?.pipelineSource === "U" || day?.pipelineSource === "C") return "stone-harbor";
      const cutoff = primaryArchiveStartDate();
      return surrogateEnabled() && String(dateStr || "") < cutoff ? "lewes" : "stone-harbor";
    }

    function getObservedArchiveShardUrl(source, year) {
      const index = source === "lewes" ? lewesArchiveIndexData : observed15MinuteData;
      const fallback = `./observed_archive/${source}/{year}.json`;
      const configuredTemplate = source === "lewes" ? configuredSurrogate().shardPathTemplate : "";
      const template = String(configuredTemplate || index?.shardPathTemplate || fallback);
      const url = new URL(template.replace("{year}", String(year)), APP_BASE);
      if (source === "stone-harbor") url.searchParams.set("policy", "20260921-usgs-first");
      return url.href;
    }

    function addArchiveShardDays(payload, source) {
      const expectedInterval = source === "lewes" ? 60 : 15;
      if (Number(payload?.intervalMinutes) !== expectedInterval) {
        throw new Error(`Invalid ${source} archive interval; expected ${expectedInterval} minutes.`);
      }
      if (payload.source && payload.source !== source) throw new Error("Archive source mismatch.");
      const expectedStation = source === "lewes" ? surrogateStationId() : String(TOWN_CONFIG?.observed?.usgsGaugeId);
      if (String(payload.stationId || payload.site) !== expectedStation) throw new Error("Archive gauge mismatch.");
      const cache = source === "lewes" ? lewesHourlyDaysByDate : observed15MinuteDaysByDate;
      const days = Array.isArray(payload?.days) ? payload.days : [];
      // Validate the whole response before committing any entries to a cache.
      days.forEach(day => {
        if (!day?.d || !Array.isArray(day.v)) return;
        const start = parseStoredLocalNyToDate(`${day.d}T00:00`);
        const end = parseStoredLocalNyToDate(`${addDaysToDateKey(day.d, 1)}T00:00`);
        const slots = start && end ? (end - start) / (expectedInterval * 60000) : 0;
        if (day.v.length !== slots || Number(day.u) * 1000 !== start?.getTime()) {
          throw new Error(`Invalid ${source} sample cadence for ${day.d}.`);
        }
        if (day.v.some(value => value !== null && !Number.isFinite(value))) throw new Error("Invalid archive sample.");
      });
      days.forEach(day => {
        if (!day?.d || !Array.isArray(day.v)) return;
        cache.set(day.d, day);
        if (!observedData) return;
        const existing = getObservedDayRecord(day.d);
        if (!existing) {
          observedData.days.push({
            date: day.d,
            classification: day.c || "none",
            peakNAVD88: day.p != null && Number.isFinite(Number(day.p)) ? source === "lewes" ? decodeSurrogateHundredths(day.p) : Number(day.p) / 100 : null,
            hours: [],
            isLewesSurrogate: source === "lewes",
            surrogateStationId: source === "lewes" ? surrogateStationId() : null,
            surrogateStationName: source === "lewes" ? surrogateStationName() : null
          });
        } else if (source !== "lewes" || existing.isLewesSurrogate) {
          existing.isHistoricalCrestOnly = false;
        }
      });
      if (observedData) {
        observedData.days.sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
      }
      observedDaysCache = null;
      clearExportAvailabilityCache();
    }

    async function ensureObservedArchiveYear(source, year) {
      const generation = archiveGeneration;
      const key = `${source}:${year}`;
      if (observedArchiveLoadedYears.has(key)) return true;
      if (observedArchiveUnavailableYears.has(key)) return false;
      if (observedArchiveYearPromises.has(key)) return observedArchiveYearPromises.get(key);
      if (source === "stone-harbor") await ensureObserved15MinuteArchive();
      const index = source === "lewes" ? await ensureLewesArchiveIndex() : observed15MinuteData;
      if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
      if (index?.days?.length && !index.days.some(day => String(day.d).startsWith(`${year}-`))) {
        observedArchiveUnavailableYears.add(key);
        return false;
      }
      const install = payload => {
        if (generation !== archiveGeneration) throw new Error("Archive request superseded by Reload");
        const covered = payload?.days?.some(day => String(day.d).startsWith(`${year}-`) && Array.isArray(day.v));
        if (!covered) throw new Error(`Archive does not cover ${source} ${year}.`);
        addArchiveShardDays(payload, source);
        observedArchiveLoadedYears.add(key);
        return true;
      };
      const promise = fetchJson(getObservedArchiveShardUrl(source, year), { cache: "default" })
        .then(install)
        .catch(async error => {
          if (generation !== archiveGeneration) throw error;
          console.warn(`Optimized ${source} ${year} archive unavailable.`, error);
          try {
            const fallback = source === "stone-harbor"
              ? await fetchJson(OBSERVED_15MIN_URL, { cache: "default" })
              : await ensureLewesHourlyArchive();
            return install(fallback);
          } catch (fallbackError) {
            if (generation !== archiveGeneration) throw fallbackError;
            // A network failure remains retryable. Never mark an uncovered
            // year as loaded or silently borrow a different gauge's samples.
            console.warn(`Detailed ${source} ${year} history unavailable; daily peaks only.`, fallbackError);
            return false;
          }
        }).finally(() => {
          if (observedArchiveYearPromises.get(key) === promise) observedArchiveYearPromises.delete(key);
        });
      observedArchiveYearPromises.set(key, promise);
      return promise;
    }

    async function ensureObservedArchiveForDate(dateStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return false;
      const source = getObservedArchiveSourceForDate(dateStr);
      await ensureObservedArchiveYear(source, String(dateStr).slice(0, 4));
      // The final three quarter-hours need the next measured hourly endpoint.
      // Usually it is in the same shard; December 31 also needs the next year.
      const nextDate = addDaysToDateKey(dateStr, 1);
      if (source === "lewes" && nextDate.slice(0, 4) !== dateStr.slice(0, 4)
          && getObservedArchiveSourceForDate(nextDate) === source) {
        await ensureObservedArchiveYear(source, nextDate.slice(0, 4));
      }
      return (source === "lewes" ? lewesHourlyDaysByDate : observed15MinuteDaysByDate).has(dateStr);
    }

    async function ensureObservedArchiveRange(startDate, endDate) {
      const startKey = getExportDayKeyFromDate(startDate);
      const endKey = getExportDayKeyFromDate(endDate);
      if (!startKey || !endKey) return;
      const keys = new Set();
      let cursor = startKey < endKey ? startKey : endKey;
      const finalKey = startKey < endKey ? endKey : startKey;
      while (cursor && cursor <= finalKey) {
        keys.add(`${getObservedArchiveSourceForDate(cursor)}:${cursor.slice(0, 4)}`);
        cursor = addDaysToDateKey(cursor, 1);
      }
      await Promise.all(Array.from(keys).map(key => {
        const [source, year] = key.split(":");
        return ensureObservedArchiveYear(source, year);
      }));
      await ensureObservedArchiveForDate(finalKey);
    }

    function decodeLewesHourlyDay(dayRecord) {
      const compact = dayRecord?.lewesCompactDay;
      if (!compact || !Number.isFinite(Number(compact.u)) || !Array.isArray(compact.v)) return [];
      const sixMinuteIndexes = new Set(Array.isArray(compact.x) ? compact.x.map(Number) : []);
      return compact.v.map((encoded, index) => {
        const timeMs = (Number(compact.u) + index * 3600) * 1000;
        const stage = encoded == null ? null : decodeSurrogateHundredths(encoded);
        return setTimelineSlotFields({
          navd88StageFt: stage,
          stageFt: stage,
          value: stage,
          source: sixMinuteIndexes.has(index) ? `noaa-${configuredSurrogate().key || "surrogate"}-verified-6min` : `noaa-${configuredSurrogate().key || "surrogate"}-verified-hourly`,
          sourceStationId: lewesHourlyData?.stationId || surrogateStationId(),
          sourceStation: lewesHourlyData?.stationName || surrogateStationName(),
          sourceStationShort: surrogateStationShort(),
          sourceResolutionMinutes: sixMinuteIndexes.has(index) ? 6 : 60,
          isLewesSurrogate: true,
          surrogateForPrimaryGauge: true,
          isMissingObservedHour: !Number.isFinite(stage)
        }, timeMs, 60, { observedDate: dayRecord.date });
      });
    }

    function decodeObserved15MinuteDay(day) {
      if (!day || !Number.isFinite(Number(day.u)) || !Array.isArray(day.v)) return [];
      return day.v.map((encoded, index) => {
        const timeMs = (Number(day.u) + index * 900) * 1000;
        const stage = encoded == null ? null : Number(encoded) / 100;
        return setTimelineSlotFields({
          navd88StageFt: stage, stageFt: stage, value: stage,
          sourceResolutionMinutes: Number(observed15MinuteData?.sourceResolutionMinutes) || 6,
          sourceStationId: (day.s || "")[index] === "N" ? "1005" : (day.s || "")[index] === "L" ? surrogateStationId() : String(TOWN_CONFIG?.observed?.usgsGaugeId || TOWN_CONFIG?.site?.usgsGaugeId || ""),
          stormReplay: day.replay || null,
          observationQuality: (day.q || "")[index] || "unknown",
          isMeasuredQuarterHourArchive: (day.q || "")[index] === "M",
          isInterpolatedTimelineFrame: (day.q || "")[index] === "I",
          interpolationSpanSeconds: Array.isArray(day.g) ? day.g[index] : null,
          isMissingObservedHour: !Number.isFinite(stage)
        }, timeMs, 15, { observedDate: day.d });
      });
    }

    function buildObservedQuarterHourDisplaySeries(dayRecord, dateStr) {
      return buildObservedCanonicalSeries(dayRecord, dateStr);
    }

    function buildObservedCanonicalSeries(dayRecord, dateStr) {
      let source = getObservedSourceHoursForDay(dayRecord);
      if (source.length && source.every(entry => entry.isDailyPeakOnly)) return source;
      const start = parseStoredLocalNyToDate(`${dateStr}T00:00`);
      const end = parseStoredLocalNyToDate(`${dateStr}T23:45`);
      if (dayRecord?.isLewesSurrogate) {
        const nextDate = addDaysToDateKey(dateStr, 1);
        const nextDay = getObservedDayRecord(nextDate);
        const midnight = parseStoredLocalNyToDate(`${nextDate}T00:00`);
        // Use a real, loaded sample from the same gauge. Never extrapolate
        // past the last reading or turn a date-only crest into a timed sample.
        if (nextDay?.isLewesSurrogate && midnight) {
          source = source.concat(getObservedSourceHoursForDay(nextDay).filter(entry =>
            !entry.isDailyPeakOnly && entryTimeMs(entry) === midnight.getTime()
          ));
        }
      }
      const sourceResolutionMinutes = detectSeriesResolutionMinutes(source);
      const series = buildQuarterHourTimelineSeries(source, {
        kind: "observed",
        observedDate: dateStr,
        startMs: start ? start.getTime() : null,
        endMs: end ? end.getTime() : null,
        sourceResolutionMinutes,
        fillMissingSlots: true,
        // Lewes archive samples are hourly; the primary archive is 15-minute.
        // Allow adjacent hourly readings, but keep missing hourly readings blank.
        maxGapMinutes: dayRecord?.isLewesSurrogate ? 60 : 30
      });

      return annotateHydraulicSeries(series.map((entry, idx) => ({
        ...entry,
        observedDate: dateStr,
        quarterHourIndex: idx,
        classification: dayRecord?.classification || entry.classification || "none",
        peakNAVD88: dayRecord?.peakNAVD88 ?? entry.peakNAVD88,
        sourceResolutionMinutes
      })));
    }

    function sampleCanonicalHydraulicSeries(entries = [], intervalMinutes = getTimelineIntervalMinutes()) {
      const canonical = Array.isArray(entries) ? entries : [];
      if (canonical.length && canonical.every(entry => entry.isDailyPeakOnly)) return canonical.slice();
      if (intervalMinutes === 15) {
        return canonical.map(entry => ({
          ...entry,
          timelineIntervalMinutes: 15,
          observationInterval: "15min"
        }));
      }
      if (intervalMinutes !== 60) return canonical.slice();

      return canonical
        .filter(entry => {
          const date = getEntryESTDate(entry);
          const parts = date ? getNyParts(date) : null;
          return parts && Number(parts.minute) === 0;
        })
        .map(entry => ({
          ...entry,
          timelineIntervalMinutes: 60,
          observationInterval: "1hour",
          sampledFromCanonical15MinuteHistory: true
        }));
    }

function setDatumHelpOpen(isOpen) {
      const modal = document.getElementById("datumModal");
      const btn = document.getElementById("datumHelpBtn");
      if (!modal || !btn) return;
      modal.hidden = !isOpen;
      modal.classList.toggle("open", isOpen);
      btn.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) {
        document.getElementById("datumModalCloseBtn")?.focus();
      }
    }

    const HELP_COPY = {
      dataSource: {
        title: "Flood data",
        body: `
          <p><strong>Forecast</strong> shows expected tides ahead. <strong>Past</strong> shows measured tide gauge readings. <strong>Modeled Floods</strong> shows sample floods that are possible over time.</p>
        `
      },
      forecastType: {
        title: "Forecast type",
        body: `
          <p>Choose Lower End, Mean, or Upper End to compare forecast scenarios based on NOAA PETSS guidance. Upper End shows the upper water-depth estimate for this forecast.</p>
        `
      },
      overlay: {
        title: "Overlay",
        body: `
          <p><strong>Flood Depth</strong> shows the estimated water depth above the ground, in inches below 1 foot and feet at 1 foot or more.</p>
          <p><strong>Flood Stages</strong> groups flooding as minor, moderate, or major.</p>
        `
      },
      timelineDetail: {
        title: "Timeline detail",
        body: `
          <p><strong>Hourly</strong> shows one point per hour. <strong>15-Min</strong> shows four points per hour when available. <strong>Daily Max</strong> shows each day's highest water level.</p>
        `
      },
      returnIntervals: {
        title: "Modeled floods",
        body: `
          <p><strong>Every 100 Years</strong> means about a 1% chance in any year. It does not mean the flood can happen only once every 100 years.</p>
          <p>Each choice shows a sample 24-hour storm whose surge peak is aligned to the first high tide in the window.</p>
        `
      },
      depthLegend: {
        title: "Flood Depth Key",
        body: `
          <p>Light blue is shallow water. Darker blue is deeper water.</p>
          <p><strong>Uncertainty</strong> marks terrain below the selected water level that the connected flood model does not classify as flooded under the current filling conditions. Marshes and beaches are never changed just to complete a street route. During drainage, lag-retained street water is blue.</p>
        `
      },
      stageLegend: {
        title: "Flood Stages Key",
        body: `
          <p>Flood Stages colors terrain below the selected water level by its existing Minor, Moderate, or Major category.</p>
          <p><strong>Green uncertainty areas</strong> are the same areas shown in Flood Depth for the selected time. They replace the stage color wherever Flood Depth marks uncertain flooding. Uncertainty is separate from flood severity; it is not a stage below Minor. Physics forecast frames do not provide this green uncertainty layer.</p>
          <ul>
            <li><strong>Minor:</strong> low roads and public areas may flood.</li>
            <li><strong>Moderate:</strong> roads and some buildings may flood. Evacuations may be needed.</li>
            <li><strong>Major:</strong> many roads and buildings may flood. Larger evacuations may be needed.</li>
          </ul>
        `
      }
    };

