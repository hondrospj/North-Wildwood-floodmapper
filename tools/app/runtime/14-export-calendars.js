    function getExportMonthKey(date) {
      const parts = getNyParts(date);
      if (!parts) return "";
      return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    }

    function getExportWeekdayIndex(date) {
      const parts = getNyParts(date);
      const weekday = String(parts?.weekday || "").slice(0, 3).toLowerCase();
      const weekdayIndex = {
        sun: 0,
        mon: 1,
        tue: 2,
        wed: 3,
        thu: 4,
        fri: 5,
        sat: 6
      }[weekday];

      return Number.isInteger(weekdayIndex) ? weekdayIndex : 0;
    }

    function getExportMonthStart(date) {
      const parts = getNyParts(date || new Date());
      if (!parts) return new Date();
      return parseStoredLocalNyToDate(`${parts.year}-${String(parts.month).padStart(2, "0")}-01T00:00`) || new Date();
    }

    function shiftExportMonth(date, delta) {
      const parts = getNyParts(date || new Date());
      const shifted = new Date(Date.UTC(parts.year, parts.month - 1 + delta, 1, 12, 0, 0));
      const y = shifted.getUTCFullYear();
      const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
      return parseStoredLocalNyToDate(`${y}-${m}-01T00:00`) || shifted;
    }

