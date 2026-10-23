    function formatLocalBannerTime(value) {
      if (!value) return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "";
      return formatFixedESTFromUtc(d.toISOString());
    }

    async function checkNwsAlerts() {
      if (TOWN_CONFIG?.alerts?.enabled === false) {
        setBanner(false);
        document.body.dataset.nwsAlertState = "disabled";
        return "disabled";
      }
      if (nwsAlertPromise) return nwsAlertPromise;
      nwsAlertPromise = (async () => {
        const zoneCodes = new Set((TOWN_CONFIG?.alerts?.zoneCodes || []).filter(Boolean).map(String));
        let incomplete = false;
        if (NWS_POINT_URL) {
          try {
            const point = await fetchJson(NWS_POINT_URL, { timeoutMs: 15000 });
            [point?.properties?.forecastZone, point?.properties?.county].forEach(url => {
              const code = String(url || "").split("/").pop();
              if (code) zoneCodes.add(code);
            });
          } catch (error) { incomplete = true; }
        }
        const allFeatures = [];
        await Promise.all(Array.from(zoneCodes, async zoneCode => {
          try {
            const alerts = await fetchJson(`https://api.weather.gov/alerts/active?zone=${encodeURIComponent(zoneCode)}`,
              { timeoutMs: 15000 });
            if (!Array.isArray(alerts?.features)) throw new Error("Invalid alert response");
            allFeatures.push(...alerts.features);
          } catch (error) { incomplete = true; }
        }));
        const seen = new Set();
        const floodAlerts = allFeatures.filter(feature => {
          const id = String(feature?.id || feature?.properties?.id || "");
          if (id && seen.has(id)) return false;
          if (id) seen.add(id);
          return /(coastal flood|storm surge|lakeshore flood|flood warning|flood watch|flood advisory)/i.test(feature?.properties?.event || "");
        });
        const unavailable = incomplete || !zoneCodes.size;
        if (!unavailable) lastSuccessfulNwsAlerts = { features: floodAlerts, checkedAt: new Date().toISOString() };
        const shown = floodAlerts.length ? floodAlerts : unavailable ? (lastSuccessfulNwsAlerts?.features || []) : [];
        const state = unavailable ? (lastSuccessfulNwsAlerts ? "stale" : "unavailable") : shown.length ? "active" : "none";
        document.body.dataset.nwsAlertState = state;
        const primary = shown[0]?.properties || {};
        const checked = lastSuccessfulNwsAlerts?.checkedAt;
        const meta = unavailable
          ? `Alert updates unavailable${checked ? "; last checked " + formatLocalBannerTime(checked) : ". Please check weather.gov"}`
          : [primary.severity, primary.expires ? `Until ${formatLocalBannerTime(primary.expires)}` : ""].filter(Boolean).join(" • ");
        setBanner(unavailable || shown.length > 0, primary.event || (unavailable ? "Flood alert status unavailable" : "No active flood alerts"), meta, shown.length);
        const countLabel = document.getElementById("bannerCount");
        if (unavailable && countLabel) countLabel.textContent = shown.length ? `${shown.length} last reported` : "Status unknown";
        return state;
      })().finally(() => { nwsAlertPromise = null; });
      return nwsAlertPromise;
    }

    function startNwsAlertRefresh() {
      if (nwsAlertRefreshTimer !== null) window.clearInterval(nwsAlertRefreshTimer);
      nwsAlertRefreshTimer = null;
      if (TOWN_CONFIG?.alerts?.enabled === false) { setBanner(false); return; }
      checkNwsAlerts().catch(error => console.warn("Flood alert refresh failed.", error));
      nwsAlertRefreshTimer = window.setInterval(() => {
        checkNwsAlerts().catch(error => console.warn("Flood alert refresh failed.", error));
      }, 5 * 60 * 1000);
    }

    function formatExpectedFloodCount(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      if (n > 0 && n < 1) return "<1";
      return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 1 : 0);
    }

    function formatFloodIntervalValue(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      if (n <= 0) return "0";
      if (n < 0.1) return "<0.1";
      if (n < 10) return n.toFixed(1);
      return n >= 100 ? Math.round(n).toLocaleString() : Math.round(n).toString();
    }

    const FLOOD_PROJECTION_SCENARIOS = {
      observedTrend: { label: "Existing trend", color: "#e2e8f0" },
      low: { label: "NOAA Low", color: "#2dd4bf" },
      intermediateLow: { label: "NOAA Int. Low", color: "#38bdf8" },
      intermediate: { label: "NOAA Intermediate", color: "#facc15" },
      intermediateHigh: { label: "NOAA Int. High", color: "#fb923c" },
      high: { label: "NOAA High", color: "#fb7185" }
    };
    let selectedFloodProjectionScenario = "intermediate";

    function openPersistentFloodPopup(latlng, html, maxWidth = 360) {
      if (!map) ensureMap();
      persistentDepthQueryContext = null;
      if (persistentFloodPopup && map.hasLayer(persistentFloodPopup)) {
        map.removeLayer(persistentFloodPopup);
      }
      const mobilePopup = isCompactFloodmapperLayout();
      const compactLandscapePopup = mobilePopup && window.innerHeight <= 560 && window.innerWidth > window.innerHeight;
      const desktopRightRailWidth = mobilePopup
        ? 0
        : Math.ceil(document.getElementById("rightRail")?.getBoundingClientRect().width || 0);
      const isHouseAlertPopup = String(html).includes("house-alert-popup");
      const isDepthQueryPopup = String(html).includes("depth-query-popup");
      const requestedPopupWidth = compactLandscapePopup && isHouseAlertPopup ? 520 : maxWidth;
      const viewportPopupWidth = mobilePopup
        ? Math.max(240, Math.min(requestedPopupWidth, window.innerWidth - 28))
        : requestedPopupWidth;
      const popup = L.popup({
        className: isDepthQueryPopup ? "shorely-flood-popup shorely-depth-popup" : "shorely-flood-popup",
        maxWidth: viewportPopupWidth,
        minWidth: 0,
        autoClose: false,
        closeOnClick: false,
        closeButton: true,
        keepInView: !document.body.classList.contains("map-3d-ready"),
        autoPan: !document.body.classList.contains("map-3d-ready"),
        autoPanPaddingTopLeft: mobilePopup ? L.point(10, 126) : L.point(16, 16),
        autoPanPaddingBottomRight: mobilePopup
          ? L.point(10, Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shorely-mobile-timeline-height")) + 16 || 140)
          : L.point(desktopRightRailWidth + 30, 16)
      })
        .setLatLng(latlng)
        .setContent(html)
        .addTo(map);
      persistentFloodPopup = popup;
      document.body.classList.add("persistent-flood-popup-open");
      popup.once("remove", () => {
        if (persistentFloodPopup === popup) {
          persistentFloodPopup = null;
          persistentDepthQueryContext = null;
          document.body.classList.remove("persistent-flood-popup-open");
        }
      });
      return popup;
    }

    function buildHouseAlertPopup(feature) {
      const p = feature?.properties || {};
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const crawlspaceDepth = Number(p.foundationHeightFt ?? p.nsi2026FoundationHeightFt);
      const stage = getSelectedStageNavd88();
      const difference = Number.isFinite(stage) && Number.isFinite(firstFloor) ? stage - firstFloor : null;
      const address = escapeTownAddressHtml(p.address || "Selected North Wildwood parcel");
      const waterStatus = difference == null
        ? "Choose a water level to compare."
        : Math.abs(difference) <= 0.1
          ? "Current water is at the estimated occupied floor."
          : difference > 0
            ? `Current water is ${formatWaterDepth(difference, 1)} above the estimated occupied floor.`
            : `Current water is ${formatWaterDepth(Math.abs(difference), 1)} below the estimated occupied floor.`;
      return '<div class="house-alert-popup building-info-card">' +
        '<span class="house-alert-kicker">Building</span>' +
        '<h3>' + address + '</h3>' +
        '<div class="building-info-facts">' +
          '<div><span>Crawlspace / garage depth</span><strong>' +
            (Number.isFinite(crawlspaceDepth) ? formatWaterDepth(crawlspaceDepth, 1) : 'Not available') +
          '</strong></div>' +
          '<p>' + escapeTownAddressHtml(waterStatus) + '</p>' +
        '</div>' +
        '<button class="house-alert-cta" type="button">See Flood History &amp; Projections</button>' +
        '</div>';
    }

    function openParcelFloodPrompt(feature, latlng) {
      selectedParcelFeature = feature;
      const p = feature?.properties || {};
      const popupLatLng = latlng || L.latLng(
        Number(p.centroidLat || p.analysisLat),
        Number(p.centroidLon || p.analysisLon)
      );
      const popup = openPersistentFloodPopup(popupLatLng, buildHouseAlertPopup(feature), 460);
      persistentDepthQueryContext = { popup, kind: "building", feature };
      return popup;
    }

    async function ensureFloodProjectionData() {
      if (houseAlertCdfData) return houseAlertCdfData;
      if (!HOUSE_ALERT_CDF_URL) throw new Error("Flood projection data is not configured.");
      if (!houseAlertCdfPromise) {
        houseAlertCdfPromise = fetchJson(HOUSE_ALERT_CDF_URL, { cache: "force-cache" })
          .then(payload => {
            if (!/flood-history-projections-v4$/.test(String(payload?.schema || ""))) {
              throw new Error("The flood projection dataset needs to be refreshed.");
            }
            houseAlertCdfData = payload;
            return payload;
          })
          .catch(error => {
            houseAlertCdfPromise = null;
            throw error;
          });
      }
      return houseAlertCdfPromise;
    }

    function closeFloodHistoryPane() {
      const backdrop = document.getElementById("floodHistoryBackdrop");
      if (!backdrop) return;
      backdrop.hidden = true;
      backdrop.setAttribute("aria-hidden", "true");
      document.body.classList.remove("flood-history-open");
    }

    function findProjectionElevationIndex(feature, data) {
      const grid = Array.isArray(data?.elevationGridFtNavd88) ? data.elevationGridFtNavd88 : [];
      const preferred = Number(
        feature?.properties?.nsi2026ModelElevationIndex ?? feature?.properties?.modelElevationIndex
      );
      if (Number.isInteger(preferred) && preferred >= 0 && preferred < grid.length) return preferred;
      const elevation = Number(
        feature?.properties?.nsi2026ModelElevationNavd88Ft ??
        feature?.properties?.nsi2026ModeledFirstFloorNavd88Ft ??
        feature?.properties?.modelElevationNavd88Ft ??
        feature?.properties?.elevationNavd88Ft
      );
      let bestIndex = 0;
      let bestDifference = Infinity;
      grid.forEach((candidate, index) => {
        const difference = Math.abs(Number(candidate) - elevation);
        if (difference < bestDifference) {
          bestDifference = difference;
          bestIndex = index;
        }
      });
      return bestIndex;
    }

    function niceProjectionMaximum(value) {
      const n = Math.max(1, Number(value) || 1);
      const magnitude = 10 ** Math.floor(Math.log10(n));
      const normalized = n / magnitude;
      const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
      return nice * magnitude;
    }

    function renderProjectionChart(data, scenarioKey, elevationIndex, selectedYearIndex) {
      const years = data.years || [];
      const record = data.annualFloodEventCount?.[scenarioKey] || {};
      const estimate = record.estimate?.[elevationIndex] || [];
      const lower = record.lower95?.[elevationIndex] || [];
      const upper = record.upper95?.[elevationIndex] || [];
      const width = 420;
      const height = 168;
      const plot = { left: 42, right: 9, top: 10, bottom: 25 };
      const plotWidth = width - plot.left - plot.right;
      const plotHeight = height - plot.top - plot.bottom;
      const maxValue = niceProjectionMaximum(Math.max(...upper.map(Number).filter(Number.isFinite), 1));
      const x = index => plot.left + (years.length > 1 ? index / (years.length - 1) : 0) * plotWidth;
      const y = value => plot.top + plotHeight - Math.min(1, Math.max(0, Number(value) / maxValue)) * plotHeight;
      const line = estimate.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      const band = upper.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
        .concat(lower.map((value, index) => `${x(lower.length - 1 - index).toFixed(1)},${y(lower[lower.length - 1 - index]).toFixed(1)}`))
        .join(" ");
      const gridValues = [0, maxValue / 2, maxValue];
      const selectedIndex = Math.max(0, Math.min(years.length - 1, selectedYearIndex));
      const tickYears = [2026, 2050, 2075, 2100].filter(year => years.includes(year));
      return `
        <svg class="flood-projection-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Expected annual flood exceedances with 95 percent uncertainty">
          ${gridValues.map(value => `<line class="flood-chart-grid" x1="${plot.left}" x2="${width - plot.right}" y1="${y(value)}" y2="${y(value)}"></line><text class="flood-chart-axis" x="${plot.left - 6}" y="${y(value) + 3}" text-anchor="end">${formatExpectedFloodCount(value)}</text>`).join("")}
          <polygon class="flood-chart-band" points="${band}"></polygon>
          <polyline class="flood-chart-line" points="${line}"></polyline>
          ${tickYears.map(year => {
            const index = years.indexOf(year);
            return `<text class="flood-chart-axis" x="${x(index)}" y="${height - 7}" text-anchor="${year === years[0] ? "start" : year === years[years.length - 1] ? "end" : "middle"}">${year}</text>`;
          }).join("")}
          <circle class="flood-chart-dot" cx="${x(selectedIndex)}" cy="${y(estimate[selectedIndex])}" r="4"></circle>
        </svg>`;
    }

    function renderFloodHistoryProjection(feature, data) {
      const body = document.getElementById("floodHistoryBody");
      if (!body) return;
      const p = feature?.properties || {};
      const years = Array.isArray(data.years) ? data.years : [];
      const elevationIndex = findProjectionElevationIndex(feature, data);
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const hasModeledFloor = Number.isFinite(firstFloor);
      const historic = Number(hasModeledFloor
        ? p.nsi2026HistoricFirstFloorExceedanceCount
        : p.historicFloodEventCount);
      const defaultYearIndex = Math.max(0, years.indexOf(2050));
      const scenarioKey = data.annualFloodEventCount?.[selectedFloodProjectionScenario]
        ? selectedFloodProjectionScenario
        : (data.scenarioOrder || []).find(key => data.annualFloodEventCount?.[key]);
      selectedFloodProjectionScenario = scenarioKey || "intermediate";
      const scenario = FLOOD_PROJECTION_SCENARIOS[selectedFloodProjectionScenario] || FLOOD_PROJECTION_SCENARIOS.intermediate;
      const record = data.annualFloodEventCount[selectedFloodProjectionScenario];
      const estimate = record.estimate[elevationIndex];
      const lower = record.lower95[elevationIndex];
      const upper = record.upper95[elevationIndex];
      body.style.setProperty("--scenario-color", scenario.color);
      body.innerHTML = `
        <div class="flood-history-summary">
          <div class="flood-summary-item">
            <span>${hasModeledFloor ? "Past floods above floor" : "Past floods at parcel"}</span>
            <strong>${Number.isFinite(historic) ? historic.toLocaleString() : "—"}</strong>
          </div>
          <div class="flood-summary-item">
            <span>${hasModeledFloor ? "Estimated occupied floor" : "Parcel ground"}</span>
            <strong>${hasModeledFloor ? firstFloor.toFixed(1) : Number(p.elevationNavd88Ft).toFixed(1)} <small>ft NAVD88</small></strong>
          </div>
        </div>
        <section class="flood-history-section">
          <div class="flood-history-section-head">
            <div><h3>${hasModeledFloor ? "Future floods above floor" : "Future floods at parcel"}</h3><p>Expected events per year · range shown</p></div>
            <label class="flood-scenario-field">
              Sea-level scenario
              <select id="floodProjectionScenarioSelect" class="flood-scenario-select" aria-label="Sea level projection curve">
                ${(data.scenarioOrder || Object.keys(data.annualFloodEventCount)).map(key => {
                  const item = FLOOD_PROJECTION_SCENARIOS[key] || { label: key };
                  return `<option value="${escapeTownAddressHtml(key)}"${key === selectedFloodProjectionScenario ? " selected" : ""}>${escapeTownAddressHtml(item.label)}</option>`;
                }).join("")}
              </select>
            </label>
          </div>
          <div id="floodProjectionChart">${renderProjectionChart(data, selectedFloodProjectionScenario, elevationIndex, defaultYearIndex)}</div>
          <div class="flood-year-control">
            <input id="floodProjectionYearSlider" type="range" min="0" max="${Math.max(0, years.length - 1)}" value="${defaultYearIndex}" step="1" aria-label="Projection year">
            <div id="floodProjectionYearReadout" class="flood-year-readout">
              <span>${years[defaultYearIndex] || "—"}</span>
              <strong>${formatExpectedFloodCount(estimate[defaultYearIndex])}/yr</strong>
              <small>95%: ${formatFloodIntervalValue(lower[defaultYearIndex])}–${formatFloodIntervalValue(upper[defaultYearIndex])}</small>
            </div>
          </div>
        </section>
      `;

      const updateSelectedYear = index => {
        const selectedIndex = Math.max(0, Math.min(years.length - 1, Number(index) || 0));
        const readout = document.getElementById("floodProjectionYearReadout");
        const chart = document.getElementById("floodProjectionChart");
        if (readout) {
          readout.innerHTML = `<span>${years[selectedIndex]}</span><strong>${formatExpectedFloodCount(estimate[selectedIndex])}/yr</strong><small>95%: ${formatFloodIntervalValue(lower[selectedIndex])}–${formatFloodIntervalValue(upper[selectedIndex])}</small>`;
        }
        if (chart) chart.innerHTML = renderProjectionChart(data, selectedFloodProjectionScenario, elevationIndex, selectedIndex);
      };
      document.getElementById("floodProjectionYearSlider")?.addEventListener("input", event => updateSelectedYear(event.target.value));
      document.getElementById("floodProjectionScenarioSelect")?.addEventListener("change", event => {
        selectedFloodProjectionScenario = event.target.value;
        renderFloodHistoryProjection(feature, data);
      });
    }

    async function openFloodHistoryPane(feature) {
      if (!feature) return;
      selectedParcelFeature = feature;
      const backdrop = document.getElementById("floodHistoryBackdrop");
      const body = document.getElementById("floodHistoryBody");
      const address = document.getElementById("floodHistoryAddress");
      if (!backdrop || !body) return;
      address.textContent = feature?.properties?.address || "Selected North Wildwood parcel";
      const provenance = document.getElementById("floodHistoryProvenance");
      if (provenance) provenance.textContent = "";
      body.innerHTML = '<div class="flood-history-loading" role="status"><span class="flood-history-spinner" aria-hidden="true"></span><strong>Preparing this building’s flood profile…</strong><span>Loading the projection model only when you need it.</span></div>';
      backdrop.hidden = false;
      backdrop.setAttribute("aria-hidden", "false");
      document.body.classList.add("flood-history-open");
      document.getElementById("floodHistoryCloseBtn")?.focus();
      try {
        const data = await ensureFloodProjectionData();
        if (selectedParcelFeature === feature && !backdrop.hidden) {
          const notice = document.getElementById("floodHistoryProvenance");
          const basis = data.site?.name || data.sources?.observed || "Archived model";
          if (notice) notice.textContent = `Model basis: ${basis}. Observations through ${data.observedArchive?.endDate || "an unspecified date"}. Generated ${(data.generatedUtc || "unknown").slice(0, 10)}.${data.qualityPolicyVersion ? "" : " This older model predates the current observation quality review and is not recalculated from the selected tide archive."}`;
          renderFloodHistoryProjection(feature, data);
        }
      } catch (error) {
        body.innerHTML = `<div class="flood-history-error"><strong>This projection could not be loaded.</strong><br>${escapeTownAddressHtml(error?.message || "Please try again in a moment.")}</div>`;
      }
    }

    function wireFloodHistoryPane() {
      const backdrop = document.getElementById("floodHistoryBackdrop");
      document.getElementById("floodHistoryCloseBtn")?.addEventListener("click", closeFloodHistoryPane);
      backdrop?.addEventListener("click", event => {
        if (event.target === backdrop) closeFloodHistoryPane();
      });
      document.addEventListener("click", event => {
        if (event.target?.closest?.(".house-alert-cta") && selectedParcelFeature) {
          openFloodHistoryPane(selectedParcelFeature);
        }
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && backdrop && !backdrop.hidden) closeFloodHistoryPane();
      });
    }

