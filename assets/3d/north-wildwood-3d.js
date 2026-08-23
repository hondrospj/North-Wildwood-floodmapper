(function () {
  "use strict";

  var TERRAIN_EXAGGERATION = 4;
  var MAP_MAX_ZOOM = 22;
  var DEFAULT_PITCH = 0;
  var DEFAULT_BEARING = 0;
  var THREE_D_PITCH = 60;
  var MAPLIBRE_CSS_URL = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css";
  var MAPLIBRE_JS_URL = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js";
  var ESRI_STYLE_URL = "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/resources/styles/root.json";
  var ESRI_VECTOR_TILES = "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf";
  var TERRAIN_TILEJSON_URL = "https://tiles.mapterhorn.com/tilejson.json";
  var BUILDINGS_3D_URL = new URL("./assets/3d/NorthWildwoodBuildings3D.geojson?v=20260823-nw-3d-v1", APP_BASE).href;

  var glMap = null;
  var glMapPromise = null;
  var glPopup = null;
  var buildingData = null;
  var buildingDataPromise = null;
  var mapLibreRuntimePromise = null;
  var syncingFromLeaflet = false;
  var syncingFrom3d = false;
  var buildingCursorHandlersWired = false;

  function setStatus(text) {
    var status = document.getElementById("map3dStatus");
    if (status) status.textContent = text || "3D terrain ×4";
    updateDiagnostics();
  }

  function loadMapLibreRuntime() {
    if (window.maplibregl && typeof window.maplibregl.Map === "function") {
      return Promise.resolve(window.maplibregl);
    }
    if (mapLibreRuntimePromise) return mapLibreRuntimePromise;

    mapLibreRuntimePromise = Promise.all([
      new Promise(function (resolve, reject) {
        var existing = document.getElementById("nwMapLibreCss");
        if (existing) {
          resolve();
          return;
        }
        var link = document.createElement("link");
        link.id = "nwMapLibreCss";
        link.rel = "stylesheet";
        link.href = MAPLIBRE_CSS_URL;
        link.onload = resolve;
        link.onerror = function () { reject(new Error("The 3D map styles could not be loaded.")); };
        document.head.appendChild(link);
      }),
      new Promise(function (resolve, reject) {
        var existing = document.getElementById("nwMapLibreScript");
        if (existing) {
          if (window.maplibregl && typeof window.maplibregl.Map === "function") resolve();
          else existing.addEventListener("load", resolve, { once: true });
          return;
        }
        var script = document.createElement("script");
        script.id = "nwMapLibreScript";
        script.src = MAPLIBRE_JS_URL;
        script.async = true;
        script.onload = resolve;
        script.onerror = function () { reject(new Error("The 3D map renderer could not be loaded.")); };
        document.head.appendChild(script);
      })
    ]).then(function () {
      if (!window.maplibregl || typeof window.maplibregl.Map !== "function") {
        throw new Error("This browser does not support the 3D map renderer.");
      }
      return window.maplibregl;
    }).catch(function (error) {
      mapLibreRuntimePromise = null;
      throw error;
    });
    return mapLibreRuntimePromise;
  }

  function updateDiagnostics() {
    var output = document.getElementById("map3dDiagnostics");
    if (!output) return;
    var state = {
      ready: document.body.classList.contains("map-3d-ready"),
      exaggeration: TERRAIN_EXAGGERATION,
      maxZoom: MAP_MAX_ZOOM,
      pitch: glMap ? Number(glMap.getPitch().toFixed(2)) : null,
      bearing: glMap ? Number(glMap.getBearing().toFixed(2)) : null,
      zoom: glMap ? Number(glMap.getZoom().toFixed(3)) : null,
      centerLng: glMap ? Number(glMap.getCenter().lng.toFixed(7)) : null,
      centerLat: glMap ? Number(glMap.getCenter().lat.toFixed(7)) : null,
      terrainSource: glMap && glMap.getTerrain ? glMap.getTerrain() : null,
      buildingCount: buildingData && buildingData.features ? buildingData.features.length : 0,
      buildingsVisible: Boolean(glMap && glMap.getLayer("nw-3d-buildings") &&
        glMap.getLayoutProperty("nw-3d-buildings", "visibility") !== "none"),
      nsiOccupiedFloorCount: Array.isArray(nsiStructureFeatures) ? nsiStructureFeatures.length : 0,
      nsiOccupiedFloorsVisible: Boolean(glMap && glMap.getLayer("nw-nsi-points") &&
        glMap.getLayoutProperty("nw-nsi-points", "visibility") !== "none")
    };
    output.textContent = JSON.stringify(state);
  }

  function GoogleEarth3dControl() {
    this.map = null;
    this.container = null;
    this.viewButton = null;
    this.sync = null;
    this.panFrame = 0;
  }

  GoogleEarth3dControl.prototype.onAdd = function (controlMap) {
    var self = this;
    this.map = controlMap;
    var container = document.createElement("div");
    container.className = "maplibregl-ctrl nw-simple-control";
    container.setAttribute("aria-label", "3D map navigation");
    container.innerHTML = [
      '<div class="nw-direction-wheel" role="application" tabindex="0" aria-label="Direction wheel. Drag toward north, east, south, west, or any direction between to move the map.">',
      '  <span class="nw-wheel-cardinal nw-wheel-n" aria-hidden="true">N</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-e" aria-hidden="true">E</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-s" aria-hidden="true">S</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-w" aria-hidden="true">W</span>',
      '  <span class="nw-wheel-knob" aria-hidden="true"></span>',
      '</div>',
      '<button class="nw-simple-view" type="button" aria-label="Switch to 3D view" aria-pressed="false" title="Switch to 3D view"><span class="nw-simple-view-label">3D</span></button>',
      '<div class="nw-simple-zoom" role="group" aria-label="Zoom controls">',
      '  <button class="nw-simple-zoom-button nw-simple-zoom-in" type="button" aria-label="Zoom in" title="Zoom in"><span aria-hidden="true">+</span></button>',
      '  <button class="nw-simple-zoom-button nw-simple-zoom-out" type="button" aria-label="Zoom out" title="Zoom out"><span aria-hidden="true">−</span></button>',
      '</div>'
    ].join("");
    this.container = container;
    this.viewButton = container.querySelector(".nw-simple-view");
    var viewLabel = container.querySelector(".nw-simple-view-label");
    var wheel = container.querySelector(".nw-direction-wheel");

    function stop(event) { event.stopPropagation(); }
    ["click", "dblclick", "mousedown", "touchstart", "pointerdown", "wheel", "contextmenu"].forEach(function (name) {
      container.addEventListener(name, stop);
    });

    function moveTo(camera, duration) {
      controlMap.stop();
      controlMap.easeTo(Object.assign({ duration: duration || 220 }, camera));
    }
    function boundedZoom(delta) {
      var target = Math.max(11, Math.min(22, controlMap.getZoom() + delta));
      moveTo({ zoom: target }, 220);
    }
    container.querySelector(".nw-simple-zoom-in").addEventListener("click", function () {
      boundedZoom(1);
    });
    container.querySelector(".nw-simple-zoom-out").addEventListener("click", function () {
      boundedZoom(-1);
    });
    this.viewButton.addEventListener("click", function () {
      var is3d = controlMap.getPitch() > 10;
      moveTo({ pitch: is3d ? 0 : THREE_D_PITCH }, 420);
    });

    var activePointer = null;
    var directionX = 0;
    var directionY = 0;
    var directionStrength = 0;

    function panBy(offset, duration) {
      controlMap.stop();
      controlMap.panBy(offset, { duration: duration || 0 });
    }
    function updateWheel(clientX, clientY) {
      var rect = wheel.getBoundingClientRect();
      var dx = clientX - (rect.left + rect.width / 2);
      var dy = clientY - (rect.top + rect.height / 2);
      var distance = Math.sqrt(dx * dx + dy * dy);
      var maxRadius = Math.max(18, rect.width * .30);
      var scale = distance > maxRadius ? maxRadius / distance : 1;
      var knobX = dx * scale;
      var knobY = dy * scale;
      wheel.style.setProperty("--nw-wheel-x", knobX.toFixed(2) + "px");
      wheel.style.setProperty("--nw-wheel-y", knobY.toFixed(2) + "px");
      directionStrength = Math.min(1, distance / maxRadius);
      if (distance > 0) {
        directionX = dx / distance;
        directionY = dy / distance;
      } else {
        directionX = 0;
        directionY = 0;
      }
      wheel.dataset.directionX = directionX.toFixed(4);
      wheel.dataset.directionY = directionY.toFixed(4);
      wheel.dataset.directionStrength = directionStrength.toFixed(4);
    }
    function panContinuously() {
      if (activePointer === null) return;
      if (directionStrength > .08) {
        var speed = 2 + directionStrength * 7;
        controlMap.panBy([directionX * speed, directionY * speed], { duration: 0 });
      }
      self.panFrame = window.requestAnimationFrame(panContinuously);
    }
    function releaseWheel(event) {
      if (activePointer === null || (event && event.pointerId !== activePointer)) return;
      try {
        if (event && wheel.hasPointerCapture && wheel.hasPointerCapture(activePointer)) {
          wheel.releasePointerCapture(activePointer);
        }
      } catch (_) {}
      activePointer = null;
      directionX = 0;
      directionY = 0;
      directionStrength = 0;
      wheel.classList.remove("is-active");
      wheel.style.setProperty("--nw-wheel-x", "0px");
      wheel.style.setProperty("--nw-wheel-y", "0px");
      if (self.panFrame) window.cancelAnimationFrame(self.panFrame);
      self.panFrame = 0;
    }
    wheel.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      controlMap.stop();
      activePointer = event.pointerId;
      try { wheel.setPointerCapture(activePointer); } catch (_) {}
      wheel.classList.add("is-active");
      updateWheel(event.clientX, event.clientY);
      if (directionStrength > .08) panBy([directionX * 9, directionY * 9], 0);
      if (self.panFrame) window.cancelAnimationFrame(self.panFrame);
      self.panFrame = window.requestAnimationFrame(panContinuously);
    });
    wheel.addEventListener("pointermove", function (event) {
      if (event.pointerId === activePointer) updateWheel(event.clientX, event.clientY);
    });
    wheel.addEventListener("pointerup", releaseWheel);
    wheel.addEventListener("pointercancel", releaseWheel);
    wheel.addEventListener("lostpointercapture", releaseWheel);
    wheel.addEventListener("click", function (event) {
      updateWheel(event.clientX, event.clientY);
      if (directionStrength > .08) panBy([directionX * 72, directionY * 72], 160);
      directionX = 0;
      directionY = 0;
      directionStrength = 0;
      wheel.style.setProperty("--nw-wheel-x", "0px");
      wheel.style.setProperty("--nw-wheel-y", "0px");
    });
    wheel.addEventListener("keydown", function (event) {
      var offsets = {
        ArrowUp: [0, -90],
        ArrowRight: [90, 0],
        ArrowDown: [0, 90],
        ArrowLeft: [-90, 0]
      };
      if (!offsets[event.key]) return;
      event.preventDefault();
      panBy(offsets[event.key], 160);
    });

    this.sync = function () {
      var is3d = controlMap.getPitch() > 10;
      self.viewButton.setAttribute("aria-pressed", is3d ? "true" : "false");
      self.viewButton.setAttribute("aria-label", is3d ? "Switch to 2D view" : "Switch to 3D view");
      self.viewButton.setAttribute("title", is3d ? "Switch to 2D view" : "Switch to 3D view");
      viewLabel.textContent = is3d ? "2D" : "3D";
      updateDiagnostics();
    };
    controlMap.on("rotate", this.sync);
    controlMap.on("pitch", this.sync);
    controlMap.on("zoom", this.sync);
    controlMap.on("moveend", this.sync);
    this.sync();
    return container;
  };

  GoogleEarth3dControl.prototype.onRemove = function () {
    if (this.panFrame) window.cancelAnimationFrame(this.panFrame);
    this.panFrame = 0;
    if (this.map && this.sync) {
      this.map.off("rotate", this.sync);
      this.map.off("pitch", this.sync);
      this.map.off("zoom", this.sync);
      this.map.off("moveend", this.sync);
    }
    if (this.container && this.container.parentNode) this.container.parentNode.removeChild(this.container);
    this.map = null;
  };

  function installMapCreditsInLayers(credits) {
    var host = document.querySelector("#rightRail .layers-card");
    if (!host || document.getElementById("nwMapCredits")) return;
    var details = document.createElement("details");
    details.id = "nwMapCredits";
    details.className = "nw-map-credits-rail";
    details.innerHTML = '<summary>Map credits</summary><div>' + credits.join(" | ") + '</div>';
    host.appendChild(details);
  }

  function layerVisible(toggleId, defaultValue) {
    var toggle = document.getElementById(toggleId);
    return toggle ? toggle.classList.contains("on") : Boolean(defaultValue);
  }

  function visibility(value) {
    return value ? "visible" : "none";
  }

  function absoluteStyleAsset(value) {
    if (!value) return value;
    try {
      return new URL(value, ESRI_STYLE_URL).href
        .replace(/%7B/gi, "{")
        .replace(/%7D/gi, "}");
    } catch (_) {
      return value;
    }
  }

  async function load3dStyle() {
    var response = await fetch(ESRI_STYLE_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error("The 3D basemap style could not be loaded.");
    var style = await response.json();
    style.sprite = absoluteStyleAsset(style.sprite);
    style.glyphs = absoluteStyleAsset(style.glyphs);
    style.sources = style.sources || {};
    style.sources.esri = {
      type: "vector",
      tiles: [ESRI_VECTOR_TILES],
      minzoom: 0,
      maxzoom: 22,
      attribution: "&copy; OpenStreetMap contributors, Esri"
    };
    return typeof styleEsriBuildingBasemap === "function"
      ? styleEsriBuildingBasemap(style)
      : style;
  }

  function coordinatesFromLeafletBounds(bounds) {
    if (!bounds || typeof bounds.getWest !== "function") return null;
    return [
      [bounds.getWest(), bounds.getNorth()],
      [bounds.getEast(), bounds.getNorth()],
      [bounds.getEast(), bounds.getSouth()],
      [bounds.getWest(), bounds.getSouth()]
    ];
  }

  function addLayerBelowMask(layer) {
    if (!glMap || glMap.getLayer(layer.id)) return;
    glMap.addLayer(layer, glMap.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined);
  }

  function removeLayerAndSource(layerId, sourceId) {
    if (!glMap || !glMap.isStyleLoaded()) return;
    if (glMap.getLayer(layerId)) glMap.removeLayer(layerId);
    if (sourceId && glMap.getSource(sourceId)) glMap.removeSource(sourceId);
  }

  function suspendLeafletVisualLayers() {
    if (!map || !document.body.classList.contains("map-3d-ready")) return;
    [
      basemapGrayLayer,
      basemapColorLayer,
      satelliteLayer,
      roadsLayer,
      buildingsLayer,
      parcelsLayer,
      nsiStructuresLayer,
      cityBoundaryMask,
      cityBoundaryOutline,
      cityBoundaryGuide
    ].forEach(function (layer) {
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    });
  }

  function updateImageLayer(options) {
    if (!glMap || !glMap.isStyleLoaded() || !options.url || !options.coordinates) return;
    var source = glMap.getSource(options.sourceId);
    if (source && typeof source.updateImage === "function") {
      source.updateImage({ url: options.url, coordinates: options.coordinates });
    } else {
      glMap.addSource(options.sourceId, {
        type: "image",
        url: options.url,
        coordinates: options.coordinates
      });
      addLayerBelowMask({
        id: options.layerId,
        type: "raster",
        source: options.sourceId,
        paint: {
          "raster-opacity": options.opacity,
          "raster-resampling": "linear",
          "raster-fade-duration": 0
        }
      });
    }
    if (glMap.getLayer(options.layerId)) {
      glMap.setPaintProperty(options.layerId, "raster-opacity", options.opacity);
      glMap.setLayoutProperty(options.layerId, "visibility", visibility(options.visible !== false));
    }
  }

  function syncFloodLayer3d() {
    if (!glMap || !glMap.isStyleLoaded()) return;
    var url = currentFloodLayer && (currentFloodLayer._url || currentFloodLayer._image && currentFloodLayer._image.src);
    var coordinates = coordinatesFromLeafletBounds(floodLatLngBounds);
    if (!url || !coordinates) {
      removeLayerAndSource("nw-flood-overlay", "nw-flood-source");
      return;
    }
    updateImageLayer({
      sourceId: "nw-flood-source",
      layerId: "nw-flood-overlay",
      url: url,
      coordinates: coordinates,
      opacity: overlayOpacity,
      visible: true
    });
  }

  function syncSatellite3d() {
    if (!glMap || !glMap.isStyleLoaded() || !glMap.getLayer("nw-satellite")) return;
    glMap.setLayoutProperty("nw-satellite", "visibility", visibility(layerVisible("satelliteToggle", false)));
  }

  function syncRoadLabels3d() {
    if (!glMap || !glMap.isStyleLoaded() || !glMap.getLayer("nw-road-labels")) return;
    glMap.setLayoutProperty("nw-road-labels", "visibility", visibility(layerVisible("roadsToggle", true)));
  }

  function boundaryGeoJson() {
    if (municipalBoundaryFeature) return municipalBoundaryFeature;
    var rings = Array.isArray(municipalBoundaryRings) ? municipalBoundaryRings : [];
    if (!rings.length) return null;
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: rings.map(function (ring) {
          return ring.map(function (point) { return [Number(point[1]), Number(point[0])]; });
        })
      }
    };
  }

  function boundaryMaskGeoJson(feature) {
    var geometry = feature && feature.geometry;
    var polygons = geometry && geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry && geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    var holes = [];
    polygons.forEach(function (polygon) {
      if (Array.isArray(polygon && polygon[0])) holes.push(polygon[0].slice().reverse());
    });
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]].concat(holes)
      }
    };
  }

  function syncBoundary3d() {
    if (!glMap || !glMap.isStyleLoaded()) return;
    var feature = boundaryGeoJson();
    if (!feature) return;
    var outlineSource = glMap.getSource("nw-boundary-source");
    var maskSource = glMap.getSource("nw-boundary-mask-source");
    if (outlineSource && typeof outlineSource.setData === "function") outlineSource.setData(feature);
    if (maskSource && typeof maskSource.setData === "function") maskSource.setData(boundaryMaskGeoJson(feature));
    if (glMap.getLayer("nw-boundary-outline")) {
      glMap.setLayoutProperty("nw-boundary-outline", "visibility", visibility(isTownBoundaryEnabled()));
    }
  }

  function syncParcels3d() {
    if (!glMap || !glMap.isStyleLoaded()) return;
    var enabled = layerVisible("parcelsToggle", false);
    var coordinates = coordinatesFromLeafletBounds(floodLatLngBounds || getBoundaryDrivenOverlayBounds());
    if (!coordinates || !PARCEL_BOUNDARY_PNG_URL) return;
    updateImageLayer({
      sourceId: "nw-parcel-source",
      layerId: "nw-parcel-overlay",
      url: PARCEL_BOUNDARY_PNG_URL,
      coordinates: coordinates,
      opacity: 0.78,
      visible: enabled
    });
  }

  function nsiImpactPaint(stage) {
    if (!Number.isFinite(stage)) {
      return {
        color: "#64748b",
        stroke: "#94a3b8",
        radius: 2.7,
        opacity: 0.42
      };
    }
    var floor = ["+",
      ["to-number", ["get", "localGroundNavd88Ft"], -9999],
      ["max", 0, ["to-number", ["get", "foundationHeightFt"], 0]]
    ];
    var difference = ["-", stage, floor];
    return {
      color: ["case", [">", difference, 0.1], "#fb7185", [">=", difference, -0.5], "#fbbf24", "#22d3ee"],
      stroke: ["case", [">", difference, 0.1], "#fff1f2", [">=", difference, -0.5], "#fff7d6", "#d9fdff"],
      radius: ["case", [">", difference, 0.1], 4.3, [">=", difference, -0.5], 3.6, 2.7],
      opacity: ["case", [">", difference, 0.1], 0.95, [">=", difference, -0.5], 0.88, 0.48]
    };
  }

  function syncNsi3d() {
    if (!glMap || !glMap.isStyleLoaded()) return;
    var enabled = layerVisible("nsiStructuresToggle", false);
    if (!nsiStructureFeatures.length) {
      if (glMap.getLayer("nw-nsi-points")) glMap.setLayoutProperty("nw-nsi-points", "visibility", "none");
      return;
    }
    var source = glMap.getSource("nw-nsi-source");
    var data = { type: "FeatureCollection", features: nsiStructureFeatures };
    if (source && typeof source.setData === "function") source.setData(data);
    if (!source) {
      glMap.addSource("nw-nsi-source", { type: "geojson", data: data });
      addLayerBelowMask({
        id: "nw-nsi-points",
        type: "circle",
        source: "nw-nsi-source",
        paint: {}
      });
    }
    var paint = nsiImpactPaint(getSelectedStageNavd88());
    glMap.setPaintProperty("nw-nsi-points", "circle-color", paint.color);
    glMap.setPaintProperty("nw-nsi-points", "circle-stroke-color", paint.stroke);
    glMap.setPaintProperty("nw-nsi-points", "circle-radius", paint.radius);
    glMap.setPaintProperty("nw-nsi-points", "circle-opacity", paint.opacity);
    glMap.setPaintProperty("nw-nsi-points", "circle-stroke-width", 0.9);
    glMap.setLayoutProperty("nw-nsi-points", "visibility", visibility(enabled));
    updateDiagnostics();
  }

  async function loadBuildingData() {
    if (buildingData) return buildingData;
    if (!buildingDataPromise) {
      buildingDataPromise = fetch(BUILDINGS_3D_URL, { cache: "force-cache" })
        .then(function (response) {
          if (!response.ok) throw new Error("The North Wildwood 3D building asset could not be loaded.");
          return response.json();
        })
        .then(function (payload) {
          if (payload && payload.metadata && payload.metadata.schema !== "north-wildwood-3d-buildings-v1") {
            throw new Error("The North Wildwood 3D building asset needs to be refreshed.");
          }
          buildingData = payload;
          document.body.dataset.buildings3dCount = String(payload && payload.features ? payload.features.length : 0);
          return payload;
        })
        .catch(function (error) {
          buildingDataPromise = null;
          throw error;
        });
    }
    return buildingDataPromise;
  }

  async function syncBuildings3d() {
    if (!glMap || !glMap.isStyleLoaded()) return;
    var enabled = layerVisible("buildingsToggle", false);
    if (!enabled && !glMap.getSource("nw-buildings-source")) {
      setStatus("3D terrain ×4");
      return;
    }
    if (!glMap.getSource("nw-buildings-source")) {
      var payload = await loadBuildingData();
      glMap.addSource("nw-buildings-source", { type: "geojson", data: payload, generateId: true });
      addLayerBelowMask({
        id: "nw-building-outlines",
        type: "line",
        source: "nw-buildings-source",
        minzoom: 12,
        paint: {
          "line-color": "#b8ad9d",
          "line-opacity": 1,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.35, 18, 1.05, 22, 1.4]
        }
      });
      addLayerBelowMask({
        id: "nw-3d-buildings",
        type: "fill-extrusion",
        source: "nw-buildings-source",
        minzoom: 12,
        paint: {
          "fill-extrusion-color": "#ddd7cb",
          "fill-extrusion-height": ["to-number", ["get", "calculatedHeightM"], 3],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.98,
          "fill-extrusion-vertical-gradient": true
        }
      });
      if (!buildingCursorHandlersWired) {
        buildingCursorHandlersWired = true;
        glMap.on("mouseenter", "nw-3d-buildings", function () {
          if (layerVisible("buildingsToggle", false)) glMap.getCanvas().style.cursor = "pointer";
        });
        glMap.on("mouseleave", "nw-3d-buildings", function () {
          glMap.getCanvas().style.cursor = "";
        });
      }
    }
    if (!glMap.getLayer("nw-3d-buildings")) return;
    glMap.setLayoutProperty("nw-building-outlines", "visibility", visibility(enabled));
    glMap.setLayoutProperty("nw-3d-buildings", "visibility", visibility(enabled));
    setStatus(enabled
      ? "3D terrain ×4 • " + Number(buildingData.features.length).toLocaleString("en-US") + " buildings"
      : "3D terrain ×4");
  }

  function buildBuildingPopupHtml(properties) {
    var p = properties || {};
    var height = Number(p.calculatedHeightFt);
    var stories = Number(p.stories);
    var isTagged = String(p.heightSource || "").indexOf("OpenStreetMap height") === 0;
    var address = escapeTownAddressHtml(p.address || p.osmName || "North Wildwood building");
    var source = escapeTownAddressHtml(p.heightSource || "USACE NSI height model");
    var geometry = escapeTownAddressHtml(p.geometrySource || "Building footprint");
    return '<div class="nsi-structure-popup">' +
      '<span class="house-alert-kicker">3D building height</span>' +
      '<h3>' + address + '</h3>' +
      '<div class="nsi-structure-grid">' +
        '<span>Calculated height</span><strong>' + (Number.isFinite(height) ? height.toFixed(1) + ' ft' : '—') + '</strong>' +
        '<span>Stories</span><strong>' + (Number.isFinite(stories) ? stories.toFixed(stories % 1 ? 1 : 0) : '—') + '</strong>' +
        '<span>Height source</span><strong>' + source + '</strong>' +
        '<span>Footprint source</span><strong>' + geometry + '</strong>' +
      '</div>' +
      '<div class="house-alert-note">' + (isTagged
        ? 'This height comes from an explicit OpenStreetMap height tag.'
        : 'This is a screening estimate from USACE NSI foundation height and story count, using 3.05 m per story plus a 1.2 m roof allowance. It is not a survey.') + '</div>' +
      '</div>';
  }

  function closeGlPopup() {
    if (!glPopup) return;
    var popup = glPopup;
    glPopup = null;
    try { popup.remove(); } catch (_) {}
  }

  function showGlPopup(latlng, html, maxWidth) {
    if (!glMap || !document.body.classList.contains("map-3d-ready")) return;
    closeGlPopup();
    glPopup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: Math.max(240, Number(maxWidth) || 360) + "px",
      offset: 18
    })
      .setLngLat([Number(latlng.lng), Number(latlng.lat)])
      .setHTML(html)
      .addTo(glMap);
    glPopup.on("close", function () {
      glPopup = null;
      if (persistentFloodPopup && map && map.hasLayer(persistentFloodPopup)) map.removeLayer(persistentFloodPopup);
    });
  }

  function syncLeafletViewTo3d() {
    if (!glMap || !map || syncingFrom3d) return;
    var center = map.getCenter();
    var zoom = map.getZoom();
    if (!center || !Number.isFinite(zoom)) return;
    var current = glMap.getCenter();
    var changed = Math.abs(current.lng - center.lng) > 0.000001 ||
      Math.abs(current.lat - center.lat) > 0.000001 ||
      Math.abs(glMap.getZoom() - zoom) > 0.001;
    if (!changed) return;
    syncingFromLeaflet = true;
    glMap.jumpTo({ center: [center.lng, center.lat], zoom: Math.min(MAP_MAX_ZOOM, zoom) });
    syncingFromLeaflet = false;
  }

  function sync3dViewToLeaflet() {
    if (!glMap || !map || syncingFromLeaflet) return;
    var center = glMap.getCenter();
    syncingFrom3d = true;
    map.setView([center.lat, center.lng], Math.min(MAP_MAX_ZOOM, glMap.getZoom()), { animate: false });
    syncingFrom3d = false;
    updateDiagnostics();
  }

  function addCore3dLayers() {
    glMap.addSource("nw-terrain", {
      type: "raster-dem",
      url: TERRAIN_TILEJSON_URL,
      tileSize: 512
    });
    glMap.setTerrain({ source: "nw-terrain", exaggeration: TERRAIN_EXAGGERATION });

    glMap.addSource("nw-satellite-source", {
      type: "raster",
      tiles: [ESRI_WORLD_IMAGERY_URL],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution: "Tiles &copy; Esri"
    });
    glMap.addLayer({
      id: "nw-satellite",
      type: "raster",
      source: "nw-satellite-source",
      layout: { visibility: visibility(layerVisible("satelliteToggle", false)) },
      paint: { "raster-fade-duration": 0 }
    });

    var feature = boundaryGeoJson();
    if (feature) {
      glMap.addSource("nw-boundary-mask-source", { type: "geojson", data: boundaryMaskGeoJson(feature) });
      glMap.addLayer({
        id: "nw-boundary-mask",
        type: "fill",
        source: "nw-boundary-mask-source",
        paint: { "fill-color": "#d7d7d7", "fill-opacity": 0.62 }
      });
      glMap.addSource("nw-boundary-source", { type: "geojson", data: feature });
      glMap.addLayer({
        id: "nw-boundary-outline",
        type: "line",
        source: "nw-boundary-source",
        layout: { visibility: visibility(isTownBoundaryEnabled()) },
        paint: {
          "line-color": getComputedStyle(document.documentElement).getPropertyValue("--boundary-color").trim() || "#000000",
          "line-width": 4.6,
          "line-opacity": 1
        }
      });
    }

    glMap.addSource("nw-road-labels-source", {
      type: "raster",
      tiles: [ROAD_LABELS_URL.replace("{s}", "a")],
      tileSize: 256,
      minzoom: 11,
      maxzoom: 20,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    });
    glMap.addLayer({
      id: "nw-road-labels",
      type: "raster",
      source: "nw-road-labels-source",
      minzoom: ROAD_LABEL_ZOOM,
      layout: { visibility: visibility(layerVisible("roadsToggle", true)) },
      paint: { "raster-opacity": 0.98, "raster-fade-duration": 0 }
    });
  }

  function wire3dInteractions() {
    glMap.on("moveend", sync3dViewToLeaflet);
    glMap.on("click", function (event) {
      var buildingsEnabled = layerVisible("buildingsToggle", false);
      if (buildingsEnabled && mapClickMode === "building" && glMap.getLayer("nw-3d-buildings")) {
        var rendered = glMap.queryRenderedFeatures(event.point, { layers: ["nw-3d-buildings"] });
        if (rendered.length) {
          openPersistentFloodPopup(
            L.latLng(event.lngLat.lat, event.lngLat.lng),
            buildBuildingPopupHtml(rendered[0].properties),
            380
          );
          return;
        }
      }
      handleDepthQueryClick({
        latlng: L.latLng(event.lngLat.lat, event.lngLat.lng),
        originalEvent: event.originalEvent || {}
      });
    });
    window.addEventListener("resize", function () { if (glMap) glMap.resize(); }, { passive: true });
    if (map) map.on("moveend zoomend", syncLeafletViewTo3d);
  }

  async function ensure3dMap() {
    if (glMap) return glMap;
    if (glMapPromise) return glMapPromise;
    glMapPromise = (async function () {
      await loadMapLibreRuntime();
      var container = document.getElementById("map3d");
      if (!container) throw new Error("The 3D map container is unavailable.");
      var style = await load3dStyle();
      var leafletCenter = map && map.getCenter ? map.getCenter() : { lng: -74.7998357, lat: 39.006945 };
      var leafletZoom = map && map.getZoom ? map.getZoom() : 13;
      glMap = new maplibregl.Map({
        container: container,
        style: style,
        center: [leafletCenter.lng, leafletCenter.lat],
        zoom: Math.min(MAP_MAX_ZOOM, leafletZoom),
        minZoom: 11,
        maxZoom: MAP_MAX_ZOOM,
        pitch: DEFAULT_PITCH,
        bearing: DEFAULT_BEARING,
        maxPitch: 85,
        scrollZoom: true,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        antialias: true,
        attributionControl: false,
        canvasContextAttributes: { antialias: true }
      });
      if (glMap.touchZoomRotate && typeof glMap.touchZoomRotate.disableRotation === "function") {
        glMap.touchZoomRotate.disableRotation();
      }
      glMap.addControl(new GoogleEarth3dControl(), "top-right");
      glMap.on("error", function (event) {
        console.warn("North Wildwood 3D renderer warning.", event && event.error ? event.error : event);
      });
      await new Promise(function (resolve, reject) {
        var timer = window.setTimeout(function () { reject(new Error("The 3D renderer timed out.")); }, 20000);
        glMap.once("load", function () {
          window.clearTimeout(timer);
          resolve();
        });
      });
      addCore3dLayers();
      var renderedStyle = glMap.getStyle();
      var mapCredits = [
        '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
        'Esri',
        '<a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
        '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">&copy; Mapterhorn</a>'
      ].concat(Object.keys(renderedStyle.sources || {}).map(function (sourceId) {
        return renderedStyle.sources[sourceId] && renderedStyle.sources[sourceId].attribution;
      })).filter(function (credit, index, allCredits) {
        return Boolean(credit) && allCredits.indexOf(credit) === index;
      });
      installMapCreditsInLayers(mapCredits);
      wire3dInteractions();
      syncBoundary3d();
      syncFloodLayer3d();
      syncSatellite3d();
      syncRoadLabels3d();
      syncParcels3d();
      syncNsi3d();
      await syncBuildings3d();
      document.body.classList.add("map-3d-ready");
      document.body.dataset.map3d = "ready";
      document.body.dataset.terrainExaggeration = String(TERRAIN_EXAGGERATION);
      document.body.dataset.map3dMaxZoom = String(MAP_MAX_ZOOM);
      document.body.dataset.map3dPitch = String(glMap.getPitch());
      updateDiagnostics();
      suspendLeafletVisualLayers();
      requestAnimationFrame(function () { glMap.resize(); });
      return glMap;
    })().catch(function (error) {
      document.body.dataset.map3d = "fallback";
      console.warn("The 3D map could not start; the 2D map remains available.", error);
      glMapPromise = null;
      if (glMap) {
        try { glMap.remove(); } catch (_) {}
        glMap = null;
      }
      return null;
    });
    return glMapPromise;
  }

  function install3dLauncher() {
    if (document.getElementById("nw3dLauncher")) return;
    var host = document.getElementById("mapWrap") || document.body;
    var launcher = document.createElement("button");
    launcher.id = "nw3dLauncher";
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open 3D terrain view");
    launcher.setAttribute("title", "Open 3D terrain view");
    launcher.innerHTML = '<svg viewBox="0 0 32 20" aria-hidden="true"><path d="M2 10s5-8 14-8 14 8 14 8-5 8-14 8S2 10 2 10Z"></path><circle cx="16" cy="10" r="4"></circle></svg><span class="nw-3d-launcher-label">3D</span>';
    launcher.addEventListener("click", async function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      launcher.setAttribute("aria-busy", "true");
      launcher.querySelector(".nw-3d-launcher-label").textContent = "Loading";
      var nextMap = await ensure3dMap();
      if (nextMap) {
        nextMap.stop();
        nextMap.easeTo({ pitch: THREE_D_PITCH, duration: 420 });
        return;
      }
      launcher.setAttribute("aria-busy", "false");
      launcher.querySelector(".nw-3d-launcher-label").textContent = "3D";
      toast("3D terrain could not load. The 2D map is still available.");
    });
    host.appendChild(launcher);
    document.body.dataset.map3d = "idle";
  }

  install3dLauncher();

  var originalSetBuildingsEnabled = setBuildingsEnabled;
  setBuildingsEnabled = async function (enabled) {
    if (glMap && document.body.classList.contains("map-3d-ready")) {
      var shouldEnable = Boolean(enabled);
      var toggle = document.getElementById("buildingsToggle");
      if (toggle) {
        toggle.classList.toggle("on", shouldEnable);
        toggle.setAttribute("aria-checked", String(shouldEnable));
      }
      if (buildingsLayer && map && map.hasLayer(buildingsLayer)) map.removeLayer(buildingsLayer);
      if (shouldEnable) setMapClickMode("building", { closePopup: false });
      updateExportBuildingsLayer();
      updateMapClickModeControl();
      toast("");
      await syncBuildings3d();
      suspendLeafletVisualLayers();
      return;
    }
    var result = await originalSetBuildingsEnabled.apply(this, arguments);
    if (glMap) await syncBuildings3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalSetSatelliteEnabled = setSatelliteEnabled;
  setSatelliteEnabled = function () {
    var result = originalSetSatelliteEnabled.apply(this, arguments);
    syncSatellite3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalUpdateRoadLayerAppearance = updateRoadLayerAppearance;
  updateRoadLayerAppearance = function () {
    var result = originalUpdateRoadLayerAppearance.apply(this, arguments);
    syncRoadLabels3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalApplyTownBoundaryVisibility = applyTownBoundaryVisibility;
  applyTownBoundaryVisibility = function () {
    var result = originalApplyTownBoundaryVisibility.apply(this, arguments);
    syncBoundary3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalUpdateMunicipalBoundaryLayer = updateMunicipalBoundaryLayer;
  updateMunicipalBoundaryLayer = function () {
    var result = originalUpdateMunicipalBoundaryLayer.apply(this, arguments);
    syncBoundary3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalSetParcelsEnabled = setParcelsEnabled;
  setParcelsEnabled = async function () {
    var result = await originalSetParcelsEnabled.apply(this, arguments);
    syncParcels3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalSetNsiStructuresEnabled = setNsiStructuresEnabled;
  setNsiStructuresEnabled = async function () {
    var result = await originalSetNsiStructuresEnabled.apply(this, arguments);
    syncNsi3d();
    suspendLeafletVisualLayers();
    return result;
  };

  var originalUpdateNsiStructureImpactLayer = updateNsiStructureImpactLayer;
  updateNsiStructureImpactLayer = function () {
    var result = originalUpdateNsiStructureImpactLayer.apply(this, arguments);
    syncNsi3d();
    return result;
  };

  var originalClearFloodLayer = clearFloodLayer;
  clearFloodLayer = function () {
    var result = originalClearFloodLayer.apply(this, arguments);
    syncFloodLayer3d();
    return result;
  };

  var originalApplyOverlayOpacity = applyOverlayOpacity;
  applyOverlayOpacity = function () {
    var result = originalApplyOverlayOpacity.apply(this, arguments);
    if (glMap && glMap.getLayer("nw-flood-overlay")) {
      glMap.setPaintProperty("nw-flood-overlay", "raster-opacity", overlayOpacity);
    }
    return result;
  };

  var originalSetFloodLayer = setFloodLayer;
  setFloodLayer = async function () {
    var result = await originalSetFloodLayer.apply(this, arguments);
    syncFloodLayer3d();
    return result;
  };

  var originalSetPhysicsFloodLayer = setPhysicsFloodLayer;
  setPhysicsFloodLayer = async function () {
    var result = await originalSetPhysicsFloodLayer.apply(this, arguments);
    syncFloodLayer3d();
    return result;
  };

  var originalSetMapClickMode = setMapClickMode;
  setMapClickMode = function (mode, options) {
    var result = originalSetMapClickMode.apply(this, arguments);
    if (!options || options.closePopup !== false) closeGlPopup();
    return result;
  };

  var originalOpenPersistentFloodPopup = openPersistentFloodPopup;
  openPersistentFloodPopup = function (latlng, html, maxWidth) {
    var popup = originalOpenPersistentFloodPopup.apply(this, arguments);
    showGlPopup(latlng, html, maxWidth);
    return popup;
  };

  var originalUpdatePersistentDepthQueryPopup = updatePersistentDepthQueryPopup;
  updatePersistentDepthQueryPopup = function () {
    var result = originalUpdatePersistentDepthQueryPopup.apply(this, arguments);
    if (glPopup && persistentFloodPopup && typeof persistentFloodPopup.getContent === "function") {
      glPopup.setHTML(String(persistentFloodPopup.getContent() || ""));
    }
    return result;
  };

  window.NORTH_WILDWOOD_3D = {
    ensure: ensure3dMap,
    getMap: function () { return glMap; },
    getBuildingData: function () { return buildingData; },
    syncFlood: syncFloodLayer3d,
    syncBuildings: syncBuildings3d,
    state: function () {
      return {
        ready: document.body.classList.contains("map-3d-ready"),
        exaggeration: TERRAIN_EXAGGERATION,
        maxZoom: MAP_MAX_ZOOM,
        pitch: glMap ? glMap.getPitch() : null,
        bearing: glMap ? glMap.getBearing() : null,
        zoom: glMap ? glMap.getZoom() : null,
        terrain: glMap ? glMap.getTerrain() : null,
        buildingCount: buildingData && buildingData.features ? buildingData.features.length : 0,
        buildingsVisible: glMap && glMap.getLayer("nw-3d-buildings")
          ? glMap.getLayoutProperty("nw-3d-buildings", "visibility") !== "none"
          : false
      };
    }
  };
})();