function clearExportAvailabilityCache() {
      exportAvailabilityCache = null;
      exportAvailabilityDayMapCache = null;
      exportAvailabilityMonthMapCache = null;
      exportAvailabilityBoundsCache = null;
      exportAvailabilityHourTotalCache = null;
      exportEntriesForDayCache = new Map();
      observedExportDayIndexCache = null;
      exportTimePickerLastSignature = "";
    }

    function getObservedExportDayIndex() {
      if (observedExportDayIndexCache) return observedExportDayIndexCache;
      const index = new Map();
      getObservedDays().forEach(day => {
        const dayKey = String(day?.date || "").slice(0, 10);
        if (!dayKey) return;
        const existing = index.get(dayKey);
        const existingCount = Array.isArray(existing?.hours) ? existing.hours.length : 0;
        const newCount = Array.isArray(day?.hours) ? day.hours.length : 0;
        if (!existing || newCount >= existingCount) index.set(dayKey, day);
      });
      observedExportDayIndexCache = index;
      return index;
    }

    function primeExportTimePickerShell() {
      const title = document.getElementById("exportPickerTitle");
      const count = document.getElementById("exportSelectionCount");
      if (title) title.textContent = "Available export dates";
      if (count) count.textContent = "Loading";
      ["exportStartCalendarGrid", "exportEndCalendarGrid"].forEach(id => {
        const grid = document.getElementById(id);
        if (grid) grid.innerHTML = `<div class="export-picker-empty" style="grid-column:1/-1">Loading available dates...</div>`;
      });
    }

    function scheduleExportTimePickerRender(force = false) {
      if (!isDownloadModalOpen() && !force) return;
      if (exportTimePickerRenderRaf != null) cancelAnimationFrame(exportTimePickerRenderRaf);
      exportTimePickerRenderRaf = requestAnimationFrame(() => {
        exportTimePickerRenderRaf = null;
        renderExportTimePicker(force);
      });
    }

    function getForecastExportEntriesLimited() {
      const entries = getForecastExportEntries()
        .filter(entry => entryTimeMs(entry) != null)
        .sort((a, b) => entryTimeMs(a) - entryTimeMs(b));
      if (!entries.length) return [];
      const firstMs = entryTimeMs(entries[0]);
      const maxMs = firstMs + EXPORT_RANGE_MAX_MS;
      return entries.filter(entry => {
        const t = entryTimeMs(entry);
        return t != null && t <= maxMs;
      });
    }

    function getExportAvailabilityDayMap() {
      if (exportAvailabilityDayMapCache) return exportAvailabilityDayMapCache;
      const map = new Map();

      function ensureMeta(dayKey) {
        if (!dayKey) return null;
        if (!map.has(dayKey)) {
          map.set(dayKey, {
            dayKey,
            observed: false,
            forecast: false,
            count: 0,
            firstDate: parseStoredLocalNyToDate(`${dayKey}T00:00`),
            lastDate: parseStoredLocalNyToDate(`${dayKey}T23:00`)
          });
        }
        return map.get(dayKey);
      }

      if (currentDataMode !== "return-interval") {
        getObservedExportDayIndex().forEach((day, dayKey) => {
          const meta = ensureMeta(dayKey);
          if (!meta) return false;
          meta.observed = true;
          const hours = Array.isArray(day?.hours) ? day.hours : [];
          meta.count += Math.max(1, hours.length || 24);
        });
      }

      const activeEntries = currentDataMode === "return-interval"
        ? getReturnIntervalExportEntries()
        : getForecastExportEntriesLimited();
      activeEntries.forEach(entry => {
        const d = getEntryESTDate(entry);
        const dayKey = getExportDayKeyFromDate(d);
        const meta = ensureMeta(dayKey);
        if (!meta) return;
        meta.forecast = true;
        meta.modeled = currentDataMode === "return-interval";
        meta.count += 1;
        if (d) {
          if (!meta.firstDate || d.getTime() < meta.firstDate.getTime()) meta.firstDate = d;
          if (!meta.lastDate || d.getTime() > meta.lastDate.getTime()) meta.lastDate = d;
        }
      });

      exportAvailabilityDayMapCache = map;
      return map;
    }

    function getExportAvailabilityBounds() {
      if (exportAvailabilityBoundsCache) return exportAvailabilityBoundsCache;
      const dayMap = getExportAvailabilityDayMap();
      if (!dayMap.size) return null;
      let firstDate = null;
      let lastDate = null;
      dayMap.forEach(meta => {
        const a = meta.firstDate || parseStoredLocalNyToDate(`${meta.dayKey}T00:00`);
        const b = meta.lastDate || parseStoredLocalNyToDate(`${meta.dayKey}T23:00`);
        if (a && (!firstDate || a.getTime() < firstDate.getTime())) firstDate = a;
        if (b && (!lastDate || b.getTime() > lastDate.getTime())) lastDate = b;
      });
      exportAvailabilityBoundsCache = firstDate && lastDate ? { firstDate, lastDate } : null;
      return exportAvailabilityBoundsCache;
    }

    function getExportAvailabilityMonthMap() {
      if (exportAvailabilityMonthMapCache) return exportAvailabilityMonthMapCache;
      const months = new Map();
      getExportAvailabilityDayMap().forEach(meta => {
        const monthKey = String(meta.dayKey || "").slice(0, 7);
        if (!monthKey) return;
        if (!months.has(monthKey)) {
          months.set(monthKey, {
            monthKey,
            observed: false,
            forecast: false,
            firstDate: meta.firstDate || parseStoredLocalNyToDate(`${meta.dayKey}T00:00`),
            lastDate: meta.lastDate || parseStoredLocalNyToDate(`${meta.dayKey}T23:00`)
          });
        }
        const current = months.get(monthKey);
        current.observed = current.observed || !!meta.observed;
        current.forecast = current.forecast || !!meta.forecast;
        const a = meta.firstDate || parseStoredLocalNyToDate(`${meta.dayKey}T00:00`);
        const b = meta.lastDate || parseStoredLocalNyToDate(`${meta.dayKey}T23:00`);
        if (a && (!current.firstDate || a.getTime() < current.firstDate.getTime())) current.firstDate = a;
        if (b && (!current.lastDate || b.getTime() > current.lastDate.getTime())) current.lastDate = b;
      });
      exportAvailabilityMonthMapCache = months;
      return months;
    }

    function getExportDataRangeDetailedText() {
      return getExportAvailabilityRangeText();
    }


    function formatExportCompactDate(date) {
      if (!date) return "--";
      const parts = getNyParts(date);
      if (!parts) return "--";
      const mm = String(Number(parts.month)).padStart(2, "0");
      const dd = String(Number(parts.day)).padStart(2, "0");
      const yy = String(Number(parts.year) % 100).padStart(2, "0");
      return `${mm}/${dd}/${yy}`;
    }

    function getExportAvailabilityRangeText() {
      const bounds = getExportAvailabilityBounds();
      if (!bounds?.firstDate || !bounds?.lastDate) return "No dates";
      return `${formatExportCompactDate(bounds.firstDate)}–${formatExportCompactDate(bounds.lastDate)}`;
    }

    function populateExportHourSelects() {
      const selects = [document.getElementById("exportStartHourSelect"), document.getElementById("exportEndHourSelect")].filter(Boolean);
      if (!selects.length) return;
      selects.forEach(select => {
        if (select.options.length >= 24) return;
        select.innerHTML = "";
        for (let h = 0; h < 24; h++) {
          const opt = document.createElement("option");
          opt.value = String(h);
          const hour12 = (h % 12) || 12;
          opt.textContent = `${hour12}:00 ${h >= 12 ? "PM" : "AM"}`;
          select.appendChild(opt);
        }
      });
    }

    function getExportHourSelectValue(id, fallbackHour = 0) {
      const value = Number(document.getElementById(id)?.value);
      return Number.isFinite(value) ? Math.max(0, Math.min(23, Math.round(value))) : fallbackHour;
    }

    function setExportHourSelectFromDate(id, date) {
      const select = document.getElementById(id);
      const parts = date ? getNyParts(date) : null;
      if (select && parts) select.value = String(parts.hour);
    }

    function syncExportHourSelectsFromInputs() {
      populateExportHourSelects();
      const start = getRangeInputDate("downloadStartInput");
      const end = getRangeInputDate("downloadEndInput");
      setExportHourSelectFromDate("exportStartHourSelect", start);
      setExportHourSelectFromDate("exportEndHourSelect", end);
      syncExportDateTimeWheelsFromInputs();
    }

    function getExportWheelIds(prefix) {
      const cap = prefix === "end" ? "End" : "Start";
      return {
        month: `export${cap}MonthSelect`,
        day: `export${cap}DaySelect`,
        year: `export${cap}YearSelect`,
        hour: `export${cap}HourSelect`,
        manual: `export${cap}ManualInput`,
        ampm: `export${cap}AmPmInput`,
        hidden: prefix === "end" ? "downloadEndInput" : "downloadStartInput"
      };
    }

    function getExportWheelSelect(prefix, part) {
      const ids = getExportWheelIds(prefix);
      return document.getElementById(ids[part]);
    }

    function getExportBoundsYears() {
      const bounds = getExportAvailabilityBounds();
      const firstParts = getNyParts(bounds?.firstDate || new Date());
      const lastParts = getNyParts(bounds?.lastDate || new Date());
      return {
        first: firstParts?.year || 2007,
        last: lastParts?.year || new Date().getFullYear()
      };
    }

    function populateExportDateTimeWheels() {
      const { first, last } = getExportBoundsYears();
      ["start", "end"].forEach(prefix => {
        const monthSelect = getExportWheelSelect(prefix, "month");
        const daySelect = getExportWheelSelect(prefix, "day");
        const yearSelect = getExportWheelSelect(prefix, "year");
        const hourSelect = getExportWheelSelect(prefix, "hour");
        if (!monthSelect || !daySelect || !yearSelect || !hourSelect) return;
        if (!monthSelect.options.length) {
          monthSelect.innerHTML = "";
          for (let m = 1; m <= 12; m++) {
            const opt = document.createElement("option");
            opt.value = String(m);
            opt.textContent = String(m).padStart(2, "0");
            monthSelect.appendChild(opt);
          }
        }
        const oldYear = yearSelect.value;
        const yearValues = Array.from(yearSelect.options).map(opt => opt.value).join(",");
        const wantedYears = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => String(first + i)).join(",");
        if (yearValues !== wantedYears) {
          yearSelect.innerHTML = "";
          for (let y = first; y <= last; y++) {
            const opt = document.createElement("option");
            opt.value = String(y);
            opt.textContent = String(y);
            yearSelect.appendChild(opt);
          }
          if (oldYear && Number(oldYear) >= first && Number(oldYear) <= last) yearSelect.value = oldYear;
        }
        populateExportHourSelects();
        updateExportWheelDayOptions(prefix, false);
      });
    }

    function updateExportWheelDayOptions(prefix, preserve = true) {
      const monthSelect = getExportWheelSelect(prefix, "month");
      const daySelect = getExportWheelSelect(prefix, "day");
      const yearSelect = getExportWheelSelect(prefix, "year");
      if (!monthSelect || !daySelect || !yearSelect) return;
      const oldDay = preserve ? Number(daySelect.value || 1) : 1;
      const y = Number(yearSelect.value) || getExportBoundsYears().first;
      const m = Number(monthSelect.value) || 1;
      const days = new Date(y, m, 0).getDate();
      if (daySelect.options.length !== days) {
        daySelect.innerHTML = "";
        for (let d = 1; d <= days; d++) {
          const opt = document.createElement("option");
          opt.value = String(d);
          opt.textContent = String(d).padStart(2, "0");
          daySelect.appendChild(opt);
        }
      }
      daySelect.value = String(Math.min(days, Math.max(1, oldDay)));
    }

