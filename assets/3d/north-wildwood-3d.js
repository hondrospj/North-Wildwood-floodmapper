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
  var BUILDINGS_3D_URL = new URL("./assets/3d/NorthWildwoodBuildings3D.geojson?v=20260823-nw-3d-v2", APP_BASE).href;

  var glMap = null;
  var glMapPromise = null;
  var glStyleReady = false;
  var glPopup = null;
  var buildingData = null;
  var buildingDataPromise = null;
  var mapLibreRuntimePromise = null;
  var mapStylePromise = null;
  var floodPlaneLayer = null;
  var floodRemovalTimer = null;
  var syncingFromLeaflet = false;
  var syncingFrom3d = false;
  var syncingModeTransition = false;
  var buildingCursorHandlersWired = false;
  var contextBuildingExtrusionLayerIds = [];
  var navControlSyncFrame = null;
  var syncPersistentNavControl = function () {};

  function schedulePersistentNavControlSync() {
    if (navControlSyncFrame !== null) return;
    navControlSyncFrame = requestAnimationFrame(function () {
      navControlSyncFrame = null;
      syncPersistentNavControl();
    });
  }

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
        glMap.getLayoutProperty("nw-nsi-points", "visibility") !== "none"),
      floodSurface: document.body.dataset.map3dFloodSurface || null,
      floodAltitudeMeters: Number(document.body.dataset.map3dFloodAltitudeMeters) || null,
      buildingMaximumHeightFt: Number(document.body.dataset.buildings3dMaxHeightFt) || null
    };
    output.textContent = JSON.stringify(state);
  }

  function normalizeBearing(value) {
    return ((Number(value) % 360) + 360) % 360;
  }

  function bearingFromViewpointVector(x, y) {
    var viewpointBearing = Math.atan2(Number(x) || 0, -(Number(y) || 0)) * 180 / Math.PI;
    return normalizeBearing(viewpointBearing + 180);
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

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  async function load3dStyle() {
    if (!mapStylePromise) {
      mapStylePromise = fetch(ESRI_STYLE_URL, { cache: "force-cache" })
        .then(function (response) {
          if (!response.ok) throw new Error("The 3D basemap style could not be loaded.");
          return response.json();
        })
        .then(function (style) {
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
        })
        .catch(function (error) {
          mapStylePromise = null;
          throw error;
        });
    }
    return cloneJson(await mapStylePromise);
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

  function activeFloodCoordinates() {
    if (typeof getActiveFloodOverlayCoordinates === "function") {
      var configured = getActiveFloodOverlayCoordinates();
      if (Array.isArray(configured) && configured.length === 4) return configured;
    }
    return coordinatesFromLeafletBounds(floodLatLngBounds);
  }

  function configuredWorldFileCoordinates() {
    if (typeof getConfiguredWorldFileCoordinates === "function") {
      var configured = getConfiguredWorldFileCoordinates();
      if (Array.isArray(configured) && configured.length === 4) return configured;
    }
    return coordinatesFromLeafletBounds(floodLatLngBounds || getBoundaryDrivenOverlayBounds());
  }

  function addLayerBelowMask(layer) {
    if (!glMap || glMap.getLayer(layer.id)) return;
    glMap.addLayer(layer, glMap.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined);
  }

  function removeLayerAndSource(layerId, sourceId) {
    if (!glMap || !glStyleReady) return;
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
    if (!glMap || !glStyleReady || !options.url || !options.coordinates) return;
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

  function compileFloodPlaneShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(shader) || "Unknown shader error";
      gl.deleteShader(shader);
      throw new Error("The flat-water shader could not compile: " + message);
    }
    return shader;
  }

  function createFlatFloodPlane(options) {
    var initial = options || {};
    return {
      id: "nw-flood-overlay",
      type: "custom",
      // Floodwater is a true level surface in the same depth buffer as terrain.
      // A no-depth 2D custom pass made the PNG slide over the map while the
      // camera moved and could leave MapLibre's following layers with mutated
      // WebGL state. Sharing the 3D depth buffer keeps the world-file corners
      // locked to terrain and clips water cleanly at land and structures.
      renderingMode: "3d",
      map: null,
      gl: null,
      program: null,
      buffer: null,
      vertexArray: null,
      texture: null,
      matrixLocation: null,
      opacityLocation: null,
      imageLocation: null,
      positionLocation: -1,
      textureLocation: -1,
      mercatorOrigin: null,
      localProjectionMatrix: new Float32Array(16),
      textureReady: false,
      visible: Boolean(initial.visible),
      textureLoadPromise: Promise.resolve(false),
      imageToken: 0,
      url: initial.url || "",
      coordinates: initial.coordinates || null,
      altitudeMeters: Number(initial.altitudeMeters) || 0,
      opacity: Number.isFinite(Number(initial.opacity)) ? Number(initial.opacity) : 0.75,

      onAdd: function (mapInstance, gl) {
        this.map = mapInstance;
        this.gl = gl;
        var priorVertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        var priorArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        var priorActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0);
        var priorTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        var vertexSource = '#version 300 es\n' +
          'precision highp float;\n' +
          'uniform mat4 u_matrix;\n' +
          'in vec3 a_position;\n' +
          'in vec2 a_texture;\n' +
          'out vec2 v_texture;\n' +
          'void main(){\n' +
          '  v_texture = a_texture;\n' +
          '  gl_Position = u_matrix * vec4(a_position, 1.0);\n' +
          '}';
        var fragmentSource = '#version 300 es\n' +
          'precision highp float;\n' +
          'uniform sampler2D u_image;\n' +
          'uniform float u_opacity;\n' +
          'in vec2 v_texture;\n' +
          'out vec4 fragColor;\n' +
          'void main(){ vec4 pixel = texture(u_image, v_texture); float alpha = pixel.a * u_opacity; if(alpha < 0.012) discard; fragColor = vec4(pixel.rgb * alpha, alpha); }';
        var vertexShader = compileFloodPlaneShader(gl, gl.VERTEX_SHADER, vertexSource);
        var fragmentShader = compileFloodPlaneShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
          throw new Error("The flat-water renderer could not link: " + (gl.getProgramInfoLog(this.program) || "Unknown program error"));
        }
        this.matrixLocation = gl.getUniformLocation(this.program, "u_matrix");
        this.opacityLocation = gl.getUniformLocation(this.program, "u_opacity");
        this.imageLocation = gl.getUniformLocation(this.program, "u_image");
        this.positionLocation = gl.getAttribLocation(this.program, "a_position");
        this.textureLocation = gl.getAttribLocation(this.program, "a_texture");
        this.buffer = gl.createBuffer();
        this.vertexArray = gl.createVertexArray();
        gl.bindVertexArray(this.vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(this.textureLocation);
        gl.vertexAttribPointer(this.textureLocation, 2, gl.FLOAT, false, 20, 12);
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.updateGeometry();
        this.loadTexture(this.url);
        // onAdd runs outside MapLibre's guarded custom render pass. Restore
        // every binding we touched so the next terrain frame starts from the
        // state MapLibre recorded in its own WebGL cache.
        gl.bindTexture(gl.TEXTURE_2D, priorTexture0);
        gl.activeTexture(priorActiveTexture);
        gl.bindBuffer(gl.ARRAY_BUFFER, priorArrayBuffer);
        gl.bindVertexArray(priorVertexArray);
      },

      updateGeometry: function () {
        if (!this.gl || !Array.isArray(this.coordinates) || this.coordinates.length !== 4) return;
        var points = this.coordinates.map(function (coordinate) {
          return maplibregl.MercatorCoordinate.fromLngLat(
            { lng: Number(coordinate[0]), lat: Number(coordinate[1]) },
            Number(this.altitudeMeters) || 0
          );
        }, this);
        // Store small camera-independent offsets around the quad's own center.
        // Multiplying two large high/low world coordinates in the vertex shader
        // still loses bits when the zoom matrix changes. A local origin keeps
        // every vertex near zero and removes the sub-pixel PNG "wiggle".
        this.mercatorOrigin = {
          x: points.reduce(function (sum, point) { return sum + point.x; }, 0) / points.length,
          y: points.reduce(function (sum, point) { return sum + point.y; }, 0) / points.length,
          z: points.reduce(function (sum, point) { return sum + (point.z || 0); }, 0) / points.length
        };
        var origin = this.mercatorOrigin;
        var vertex = function (point, u, v) {
          return [point.x - origin.x, point.y - origin.y, (point.z || 0) - origin.z, u, v];
        };
        var values = []
          .concat(vertex(points[0], 0, 0), vertex(points[1], 1, 0), vertex(points[2], 1, 1))
          .concat(vertex(points[0], 0, 0), vertex(points[2], 1, 1), vertex(points[3], 0, 1));
        var priorArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(values), this.gl.STATIC_DRAW);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, priorArrayBuffer);
        document.body.dataset.map3dFloodPrecision = "camera-stable-local-origin";
      },

      loadTexture: function (url) {
        if (!this.gl || !url) return Promise.resolve(false);
        var self = this;
        var token = ++this.imageToken;
        var image = new Image();
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        document.body.dataset.map3dFloodTexture = self.textureReady ? "updating" : "loading";
        this.textureLoadPromise = new Promise(function (resolve) {
          image.onload = function () {
            if (token !== self.imageToken || !self.gl || !self.texture) {
              resolve(false);
              return;
            }
            var gl = self.gl;
            // Image decoding completes outside the custom render callback.
            // Preserve MapLibre's live bindings and pixel-store flags around
            // this upload; leaking them desynchronizes its cached GL state and
            // is visible as whole-frame flashing on the next camera movement.
            var priorActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
            var priorFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
            var priorPremultiplyAlpha = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
            gl.activeTexture(gl.TEXTURE0);
            var priorTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
            try {
              gl.bindTexture(gl.TEXTURE_2D, self.texture);
              gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
              gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
              // Trilinear minification removes block stair-stepping without
              // replacing the texture while the camera is moving.
              gl.generateMipmap(gl.TEXTURE_2D);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            } finally {
              gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, priorFlipY);
              gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, priorPremultiplyAlpha);
              gl.bindTexture(gl.TEXTURE_2D, priorTexture0);
              gl.activeTexture(priorActiveTexture);
            }
            self.textureReady = true;
            document.body.dataset.map3dFloodTexture = "ready";
            if (self.map) self.map.triggerRepaint();
            resolve(true);
          };
          image.onerror = function () {
            if (token === self.imageToken) {
              // Keep the last fully uploaded frame visible. A failed replacement
              // must not flash a transparent map or destroy a valid flood frame.
              document.body.dataset.map3dFloodTexture = self.textureReady ? "stale" : "unavailable";
            }
            resolve(false);
          };
        });
        image.src = url;
        return this.textureLoadPromise;
      },

      update: function (next) {
        var priorUrl = this.url;
        this.url = next.url || "";
        this.coordinates = next.coordinates || null;
        this.altitudeMeters = Number(next.altitudeMeters) || 0;
        this.opacity = Math.max(0, Math.min(1, Number(next.opacity)));
        this.updateGeometry();
        if (this.url && this.url !== priorUrl) {
          // The old texture remains on the GPU until the replacement is decoded
          // and uploaded, preventing flashes during timeline and camera movement.
          this.loadTexture(this.url);
        }
        if (this.map) this.map.triggerRepaint();
      },

      setOpacity: function (value) {
        this.opacity = Math.max(0, Math.min(1, Number(value)));
        if (this.map) this.map.triggerRepaint();
      },

      setVisible: function (value) {
        this.visible = Boolean(value);
        if (this.map) this.map.triggerRepaint();
      },

      whenReady: function () {
        return this.textureLoadPromise || Promise.resolve(this.textureReady);
      },

      render: function (gl, args) {
        if (!this.visible || !this.textureReady || !this.program || !this.buffer || !this.texture) return;
        var matrix = args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix
          ? args.defaultProjectionData.mainMatrix
          : args && args.projectionMatrix
            ? args.projectionMatrix
            : args;
        if (!matrix) return;
        if (!this.mercatorOrigin) return;
        // Compose M * translate(origin) in JavaScript's double precision, then
        // upload one camera-relative Float32 matrix. This avoids the large
        // world-coordinate cancellation that made the flood texture shift
        // between adjacent zoom frames.
        var origin = this.mercatorOrigin;
        var localMatrix = this.localProjectionMatrix;
        for (var matrixIndex = 0; matrixIndex < 12; matrixIndex += 1) {
          localMatrix[matrixIndex] = matrix[matrixIndex];
        }
        localMatrix[12] = matrix[0] * origin.x + matrix[4] * origin.y + matrix[8] * origin.z + matrix[12];
        localMatrix[13] = matrix[1] * origin.x + matrix[5] * origin.y + matrix[9] * origin.z + matrix[13];
        localMatrix[14] = matrix[2] * origin.x + matrix[6] * origin.y + matrix[10] * origin.z + matrix[14];
        localMatrix[15] = matrix[3] * origin.x + matrix[7] * origin.y + matrix[11] * origin.z + matrix[15];
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.matrixLocation, false, localMatrix);
        gl.uniform1f(this.opacityLocation, this.opacity);
        gl.bindVertexArray(this.vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform1i(this.imageLocation, 0);
        // MapLibre brackets custom render callbacks with context.setDirty().
        // Set every state this draw needs, then let that guard restore its
        // cached defaults. Per-frame getParameter() readbacks force a GPU/CPU
        // synchronization and were themselves a source of camera jank.
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        // Strict depth comparison makes the shoreline deterministic. LEQUAL
        // let coplanar terrain/water samples alternate as the camera moved.
        gl.depthFunc(gl.LESS);
        gl.disable(gl.CULL_FACE);
        // Terrain already owns the depth buffer. Water should be clipped by it
        // without preventing the later opaque building pass from drawing.
        gl.depthMask(false);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
        document.body.dataset.map3dFloodGlIsolation = "maplibre-guarded-no-readback";
        document.body.dataset.map3dFloodDepthFunction = "less-no-coplanar-fight";
      },

      onRemove: function (_, gl) {
        this.imageToken += 1;
        if (this.texture) gl.deleteTexture(this.texture);
        if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
        if (this.buffer) gl.deleteBuffer(this.buffer);
        if (this.program) gl.deleteProgram(this.program);
        this.texture = null;
        this.vertexArray = null;
        this.buffer = null;
        this.program = null;
        this.gl = null;
        this.map = null;
      }
    };
  }

  function syncFloodPresentationMode() {
    if (!glMap || !glStyleReady) return;
    var pitched = glMap.getPitch() > 10;
    if (glMap.getLayer("nw-flood-drape")) {
      glMap.setLayoutProperty("nw-flood-drape", "visibility", visibility(!pitched));
    }
    if (floodPlaneLayer && typeof floodPlaneLayer.setVisible === "function") {
      floodPlaneLayer.setVisible(pitched);
    }
    document.body.dataset.map3dFloodRenderer = pitched ? "depth-locked-water-plane" : "stable-image-layer";
  }

  function placeFloodBelowBuildingDepthPass() {
    if (!glMap || !glMap.getLayer("nw-flood-overlay")) return;
    var buildingLayerIds = contextBuildingExtrusionLayerIds.concat([
      "nw-building-outlines",
      "nw-3d-buildings-wet",
      "nw-3d-buildings"
    ]);
    var firstBuildingLayer = (glMap.getStyle().layers || []).find(function (layer) {
      return buildingLayerIds.indexOf(layer.id) >= 0;
    });
    if (firstBuildingLayer) glMap.moveLayer("nw-flood-overlay", firstBuildingLayer.id);
    document.body.dataset.map3dFloodBuildingOcclusion = firstBuildingLayer ? "opaque-depth-pass" : "not-required";
  }

  function buildingFloodDepthFeetExpression(stageNavd88) {
    var stage = stageNavd88 === null || typeof stageNavd88 === "undefined" ? NaN : Number(stageNavd88);
    if (!Number.isFinite(stage)) return 0;
    return ["max", 0, ["-", stage,
      ["to-number", ["get", "visualGroundNavd88Ft"], stage]
    ]];
  }

  function buildingWetHeightExpression(stageNavd88) {
    var depthFeet = buildingFloodDepthFeetExpression(stageNavd88);
    if (!Array.isArray(depthFeet)) return 0;
    return ["min",
      ["to-number", ["get", "renderHeightM"], 3],
      ["*", depthFeet, 0.3048 * TERRAIN_EXAGGERATION]
    ];
  }

  function buildingFloodColorExpression(stageNavd88) {
    var depthFeet = buildingFloodDepthFeetExpression(stageNavd88);
    if (!Array.isArray(depthFeet)) return "#7DF9FF";
    return ["step", depthFeet,
      "#7DF9FF",
      1, "#5DE7FF",
      2, "#38D3FF",
      3, "#1BB7F5",
      4, "#168CEB",
      5, "#156BE0",
      6, "#1853C6",
      7, "#173EA8",
      8, "#132F84",
      9, "#0B1E5B",
      10, "#050E33"
    ];
  }

  function syncBuildingFloodBands3d(stageNavd88) {
    if (!glMap || !glStyleReady) return;
    var wetLayer = glMap.getLayer("nw-3d-buildings-wet");
    var dryLayer = glMap.getLayer("nw-3d-buildings");
    if (!wetLayer || !dryLayer) return;
    var stage = stageNavd88 === null || typeof stageNavd88 === "undefined" ? NaN : Number(stageNavd88);
    var selectedStage = Number.isFinite(stage) ? stage : null;
    var wetHeight = buildingWetHeightExpression(selectedStage);
    glMap.setPaintProperty("nw-3d-buildings-wet", "fill-extrusion-height", wetHeight);
    glMap.setPaintProperty("nw-3d-buildings-wet", "fill-extrusion-color", buildingFloodColorExpression(selectedStage));
    glMap.setPaintProperty("nw-3d-buildings", "fill-extrusion-base", wetHeight);
    document.body.dataset.map3dBuildingWaterline = "split-extrusion";
    document.body.dataset.map3dBuildingWaterStageNavd88Ft = selectedStage === null ? "none" : selectedStage.toFixed(3);
  }

  function syncFloodLayer3d() {
    if (!glMap || !glStyleReady) return;
    var url = currentFloodLayer && (currentFloodLayer._url || currentFloodLayer._image && currentFloodLayer._image.src);
    var coordinates = activeFloodCoordinates();
    if (!url || !coordinates) {
      syncBuildingFloodBands3d(null);
      if (floodRemovalTimer) window.clearTimeout(floodRemovalTimer);
      // clearFloodLayer() is part of normal async frame replacement. Give the
      // incoming frame time to arrive while the last complete texture remains.
      floodRemovalTimer = window.setTimeout(function () {
        var activeUrl = currentFloodLayer && (currentFloodLayer._url || currentFloodLayer._image && currentFloodLayer._image.src);
        if (activeUrl) return;
        removeLayerAndSource("nw-flood-drape", "nw-flood-drape-source");
        removeLayerAndSource("nw-flood-overlay", "nw-flood-source");
        floodPlaneLayer = null;
        document.body.dataset.map3dFloodTexture = "empty";
      }, 2500);
      return;
    }
    if (floodRemovalTimer) {
      window.clearTimeout(floodRemovalTimer);
      floodRemovalTimer = null;
    }
    var stageNavd88 = Number(getSelectedStageNavd88());
    var pitched = glMap.getPitch() > 10;
    var physicalAltitudeMeters = Number.isFinite(stageNavd88)
      ? stageNavd88 * 0.3048 * TERRAIN_EXAGGERATION
      : 0;
    var options = {
      url: url,
      coordinates: coordinates,
      opacity: overlayOpacity,
      visible: pitched,
      altitudeMeters: physicalAltitudeMeters
    };
    // Top-down mode uses MapLibre's native image source, which remains in one
    // stable style layer while the camera pans or rotates. The preloaded flat
    // depth plane is reserved for pitched 3D, where water must meet terrain
    // and building walls instead of stretching over the DEM.
    updateImageLayer({
      sourceId: "nw-flood-drape-source",
      layerId: "nw-flood-drape",
      url: url,
      coordinates: coordinates,
      opacity: overlayOpacity,
      visible: !pitched
    });
    if (glMap.getSource("nw-flood-source")) removeLayerAndSource("nw-flood-overlay", "nw-flood-source");
    if (!glMap.getLayer("nw-flood-overlay")) {
      floodPlaneLayer = createFlatFloodPlane(options);
      addLayerBelowMask(floodPlaneLayer);
    } else if (floodPlaneLayer && typeof floodPlaneLayer.update === "function") {
      floodPlaneLayer.update(options);
    }
    placeFloodBelowBuildingDepthPass();
    syncBuildingFloodBands3d(stageNavd88);
    syncFloodPresentationMode();
    document.body.dataset.map3dFloodSurface = "flat-water-overlay";
    document.body.dataset.map3dFloodDepthMode = "independent";
    document.body.dataset.map3dFloodGeometry = currentFloodLayer && currentFloodLayer._worldFileAffine
      ? "world-file-quadrilateral"
      : "axis-aligned";
    document.body.dataset.map3dFloodAltitudeMeters = options.altitudeMeters.toFixed(3);
    document.body.dataset.map3dFloodPhysicalAltitudeMeters = physicalAltitudeMeters.toFixed(3);
    document.body.dataset.map3dFloodCompositing = "shared-3d-depth-buffer";
  }

  function syncSatellite3d() {
    if (!glMap || !glStyleReady || !glMap.getLayer("nw-satellite")) return;
    glMap.setLayoutProperty("nw-satellite", "visibility", visibility(layerVisible("satelliteToggle", false)));
  }

  function syncRoadLabels3d() {
    if (!glMap || !glStyleReady || !glMap.getLayer("nw-road-labels")) return;
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
    if (!glMap || !glStyleReady) return;
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
    if (!glMap || !glStyleReady) return;
    var enabled = layerVisible("parcelsToggle", false);
    var coordinates = configuredWorldFileCoordinates();
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
    if (!glMap || !glStyleReady) return;
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

  function buildingFeatureCenter(feature) {
    var geometry = feature && feature.geometry;
    var coordinates = geometry && geometry.coordinates;
    if (!Array.isArray(coordinates)) return null;
    var minimumLng = Infinity;
    var minimumLat = Infinity;
    var maximumLng = -Infinity;
    var maximumLat = -Infinity;
    function visit(value) {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
        var lng = Number(value[0]);
        var lat = Number(value[1]);
        minimumLng = Math.min(minimumLng, lng);
        maximumLng = Math.max(maximumLng, lng);
        minimumLat = Math.min(minimumLat, lat);
        maximumLat = Math.max(maximumLat, lat);
        return;
      }
      value.forEach(visit);
    }
    visit(coordinates);
    return Number.isFinite(minimumLng) && Number.isFinite(minimumLat)
      ? [(minimumLng + maximumLng) / 2, (minimumLat + maximumLat) / 2]
      : null;
  }

  function finiteBuildingNumber(value) {
    if (value === null || typeof value === "undefined" || value === "" || typeof value === "boolean") return NaN;
    var number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function prepareVisualBuildingGround(sourceFeatures) {
    var cellSize = 0.001;
    var known = [];
    var centers = sourceFeatures.map(buildingFeatureCenter);
    sourceFeatures.forEach(function (feature, index) {
      var properties = feature && feature.properties ? feature.properties : {};
      var localGround = finiteBuildingNumber(properties.localGroundNavd88Ft);
      if (!Number.isFinite(localGround)) {
        var firstFloor = finiteBuildingNumber(properties.modeledFirstFloorNavd88Ft);
        var foundation = finiteBuildingNumber(properties.foundationHeightFt);
        if (Number.isFinite(firstFloor) && Number.isFinite(foundation)) {
          localGround = firstFloor - Math.max(0, foundation);
        }
      }
      if (Number.isFinite(localGround) && centers[index]) {
        known.push({ index: index, center: centers[index], ground: localGround });
      }
    });
    var sortedGround = known.map(function (entry) { return entry.ground; }).sort(function (a, b) { return a - b; });
    var medianGround = sortedGround.length
      ? sortedGround[Math.floor(sortedGround.length / 2)]
      : 5;
    var grid = Object.create(null);
    known.forEach(function (entry) {
      var key = Math.floor(entry.center[0] / cellSize) + ":" + Math.floor(entry.center[1] / cellSize);
      if (!grid[key]) grid[key] = [];
      grid[key].push(entry);
    });
    var derivedCount = 0;
    var medianCount = 0;
    var result = sourceFeatures.map(function (feature, index) {
      var properties = feature && feature.properties ? feature.properties : {};
      var ground = finiteBuildingNumber(properties.localGroundNavd88Ft);
      if (!Number.isFinite(ground)) {
        var storedFloor = finiteBuildingNumber(properties.modeledFirstFloorNavd88Ft);
        var storedFoundation = finiteBuildingNumber(properties.foundationHeightFt);
        if (Number.isFinite(storedFloor) && Number.isFinite(storedFoundation)) {
          ground = storedFloor - Math.max(0, storedFoundation);
        }
      }
      if (Number.isFinite(ground)) {
        return { value: ground, source: "2019 bare-earth LiDAR building reference" };
      }
      var center = centers[index];
      var nearest = null;
      if (center) {
        var cellX = Math.floor(center[0] / cellSize);
        var cellY = Math.floor(center[1] / cellSize);
        for (var radius = 0; radius <= 12 && !nearest; radius += 1) {
          var candidates = [];
          for (var x = cellX - radius; x <= cellX + radius; x += 1) {
            for (var y = cellY - radius; y <= cellY + radius; y += 1) {
              if (radius > 0 && x > cellX - radius && x < cellX + radius && y > cellY - radius && y < cellY + radius) continue;
              var entries = grid[x + ":" + y];
              if (entries) candidates = candidates.concat(entries);
            }
          }
          candidates.forEach(function (candidate) {
            var dx = candidate.center[0] - center[0];
            var dy = candidate.center[1] - center[1];
            var distance = dx * dx + dy * dy;
            if (!nearest || distance < nearest.distance) nearest = { distance: distance, ground: candidate.ground };
          });
        }
      }
      if (nearest) {
        derivedCount += 1;
        return { value: nearest.ground, source: "nearest 2019 bare-earth LiDAR building reference" };
      }
      medianCount += 1;
      return { value: medianGround, source: "municipal 2019 bare-earth LiDAR building median" };
    });
    return {
      values: result,
      measuredCount: known.length,
      derivedCount: derivedCount,
      medianCount: medianCount
    };
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
          if (payload && payload.metadata && payload.metadata.schema !== "north-wildwood-3d-buildings-v2") {
            throw new Error("The North Wildwood 3D building asset needs to be refreshed.");
          }
          var sourceFeatures = Array.isArray(payload && payload.features) ? payload.features : [];
          var visualGround = prepareVisualBuildingGround(sourceFeatures);
          var excludedFallbacks = 0;
          var sanitizedFeatures = sourceFeatures.reduce(function (features, feature, sourceIndex) {
            var properties = feature && feature.properties ? feature.properties : {};
            if (String(properties.geometrySource || "") === "NSI modeled square") {
              excludedFallbacks += 1;
              return features;
            }
            var taggedHeight = String(properties.heightSource || "").indexOf("OpenStreetMap height") === 0
              ? Number(properties.calculatedHeightM)
              : NaN;
            var rawStories = Number(properties.stories);
            var stories = Number.isFinite(rawStories)
              ? Math.max(1, Math.min(6, Math.round(rawStories)))
              : 1;
            var modeledHeight = stories * 3.05 + 1.2;
            var renderHeightM = Number.isFinite(taggedHeight)
              ? Math.max(3.2, Math.min(30, taggedHeight))
              : Math.max(3.2, Math.min(19.5, modeledHeight));
            features.push(Object.assign({}, feature, {
              properties: Object.assign({}, properties, {
                renderStories: stories,
                renderHeightM: Number(renderHeightM.toFixed(2)),
                renderHeightFt: Number((renderHeightM * 3.280839895).toFixed(1)),
                renderHeightSource: Number.isFinite(taggedHeight)
                  ? "OpenStreetMap tagged height"
                  : String(properties.geometryMatch || "") === "point-in-footprint"
                    ? "NSI story count, screened for local outliers"
                    : "Screened one-story vector-footprint default",
                visualGroundNavd88Ft: Number(visualGround.values[sourceIndex].value.toFixed(2)),
                visualGroundSource: visualGround.values[sourceIndex].source,
                groundReferenceSource: properties.groundReferenceSource || "2019 bare-earth LiDAR terrain surface"
              })
            }));
            return features;
          }, []);
          buildingData = {
            type: "FeatureCollection",
            metadata: Object.assign({}, payload && payload.metadata, {
              renderedFeatureCount: sanitizedFeatures.length,
              excludedModeledSquares: excludedFallbacks,
              excludedLooseMatches: 0,
              visualGroundMeasuredCount: visualGround.measuredCount,
              visualGroundNearestDerivedCount: visualGround.derivedCount,
              visualGroundMedianFallbackCount: visualGround.medianCount,
              renderHeightModel: "OSM tagged height when available; otherwise 3.05 m per screened story plus 1.2 m roof. Crawlspace rise is not added to roof height. Buildings render at screened real height while terrain elevation remains 4x exaggerated."
            }),
            features: sanitizedFeatures
          };
          document.body.dataset.buildings3dCount = String(sanitizedFeatures.length);
          document.body.dataset.buildings3dExcludedFallbacks = String(excludedFallbacks);
          document.body.dataset.buildings3dExcludedLooseMatches = "0";
          document.body.dataset.buildings3dGroundMeasured = String(visualGround.measuredCount);
          document.body.dataset.buildings3dGroundNearestDerived = String(visualGround.derivedCount);
          document.body.dataset.buildings3dGroundMedianFallback = String(visualGround.medianCount);
          document.body.dataset.buildings3dVerticalScale = "1";
          document.body.dataset.buildings3dMaxHeightFt = String(sanitizedFeatures.reduce(function (maximum, feature) {
            return Math.max(maximum, Number(feature.properties && feature.properties.renderHeightFt) || 0);
          }, 0).toFixed(1));
          return buildingData;
        })
        .catch(function (error) {
          buildingDataPromise = null;
          throw error;
        });
    }
    return buildingDataPromise;
  }

  async function syncBuildings3d(options) {
    if (!glMap || !glStyleReady) return;
    var syncOptions = options || {};
    var enabled = layerVisible("buildingsToggle", false);
    if (!enabled && !syncOptions.preload && !glMap.getSource("nw-buildings-source")) {
      setStatus("3D terrain ×4");
      return;
    }
    if (!glMap.getSource("nw-buildings-source")) {
      var payload = await loadBuildingData();
      glMap.addSource("nw-buildings-source", {
        type: "geojson",
        data: payload,
        generateId: true,
        // Tile to street scale before overscaling. The old zoom-16 buckets
        // could cull whole runs of extrusions at an oblique tile boundary.
        // Zoom 18 keeps the complete 5,160-footprint source present without
        // asking the worker to rebuild geometry at the final 100 m zooms.
        maxzoom: 18,
        buffer: 256,
        tolerance: 0
      });
      document.body.dataset.buildings3dSourceMaxZoom = "18";
      document.body.dataset.buildings3dSourceBuffer = "256";
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
        id: "nw-3d-buildings-wet",
        type: "fill-extrusion",
        source: "nw-buildings-source",
        minzoom: 12,
        paint: {
          "fill-extrusion-color": "#7DF9FF",
          "fill-extrusion-height": 0,
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 1,
          "fill-extrusion-opacity-transition": { duration: 0, delay: 0 },
          "fill-extrusion-vertical-gradient": false
        }
      });
      addLayerBelowMask({
        id: "nw-3d-buildings",
        type: "fill-extrusion",
        source: "nw-buildings-source",
        minzoom: 12,
        paint: {
          "fill-extrusion-color": "#ddd7cb",
          "fill-extrusion-height": ["to-number", ["get", "renderHeightM"], 3],
          "fill-extrusion-base": 0,
          // Fully opaque extrusions form a stable occlusion pass above the
          // terrain-independent water plane. Fractional opacity is dithered by
          // MapLibre and produced cyan stippling that shimmered on wall faces.
          "fill-extrusion-opacity": 1,
          "fill-extrusion-opacity-transition": { duration: 0, delay: 0 },
          "fill-extrusion-vertical-gradient": true
        }
      });
      syncBuildingFloodBands3d(getSelectedStageNavd88());
      if (!buildingCursorHandlersWired) {
        buildingCursorHandlersWired = true;
        ["nw-3d-buildings-wet", "nw-3d-buildings"].forEach(function (layerId) {
          glMap.on("mouseenter", layerId, function () {
            if (layerVisible("buildingsToggle", false)) glMap.getCanvas().style.cursor = "pointer";
          });
          glMap.on("mouseleave", layerId, function () {
            glMap.getCanvas().style.cursor = "";
          });
        });
      }
      // Draw water before every building source, including live-vector
      // fallbacks. The opaque extrusion pass then masks the water cleanly at
      // each wall instead of alpha-dithering cyan fragments through it.
      placeFloodBelowBuildingDepthPass();
    }
    if (!glMap.getLayer("nw-3d-buildings")) return;
    glMap.setLayoutProperty("nw-building-outlines", "visibility", visibility(enabled));
    glMap.setLayoutProperty("nw-3d-buildings-wet", "visibility", visibility(enabled));
    glMap.setLayoutProperty("nw-3d-buildings", "visibility", visibility(enabled));
    setContextBuildingExtrusionsEnabled(enabled);
    syncBuildingFloodBands3d(getSelectedStageNavd88());
    setStatus(enabled
      ? "3D terrain ×4 • " + Number(buildingData.features.length).toLocaleString("en-US") + " buildings"
      : "3D terrain ×4");
  }

  function buildBuildingPopupHtml(properties) {
    var p = properties || {};
    var address = escapeTownAddressHtml(p.address || p.osmName || "North Wildwood building");
    var crawlspaceDepth = Number(p.foundationHeightFt);
    var firstFloor = Number(p.modeledFirstFloorNavd88Ft);
    var stage = Number(getSelectedStageNavd88());
    var difference = Number.isFinite(stage) && Number.isFinite(firstFloor) ? stage - firstFloor : NaN;
    var status = !Number.isFinite(difference)
      ? "Choose a water level to compare."
      : Math.abs(difference) <= 0.1
        ? "Current water is at the estimated occupied floor."
        : difference > 0
          ? "Current water is " + difference.toFixed(1) + " ft above the estimated occupied floor."
          : "Current water is " + Math.abs(difference).toFixed(1) + " ft below the estimated occupied floor.";
    return '<div class="nsi-structure-popup building-info-card">' +
      '<span class="house-alert-kicker">Building</span>' +
      '<h3>' + address + '</h3>' +
      '<div class="building-info-facts">' +
        '<div><span>Crawlspace / garage depth</span><strong>' + (Number.isFinite(crawlspaceDepth) ? crawlspaceDepth.toFixed(1) + ' ft' : '—') + '</strong></div>' +
        '<p>' + escapeTownAddressHtml(status) + '</p>' +
      '</div>' +
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
    if (!glMap || !map || syncingFrom3d || syncingModeTransition) return;
    var center = map.getCenter();
    var zoom = map.getZoom();
    if (!center || !Number.isFinite(zoom)) return;
    var current = glMap.getCenter();
    var changed = Math.abs(current.lng - center.lng) > 0.000001 ||
      Math.abs(current.lat - center.lat) > 0.000001 ||
      Math.abs(glMap.getZoom() - zoom) > 0.001;
    if (!changed) {
      document.body.dataset.map3dLeafletSync = "skipped-bearing-only";
      return;
    }
    document.body.dataset.map3dLeafletSync = "center-or-zoom";
    syncingFromLeaflet = true;
    glMap.jumpTo({ center: [center.lng, center.lat], zoom: Math.min(MAP_MAX_ZOOM, zoom) });
    syncingFromLeaflet = false;
  }

  function sync3dViewToLeaflet() {
    if (!glMap || !map || syncingFromLeaflet || syncingModeTransition) return;
    var center = glMap.getCenter();
    var leafletCenter = map.getCenter();
    var targetZoom = Math.min(MAP_MAX_ZOOM, glMap.getZoom());
    // Bearing and pitch have no Leaflet equivalent. Guard against any
    // redundant move-end signal so a compass-only camera change can never
    // force the hidden 2D PNG and Leaflet overlays to rebuild beneath WebGL.
    var changed = !leafletCenter ||
      Math.abs(Number(leafletCenter.lng) - Number(center.lng)) > 0.000001 ||
      Math.abs(Number(leafletCenter.lat) - Number(center.lat)) > 0.000001 ||
      Math.abs(Number(map.getZoom()) - targetZoom) > 0.001;
    if (!changed) return;
    syncingFrom3d = true;
    map.setView([center.lat, center.lng], targetZoom, { animate: false });
    syncingFrom3d = false;
    updateDiagnostics();
  }

  function setContextBuildingExtrusionsEnabled(enabled) {
    if (!glMap) return;
    contextBuildingExtrusionLayerIds.forEach(function (layerId) {
      if (glMap.getLayer(layerId)) glMap.setLayoutProperty(layerId, "visibility", visibility(enabled));
    });
  }

  function installContextBuildingExtrusions() {
    if (!glMap || contextBuildingExtrusionLayerIds.length) return;
    var municipalFeature = boundaryGeoJson();
    if (!municipalFeature) return;
    var sourceLayers = ["Daylight building", "OSM building", "OSM major building"];
    var outsideMunicipality = ["!", ["within", municipalFeature]];
    var styleLayers = (glMap.getStyle().layers || []).filter(function (layer) {
      return layer.type === "fill" && sourceLayers.indexOf(layer["source-layer"]) >= 0;
    });
    styleLayers.forEach(function (layer, index) {
      var layerId = "nw-context-building-extrusion-" + index;
      var sourceFilter = layer.filter ? layer.filter : true;
      var contextLayer = {
        id: layerId,
        type: "fill-extrusion",
        source: layer.source,
        "source-layer": layer["source-layer"],
        minzoom: Math.max(12, Number(layer.minzoom) || 12),
        filter: ["all", sourceFilter, outsideMunicipality],
        layout: { visibility: visibility(layerVisible("buildingsToggle", false)) },
        paint: {
          "fill-extrusion-color": "#ddd7cb",
          "fill-extrusion-height": [
            "case",
            ["has", "height"],
            ["max", 3.6, ["min", 30, ["to-number", ["get", "height"], 3.9]]],
            ["has", "building:levels"],
            ["max", 3.6, ["min", 19.5, ["+", 1.2, ["*", 3.05, ["to-number", ["get", "building:levels"], 1]]]]],
            3.9
          ],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 1,
          "fill-extrusion-opacity-transition": { duration: 0, delay: 0 },
          "fill-extrusion-vertical-gradient": true
        }
      };
      if (Number.isFinite(Number(layer.maxzoom))) contextLayer.maxzoom = Number(layer.maxzoom);
      glMap.addLayer(contextLayer, glMap.getLayer("nw-boundary-mask") ? "nw-boundary-mask" : undefined);
      contextBuildingExtrusionLayerIds.push(layerId);
    });
    document.body.dataset.buildings3dFallbackLayers = "0";
    document.body.dataset.buildings3dContextLayers = String(contextBuildingExtrusionLayerIds.length);
    document.body.dataset.buildings3dCoverage = "complete-static-municipal-plus-live-context";
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

    // NorthWildwoodBuildings3D.geojson contains every vector footprint inside
    // the municipality. A boundary-filtered live layer fills only surrounding
    // context; it can never overlap or z-fight with the municipal asset.
    document.body.dataset.buildings3dFallbackLayers = "0";
    document.body.dataset.buildings3dCoverage = "complete-static-municipal-footprints";
    installContextBuildingExtrusions();

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

  function syncTerrainForView(pitched) {
    if (!glMap || !glStyleReady) return;
    var terrain = glMap.getTerrain ? glMap.getTerrain() : null;
    if (pitched) {
      if (!terrain || terrain.source !== "nw-terrain" || Number(terrain.exaggeration) !== TERRAIN_EXAGGERATION) {
        glMap.setTerrain({ source: "nw-terrain", exaggeration: TERRAIN_EXAGGERATION });
      }
      document.body.dataset.map3dTerrainState = "active";
    } else {
      if (terrain) glMap.setTerrain(null);
      document.body.dataset.map3dTerrainState = "parked-in-2d";
    }
  }

  function wire3dInteractions() {
    glMap.on("moveend", sync3dViewToLeaflet);
    glMap.on("dragend", function () {
      // MapLibre's inertial glide keeps redrawing terrain after the pointer is
      // released. On this dense full-screen scene that starves Chrome's fixed
      // UI layers and presents as strips of missing text/buildings. Preserve
      // direct dragging but finish the camera on the release frame.
      glMap.stop();
      requestAnimationFrame(function () {
        if (glMap) glMap.stop();
      });
    });
    glMap.on("click", async function (event) {
      var buildingsEnabled = layerVisible("buildingsToggle", false);
      if (buildingsEnabled && mapClickMode === "building" && glMap.getLayer("nw-3d-buildings")) {
        var buildingQueryLayers = ["nw-3d-buildings", "nw-3d-buildings-wet"].filter(function (layerId) {
          return Boolean(glMap.getLayer(layerId));
        });
        var rendered = glMap.queryRenderedFeatures(event.point, { layers: buildingQueryLayers });
        if (rendered.length) {
          try {
            var parcelFeature = await findParcelFeatureForLocation(
              event.lngLat.lat,
              event.lngLat.lng,
              { allowNearest: false }
            );
            if (parcelFeature) {
              openParcelFloodPrompt(parcelFeature, L.latLng(event.lngLat.lat, event.lngLat.lng));
              return;
            }
          } catch (_) {}
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
        // Multisample antialiasing doubles the cost of the terrain/building
        // framebuffer on Retina displays and was the last source of visible
        // checkerboarding during sustained pans. Normal map filtering keeps
        // the scene clean without the multisampled offscreen surface.
        antialias: false,
        fadeDuration: 0,
        refreshExpiredTiles: false,
        maxTileCacheZoomLevels: 8,
        // Render at one physical pixel per CSS pixel. The former 0.75 scale was
        // visibly resampled during camera movement, making the flood PNG and
        // thin building runs appear to wiggle or disappear at street scale.
        pixelRatio: 1,
        // MapLibre's supported no-inertia path avoids an expensive terrain
        // glide after every pointer release and makes mode changes atomic.
        reduceMotion: true,
        powerPreference: "high-performance",
        attributionControl: false,
        canvasContextAttributes: { antialias: false }
      });
      if (glMap.touchZoomRotate && typeof glMap.touchZoomRotate.disableRotation === "function") {
        glMap.touchZoomRotate.disableRotation();
      }
      ["pitch", "rotate", "zoom"].forEach(function (eventName) {
        glMap.on(eventName, schedulePersistentNavControlSync);
      });
      glMap.on("pitch", syncFloodPresentationMode);
      glMap.on("moveend", syncPersistentNavControl);
      syncPersistentNavControl();
      glMap.on("error", function (event) {
        console.warn("North Wildwood 3D renderer warning.", event && event.error ? event.error : event);
      });
      await new Promise(function (resolve, reject) {
        var timer = window.setTimeout(function () { reject(new Error("The 3D renderer timed out.")); }, 20000);
        glMap.once("load", function () {
          window.clearTimeout(timer);
          glStyleReady = true;
          resolve();
        });
      });
      addCore3dLayers();
      wire3dInteractions();
      syncBoundary3d();
      syncFloodLayer3d();
      syncSatellite3d();
      syncRoadLabels3d();
      syncParcels3d();
      syncNsi3d();
      document.body.classList.add("map-3d-ready");
      document.body.dataset.map3d = "ready";
      document.body.dataset.terrainExaggeration = String(TERRAIN_EXAGGERATION);
      document.body.dataset.map3dMaxZoom = String(MAP_MAX_ZOOM);
      document.body.dataset.map3dPixelRatio = "1";
      document.body.dataset.map3dPitch = String(glMap.getPitch());
      await syncBuildings3d({ preload: true });
      updateDiagnostics();
      suspendLeafletVisualLayers();
      requestAnimationFrame(function () { glMap.resize(); });
      return glMap;
    })().catch(function (error) {
      document.body.dataset.map3d = "fallback";
      glStyleReady = false;
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

  function waitFor3dMapIdle(mapInstance, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeout = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        mapInstance.off("idle", onIdle);
        reject(new Error("The 3D terrain tiles did not finish loading in time."));
      }, Number(timeoutMs) || 45000);
      function onIdle() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        // Let the browser present the idle frame before the site loader fades.
        requestAnimationFrame(function () {
          requestAnimationFrame(resolve);
        });
      }
      mapInstance.once("idle", onIdle);
      mapInstance.triggerRepaint();
    });
  }

  function warm3dCameraFootprint(mapInstance, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timeout = window.setTimeout(function () { finish(false); }, Math.max(250, Number(timeoutMs) || 750));
      function finish(loaded) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        mapInstance.off("idle", onIdle);
        requestAnimationFrame(function () { resolve(Boolean(loaded)); });
      }
      function onIdle() { finish(true); }
      mapInstance.once("idle", onIdle);
      mapInstance.triggerRepaint();
    });
  }

  async function warm3dCamera(mapInstance) {
    if (document.body.dataset.map3dCameraWarmup === "ready") return;
    document.body.dataset.map3dCameraWarmup = "loading";
    document.body.dataset.map3dBearingWarmup = "loading";
    var originalCamera = {
      center: mapInstance.getCenter(),
      zoom: mapInstance.getZoom(),
      bearing: mapInstance.getBearing(),
      pitch: mapInstance.getPitch()
    };
    var buildingsEnabled = layerVisible("buildingsToggle", false);
    var hasBuildings = Boolean(mapInstance.getLayer("nw-3d-buildings"));
    if (hasBuildings) {
      mapInstance.setLayoutProperty("nw-building-outlines", "visibility", "visible");
      mapInstance.setLayoutProperty("nw-3d-buildings-wet", "visibility", "visible");
      mapInstance.setLayoutProperty("nw-3d-buildings", "visibility", "visible");
      setContextBuildingExtrusionsEnabled(true);
      mapInstance.setPaintProperty("nw-building-outlines", "line-opacity", 0);
      // The loader covers this pass. Render the final opaque material now so
      // the first visible compass gesture does not compile or populate a
      // different extrusion path than the one that was warmed.
      mapInstance.setPaintProperty("nw-3d-buildings", "fill-extrusion-opacity", 1);
      mapInstance.setPaintProperty("nw-3d-buildings-wet", "fill-extrusion-opacity", 1);
    }
    try {
      // Exercise every distinct pitched cardinal footprint while the loading
      // screen still covers the canvas. Previously only north-facing 3D was
      // warmed; the first south/west compass sweep had to fetch terrain and
      // rebuild extrusion buckets after the site was already interactive.
      var initialWarmZoom = Number(originalCamera.zoom);
      var overviewWarmZoom = Math.max(11, initialWarmZoom - 1.25);
      var warmCameras = [];
      // Warm both the initial camera scale and the zoomed-out scale that
      // exposes the largest terrain footprint. Top-down rotation no longer
      // needs a DEM warmup because terrain is parked in 2D mode.
      [initialWarmZoom, overviewWarmZoom].forEach(function (warmZoom) {
        [0, 90, 180, 270].forEach(function (bearing) {
          warmCameras.push({ pitch: THREE_D_PITCH, bearing: bearing, zoom: warmZoom });
        });
      });
      var fullySettledWarmCameras = 0;
      for (var warmIndex = 0; warmIndex < warmCameras.length; warmIndex += 1) {
        mapInstance.jumpTo(warmCameras[warmIndex]);
        // Enqueue and compile every footprint, but never let a cold DEM tile
        // keep the whole site behind its loader. Pitched views get a slightly
        // larger slice of the fixed warmup budget than top-down rotations.
        var footprintSettled = await warm3dCameraFootprint(
          mapInstance,
          warmCameras[warmIndex].pitch > 10 ? 650 : 350
        );
        if (footprintSettled) fullySettledWarmCameras += 1;
      }
    } finally {
      mapInstance.jumpTo(originalCamera);
      syncTerrainForView(originalCamera.pitch > 10);
      if (hasBuildings) {
        mapInstance.setPaintProperty("nw-building-outlines", "line-opacity", 1);
        mapInstance.setPaintProperty("nw-3d-buildings", "fill-extrusion-opacity", 1);
        mapInstance.setPaintProperty("nw-3d-buildings-wet", "fill-extrusion-opacity", 1);
        mapInstance.setLayoutProperty("nw-building-outlines", "visibility", visibility(buildingsEnabled));
        mapInstance.setLayoutProperty("nw-3d-buildings-wet", "visibility", visibility(buildingsEnabled));
        mapInstance.setLayoutProperty("nw-3d-buildings", "visibility", visibility(buildingsEnabled));
        setContextBuildingExtrusionsEnabled(buildingsEnabled);
      }
    }
    await waitFor3dMapIdle(mapInstance, 45000);
    document.body.dataset.map3dBearingWarmupAngles = "3d:0,90,180,270";
    document.body.dataset.map3dBearingWarmupZooms = Number(initialWarmZoom).toFixed(2) + "," + Number(overviewWarmZoom).toFixed(2);
    document.body.dataset.map3dBearingWarmupSettled = String(fullySettledWarmCameras) + "/" + String(warmCameras.length);
    document.body.dataset.map3dBearingWarmupBudgetMs = "5200";
    document.body.dataset.map3dWheelPreloaded = "true";
    document.body.dataset.map3dBearingWarmup = "ready";
    document.body.dataset.map3dCameraWarmup = "ready";
    syncPersistentNavControl();
    updateDiagnostics();
  }

  async function preload3dAssets(options) {
    var preloadOptions = options || {};
    await Promise.all([
      loadMapLibreRuntime(),
      load3dStyle(),
      loadBuildingData()
    ]);
    document.body.dataset.map3dPreloaded = "true";
    if (preloadOptions.initialize) {
      document.body.dataset.map3dFullyPreloaded = "loading";
      var mapInstance = await ensure3dMap();
      if (!mapInstance) throw new Error("The complete 3D map could not be preloaded.");
      var floodReady = floodPlaneLayer && typeof floodPlaneLayer.whenReady === "function"
        ? floodPlaneLayer.whenReady()
        : Promise.resolve(true);
      await Promise.all([
        waitFor3dMapIdle(mapInstance, 45000),
        floodReady
      ]);
      await warm3dCamera(mapInstance);
      document.body.dataset.map3dFullyPreloaded = "ready";
    }
    return {
      buildings: buildingData && buildingData.features ? buildingData.features.length : 0,
      terrainExaggeration: TERRAIN_EXAGGERATION,
      initialized: Boolean(preloadOptions.initialize && glMap)
    };
  }

  function install3dLauncher() {
    if (document.getElementById("nwDefaultNavControl")) return;
    var host = document.getElementById("mapWrap") || document.body;
    var control = document.createElement("div");
    control.id = "nwDefaultNavControl";
    control.className = "nw-simple-control";
    control.setAttribute("aria-label", "Map navigation");
    control.innerHTML = [
      '<div class="nw-direction-wheel" role="application" tabindex="0" aria-label="Viewpoint wheel. Choose north, east, south, west, or any direction between to rotate the map viewing direction.">',
      '  <span class="nw-wheel-cardinal nw-wheel-n" aria-hidden="true">N</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-e" aria-hidden="true">E</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-s" aria-hidden="true">S</span>',
      '  <span class="nw-wheel-cardinal nw-wheel-w" aria-hidden="true">W</span>',
      '  <span class="nw-wheel-knob" aria-hidden="true"></span>',
      '</div>',
      '<button class="nw-simple-view" type="button" aria-label="2D view active. Switch to 3D view" aria-pressed="false" title="2D view active. Switch to 3D view"><span class="nw-simple-view-label">2D</span></button>',
      '<div class="nw-simple-zoom" role="group" aria-label="Zoom controls">',
      '  <button class="nw-simple-zoom-button nw-simple-zoom-in" type="button" aria-label="Zoom in" title="Zoom in"><span aria-hidden="true">+</span></button>',
      '  <button class="nw-simple-zoom-button nw-simple-zoom-out" type="button" aria-label="Zoom out" title="Zoom out"><span aria-hidden="true">−</span></button>',
      '</div>'
    ].join("");
    var launcher = control.querySelector(".nw-simple-view");
    var label = control.querySelector(".nw-simple-view-label");
    var wheel = control.querySelector(".nw-direction-wheel");
    var pendingBearing = null;
    var pendingPointerBearing = null;
    var queuedViewpointBearing = null;
    var queuedViewpointDuration = 0;
    var viewpointAnimationFrame = 0;
    var activePointer = null;
    var desired3dMode = false;
    var modeTransitionTimer = null;

    function stop(event) { event.stopPropagation(); }
    ["click", "dblclick", "mousedown", "touchstart", "pointerdown", "wheel", "contextmenu"].forEach(function (name) {
      control.addEventListener(name, stop);
    });

    function map3dReady() {
      return Boolean(glMap && document.body.classList.contains("map-3d-ready"));
    }

    function actual3dMode() {
      return Boolean(map3dReady() && glMap.getPitch() > 10);
    }

    function setModeBusy(busy) {
      launcher.setAttribute("aria-busy", busy ? "true" : "false");
      control.classList.toggle("is-mode-transitioning", Boolean(busy));
    }

    syncPersistentNavControl = function () {
      var busy = launcher.getAttribute("aria-busy") === "true";
      var showing3d = busy ? desired3dMode : actual3dMode();
      var accessibleLabel = busy
        ? "Switching to " + (showing3d ? "3D" : "2D") + " view"
        : showing3d
          ? "3D view active. Switch to 2D view"
          : "2D view active. Switch to 3D view";
      label.textContent = showing3d ? "3D" : "2D";
      launcher.setAttribute("aria-pressed", showing3d ? "true" : "false");
      launcher.setAttribute("aria-label", accessibleLabel);
      launcher.setAttribute("title", accessibleLabel);
      control.dataset.viewMode = showing3d ? "3d" : "2d";
      document.body.dataset.mapViewMode = showing3d ? "3d" : "2d";
      if (glMap) document.body.dataset.map3dPitch = String(glMap.getPitch());
    };

    function finishModeTransition() {
      if (modeTransitionTimer) window.clearTimeout(modeTransitionTimer);
      modeTransitionTimer = null;
      syncingModeTransition = false;
      setModeBusy(false);
      if (desired3dMode && glMap && Number.isFinite(pendingBearing)) {
        glMap.jumpTo({ bearing: pendingBearing });
      }
      syncPersistentNavControl();
      updateDiagnostics();
    }

    function transitionMode(target3d, requestedBearing) {
      if (!map3dReady()) return;
      desired3dMode = Boolean(target3d);
      if (Number.isFinite(requestedBearing)) pendingBearing = requestedBearing;
      syncingModeTransition = true;
      setModeBusy(true);
      syncPersistentNavControl();
      var camera = { pitch: desired3dMode ? THREE_D_PITCH : DEFAULT_PITCH };
      if (Number.isFinite(requestedBearing)) camera.bearing = requestedBearing;
      glMap.stop();
      // Terrain is useful only for a pitched camera. Parking it in 2D removes
      // the expensive DEM rebuild from compass rotation without changing the
      // default top-down view. The terrain source stays loaded for instant 3D.
      syncTerrainForView(desired3dMode);
      // The pitched renderer has already been warmed behind the loader. An
      // atomic camera update avoids a costly multi-frame terrain rebuild.
      glMap.jumpTo(camera);
      syncFloodPresentationMode();
      if (modeTransitionTimer) window.clearTimeout(modeTransitionTimer);
      modeTransitionTimer = window.setTimeout(finishModeTransition, 120);
      requestAnimationFrame(function () {
        requestAnimationFrame(finishModeTransition);
      });
    }

    function updateDefaultWheel(clientX, clientY) {
      var rect = wheel.getBoundingClientRect();
      var dx = clientX - (rect.left + rect.width / 2);
      var dy = clientY - (rect.top + rect.height / 2);
      var distance = Math.sqrt(dx * dx + dy * dy);
      var maxRadius = Math.max(18, rect.width * .30);
      if (distance <= maxRadius * .08) return null;
      var scale = distance > maxRadius ? maxRadius / distance : 1;
      wheel.style.setProperty("--nw-wheel-x", (dx * scale).toFixed(2) + "px");
      wheel.style.setProperty("--nw-wheel-y", (dy * scale).toFixed(2) + "px");
      pendingBearing = bearingFromViewpointVector(dx / distance, dy / distance);
      return pendingBearing;
    }

    function resetDefaultWheel() {
      if (activePointer !== null) {
        try {
          if (wheel.hasPointerCapture && wheel.hasPointerCapture(activePointer)) {
            wheel.releasePointerCapture(activePointer);
          }
        } catch (_) {}
      }
      activePointer = null;
      wheel.classList.remove("is-active");
      wheel.style.setProperty("--nw-wheel-x", "0px");
      wheel.style.setProperty("--nw-wheel-y", "0px");
    }

    function finishDefaultWheel(event, commit) {
      if (activePointer === null || event.pointerId !== activePointer) return;
      var selectedBearing = pendingPointerBearing;
      pendingPointerBearing = null;
      resetDefaultWheel();
      // Always commit the exact final bearing. Live previews are deliberately
      // throttled below so this remains one bounded final camera update rather
      // than a terrain rebuild for every raw pointer sample.
      if (commit && Number.isFinite(selectedBearing)) {
        applyViewpoint(selectedBearing, 0);
      }
    }

    async function activate3d(requestedBearing) {
      if (Number.isFinite(requestedBearing)) pendingBearing = requestedBearing;
      if (launcher.getAttribute("aria-busy") === "true") return;
      desired3dMode = true;
      setModeBusy(true);
      syncPersistentNavControl();
      var nextMap = await ensure3dMap();
      if (nextMap) {
        transitionMode(true, Number.isFinite(pendingBearing) ? pendingBearing : nextMap.getBearing());
        return;
      }
      desired3dMode = false;
      syncingModeTransition = false;
      setModeBusy(false);
      syncPersistentNavControl();
      resetDefaultWheel();
      toast("3D terrain could not load. The 2D map is still available.");
    }

    function flushQueuedViewpoint() {
      viewpointAnimationFrame = 0;
      var bearing = queuedViewpointBearing;
      var duration = queuedViewpointDuration;
      queuedViewpointBearing = null;
      queuedViewpointDuration = 0;
      if (!Number.isFinite(bearing) || !map3dReady()) return;
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (duration) {
        glMap.stop();
        glMap.easeTo({ bearing: bearing, duration: duration });
      } else {
        glMap.jumpTo({ bearing: bearing });
      }
      document.body.dataset.map3dWheelFrame = String(
        Number(document.body.dataset.map3dWheelFrame || 0) + 1
      );
      syncPersistentNavControl();
    }

    function queueViewpoint(bearing, duration) {
      queuedViewpointBearing = bearing;
      queuedViewpointDuration = Number(duration) || 0;
      if (!viewpointAnimationFrame) {
        viewpointAnimationFrame = requestAnimationFrame(flushQueuedViewpoint);
      }
    }

    async function applyViewpoint(bearing, duration) {
      if (!Number.isFinite(bearing)) return;
      pendingBearing = bearing;
      if (!map3dReady()) {
        var nextMap = await ensure3dMap();
        if (!nextMap) return;
      }
      if (launcher.getAttribute("aria-busy") === "true") return;
      // Pointer events can arrive much faster than the map can paint. Keep
      // only the latest bearing and update the camera once per display frame.
      queueViewpoint(bearing, duration);
    }

    launcher.addEventListener("click", function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      pendingBearing = null;
      if (!map3dReady()) activate3d(null);
      else transitionMode(!actual3dMode());
    });
    control.querySelector(".nw-simple-zoom-in").addEventListener("click", function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (map3dReady()) {
        glMap.stop();
        glMap.jumpTo({ zoom: Math.min(MAP_MAX_ZOOM, glMap.getZoom() + 1) });
      } else if (map && typeof map.zoomIn === "function") map.zoomIn();
    });
    control.querySelector(".nw-simple-zoom-out").addEventListener("click", function () {
      if (launcher.getAttribute("aria-busy") === "true") return;
      if (map3dReady()) {
        glMap.stop();
        glMap.jumpTo({ zoom: Math.max(11, glMap.getZoom() - 1) });
      } else if (map && typeof map.zoomOut === "function") map.zoomOut();
    });
    wheel.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      activePointer = event.pointerId;
      wheel.classList.add("is-active");
      try { wheel.setPointerCapture(activePointer); } catch (_) {}
      pendingPointerBearing = updateDefaultWheel(event.clientX, event.clientY);
    });
    wheel.addEventListener("pointermove", function (event) {
      if (event.pointerId !== activePointer) return;
      pendingPointerBearing = updateDefaultWheel(event.clientX, event.clientY);
    });
    wheel.addEventListener("pointerup", function (event) { finishDefaultWheel(event, true); });
    wheel.addEventListener("pointercancel", function (event) { finishDefaultWheel(event, false); });
    wheel.addEventListener("lostpointercapture", function (event) {
      if (activePointer !== null && event.pointerId === activePointer) {
        pendingPointerBearing = null;
        resetDefaultWheel();
      }
    });
    wheel.addEventListener("keydown", function (event) {
      var bearings = { ArrowUp: 180, ArrowRight: 270, ArrowDown: 0, ArrowLeft: 90 };
      if (!Object.prototype.hasOwnProperty.call(bearings, event.key)) return;
      event.preventDefault();
      applyViewpoint(bearings[event.key], 0);
    });
    host.appendChild(control);
    control.dataset.wheelCameraUpdates = "single-commit";
    control.dataset.wheelPreview3dMs = "0";
    control.dataset.wheelPreview2dMs = "0";
    if (!document.body.dataset.map3d) document.body.dataset.map3d = "idle";
    syncPersistentNavControl();
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
    if (floodPlaneLayer && typeof floodPlaneLayer.setOpacity === "function") floodPlaneLayer.setOpacity(overlayOpacity);
    if (glMap && glMap.getLayer("nw-flood-drape")) {
      glMap.setPaintProperty("nw-flood-drape", "raster-opacity", overlayOpacity);
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
    preload: preload3dAssets,
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
