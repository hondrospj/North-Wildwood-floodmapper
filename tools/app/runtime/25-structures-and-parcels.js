    function getSelectedStageNavd88() {
      const committedStage = currentFloodLayer?._floodmapperFrame?.stage;
      if (Number.isFinite(committedStage)) return committedStage;
      const entry = currentSeriesHours[currentHourIndex];
      const stage = normalizeStageValue(getStageValue(entry));
      return Number.isFinite(stage) ? stage : null;
    }

    function finiteStructureNumber(value) {
      if (value == null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function getNsiFirstOccupiedFloorNavd88(properties) {
      const p = properties || {};
      const localGround = finiteStructureNumber(p.localGroundNavd88Ft ?? p.nsi2026LocalGroundNavd88Ft);
      const riseToOccupiedFloor = finiteStructureNumber(p.foundationHeightFt ?? p.nsi2026FoundationHeightFt);
      if (localGround != null && riseToOccupiedFloor != null) {
        return localGround + Math.max(0, riseToOccupiedFloor);
      }
      return finiteStructureNumber(p.modeledFirstFloorNavd88Ft ?? p.nsi2026ModeledFirstFloorNavd88Ft);
    }

    function getNsiStructureImpactStyle(properties, stage = getSelectedStageNavd88()) {
      const firstFloor = getNsiFirstOccupiedFloorNavd88(properties);
      if (!Number.isFinite(firstFloor) || !Number.isFinite(stage)) {
        return { radius: 2.7, color: "#94a3b8", weight: 0.7, opacity: 0.8, fillColor: "#64748b", fillOpacity: 0.42 };
      }
      const waterAboveFloor = stage - firstFloor;
      if (waterAboveFloor > 0.1) {
        return { radius: 4.3, color: "#fff1f2", weight: 1.1, opacity: 0.95, fillColor: "#fb7185", fillOpacity: 0.95 };
      }
      if (waterAboveFloor >= -0.5) {
        return { radius: 3.6, color: "#fff7d6", weight: 1.0, opacity: 0.95, fillColor: "#fbbf24", fillOpacity: 0.88 };
      }
      return { radius: 2.7, color: "#d9fdff", weight: 0.7, opacity: 0.72, fillColor: "#22d3ee", fillOpacity: 0.48 };
    }

    function formatNsiImpactStatus(properties, stage = getSelectedStageNavd88()) {
      const firstFloor = getNsiFirstOccupiedFloorNavd88(properties);
      if (!Number.isFinite(firstFloor) || !Number.isFinite(stage)) return "Choose a water level to compare.";
      const difference = stage - firstFloor;
      if (difference > 0.1) return `Current water is ${formatWaterDepth(difference, 1)} above the estimated first occupied floor.`;
      if (difference >= -0.1) return "Current water is at the estimated first occupied floor.";
      return `Current water is ${formatWaterDepth(Math.abs(difference), 1)} below the estimated first occupied floor.`;
    }

    function buildNsiStructurePopup(feature) {
      const p = feature?.properties || {};
      const firstFloor = getNsiFirstOccupiedFloorNavd88(p);
      const address = escapeTownAddressHtml(p.address || "Modeled North Wildwood structure");
      return '<div class="nsi-structure-popup">' +
        '<span class="house-alert-kicker">Estimated floor flooding</span>' +
        '<h3>' + address + '</h3>' +
        '<div class="nsi-structure-grid">' +
          '<span>Estimated first occupied floor</span><strong>' + (Number.isFinite(firstFloor) ? firstFloor.toFixed(1) + ' ft NAVD88' : '—') + '</strong>' +
        '</div>' +
        '<div class="nsi-impact-status">' + escapeTownAddressHtml(formatNsiImpactStatus(p)) + '</div>' +
        '<div class="house-alert-note">Screening estimate.</div>' +
        '</div>';
    }

    function openNsiStructurePopup(feature, latlng) {
      const popup = openPersistentFloodPopup(latlng, buildNsiStructurePopup(feature), 360);
      persistentDepthQueryContext = { popup, kind: "structure", feature };
      return popup;
    }

    function updateNsiStructureImpactLayer() {
      if (!nsiStructuresLayer) return;
      const stage = getSelectedStageNavd88();
      nsiStructuresLayer.eachLayer(layer => {
        if (layer?.feature?.properties && typeof layer.setStyle === "function") {
          layer.setStyle(getNsiStructureImpactStyle(layer.feature.properties, stage));
        }
      });
    }

    function findNsiStructureFeatureForLocation(lat, lon, maximumDistanceMeters = 24) {
      let nearest = null;
      let nearestDistance = Infinity;
      const longitudeScale = Math.cos(Number(lat) * Math.PI / 180);
      nsiStructureFeatures.forEach(feature => {
        const coordinates = feature?.geometry?.coordinates || [];
        const dLat = Number(coordinates[1]) - Number(lat);
        const dLon = (Number(coordinates[0]) - Number(lon)) * longitudeScale;
        const meters = Math.hypot(dLat, dLon) * 111320;
        if (Number.isFinite(meters) && meters < nearestDistance) {
          nearestDistance = meters;
          nearest = feature;
        }
      });
      return nearestDistance <= maximumDistanceMeters ? nearest : null;
    }

    async function ensureNsiStructureAssets() {
      if (nsiStructuresLayer) return nsiStructuresLayer;
      if (!NSI_STRUCTURES_URL) throw new Error("USACE NSI 2026 structures are not configured.");
      if (!nsiStructureLoadPromise) {
        nsiStructureLoadPromise = fetchJson(NSI_STRUCTURES_URL, { cache: "force-cache" })
          .then(payload => {
            if (!/nsi-2026-first-floor-v1$/.test(String(payload?.metadata?.schema || ""))) {
              throw new Error("The USACE NSI 2026 structure asset needs to be refreshed.");
            }
            nsiStructureFeatures = Array.isArray(payload.features) ? payload.features : [];
            nsiStructureRenderer = nsiStructureRenderer || L.canvas({ pane: "structuresPane", padding: 0.5, tolerance: 7 });
            nsiStructuresLayer = L.geoJSON(payload, {
              pane: "structuresPane",
              renderer: nsiStructureRenderer,
              pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                ...getNsiStructureImpactStyle(feature?.properties),
                pane: "structuresPane",
                renderer: nsiStructureRenderer,
                bubblingMouseEvents: false,
                interactive: true
              }),
              onEachFeature: (feature, layer) => {
                layer.on("click", event => {
                  if (event?.originalEvent) event.originalEvent._parcelHandled = true;
                  openNsiStructurePopup(feature, event.latlng);
                });
              }
            });
            return nsiStructuresLayer;
          })
          .catch(error => {
            nsiStructureLoadPromise = null;
            throw error;
          });
      }
      return nsiStructureLoadPromise;
    }

    async function setNsiStructuresEnabled(enabled) {
      const generation = ++nsiLayerGeneration;
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("nsiStructuresToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        if (nsiStructuresLayer && map.hasLayer(nsiStructuresLayer)) map.removeLayer(nsiStructuresLayer);
        updateMapClickModeControl();
        toast("");
        return;
      }
      let layer;
      try {
        layer = await ensureNsiStructureAssets();
      } catch (error) {
        if (generation !== nsiLayerGeneration) return;
        throw error;
      }
      if (generation !== nsiLayerGeneration) return;
      updateNsiStructureImpactLayer();
      if (!map.hasLayer(layer)) layer.addTo(map);
      setMapClickMode("building", { closePopup: false });
      toast("Crawlspace/Garage impacts: red is above, gold is close, cyan is below.");
    }

    async function ensureParcelAssets() {
      if (parcelLoadPromise) return parcelLoadPromise;
      parcelLoadPromise = (async () => {
        const geojson = await fetchJson(PARCELS_URL, { cache: "force-cache" });
        parcelFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
        parcelsLayer = createHydraulicImageOverlay(PARCEL_BOUNDARY_PNG_URL, {
          pane: "parcelsPane",
          opacity: 0.78,
          interactive: false,
          crossOrigin: true,
          zIndex: 610
        });
        return parcelsLayer;
      })().catch(err => {
        parcelLoadPromise = null;
        throw err;
      });
      return parcelLoadPromise;
    }

    async function setParcelsEnabled(enabled) {
      const generation = ++parcelLayerGeneration;
      const shouldEnable = Boolean(enabled);
      const toggle = document.getElementById("parcelsToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (!map) ensureMap();
      if (!shouldEnable) {
        if (parcelsLayer && map.hasLayer(parcelsLayer)) map.removeLayer(parcelsLayer);
        updateMapClickModeControl();
        toast("");
        return;
      }
      let layer;
      try {
        layer = await ensureParcelAssets();
      } catch (error) {
        if (generation !== parcelLayerGeneration) return;
        throw error;
      }
      if (generation !== parcelLayerGeneration) return;
      if (!map.hasLayer(layer)) layer.addTo(map);
      setMapClickMode("building", { closePopup: false });
      toast("");
    }

    function pointInRing(lon, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = Number(ring[i]?.[0]), yi = Number(ring[i]?.[1]);
        const xj = Number(ring[j]?.[0]), yj = Number(ring[j]?.[1]);
        const intersects = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    }

    function pointInParcelFeature(feature, lat, lon) {
      const geometry = feature?.geometry;
      if (!geometry) return false;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] :
        (geometry.type === "MultiPolygon" ? geometry.coordinates : []);
      return polygons.some(rings => {
        if (!Array.isArray(rings?.[0]) || !pointInRing(lon, lat, rings[0])) return false;
        return !rings.slice(1).some(hole => pointInRing(lon, lat, hole));
      });
    }

    async function findParcelFeatureForLocation(lat, lon, options = {}) {
      await ensureParcelAssets();
      const containing = parcelFeatures.find(feature => pointInParcelFeature(feature, lat, lon));
      if (containing) return containing;
      if (options.allowNearest === false) return null;
      let nearest = null;
      let nearestDistance = Infinity;
      parcelFeatures.forEach(feature => {
        const p = feature?.properties || {};
        const dLat = Number(p.centroidLat) - lat;
        const dLon = (Number(p.centroidLon) - lon) * Math.cos(lat * Math.PI / 180);
        const meters = Math.hypot(dLat, dLon) * 111320;
        if (Number.isFinite(meters) && meters < nearestDistance) {
          nearestDistance = meters;
          nearest = feature;
        }
      });
      return nearestDistance <= 90 ? nearest : null;
    }