function setExportAmPmValue(prefix, value) {
      const normalized = String(value || "AM").toUpperCase() === "PM" ? "PM" : "AM";
      const input = getExportWheelSelect(prefix, "ampm");
      if (input) input.value = normalized;
      document.querySelectorAll(`[data-export-ampm-prefix="${prefix}"][data-export-ampm]`).forEach(btn => {
        const active = btn.dataset.exportAmpm === normalized;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }

    function formatExportManualTyping(value) {
      const raw = String(value || "");
      const digits = raw.replace(/\D/g, "").slice(0, 6);
      if (!digits) return "";
      let out = "";
      const mm = digits.slice(0, 2);
      const dd = digits.slice(2, 4);
      const yy = digits.slice(4, 6);
      out += mm;
      if (digits.length > 2) out += "/" + dd;
      else if (digits.length === 2 && raw.endsWith("/")) out += "/";
      if (digits.length > 4) out += "/" + yy;
      else if (digits.length === 4 && /\/$/.test(raw)) out += "/";
      return out;
    }

    function isCompleteExportManualValue(value) {
      return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/i.test(String(value || "").trim());
    }

    function setExportManualValidity(prefix, isValid, message = "") {
      const manual = getExportWheelSelect(prefix, "manual");
      if (!manual) return;
      manual.classList.toggle("is-invalid", Boolean(!isValid && String(manual.value || "").trim()));
      manual.setAttribute("aria-invalid", String(Boolean(!isValid && String(manual.value || "").trim())));
      if (!isValid && message && !exportInProgress) setDownloadStatus(message, true);
      if (isValid && !exportInProgress) setDownloadStatus("", false);
    }

    function formatExportManualDate(date) {
      const p = date ? getNyParts(date) : null;
      if (!p) return "";
      const yy = String(p.year % 100).padStart(2, "0");
      return `${String(p.month).padStart(2, "0")}/${String(p.day).padStart(2, "0")}/${yy}`;
    }


    function formatExportPickedDateLabel(date) {
      const p = date ? getNyParts(date) : null;
      if (!p) return "Select a date";
      const d = parseStoredLocalNyToDate(`${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T12:00`);
      return d ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric"
      }).format(d) : `${p.month}/${p.day}/${p.year}`;
    }

    function updateExportPickedDateLabels() {
      const startBtn = document.getElementById("exportStartPickedDate");
      const endBtn = document.getElementById("exportEndPickedDate");
      const startDate = getRangeInputDate("downloadStartInput");
      const endDate = getRangeInputDate("downloadEndInput");
      if (startBtn) startBtn.textContent = startDate ? formatExportPickedDateLabel(startDate) : "Select a start date";
      if (endBtn) endBtn.textContent = endDate ? formatExportPickedDateLabel(endDate) : "Select an end date";
      const startManual = document.getElementById("exportStartManualInput");
      const endManual = document.getElementById("exportEndManualInput");
      if (startManual && document.activeElement !== startManual && startDate) startManual.value = formatExportManualDate(startDate);
      if (endManual && document.activeElement !== endManual && endDate) endManual.value = formatExportManualDate(endDate);
    }

    function parseExportManualDate(value, prefix = null) {
      const raw = String(value || "").trim();
      const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/i);
      if (!match) return null;
      let month = Number(match[1]);
      let day = Number(match[2]);
      let year = Number(match[3]);
      const hour = prefix === "end" ? getExportHourSelectValue("exportEndHourSelect", 23) : getExportHourSelectValue("exportStartHourSelect", 0);
      if (year < 100) year += 2000;
      if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year) || !Number.isFinite(hour)) return null;
      if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23) return null;
      const parsed = parseStoredLocalNyToDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00`);
      const check = parsed ? getNyParts(parsed) : null;
      if (!check || check.year !== year || check.month !== month || check.day !== day) return null;
      return parsed;
    }

    function getExportDateFromWheels(prefix) {
      const manual = getExportWheelSelect(prefix, "manual");
      const manualDate = parseExportManualDate(manual?.value, prefix);
      if (manualDate) return manualDate;
      const monthSelect = getExportWheelSelect(prefix, "month");
      const daySelect = getExportWheelSelect(prefix, "day");
      const yearSelect = getExportWheelSelect(prefix, "year");
      const hourSelect = getExportWheelSelect(prefix, "hour");
      if (!monthSelect || !daySelect || !yearSelect || !hourSelect) return null;
      const y = Number(yearSelect.value);
      const m = Number(monthSelect.value);
      const d = Number(daySelect.value);
      const h = Number(hourSelect.value);
      if (![y, m, d, h].every(Number.isFinite)) return null;
      return parseStoredLocalNyToDate(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`);
    }

    function setExportWheelsFromDate(prefix, date) {
      populateExportDateTimeWheels();
      const p = date ? getNyParts(date) : null;
      if (!p) return;
      const monthSelect = getExportWheelSelect(prefix, "month");
      const yearSelect = getExportWheelSelect(prefix, "year");
      const daySelect = getExportWheelSelect(prefix, "day");
      const hourSelect = getExportWheelSelect(prefix, "hour");
      const manual = getExportWheelSelect(prefix, "manual");
      if (monthSelect) monthSelect.value = String(p.month);
      if (yearSelect) yearSelect.value = String(p.year);
      updateExportWheelDayOptions(prefix, true);
      if (daySelect) daySelect.value = String(p.day);
      if (hourSelect) hourSelect.value = String(p.hour);
      setExportAmPmValue(prefix, p.hour >= 12 ? "PM" : "AM");
      if (manual && document.activeElement !== manual) manual.value = formatExportManualDate(date);
      updateExportPickedDateLabels();
    }

    function syncExportDateTimeWheelsFromInputs() {
      populateExportDateTimeWheels();
      setExportWheelsFromDate("start", getRangeInputDate("downloadStartInput"));
      setExportWheelsFromDate("end", getRangeInputDate("downloadEndInput"));
    }

    function getExportOrderMessage(prefix) {
      return prefix === "start"
        ? "Start date must be before end date. Please choose a start date/time before the end date/time."
        : "End date must be after start date. Please choose an end date/time after the start date/time.";
    }

    function showExportDateOrderPopup(message, title = "Check export range") {
      const finalMessage = message || "Please check the selected export range.";
      const modal = document.getElementById("exportOrderModal");
      const heading = document.getElementById("exportOrderModalTitle");
      const body = document.getElementById("exportOrderModalBody");
      if (heading) heading.textContent = title;
      if (body) body.textContent = finalMessage;
      if (modal) {
        modal.hidden = false;
        modal.classList.add("open");
        setTimeout(() => document.getElementById("exportOrderModalOkBtn")?.focus(), 0);
      } else {
        window.alert(finalMessage);
      }
      setDownloadStatus(finalMessage, true);
    }

    function closeExportDateOrderPopup() {
      const modal = document.getElementById("exportOrderModal");
      if (!modal) return;
      modal.classList.remove("open");
      modal.hidden = true;
    }

    function isExportBoundaryOrderValid(prefix, proposedDate) {
      if (!proposedDate) return false;
      const other = getRangeInputDate(prefix === "end" ? "downloadStartInput" : "downloadEndInput");
      if (!other) return true;
      return prefix === "end" ? proposedDate.getTime() >= other.getTime() : proposedDate.getTime() <= other.getTime();
    }

    function setHiddenExportDate(prefix, date, options = {}) {
      const ids = getExportWheelIds(prefix);
      const input = document.getElementById(ids.hidden);
      if (!input || !date) return false;
      if (!options.skipOrderCheck && !isExportBoundaryOrderValid(prefix, date)) {
        if (options.showPopup !== false) showExportDateOrderPopup(getExportOrderMessage(prefix));
        syncExportDateTimeWheelsFromInputs();
        return false;
      }
      setRangeInputDate(ids.hidden, date);
      input.dataset.userEdited = "1";
      updateExportPickedDateLabels();
      return true;
    }

    function handleExportDateTimeWheelChange(prefix) {
      updateExportWheelDayOptions(prefix, true);
      const date = getExportDateFromWheels(prefix);
      if (!date) return;
      if (!setHiddenExportDate(prefix, date, { showPopup: true })) {
        updateDownloadSummary();
        scheduleExportTimePickerRender(true);
        return;
      }
      const selected = getRangeInputDate(prefix === "end" ? "downloadEndInput" : "downloadStartInput") || date;
      exportCalendarSelectedDayKey = getExportDayKeyFromDate(selected);
      setExportCalendarCursor(prefix, selected);
      syncExportDateTimeWheelsFromInputs();
      scheduleExportTimePickerRender(true);
      updateDownloadSummary();
    }

    function handleExportManualInput(prefix) {
      const manual = getExportWheelSelect(prefix, "manual");
      if (!manual) return;
      const raw = String(manual.value || "").trim();
      if (!raw) {
        setExportManualValidity(prefix, true);
        return;
      }
      const date = parseExportManualDate(raw, prefix);
      if (!date) {
        const msg = isCompleteExportManualValue(raw)
          ? "That date is not valid. Use MM/DD/YY, then choose the time below."
          : "Use MM/DD/YY, then choose the time below.";
        setExportManualValidity(prefix, false, msg);
        updateDownloadSummary();
        return;
      }
      setExportManualValidity(prefix, true);
      setExportPickMode(prefix, false);
      if (!setHiddenExportDate(prefix, date, { showPopup: true })) {
        const current = getRangeInputDate(prefix === "end" ? "downloadEndInput" : "downloadStartInput");
        if (current) manual.value = formatExportManualDate(current);
        updateDownloadSummary();
        scheduleExportTimePickerRender(true);
        return;
      }
      exportCalendarSelectedDayKey = getExportDayKeyFromDate(date);
      setExportCalendarCursor(prefix, date);
      setExportCalendarViewMode(prefix, "month");
      syncExportDateTimeWheelsFromInputs();
      scheduleExportTimePickerRender(true);
      updateDownloadSummary();
    }

    function handleExportAmPmToggle(prefix, ampm) {
      setExportPickMode(prefix, false);
      setExportAmPmValue(prefix, ampm);
      const date = getExportDateFromWheels(prefix);
      if (!date) return;
      if (!setHiddenExportDate(prefix, date, { showPopup: true })) {
        updateDownloadSummary();
        scheduleExportTimePickerRender(true);
        return;
      }
      exportCalendarSelectedDayKey = getExportDayKeyFromDate(date);
      setExportCalendarCursor(prefix, date);
      setExportCalendarViewMode(prefix, "month");
      syncExportDateTimeWheelsFromInputs();
      scheduleExportTimePickerRender(true);
      updateDownloadSummary();
    }

    function getExportDateForDayAndHour(dayKey, hour) {
      if (!dayKey) return null;
      return parseStoredLocalNyToDate(`${dayKey}T${String(hour).padStart(2, "0")}:00`);
    }

