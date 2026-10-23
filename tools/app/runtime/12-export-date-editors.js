    function getExportEditorPrefixFromCanonicalId(id) {
      if (id === "downloadStartInput") return "start";
      if (id === "downloadEndInput") return "end";
      return "";
    }

    function getExportDateEditorElements(prefix) {
      const cap = prefix === "end" ? "End" : "Start";
      return {
        canonical: document.getElementById(`download${cap}Input`),
        dateText: document.getElementById(`download${cap}DateText`),
        datePicker: document.getElementById(`download${cap}DatePicker`),
        timeSelect: document.getElementById(`download${cap}TimeSelect`)
      };
    }

    const EXPORT_DATE_MASK = "MM/DD/YYYY";
    const MODELED_EXPORT_DATE_PLACEHOLDER = "xx/xx/xxxx";
    const EXPORT_DATE_MASK_POSITIONS = [0, 1, 3, 4, 6, 7, 8, 9];

    function exportDateMaskPlaceholderAt(index) {
      if (index < 2) return "M";
      if (index < 5) return "D";
      return "Y";
    }

    function formatExportDateMask(value) {
      const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
      const chars = EXPORT_DATE_MASK.split("");
      EXPORT_DATE_MASK_POSITIONS.forEach((position, index) => {
        chars[position] = digits[index] || exportDateMaskPlaceholderAt(position);
      });
      return chars.join("");
    }

    function normalizeExportDateMask(input) {
      if (!input) return EXPORT_DATE_MASK;
      const normalized = formatExportDateMask(input.value);
      if (input.value !== normalized) input.value = normalized;
      return normalized;
    }

    function getNextExportDateMaskPosition(index, direction = 1, includeCurrent = true) {
      let current = Number.isFinite(index) ? index : 0;
      if (!includeCurrent) current += direction;
      while (current >= 0 && current < EXPORT_DATE_MASK.length) {
        if (EXPORT_DATE_MASK_POSITIONS.includes(current)) return current;
        current += direction;
      }
      return direction > 0 ? EXPORT_DATE_MASK.length : 0;
    }

    function setExportDateMaskCaret(input, index) {
      if (!input) return;
      let position = Math.max(0, Math.min(EXPORT_DATE_MASK.length, Number(index) || 0));
      if (!EXPORT_DATE_MASK_POSITIONS.includes(position) && position < EXPORT_DATE_MASK.length) {
        position = getNextExportDateMaskPosition(position, 1, true);
      }
      requestAnimationFrame(() => {
        try { input.setSelectionRange(position, position); } catch (e) {}
      });
    }

    function clearExportDateMaskRange(chars, start, end) {
      EXPORT_DATE_MASK_POSITIONS.forEach(position => {
        if (position >= start && position < end) chars[position] = exportDateMaskPlaceholderAt(position);
      });
    }

    function insertExportDateMaskDigits(input, text) {
      normalizeExportDateMask(input);
      const digits = String(text || "").replace(/\D/g, "");
      if (!digits) return;
      const chars = input.value.split("");
      const start = input.selectionStart == null ? 0 : input.selectionStart;
      const end = input.selectionEnd == null ? start : input.selectionEnd;
      if (end > start) clearExportDateMaskRange(chars, start, end);
      let position = getNextExportDateMaskPosition(start, 1, true);
      for (const digit of digits) {
        if (position >= EXPORT_DATE_MASK.length) break;
        chars[position] = digit;
        position = getNextExportDateMaskPosition(position, 1, false);
      }
      input.value = chars.join("");
      setExportDateMaskCaret(input, position);
    }

    function deleteExportDateMaskDigits(input, backward) {
      normalizeExportDateMask(input);
      const chars = input.value.split("");
      const start = input.selectionStart == null ? 0 : input.selectionStart;
      const end = input.selectionEnd == null ? start : input.selectionEnd;
      let caret = start;
      if (end > start) {
        clearExportDateMaskRange(chars, start, end);
        caret = getNextExportDateMaskPosition(start, 1, true);
      } else if (backward) {
        const target = getNextExportDateMaskPosition(start, -1, false);
        if (EXPORT_DATE_MASK_POSITIONS.includes(target)) {
          chars[target] = exportDateMaskPlaceholderAt(target);
          caret = target;
        }
      } else {
        const target = getNextExportDateMaskPosition(start, 1, true);
        if (EXPORT_DATE_MASK_POSITIONS.includes(target)) {
          chars[target] = exportDateMaskPlaceholderAt(target);
          caret = target;
        }
      }
      input.value = chars.join("");
      setExportDateMaskCaret(input, caret);
    }

    function parseExportDateText(value) {
      const raw = String(value || "").trim();
      if (!raw || /[MDY]/i.test(raw)) return null;
      let year;
      let month;
      let day;
      const digits = raw.replace(/\D/g, "");
      let match = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
      if (match) {
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);
      } else {
        match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
        if (match) {
          month = Number(match[1]);
          day = Number(match[2]);
          year = Number(match[3]);
          if (year < 100) year += 2000;
        } else if (/^\d{8}$/.test(digits)) {
          month = Number(digits.slice(0, 2));
          day = Number(digits.slice(2, 4));
          year = Number(digits.slice(4, 8));
        } else {
          return null;
        }
      }
      if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
      const test = new Date(Date.UTC(year, month - 1, day));
      if (test.getUTCFullYear() !== year || test.getUTCMonth() !== month - 1 || test.getUTCDate() !== day) return null;
      return {
        year,
        month,
        day,
        isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
        displayDate: `${pad2(month)}/${pad2(day)}/${year}`
      };
    }

    function openExportDatePicker(prefix) {
      const elements = getExportDateEditorElements(prefix);
      const picker = elements.datePicker;
      if (!picker || picker.disabled) return;
      const parsed = parseExportDateText(elements.dateText?.value);
      const current = getRangeInputDate(elements.canonical?.id || "");
      const currentIso = current ? formatNyLocalIso(current).slice(0, 10) : "";
      picker.value = parsed?.isoDate || currentIso || picker.value || "";
      const rect = elements.dateText?.getBoundingClientRect?.();
      if (rect && rect.width && rect.height) {
        picker.style.left = `${Math.max(0, Math.round(rect.left))}px`;
        picker.style.top = `${Math.max(0, Math.round(rect.top))}px`;
        picker.style.width = `${Math.max(44, Math.round(rect.width))}px`;
        picker.style.height = `${Math.max(44, Math.round(rect.height))}px`;
      }
      try {
        if (typeof picker.showPicker === "function") {
          picker.showPicker();
          return;
        }
      } catch (e) {}
      try { picker.focus({ preventScroll: true }); } catch (e) { try { picker.focus(); } catch (ignore) {} }
      try { picker.click(); } catch (e) {}
    }

    function formatExportTimeLabel(value) {
      const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
      if (!match) return value || "";
      const hour24 = Number(match[1]);
      const minute = Number(match[2]);
      const period = hour24 >= 12 ? "PM" : "AM";
      const hour12 = hour24 % 12 || 12;
      return `${pad2(hour12)}:${pad2(minute)} ${period}`;
    }

    function populateExportTimeSelect(select, selectedValue = "00:00") {
      if (!select) return;
      const normalized = /^\d{2}:\d{2}$/.test(selectedValue) ? selectedValue : "00:00";
      const values = [];
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        values.push(`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`);
      }
      if (!values.includes(normalized)) values.push(normalized);
      values.sort();
      const existingValues = Array.from(select.options || [], option => option.value);
      const optionsAreCurrent = existingValues.length === values.length
        && existingValues.every((value, index) => value === values[index]);
      if (!optionsAreCurrent) {
        select.innerHTML = values.map(value => `<option value="${value}">${formatExportTimeLabel(value)}</option>`).join("");
      }
      select.value = normalized;
    }

    function syncExportDateTimeEditorFromCanonical(prefix) {
      const elements = getExportDateEditorElements(prefix);
      if (!elements.canonical || !elements.dateText || !elements.timeSelect) return;
      const modeledDateLocked = currentDataMode === "return-interval";
      const cap = prefix === "end" ? "End" : "Start";
      const calendarButton = document.getElementById(`download${cap}CalendarBtn`);
      elements.dateText.readOnly = modeledDateLocked;
      elements.dateText.disabled = exportInProgress || modeledDateLocked;
      elements.dateText.classList.toggle("modeled-date-locked", modeledDateLocked);
      elements.dateText.setAttribute(
        "aria-label",
        modeledDateLocked
          ? "Modeled storm date is not applicable"
          : `Export ${prefix} date in month day year format`
      );
      if (calendarButton) {
        calendarButton.hidden = modeledDateLocked;
        calendarButton.disabled = exportInProgress || modeledDateLocked;
      }
      if (elements.datePicker) elements.datePicker.disabled = exportInProgress || modeledDateLocked;
      const value = elements.canonical.value || "";
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (!match) {
        elements.dateText.value = modeledDateLocked ? MODELED_EXPORT_DATE_PLACEHOLDER : EXPORT_DATE_MASK;
        if (elements.datePicker) elements.datePicker.value = "";
        populateExportTimeSelect(elements.timeSelect, "00:00");
        return;
      }
      const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
      const timeValue = `${match[4]}:${match[5]}`;
      elements.dateText.value = modeledDateLocked
        ? MODELED_EXPORT_DATE_PLACEHOLDER
        : `${match[2]}/${match[3]}/${match[1]}`;
      elements.dateText.classList.remove("is-invalid");
      elements.dateText.removeAttribute("aria-invalid");
      if (elements.datePicker) elements.datePicker.value = isoDate;
      populateExportTimeSelect(elements.timeSelect, timeValue);
    }

    function commitExportDateTimeEditor(prefix, options = {}) {
      const elements = getExportDateEditorElements(prefix);
      if (!elements.canonical || !elements.dateText || !elements.timeSelect) return false;
      if (currentDataMode === "return-interval") {
        const canonicalMatch = elements.canonical.value.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}$/);
        if (!canonicalMatch) return false;
        const timeValue = /^\d{2}:\d{2}$/.test(elements.timeSelect.value) ? elements.timeSelect.value : "00:00";
        elements.canonical.value = `${canonicalMatch[1]}T${timeValue}`;
        if (options.markEdited) elements.canonical.dataset.userEdited = "1";
        elements.dateText.value = MODELED_EXPORT_DATE_PLACEHOLDER;
        elements.dateText.classList.remove("is-invalid");
        elements.dateText.removeAttribute("aria-invalid");
        return true;
      }
      const parsed = parseExportDateText(elements.dateText.value);
      if (!parsed) {
        elements.dateText.classList.add("is-invalid");
        elements.dateText.setAttribute("aria-invalid", "true");
        if (options.showError) setDownloadStatus("Enter the date as MM/DD/YYYY.", true);
        return false;
      }
      const timeValue = /^\d{2}:\d{2}$/.test(elements.timeSelect.value) ? elements.timeSelect.value : "00:00";
      elements.canonical.value = `${parsed.isoDate}T${timeValue}`;
      if (options.markEdited) elements.canonical.dataset.userEdited = "1";
      if (options.normalize !== false) elements.dateText.value = parsed.displayDate;
      elements.dateText.classList.remove("is-invalid");
      elements.dateText.removeAttribute("aria-invalid");
      if (elements.datePicker) elements.datePicker.value = parsed.isoDate;
      return true;
    }

    function commitAllExportDateTimeEditors(showError = false) {
      const startOk = commitExportDateTimeEditor("start", { showError, normalize: true });
      const endOk = commitExportDateTimeEditor("end", { showError, normalize: true });
      return startOk && endOk;
    }

    function getRangeInputDate(id) {
      const value = document.getElementById(id)?.value || "";
      return value ? parseStoredLocalNyToDate(value) : null;
    }

    function setRangeInputDate(id, date) {
      const input = document.getElementById(id);
      if (!input) return;
      input.value = date ? formatNyLocalIso(date) : "";
      const prefix = getExportEditorPrefixFromCanonicalId(id);
      if (prefix) syncExportDateTimeEditorFromCanonical(prefix);
    }

    function findStartIndexForTime(entries, targetMs) {
      if (!entries.length || targetMs == null) return 0;
      for (let i = 0; i < entries.length; i++) {
        const t = entryTimeMs(entries[i]);
        if (t != null && t >= targetMs) return i;
      }
      return Math.max(0, entries.length - 1);
    }

    function findEndIndexForTime(entries, targetMs) {
      if (!entries.length || targetMs == null) return Math.max(0, entries.length - 1);
      let lastIndex = 0;
      for (let i = 0; i < entries.length; i++) {
        const t = entryTimeMs(entries[i]);
        if (t == null) continue;
        if (t <= targetMs) {
          lastIndex = i;
        } else {
          break;
        }
      }
      return lastIndex;
    }

