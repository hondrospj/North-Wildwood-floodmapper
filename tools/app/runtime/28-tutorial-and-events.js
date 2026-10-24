    function getVisibleTutorialTarget(selector) {
      document.dispatchEvent(new CustomEvent("nww:reveal-control", {detail:selector}));
      return Array.from(document.querySelectorAll(selector)).find(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
      }) || document.querySelector(selector);
    }

    function positionMapperTutorial() {
      const step = MAPPER_TUTORIAL_STEPS[mapperTutorialIndex];
      const target = step ? getVisibleTutorialTarget(step.target) : null;
      const spotlight = document.getElementById("mapperTutorialSpotlight");
      const card = document.getElementById("mapperTutorialCard");
      if (!target || !spotlight || !card) return;
      const rect = target.getBoundingClientRect();
      const pad = 8;
      spotlight.style.left = Math.max(4, rect.left - pad) + "px";
      spotlight.style.top = Math.max(4, rect.top - pad) + "px";
      spotlight.style.width = Math.max(20, Math.min(window.innerWidth - 8, rect.width + pad * 2)) + "px";
      spotlight.style.height = Math.max(20, Math.min(window.innerHeight - 8, rect.height + pad * 2)) + "px";
      const cardRect = card.getBoundingClientRect();
      const gap = 18;
      const margin = 14;
      const width = Math.min(cardRect.width, window.innerWidth - margin * 2);
      const height = Math.min(cardRect.height, window.innerHeight - margin * 2);
      const clampLeft = value => Math.max(margin, Math.min(window.innerWidth - width - margin, value));
      const clampTop = value => Math.max(margin, Math.min(window.innerHeight - height - margin, value));
      const targetBox = {
        left: Math.max(0, rect.left - pad), top: Math.max(0, rect.top - pad),
        right: Math.min(window.innerWidth, rect.right + pad), bottom: Math.min(window.innerHeight, rect.bottom + pad)
      };
      const candidates = [
        [rect.right + gap, rect.top],
        [rect.left - width - gap, rect.top],
        [rect.left, rect.bottom + gap],
        [rect.left, rect.top - height - gap],
        [margin, margin],
        [window.innerWidth - width - margin, margin],
        [margin, window.innerHeight - height - margin],
        [window.innerWidth - width - margin, window.innerHeight - height - margin]
      ].map(([rawLeft, rawTop]) => ({ left: clampLeft(rawLeft), top: clampTop(rawTop) }));
      const overlapArea = candidate => {
        const overlapWidth = Math.max(0, Math.min(candidate.left + width, targetBox.right) - Math.max(candidate.left, targetBox.left));
        const overlapHeight = Math.max(0, Math.min(candidate.top + height, targetBox.bottom) - Math.max(candidate.top, targetBox.top));
        return overlapWidth * overlapHeight;
      };
      candidates.sort((a, b) => overlapArea(a) - overlapArea(b));
      const chosen = candidates[0];
      card.style.setProperty("left", chosen.left + "px", "important");
      card.style.setProperty("top", chosen.top + "px", "important");
      card.style.setProperty("right", "auto", "important");
      card.style.setProperty("bottom", "auto", "important");
    }

    function renderMapperTutorialStep() {
      const step = MAPPER_TUTORIAL_STEPS[mapperTutorialIndex];
      if (!step) return;
      const tutorialModePromise = mapperTutorialIndex === 1 && currentDataMode !== "forecast"
        ? switchDataMode("forecast")
        : (mapperTutorialIndex === 3 && currentDataMode !== "observed" ? switchDataMode("observed") : Promise.resolve());
      const target = getVisibleTutorialTarget(step.target);
      const compactTutorial = isCompactFloodmapperLayout();
      if (compactTutorial && target) {
        const needsDrawer = Boolean(target.closest("#leftPanel, #mobileRailMount"));
        setMobileControlsOpen(needsDrawer);
      }
      document.getElementById("mapperTutorialProgress").textContent = (mapperTutorialIndex + 1) + " of " + MAPPER_TUTORIAL_STEPS.length;
      document.getElementById("mapperTutorialTitle").textContent = step.title;
      document.getElementById("mapperTutorialBody").innerHTML = step.body;
      const back = document.getElementById("mapperTutorialBack");
      const next = document.getElementById("mapperTutorialNext");
      back.disabled = mapperTutorialIndex === 0;
      next.textContent = mapperTutorialIndex === MAPPER_TUTORIAL_STEPS.length - 1 ? "Finish" : "Next";
      window.setTimeout(async () => {
        try { await tutorialModePromise; } catch (err) {}
        const resolved = getVisibleTutorialTarget(step.target);
        const mobileBlockByStep = { 1: "start", 3: "end", 6: "end", 7: "start" };
        const block = compactTutorial ? (mobileBlockByStep[mapperTutorialIndex] || "center") : "center";
        resolved?.scrollIntoView({ block, inline: "center", behavior: "auto" });
        window.setTimeout(positionMapperTutorial, 80);
        window.setTimeout(positionMapperTutorial, 320);
      }, 40);
    }

    function setMapperTutorialOpen(open, startIndex = 0) {
      const tutorial = document.getElementById("mapperTutorial");
      if (!tutorial) return;
      tutorial.hidden = !open;
      tutorial.setAttribute("aria-hidden", open ? "false" : "true");
      document.body.classList.toggle("tutorial-active", Boolean(open));
      if (open) {
        mapperTutorialIndex = Math.max(0, Math.min(startIndex, MAPPER_TUTORIAL_STEPS.length - 1));
        renderMapperTutorialStep();
        mapperTutorialResizeHandler = () => positionMapperTutorial();
        window.addEventListener("resize", mapperTutorialResizeHandler);
        document.getElementById("mapperTutorialNext")?.focus();
      } else if (mapperTutorialResizeHandler) {
        window.removeEventListener("resize", mapperTutorialResizeHandler);
        mapperTutorialResizeHandler = null;
      }
    }

    function wireMapperTutorial() {
      document.getElementById("mapperTutorialBtn")?.addEventListener("click", () => setMapperTutorialOpen(true, 0));
      document.getElementById("mapperTutorialClose")?.addEventListener("click", () => setMapperTutorialOpen(false));
      document.getElementById("mapperTutorialBack")?.addEventListener("click", () => {
        if (mapperTutorialIndex > 0) {
          mapperTutorialIndex -= 1;
          renderMapperTutorialStep();
        }
      });
      document.getElementById("mapperTutorialNext")?.addEventListener("click", () => {
        if (mapperTutorialIndex >= MAPPER_TUTORIAL_STEPS.length - 1) setMapperTutorialOpen(false);
        else {
          mapperTutorialIndex += 1;
          renderMapperTutorialStep();
        }
      });
      document.addEventListener("keydown", event => {
        if (document.getElementById("mapperTutorial")?.hidden) return;
        if (event.key === "Escape") setMapperTutorialOpen(false);
        if (event.key === "ArrowRight") document.getElementById("mapperTutorialNext")?.click();
        if (event.key === "ArrowLeft") document.getElementById("mapperTutorialBack")?.click();
      });
    }

    function wireEvents() {
      floodmapperLayoutMedia.addEventListener("change", () => {
        syncMobileControlsLayout();
        syncLeftPanelLayout();
        renderTimelineMeta();
        positionTimelineBubble();
      });
      document.getElementById("topBannerCloseBtn")?.addEventListener("click", clearTopBanner);
      document.getElementById("toastCloseBtn")?.addEventListener("click", () => toast(""));
      document.getElementById("exportProgressCloseBtn")?.addEventListener("click", cancelCurrentExport);

      const timeSlider = document.getElementById("hourSlider");
      timeSlider.addEventListener("input", event => {
        stopPlayback();
        queueTimelineSelection(Number(event.target.value));
      });
      timeSlider.addEventListener("change", event => queueTimelineSelection(Number(event.target.value), true));
      timeSlider.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        // Step continuously across midnight even though the phone rail shows one day.
        event.preventDefault();
        stepTimeline(event.key === "ArrowLeft" ? -1 : 1);
      });
      document.getElementById("timelineStepBack")?.addEventListener("click", () => stepTimeline(-1));
      document.getElementById("timelineStepForward")?.addEventListener("click", () => stepTimeline(1));

      document.getElementById("intervalHourBtn")?.addEventListener("click", () => {
        setTimelineIntervalMinutes(60).catch(err => toast(err.message));
      });

      document.getElementById("intervalQuarterBtn")?.addEventListener("click", () => {
        setTimelineIntervalMinutes(15).catch(err => toast(err.message));
      });

      document.getElementById("intervalDailyBtn")?.addEventListener("click", () => {
        setTimelineIntervalMinutes(1440).catch(err => toast(err.message));
      });

      document.getElementById("opacitySlider").addEventListener("input", e => {
        overlayOpacity = Number(e.target.value) / 100;
        setOpacityText();
        applyOverlayOpacity();
      });

      document.getElementById("datumNavd88Btn").addEventListener("click", () => {
        if (currentDatum === "navd88") return;
        currentDatum = "navd88";
        refreshCurrentDisplayText();
      });

      document.getElementById("datumMllwBtn").addEventListener("click", () => {
        if (currentDatum === "mllw") return;
        currentDatum = "mllw";
        refreshCurrentDisplayText();
      });

      document.getElementById("forecastDataBtn").addEventListener("click", () => {
        switchDataMode("forecast").catch(err => toast(err.message));
      });

      document.getElementById("observedDataBtn").addEventListener("click", () => {
        switchDataMode("observed").catch(err => toast(err.message));
      });

      document.getElementById("returnIntervalDataBtn")?.addEventListener("click", () => {
        switchDataMode("return-interval").catch(err => toast(err.message));
      });

      document.getElementById("forecastLowBtn").addEventListener("click", () => {
        switchForecastScenario("lowEnd").catch(err => toast(err.message));
      });

      document.getElementById("forecastMeanBtn").addEventListener("click", () => {
        switchForecastScenario("mean").catch(err => toast(err.message));
      });

      document.getElementById("forecastHighBtn").addEventListener("click", () => {
        switchForecastScenario("highEnd").catch(err => toast(err.message));
      });

      document.querySelectorAll("[data-return-years]").forEach(button => {
        button.addEventListener("click", () => {
          switchReturnInterval(Number(button.dataset.returnYears)).catch(err => toast(err.message));
        });
      });

      document.getElementById("depthModeBtn").addEventListener("click", () => {
        switchOverlayMode("depth").catch(err => toast(err.message));
      });

      document.getElementById("dynamicModeBtn").addEventListener("click", () => {
        switchOverlayMode("dynamic").catch(err => toast(err.message));
      });

      const playButton = document.getElementById("playBtn");
      if (playButton) {
        playButton.disabled = false;
        playButton.removeAttribute("disabled");
        playButton.removeAttribute("title");
        playButton.style.pointerEvents = "auto";
        updatePlayPauseButton();

        const isInsidePlayButton = event => {
          if (!event || typeof event.clientX !== "number" || typeof event.clientY !== "number") return false;
          const rect = playButton.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;

          const pad = 12;
          const x = event.clientX;
          const y = event.clientY;
          return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
        };

        const activatePlay = event => {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          }


          const now = performance.now ? performance.now() : Date.now();
          const lockedUntil = Number(playButton.dataset.playLockedUntil || 0);
          if (now < lockedUntil) return;
          playButton.dataset.playLockedUntil = String(now + 240);

          playButton.classList.add("just-pressed");
          window.setTimeout(() => playButton.classList.remove("just-pressed"), 160);
          togglePlayback(event);
        };

        playButton.addEventListener("pointerdown", activatePlay, { capture:true });
        playButton.addEventListener("click", activatePlay, { capture:true });
        playButton.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") activatePlay(event);
        });


        document.addEventListener("pointerdown", event => {
          if (playButton.contains(event.target)) return;
          // The enlarged hit area must not intercept dialogs or other buttons.
          if (!event.target?.closest?.("#timelineDock") || event.target.closest("button, input, select, a")) return;
          if (isInsidePlayButton(event)) activatePlay(event);
        }, { capture:true });
      }
      const stopBtn = document.getElementById("stopBtn");
      if (stopBtn) stopBtn.addEventListener("click", stopPlayback);

      const reloadBtn = document.getElementById("reloadBtn");
      if (reloadBtn) {
        reloadBtn.addEventListener("click", () => {
          reloadAll().catch(err => toast(err.message));
        });
      }

      document.getElementById("prevMonthBtn").addEventListener("click", () => {
        const idx = observedMonthKeys.indexOf(currentMonthKey);
        if (idx > 0) {
          currentMonthKey = observedMonthKeys[idx - 1];
          renderCalendar().catch(err => toast(err.message));
        }
      });

      document.getElementById("nextMonthBtn").addEventListener("click", () => {
        const idx = observedMonthKeys.indexOf(currentMonthKey);
        if (idx >= 0 && idx < observedMonthKeys.length - 1) {
          currentMonthKey = observedMonthKeys[idx + 1];
          renderCalendar().catch(err => toast(err.message));
        }
      });

      document.getElementById("dataSourceHelpBtn")?.addEventListener("click", e => {
        e.stopPropagation();
        showInfoModal("dataSource");
      });
      document.getElementById("forecastTypeHelpBtn")?.addEventListener("click", e => {
        e.stopPropagation();
        showInfoModal("forecastType");
      });
      document.getElementById("returnIntervalHelpBtn")?.addEventListener("click", e => {
        e.stopPropagation();
        showInfoModal("returnIntervals");
      });
      document.getElementById("overlayHelpBtn")?.addEventListener("click", e => {
        e.stopPropagation();
        showInfoModal("overlay");
      });
      document.getElementById("timelineDetailHelpBtn")?.addEventListener("click", e => {
        e.stopPropagation();
        showInfoModal("timelineDetail");
      });
      document.getElementById("legendHelpBtn")?.addEventListener("click", e => {
        e.stopPropagation();
        showLegendInfoModal();
      });
      document.getElementById("infoModalCloseBtn")?.addEventListener("click", () => setInfoModalOpen(false));
      document.getElementById("infoModal")?.addEventListener("click", e => {
        if (e.target === e.currentTarget) setInfoModalOpen(false);
      });

      document.getElementById("datumHelpBtn").addEventListener("click", e => {
        e.stopPropagation();
        setDatumHelpOpen(true);
      });

      document.getElementById("datumModalCloseBtn").addEventListener("click", () => {
        setDatumHelpOpen(false);
      });

      document.getElementById("datumModal").addEventListener("click", e => {
        if (e.target === e.currentTarget) {
          setDatumHelpOpen(false);
        }
      });

      document.getElementById("openDownloadModalBtn").addEventListener("click", () => {
        setDownloadModalOpen(true);
        window.setTimeout(warmExportLibraries, 0);
      });

      document.getElementById("downloadModalCloseBtn").addEventListener("click", () => {
        setDownloadModalOpen(false);
      });

      document.getElementById("downloadResetBtn")?.addEventListener("click", resetExportPanelToDefaults);

      document.getElementById("exportOrderModalCloseBtn")?.addEventListener("click", closeExportDateOrderPopup);
      document.getElementById("exportOrderModalOkBtn")?.addEventListener("click", closeExportDateOrderPopup);
      document.getElementById("exportOrderModal")?.addEventListener("click", e => {
        if (e.target === e.currentTarget) closeExportDateOrderPopup();
      });

      const stopPlaybackFromPrompt = () => {
        stopPlayback();
        setPlaybackStillThereOpen(false);
      };
      document.getElementById("playbackStillThereCloseBtn")?.addEventListener("click", stopPlaybackFromPrompt);
      document.getElementById("playbackStillThereStopBtn")?.addEventListener("click", stopPlaybackFromPrompt);
      document.getElementById("playbackStillThereContinueBtn")?.addEventListener("click", continuePlaybackAfterDayConfirmation);
      document.getElementById("playbackStillThereModal")?.addEventListener("click", event => {
        if (event.target === event.currentTarget) stopPlaybackFromPrompt();
      });

      document.getElementById("downloadModal").addEventListener("click", e => {
        if (e.target === e.currentTarget) {
          setDownloadModalOpen(false);
        }
      });

      document.addEventListener("keydown", e => {
        if (e.key === "Escape") {
          setDatumHelpOpen(false);
          setInfoModalOpen(false);
          setDownloadModalOpen(false);
          if (!document.getElementById("calendarPopover")?.classList.contains("open")) setObservedCalendarOpen(false);
          setCalendarPopoverOpen(false);
          setTopTidesModalOpen(false);
          closeExportDateOrderPopup();
          if (playbackPausedForConfirmation) stopPlayback();
          setPlaybackStillThereOpen(false);
          if (exportInProgress && isExportProgressOpen()) cancelCurrentExport();
          else setExportProgressVisible(false);
          toast("");
        }
      });

      document.getElementById("prevDayBtn").addEventListener("click", () => {
        const date = getNeighborObservedDate(selectedObservedDate, -1);
        if (date) loadObservedDay(date).catch(err => toast(err.message));
      });

      document.getElementById("nextDayBtn").addEventListener("click", () => {
        const date = getNeighborObservedDate(selectedObservedDate, 1);
        if (date) loadObservedDay(date).catch(err => toast(err.message));
      });

      document.getElementById("observedCalendarOpenBtn").addEventListener("click", () => setObservedCalendarOpen(true));
      document.getElementById("observedCalendarCloseBtn").addEventListener("click", () => setObservedCalendarOpen(false));
      document.getElementById("observedCalendarModal").addEventListener("click", event => {
        if (event.target === event.currentTarget) setObservedCalendarOpen(false);
      });

      document.getElementById("calendarTitleBtn").addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const popover = ensureCalendarPopoverIsBodyChild();
        const open = !(popover && popover.classList.contains("open"));
        setCalendarPopoverOpen(open);
      });

      document.getElementById("calendarPopoverCloseBtn")?.addEventListener("click", () => setCalendarPopoverOpen(false));

      document.getElementById("calendarGoBtn").addEventListener("click", () => {
        closeWindowsDatebarMenus();
        goToCalendarSelection().then(() => setCalendarPopoverOpen(false)).catch(err => toast(err.message));
      });

      document.getElementById("calendarPopover").addEventListener("click", e => {
        e.stopPropagation();
      });

      document.addEventListener("click", e => {
        const popover = document.getElementById("calendarPopover");
        const titleBtn = document.getElementById("calendarTitleBtn");
        if (!popover || !popover.classList.contains("open")) return;
        if (popover.contains(e.target) || titleBtn?.contains(e.target)) return;
        setCalendarPopoverOpen(false);
      });

      document.addEventListener("keydown", e => {
        if (e.key === "Escape") setCalendarPopoverOpen(false);
      });

      const observedDateInput = document.getElementById("observedDateInput");
      if (observedDateInput) {
        observedDateInput.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitTypedObservedDate().catch(err => toast(err.message));
          }
          if (e.key === "Escape") {
            observedDateInput.value = selectedObservedDate ? formatSelectedObservedDate(selectedObservedDate) : "";
            observedDateInput.blur();
          }
        });
        observedDateInput.addEventListener("blur", () => {
          const typed = observedDateInput.value.trim();
          const currentDisplay = selectedObservedDate ? formatSelectedObservedDate(selectedObservedDate) : "";
          if (!typed || typed === currentDisplay) {
            observedDateInput.value = currentDisplay;
            return;
          }
          submitTypedObservedDate().catch(err => toast(err.message));
        });
        observedDateInput.addEventListener("focus", () => observedDateInput.select());
      }

      document.querySelectorAll("#downloadScopeControl button[data-scope]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          const input = document.getElementById("downloadScopeSelect");
          if (!input) return;
          input.value = btn.dataset.scope || "current";
          document.querySelectorAll("#downloadScopeControl button[data-scope]").forEach(other => other.classList.toggle("active", other === btn));
          if (!exportInProgress) setDownloadStatus("", false);
          updateExportSegmentedUI();
          syncDownloadRangeInputs(true);
          updateDownloadSummary();
        });
      });

      document.getElementById("downloadScopeSelect").addEventListener("change", () => {
        if (!exportInProgress) setDownloadStatus("", false);
        updateExportSegmentedUI();
        syncDownloadRangeInputs(true);
        updateDownloadSummary();
      });

      document.querySelectorAll("#downloadFormatControl button[data-format]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          const input = document.getElementById("downloadFormatSelect");
          if (!input) return;
          const previousFormat = getDownloadFormatValue();
          input.value = btn.dataset.format || "gif";
          if (input.value !== previousFormat && input.value === "png") {
            const endEl = document.getElementById("downloadEndInput");
            if (endEl) delete endEl.dataset.userEdited;
          }
          if (!exportInProgress) setDownloadStatus("", false);
          applyExportStageAspect(getDownloadAspectValue());
          updateExportSegmentedUI();
          scheduleExportTimePickerRender(true);
          updateDownloadSummary();
        });
      });

      document.querySelectorAll("#downloadIntervalControl button[data-export-interval]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          const input = document.getElementById("downloadIntervalSelect");
          if (!input) return;
          input.value = btn.dataset.exportInterval || "hourly";
          if (!exportInProgress) setDownloadStatus("", false);
          updateExportSegmentedUI();
          scheduleExportTimePickerRender(true);
          updateDownloadSummary();
        });
      });

      document.getElementById("downloadIntervalSelect")?.addEventListener("change", () => {
        if (!exportInProgress) setDownloadStatus("", false);
        updateExportSegmentedUI();
        scheduleExportTimePickerRender(true);
        updateDownloadSummary();
      });

      document.querySelectorAll("#downloadAspectControl button[data-aspect]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          const input = document.getElementById("downloadAspectSelect");
          if (!input) return;
          input.value = btn.dataset.aspect || "viewport";
          if (!exportInProgress) setDownloadStatus("", false);
          applyExportStageAspect(input.value);
          updateExportSegmentedUI();
          updateDownloadSummary();
        });
      });

      document.getElementById("downloadAspectSelect")?.addEventListener("change", () => {
        if (!exportInProgress) setDownloadStatus("", false);
        applyExportStageAspect(getDownloadAspectValue());
        updateExportSegmentedUI();
        updateDownloadSummary();
      });