function getExportCalendarCursor(prefix) {
      return prefix === "end" ? exportEndCalendarCursorDate : exportStartCalendarCursorDate;
    }

    function setExportCalendarCursor(prefix, date) {
      const monthStart = date ? getExportMonthStart(date) : null;
      if (prefix === "end") exportEndCalendarCursorDate = monthStart;
      else exportStartCalendarCursorDate = monthStart;
    }

    function getExportCalendarViewMode(prefix) {
      return prefix === "end" ? exportEndCalendarViewMode : exportStartCalendarViewMode;
    }

    function setExportCalendarViewMode(prefix, mode) {
      const normalized = mode === "year" ? "year" : "month";
      if (prefix === "end") exportEndCalendarViewMode = normalized;
      else exportStartCalendarViewMode = normalized;
    }

    function setExportPickMode(mode = "start", syncCursor = true) {
      exportRangePickMode = mode === "end" ? "end" : "start";
      if (syncCursor) {
        const date = getRangeInputDate(exportRangePickMode === "end" ? "downloadEndInput" : "downloadStartInput");
        if (date) {
          exportCalendarSelectedDayKey = getExportDayKeyFromDate(date);
          setExportCalendarCursor(exportRangePickMode, date);
          setExportCalendarViewMode(exportRangePickMode, "month");
        }
      }
      updateExportPickModeUI();
    }

    function updateExportPickModeUI() {
      const mode = exportRangePickMode === "end" ? "end" : "start";
      document.querySelectorAll("[data-export-pick-panel]").forEach(panel => {
        panel.classList.toggle("is-pick-active", panel.dataset.exportPickPanel === mode);
      });
      const hint = document.getElementById("exportPickerHint");
      if (hint) hint.textContent = "";
    }

    function ensureExportCalendarCursors() {
      const dayMap = getExportAvailabilityDayMap();
      const bounds = getExportAvailabilityBounds();
      if (!bounds || !dayMap.size) return;
      const start = getRangeInputDate("downloadStartInput") || bounds.firstDate;
      const end = getRangeInputDate("downloadEndInput") || bounds.lastDate || start;
      if (!exportStartCalendarCursorDate) setExportCalendarCursor("start", start);
      if (!exportEndCalendarCursorDate) setExportCalendarCursor("end", end);
      if (!exportCalendarSelectedDayKey) exportCalendarSelectedDayKey = getExportDayKeyFromDate(start);
    }

    function setExportRangeBoundaryFromDayKey(dayKey, boundary = exportRangePickMode) {
      const prefix = boundary === "end" ? "end" : "start";
      const dayMap = getExportAvailabilityDayMap();
      const meta = dayMap.get(dayKey);
      if (!meta) return;
      populateExportHourSelects();
      const startEl = document.getElementById("downloadStartInput");
      const endEl = document.getElementById("downloadEndInput");
      const startHour = getExportHourSelectValue("exportStartHourSelect", 0);
      const endHour = getExportHourSelectValue("exportEndHourSelect", 23);
      const picked = getExportDateForDayAndHour(dayKey, prefix === "end" ? endHour : startHour);
      if (!picked) return false;

      if (!isExportBoundaryOrderValid(prefix, picked)) {
        showExportDateOrderPopup(getExportOrderMessage(prefix));
        syncExportHourSelectsFromInputs();
        scheduleExportTimePickerRender(true);
        updateDownloadSummary();
        return false;
      }

      setRangeInputDate(prefix === "end" ? "downloadEndInput" : "downloadStartInput", picked);
      if (startEl) startEl.dataset.userEdited = "1";
      if (endEl) endEl.dataset.userEdited = "1";
      exportCalendarSelectedDayKey = dayKey;
      setExportCalendarCursor(prefix, picked);
      setExportCalendarViewMode(prefix, "month");
      syncExportHourSelectsFromInputs();
      updateExportPickedDateLabels();
      return true;
    }

function getSelectedPngFrameItems() {
      return Array.from(exportPngSelections.values()).sort((a, b) => entryTimeMs(a.entry) - entryTimeMs(b.entry));
    }

function setExportRangeFromDayKey(dayKey, prefix = exportRangePickMode) {
      const dayMap = getExportAvailabilityDayMap();
      if (!dayMap.has(dayKey)) return false;
      const activeMode = prefix === "end" ? "end" : "start";
      setExportPickMode(activeMode, false);
      const ok = setExportRangeBoundaryFromDayKey(dayKey, activeMode);
      if (!ok) return false;
      exportCalendarSelectedDayKey = dayKey;
      syncExportHourSelectsFromInputs();
      return true;
    }

    function flashExportSelectedDateBox(prefix) {
      const cap = prefix === "end" ? "End" : "Start";
      const picked = document.getElementById(`export${cap}ManualInput`) || document.getElementById(`export${cap}PickedDate`);
      if (picked) {
        picked.classList.remove("selected-date-flash");
        void picked.offsetWidth;
        picked.classList.add("selected-date-flash");
      }
    }

    function renderExportBoundaryCalendar(prefix) {
      const cap = prefix === "end" ? "End" : "Start";
      const grid = document.getElementById(`export${cap}CalendarGrid`);
      const titleEl = document.getElementById(`export${cap}CalendarTitle`);
      const prevBtn = document.getElementById(`export${cap}CalendarPrevBtn`);
      const nextBtn = document.getElementById(`export${cap}CalendarNextBtn`);
      const container = document.querySelector(`[data-export-calendar="${prefix}"]`);
      const weekdays = container?.querySelector(".export-calendar-weekdays");
      if (!grid) return;

      const dayMap = getExportAvailabilityDayMap();
      const bounds = getExportAvailabilityBounds();
      grid.innerHTML = "";
      if (!bounds || !dayMap.size) {
        grid.innerHTML = `<div class="export-picker-empty" style="grid-column:1/-1">No exportable dates are available.</div>`;
        return;
      }

      let cursor = getExportCalendarCursor(prefix);
      if (!cursor) {
        const fallbackDate = getRangeInputDate(prefix === "end" ? "downloadEndInput" : "downloadStartInput") || (prefix === "end" ? bounds.lastDate : bounds.firstDate);
        setExportCalendarCursor(prefix, fallbackDate);
        cursor = getExportCalendarCursor(prefix);
      }

      const viewMode = getExportCalendarViewMode(prefix);
      const cursorParts = getNyParts(cursor || bounds.firstDate);
      const firstMonth = getExportMonthKey(bounds.firstDate);
      const lastMonth = getExportMonthKey(bounds.lastDate);
      const currentMonth = getExportMonthKey(cursor);
      const firstYear = getNyParts(bounds.firstDate)?.year || cursorParts.year;
      const lastYear = getNyParts(bounds.lastDate)?.year || cursorParts.year;

      if (titleEl) {
        const monthName = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" }).format(cursor || bounds.firstDate);
        titleEl.textContent = viewMode === "year" ? String(cursorParts.year) : monthName;
        titleEl.title = viewMode === "year" ? "Show month calendar" : "Show year view";
      }
      if (prevBtn) prevBtn.disabled = viewMode === "year" ? cursorParts.year <= firstYear : currentMonth <= firstMonth;
      if (nextBtn) nextBtn.disabled = viewMode === "year" ? cursorParts.year >= lastYear : currentMonth >= lastMonth;

      if (viewMode === "year") {
        if (weekdays) weekdays.style.display = "none";
        grid.classList.add("year-view");
        const monthMap = getExportAvailabilityMonthMap();
        for (let m = 1; m <= 12; m++) {
          const monthKey = `${cursorParts.year}-${String(m).padStart(2, "0")}`;
          const meta = monthMap.get(monthKey);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "export-calendar-day";
          const labelDate = parseStoredLocalNyToDate(`${monthKey}-01T00:00`);
          btn.textContent = labelDate ? new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "America/New_York" }).format(labelDate) : monthKey;
          if (meta) {
            btn.classList.add("available");
            if (meta.forecast) btn.classList.add("forecast-day");
            btn.addEventListener("click", () => {
              setExportCalendarCursor(prefix, parseStoredLocalNyToDate(`${monthKey}-01T00:00`) || cursor || bounds.firstDate);
              setExportCalendarViewMode(prefix, "month");
              scheduleExportTimePickerRender(true);
            });
          } else {
            btn.disabled = true;
            btn.classList.add("empty");
          }
          grid.appendChild(btn);
        }
        return;
      }

      if (weekdays) weekdays.style.display = "grid";
      grid.classList.remove("year-view");
      const year = Number(cursorParts.year);
      const month = Number(cursorParts.month);
      const monthText = String(month).padStart(2, "0");
      const firstOfMonth = parseStoredLocalNyToDate(`${year}-${monthText}-01T00:00`);
      const startPad = getExportWeekdayIndex(firstOfMonth);
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const start = getRangeInputDate("downloadStartInput");
      const end = getRangeInputDate("downloadEndInput");
      const rangeStartMs = start ? start.getTime() : null;
      const rangeEndMs = end ? end.getTime() : null;
      const minRangeMs = rangeStartMs != null && rangeEndMs != null ? Math.min(rangeStartMs, rangeEndMs) : null;
      const maxRangeMs = rangeStartMs != null && rangeEndMs != null ? Math.max(rangeStartMs, rangeEndMs) : null;
      const startDayKey = start ? getExportDayKeyFromDate(start) : "";
      const endDayKey = end ? getExportDayKeyFromDate(end) : "";

      for (let i = 0; i < startPad; i++) {
        const blank = document.createElement("div");
        blank.className = "export-calendar-day empty";
        grid.appendChild(blank);
      }

      for (let day = 1; day <= daysInMonth; day++) {
        const dayKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const meta = dayMap.get(dayKey);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "export-calendar-day";
        if (meta) {
          btn.classList.add("available");
          if (meta.forecast) btn.classList.add("forecast-day");
          btn.textContent = String(day);
          btn.title = meta.forecast && meta.observed ? "Forecast + historical data available" : meta.forecast ? "Forecast data available" : "Historical data available";
          const firstMs = meta.firstMs ?? (meta.firstDate ? meta.firstDate.getTime() : null);
          const lastMs = meta.lastMs ?? (meta.lastDate ? meta.lastDate.getTime() : null);
          if (minRangeMs != null && maxRangeMs != null && firstMs != null && lastMs != null && lastMs >= minRangeMs && firstMs <= maxRangeMs) {
            btn.classList.add("in-range");
          }
          if (dayKey === startDayKey) btn.classList.add("range-start");
          if (dayKey === endDayKey) btn.classList.add("range-end");
          btn.classList.toggle("selected", prefix === "end" ? dayKey === endDayKey : dayKey === startDayKey);
          btn.addEventListener("click", () => {
            const changed = setExportRangeFromDayKey(dayKey, prefix);
            if (!changed) return;
            flashExportSelectedDateBox(prefix);
            scheduleExportTimePickerRender(true);
            updateDownloadSummary();
          });
        } else {
          const dayStart = parseStoredLocalNyToDate(`${dayKey}T00:00`);
          const dayEnd = parseStoredLocalNyToDate(`${dayKey}T23:00`);
          const withinExportRange = bounds?.firstDate && bounds?.lastDate && dayEnd && dayStart && dayEnd.getTime() >= bounds.firstDate.getTime() && dayStart.getTime() <= bounds.lastDate.getTime();
          btn.textContent = "";
          btn.disabled = true;
          btn.title = withinExportRange ? "No data available" : "";
          btn.classList.add(withinExportRange ? "no-data" : "empty");
        }
        grid.appendChild(btn);
      }
    }

    function renderExportTimePicker(force = false) {
      const wrap = document.getElementById("exportTimePicker");
      const dataRangeEl = document.getElementById("exportDataRangeText");
      if (!wrap) return;

      wrap.hidden = false;
      const bounds = getDownloadArchiveBounds();
      if (dataRangeEl) {
        if (currentDataMode === "return-interval") {
          dataRangeEl.innerHTML = `<span>Modeled storm</span><strong>${Number(returnIntervalData?.windowHours || 24)}-hour synthetic event</strong>`;
        } else if (bounds?.firstDate && bounds?.lastDate) {
          dataRangeEl.innerHTML = `<span>Available data</span><strong>${formatExportCompactDate(bounds.firstDate)} – ${formatExportCompactDate(bounds.lastDate)}</strong>`;
        } else {
          dataRangeEl.innerHTML = `<span>Available data</span><strong>Loading…</strong>`;
        }
      }
    }