document.querySelectorAll("#downloadExtentControl button[data-extent]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          const input = document.getElementById("downloadExtentSelect");
          if (!input) return;
          input.value = btn.dataset.extent || "current";
          if (!exportInProgress) setDownloadStatus("", false);
          updateExportSegmentedUI();
          updateDownloadSummary();
        });
      });

      document.getElementById("downloadExtentSelect")?.addEventListener("change", () => {
        if (!exportInProgress) setDownloadStatus("", false);
        updateExportSegmentedUI();
        updateDownloadSummary();
      });

      document.getElementById("adjustExportViewBtn")?.addEventListener("click", event => {
        event.preventDefault();
        const extentInput = document.getElementById("downloadExtentSelect");
        if (extentInput) extentInput.value = "current";
        updateExportSegmentedUI();
        setDownloadModalOpen(false);
        toast("Zoom or pan the map to the area you want, then reopen Export and keep Current View selected.");
      });

      document.querySelectorAll("#downloadSpeedControl button[data-speed]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          const input = document.getElementById("downloadSpeedSelect");
          if (!input) return;
          input.value = btn.dataset.speed || "normal";
          if (!exportInProgress) setDownloadStatus("", false);
          updateExportSegmentedUI();
          updateDownloadSummary();
        });
      });

      document.getElementById("downloadSpeedSelect")?.addEventListener("change", () => {
        if (!exportInProgress) setDownloadStatus("", false);
        updateExportSegmentedUI();
        updateDownloadSummary();
      });

      ["start", "end"].forEach(prefix => {
        const cap = prefix === "end" ? "End" : "Start";
        document.getElementById(`export${cap}CalendarPrevBtn`)?.addEventListener("click", () => {
          const cursor = getExportCalendarCursor(prefix) || new Date();
          setExportCalendarCursor(prefix, shiftExportMonth(cursor, getExportCalendarViewMode(prefix) === "year" ? -12 : -1));
          scheduleExportTimePickerRender(true);
        });
        document.getElementById(`export${cap}CalendarNextBtn`)?.addEventListener("click", () => {
          const cursor = getExportCalendarCursor(prefix) || new Date();
          setExportCalendarCursor(prefix, shiftExportMonth(cursor, getExportCalendarViewMode(prefix) === "year" ? 12 : 1));
          scheduleExportTimePickerRender(true);
        });
        document.getElementById(`export${cap}CalendarTitle`)?.addEventListener("click", event => {
          event.preventDefault();
          setExportCalendarViewMode(prefix, getExportCalendarViewMode(prefix) === "year" ? "month" : "year");
          scheduleExportTimePickerRender(true);
        });
      });

      document.getElementById("exportStartPickedDate")?.addEventListener("click", () => {
        setExportPickMode("start", true);
        const date = getRangeInputDate("downloadStartInput");
        if (date) setExportCalendarCursor("start", date);
        setExportCalendarViewMode("start", "month");
        scheduleExportTimePickerRender(true);
      });
      document.getElementById("exportEndPickedDate")?.addEventListener("click", () => {
        setExportPickMode("end", true);
        const date = getRangeInputDate("downloadEndInput");
        if (date) setExportCalendarCursor("end", date);
        setExportCalendarViewMode("end", "month");
        scheduleExportTimePickerRender(true);
      });

      document.getElementById("clearPngSelectionsBtn")?.addEventListener("click", () => {
        exportPngSelections.clear();
        scheduleExportTimePickerRender(true);
        updateDownloadSummary();
      });

      ["start", "end"].forEach(prefix => {
        ["month", "day", "year", "hour"].forEach(part => {
          const select = getExportWheelSelect(prefix, part);
          if (!select) return;
          select.addEventListener("change", () => {
            if (!exportInProgress) setDownloadStatus("", false);
            handleExportDateTimeWheelChange(prefix);
          });
          select.addEventListener("input", () => {
            if (!exportInProgress) setDownloadStatus("", false);
            handleExportDateTimeWheelChange(prefix);
          });
        });
        const manual = getExportWheelSelect(prefix, "manual");
        if (manual) {
          const activateThisPicker = () => {
            setExportPickMode(prefix, true);
            scheduleExportTimePickerRender(true);
          };
          manual.addEventListener("focus", activateThisPicker);
          manual.addEventListener("click", activateThisPicker);
          let manualInputTimer = null;
          manual.addEventListener("input", () => {
            const formatted = formatExportManualTyping(manual.value);
            if (manual.value !== formatted) {
              manual.value = formatted;
              try { manual.setSelectionRange(manual.value.length, manual.value.length); } catch (e) {}
            }
            if (manualInputTimer) clearTimeout(manualInputTimer);
            manualInputTimer = setTimeout(() => handleExportManualInput(prefix), 180);
          });
          manual.addEventListener("change", () => handleExportManualInput(prefix));
          manual.addEventListener("blur", () => {
            const formatted = formatExportManualTyping(manual.value);
            if (formatted) manual.value = formatted;
            handleExportManualInput(prefix);
          });
        }
      });

      document.querySelectorAll("[data-export-ampm-prefix][data-export-ampm]").forEach(btn => {
        btn.addEventListener("click", event => {
          event.preventDefault();
          if (!exportInProgress) setDownloadStatus("", false);
          handleExportAmPmToggle(btn.dataset.exportAmpmPrefix, btn.dataset.exportAmpm);
        });
      });

      ["start", "end"].forEach(prefix => {
        const cap = prefix === "end" ? "End" : "Start";
        const elements = getExportDateEditorElements(prefix);
        if (!elements.canonical || !elements.dateText || !elements.timeSelect) return;
        const refresh = () => {
          if (!exportInProgress) setDownloadStatus("", false);
          syncExportHourSelectsFromInputs();
          scheduleExportTimePickerRender(true);
          updateDownloadSummary();
        };
        normalizeExportDateMask(elements.dateText);
        elements.dateText.addEventListener("focus", () => {
          normalizeExportDateMask(elements.dateText);
          const firstOpen = elements.dateText.value.search(/[MDY]/);
          setExportDateMaskCaret(elements.dateText, firstOpen >= 0 ? firstOpen : 0);
        });
        elements.dateText.addEventListener("click", () => {
          const start = elements.dateText.selectionStart == null ? 0 : elements.dateText.selectionStart;
          setExportDateMaskCaret(elements.dateText, start);
        });
        elements.dateText.addEventListener("beforeinput", event => {
          const type = String(event.inputType || "");
          if (type.startsWith("insert")) {
            const text = event.data || (event.dataTransfer ? event.dataTransfer.getData("text") : "");
            if (text && /\d/.test(text)) {
              event.preventDefault();
              insertExportDateMaskDigits(elements.dateText, text);
            } else if (type !== "insertCompositionText") {
              event.preventDefault();
            }
          } else if (type === "deleteContentBackward" || type === "deleteWordBackward" || type === "deleteSoftLineBackward") {
            event.preventDefault();
            deleteExportDateMaskDigits(elements.dateText, true);
          } else if (type.startsWith("delete")) {
            event.preventDefault();
            deleteExportDateMaskDigits(elements.dateText, false);
          }
          elements.canonical.dataset.userEdited = "1";
          elements.dateText.classList.remove("is-invalid");
          elements.dateText.removeAttribute("aria-invalid");
          if (!exportInProgress) setDownloadStatus("", false);
        });
        elements.dateText.addEventListener("paste", event => {
          event.preventDefault();
          insertExportDateMaskDigits(elements.dateText, event.clipboardData?.getData("text") || "");
          elements.canonical.dataset.userEdited = "1";
        });
        elements.dateText.addEventListener("input", () => {
          normalizeExportDateMask(elements.dateText);
          elements.canonical.dataset.userEdited = "1";
          elements.dateText.classList.remove("is-invalid");
          elements.dateText.removeAttribute("aria-invalid");
          if (!exportInProgress) setDownloadStatus("", false);
        });
        elements.dateText.addEventListener("keydown", event => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (commitExportDateTimeEditor(prefix, { markEdited: true, showError: true, normalize: true })) refresh();
            elements.dateText.blur();
          } else if (event.key === "Backspace") {
            event.preventDefault();
            deleteExportDateMaskDigits(elements.dateText, true);
          } else if (event.key === "Delete") {
            event.preventDefault();
            deleteExportDateMaskDigits(elements.dateText, false);
          } else if (event.key === "Home") {
            event.preventDefault();
            setExportDateMaskCaret(elements.dateText, 0);
          } else if (event.key === "End") {
            event.preventDefault();
            setExportDateMaskCaret(elements.dateText, EXPORT_DATE_MASK.length);
          }
        });
        elements.dateText.addEventListener("blur", () => {
          if (commitExportDateTimeEditor(prefix, { markEdited: true, showError: false, normalize: true })) {
            refresh();
          } else {
            syncExportDateTimeEditorFromCanonical(prefix);
          }
        });
        elements.timeSelect.addEventListener("change", () => {
          if (commitExportDateTimeEditor(prefix, { markEdited: true, showError: true, normalize: true })) refresh();
        });
        const calendarButton = document.getElementById(`download${cap}CalendarBtn`);
        calendarButton?.addEventListener("click", event => {
          event.preventDefault();
          openExportDatePicker(prefix);
        });
        if (elements.datePicker) {
          const applyPickerValue = () => {
            const match = String(elements.datePicker.value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!match) return;
            elements.dateText.value = `${match[2]}/${match[3]}/${match[1]}`;
            if (commitExportDateTimeEditor(prefix, { markEdited: true, showError: true, normalize: true })) refresh();
          };
          elements.datePicker.addEventListener("input", applyPickerValue);
          elements.datePicker.addEventListener("change", applyPickerValue);
        }
      });
      document.getElementById("downloadBtn").addEventListener("click", () => {
        downloadCurrentSelection().catch(err => {
          const format = getDownloadFormatValue();
          const friendlyMessage = getFriendlyExportError(err, format);
          console.error(err);
          toast(friendlyMessage);
          setDownloadStatus(friendlyMessage, true);
        });
      });

      document.getElementById("timelineDock").addEventListener("wheel", e => {
        if (currentDataMode !== "observed" || !currentSeriesHours.length) return;
        e.preventDefault();
        stopPlayback();
        stepSeriesBy(e.deltaY > 0 ? 1 : -1).catch(err => toast(err.message));
      }, { passive: false });

      document.addEventListener("keydown", e => {
        if (currentDataMode !== "observed" || !currentSeriesHours.length) return;
        if (e.target?.closest?.('[role="dialog"], #calendarPopover, #mapperTutorial')) return;
        const tag = String(document.activeElement?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        if (e.key === "ArrowRight") {
          e.preventDefault();
          stopPlayback();
          stepSeriesBy(1).catch(err => toast(err.message));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          stopPlayback();
          stepSeriesBy(-1).catch(err => toast(err.message));
        } else if (e.key === "Escape") {
          setDatumHelpOpen(false);
          setInfoModalOpen(false);
        }
      });

      const topTidesModal = document.getElementById("topTidesModal");
      document.getElementById("topTidesModalCloseBtn")?.addEventListener("click", () => setTopTidesModalOpen(false));
      topTidesModal?.addEventListener("click", e => {
        if (e.target === e.currentTarget) setTopTidesModalOpen(false);
      });
      document.addEventListener("keydown", e => {
        if (e.key === "Escape") setTopTidesModalOpen(false);
      });

      wireLayerToggles();
      wireMapperTutorial();
    }

    async function main() {
      document.body.dataset.initialFloodFrame = "loading";
      document.body.dataset.deferredMapLayers = "waiting";
      ensureMap();
      const boundaryReady = loadMunicipalBoundary().catch(() => {});
      setOpacityText();
      updateDatumUI();
      updateObservedResolutionUI();
      updateModeButtons();
      updateDataModeButtons();
      setDatumHelpOpen(false);
      setInfoModalOpen(false);
      setDownloadModalOpen(false);
      wireEvents();
      wireTownAddressLookup();
      wireFloodHistoryPane();
      ensureCalendarPopoverIsBodyChild();
      initWindowsCalendarDatebar();
      wireMobileControlShell();
      updateRoadLayerAppearance();
      updateExportSegmentedUI();
      syncDownloadRangeInputs(true);
      updateDownloadSummary();
      scheduleMapTitleFit();
      if (typeof ResizeObserver === "function") {
        const titleModeObserver = new ResizeObserver(positionMapClickModeControl);
        const titleBadge = document.getElementById("mapTitleBadge");
        if (titleBadge) titleModeObserver.observe(titleBadge);
      }
      window.addEventListener('resize', () => {
        if (map) {
          map.invalidateSize();
          updateColorBasemapClip();
        }
        syncMobileControlsLayout();
        syncLeftPanelLayout();
        positionTimelineBubble();
        fitSnapshotTimeText();
        scheduleMapTitleFit();
        positionMapClickModeControl();
      });
      requestAnimationFrame(() => {
        if (map) {
          map.invalidateSize();
          updateColorBasemapClip();
        }
        syncMobileControlsLayout();
        syncLeftPanelLayout();
        positionTimelineBubble();
        fitSnapshotTimeText();
        scheduleMapTitleFit();
      });
      startNwsAlertRefresh();
      await Promise.all([reloadAll(), boundaryReady]);
    }

    function applyMobileObservedOrdering() {
      const leftPanel = document.getElementById("leftPanel");
      if (!leftPanel || !document.body.classList.contains("mobile-optimized")) return;
      const afterDataSource = document.querySelector(".data-source-card");
      const order = [
        document.getElementById("forecastScenarioCard"),
        document.getElementById("calendarCard"),
        document.getElementById("returnIntervalCard"),
        document.querySelector(".overlay-card"),
        document.querySelector(".datum-card"),
        document.querySelector(".opacity-card"),
        document.querySelector(".mobile-top-tides-card"),
        document.querySelector(".snapshot-card")
      ].filter(Boolean);
      let anchor = afterDataSource;
      order.forEach(node => {
        if (node.parentNode === leftPanel) {
          const next = anchor ? anchor.nextSibling : leftPanel.firstChild;
          // Do not detach an already ordered card during a pointer gesture.
          if (node !== next) leftPanel.insertBefore(node, next);
          anchor = node;
        }
      });
      const mobileRailMount = document.getElementById("mobileRailMount");
      if (mobileRailMount) {
        const exportCard = mobileRailMount.querySelector(".download-launch-card, .download-card");
        const addressCard = mobileRailMount.querySelector("#townAddressCard, .town-address-card");
        if (exportCard && addressCard && exportCard.nextSibling !== addressCard) {
          mobileRailMount.insertBefore(exportCard, addressCard);
        }
      }
    }

    const _shorelyOriginalSetMobileControlsOpen = setMobileControlsOpen;
    setMobileControlsOpen = function(isOpen) {
      _shorelyOriginalSetMobileControlsOpen(isOpen);
      window.setTimeout(applyMobileObservedOrdering, 0);
      window.setTimeout(applyMobileObservedOrdering, 120);
    };

    const _shorelyOriginalSyncMobileControlsLayout = syncMobileControlsLayout;
    syncMobileControlsLayout = function() {
      _shorelyOriginalSyncMobileControlsLayout();
      applyMobileObservedOrdering();
    };

    const _shorelyOriginalSwitchDataMode = switchDataMode;
    switchDataMode = async function(mode) {
      const result = await _shorelyOriginalSwitchDataMode(mode);
      applyMobileObservedOrdering();
      return result;
    };

  