function updateDownloadSummary() {
      const summary = document.getElementById("downloadSummary");
      if (!summary || !isDownloadModalOpen()) return;

      syncDownloadRangeInputs(false);
      const scope = getDownloadScopeValue();
      const format = getDownloadFormatValue();
      const formatLabel = format.toUpperCase();
      const aspectConfig = getExportAspectConfig();
      const aspectLabel = aspectConfig.label;
      const resolutionLabel = format === "png" ? `, ${aspectConfig.resolutionLabel}` : "";
      const extentLabel = getDownloadExtentValue() === "town" ? "Fill North Wildwood" : "Current View";
      const speed = EXPORT_GIF_SPEEDS[getDownloadSpeedValue()]?.label || "Normal";
      const interval = getDownloadIntervalConfig();
      const frameLimit = getDownloadFrameLimit();

      if (format === "png") {
        const selectedItems = getSelectedPngFrameItems();
        if (selectedItems.length) {
          summary.textContent = `PNG (${aspectLabel}${resolutionLabel}, ${extentLabel}) export of ${selectedItems.length} selected frame${selectedItems.length === 1 ? "" : "s"}.`;
          return;
        }
        if (scope === "range") {
          const range = getDownloadRangeRequest();
          const count = range ? Math.min(getDownloadRangeSummaryFrameCount(range), frameLimit) : 0;
          summary.textContent = count
            ? `PNG (${aspectLabel}${resolutionLabel}, ${interval.label}, ${extentLabel}) export of ${count} frame${count === 1 ? "" : "s"}.`
            : "No frames are available for export.";
          return;
        }
        const item = getDownloadFrameItemFromEntry(getDownloadCurrentEntry(), currentHourIndex);
        summary.textContent = item ? `PNG (${aspectLabel}${resolutionLabel}, ${extentLabel}) export at ${formatHourEntryTime(item.entry)}.` : "No frames are available for export.";
        return;
      }

      if (scope === "range") {
        const range = getDownloadRangeRequest();
        if (!range) {
          summary.textContent = "No frames are available for export.";
          return;
        }
        if (range.durationMs > EXPORT_RANGE_MAX_MS) {
          summary.textContent = `${formatLabel} (${aspectLabel}, ${speed}, ${extentLabel}) export range is longer than ${EXPORT_RANGE_MAX_HOURS} hours and is not allowed.`;
          return;
        }
        const frameCount = Math.min(getDownloadRangeSummaryFrameCount(range), frameLimit);
        summary.textContent = `${formatLabel} (${aspectLabel}, ${interval.label}, ${speed}, ${extentLabel}) export of ${frameCount} frame${frameCount === 1 ? "" : "s"} from ${formatFixedESTFromUtc(range.startDate.toISOString())} to ${formatFixedESTFromUtc(range.endDate.toISOString())}.`;
        return;
      }

      const item = getDownloadFrameItemFromEntry(getDownloadCurrentEntry(), currentHourIndex);
      if (!item) {
        summary.textContent = "No frames are available for export.";
        return;
      }
      summary.textContent = `${formatLabel} (${aspectLabel}, ${speed}, ${extentLabel}) export at ${formatHourEntryTime(item.entry)}.`;
    }



function updateExportSegmentedUI() {
      const scopeValue = getDownloadScopeValue();
      const formatValue = getDownloadFormatValue();
      const intervalValue = getDownloadIntervalValue();
      const aspectValue = getDownloadAspectValue();
      const extentValue = getDownloadExtentValue();
      const speedValue = getDownloadSpeedValue();

      document.querySelectorAll("#downloadScopeControl button[data-scope]").forEach(btn => {
        const active = btn.dataset.scope === scopeValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadFormatControl button[data-format]").forEach(btn => {
        const active = btn.dataset.format === formatValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadIntervalControl button[data-export-interval]").forEach(btn => {
        const active = btn.dataset.exportInterval === intervalValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadAspectControl button[data-aspect]").forEach(btn => {
        const active = btn.dataset.aspect === aspectValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadExtentControl button[data-extent]").forEach(btn => {
        const active = btn.dataset.extent === extentValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll("#downloadSpeedControl button[data-speed]").forEach(btn => {
        const active = btn.dataset.speed === speedValue;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      const speedField = document.getElementById("gifSpeedField");
      if (speedField) speedField.hidden = formatValue !== "gif";
      const btnLabel = document.getElementById("downloadBtnLabel");
      if (btnLabel && !exportInProgress) {
        btnLabel.textContent = formatValue === "png" ? "Download PNG Frames" : "Download GIF";
      }
    }

    function resetExportPanelToDefaults() {
      if (exportInProgress) return;

      const setHidden = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
      };

      setHidden("downloadFormatSelect", "gif");
      setHidden("downloadIntervalSelect", "hourly");
      setHidden("downloadAspectSelect", "viewport");
      setHidden("downloadSpeedSelect", "normal");
      setHidden("downloadScopeSelect", "range");
      setHidden("downloadExtentSelect", "current");

      closeExportDateOrderPopup();
      setDownloadStatus("", false);
      updateExportSegmentedUI();
      syncDownloadRangeInputs(true);
      applyExportStageAspect("viewport");
      updateDownloadSummary();
      setTimeout(() => document.getElementById("downloadResetBtn")?.blur(), 0);
    }

    function setDownloadBusy(isBusy, message = "") {
      if (isBusy) {
        if (!exportInProgress) exportViewportBounds = getActiveMapBounds();
        exportCancelRequested = false;
      } else {
        exportViewportBounds = null;
        exportCancelRequested = false;
        activeGifExport = null;
      }
      exportInProgress = isBusy;
      const btn = document.getElementById("downloadBtn");
      const btnLabel = document.getElementById("downloadBtnLabel");
      const progressCloseBtn = document.getElementById("exportProgressCloseBtn");
      const scope = document.getElementById("downloadScopeSelect");
      const start = document.getElementById("downloadStartInput");
      const format = document.getElementById("downloadFormatSelect");
      const interval = document.getElementById("downloadIntervalSelect");
      const aspect = document.getElementById("downloadAspectSelect");
      const speed = document.getElementById("downloadSpeedSelect");
      const extent = document.getElementById("downloadExtentSelect");
      const end = document.getElementById("downloadEndInput");
      const exportEditorControls = [
        "downloadStartDateText",
        "downloadStartDatePicker",
        "downloadStartCalendarBtn",
        "downloadStartTimeSelect",
        "downloadEndDateText",
        "downloadEndDatePicker",
        "downloadEndCalendarBtn",
        "downloadEndTimeSelect"
      ].map(id => document.getElementById(id)).filter(Boolean);
      if (btn) {
        btn.disabled = isBusy;
        btn.classList.toggle("is-busy", isBusy);
      }
      if (btnLabel) {
        btnLabel.textContent = isBusy
          ? "Creating export..."
          : getDownloadFormatValue() === "png" ? "Download PNG Frames" : "Download GIF";
      }
      if (progressCloseBtn) {
        progressCloseBtn.disabled = false;
        progressCloseBtn.classList.toggle("is-cancel-action", isBusy);
        progressCloseBtn.textContent = isBusy ? "Cancel" : "×";
        progressCloseBtn.setAttribute("aria-label", isBusy ? "Cancel export" : "Hide export progress");
        progressCloseBtn.title = isBusy ? "Cancel export" : "Hide export progress";
      }
      if (scope) scope.disabled = isBusy;
      if (format) format.disabled = isBusy;
      if (interval) interval.disabled = isBusy;
      if (aspect) aspect.disabled = isBusy;
      if (speed) speed.disabled = isBusy;
      document.querySelectorAll("#downloadFormatControl button, #downloadIntervalControl button, #downloadAspectControl button, #downloadSpeedControl button").forEach(el => { el.disabled = isBusy; });
      const picker = document.getElementById("exportTimePicker");
      if (picker) picker.classList.toggle("is-busy", isBusy);
      if (start) start.disabled = isBusy;
      if (end) end.disabled = isBusy;
      const modeledDateLocked = currentDataMode === "return-interval";
      const modeledDateControlIds = new Set([
        "downloadStartDateText",
        "downloadStartDatePicker",
        "downloadStartCalendarBtn",
        "downloadEndDateText",
        "downloadEndDatePicker",
        "downloadEndCalendarBtn"
      ]);
      exportEditorControls.forEach(control => {
        control.disabled = isBusy || (modeledDateLocked && modeledDateControlIds.has(control.id));
      });
      if (isBusy) {
        setExportProgressVisible(true);
        setExportProgress(message || "Preparing export...", 0, false);
      }
      setDownloadStatus(message, false);
    }

