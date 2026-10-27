    function loadDepthQueryPng(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const timer = window.setTimeout(() => {
          const error = new Error("Packed depth-query PNG took too long to load. Please try again.");
          error.name = "TimeoutError";
          finish(error);
        }, 20000);
        const finish = (error, grid) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          image.onload = image.onerror = null;
          if (error) {
            try { image.src = ""; } catch (_) {}
            reject(error);
          } else resolve(grid);
        };
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        image.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Could not create the depth-query canvas.");
            context.drawImage(image, 0, 0);
            finish(null, {
              width: canvas.width,
              height: canvas.height,
              values: context.getImageData(0, 0, canvas.width, canvas.height).data
            });
          } catch (error) {
            finish(error);
          }
        };
        image.onerror = () => finish(new Error("Packed depth-query PNG could not be loaded."));
        image.src = url;
      });
    }

    async function getDepthQueryGrid() {
      if (!DEPTH_QUERY_PNG_URL) return null;
      if (!depthQueryGridPromise) {
        const request = (async () => {
          let lastError = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const url = new URL(DEPTH_QUERY_PNG_URL);
              if (attempt) url.searchParams.set("_retry", String(Date.now()));
              return await loadDepthQueryPng(url.href);
            } catch (error) {
              // A stalled transport has already used its full deadline. Let
              // the frame controller/user retry instead of doubling that wait.
              if (error?.name === "TimeoutError") throw error;
              lastError = error;
            }
          }
          throw lastError || new Error("Packed depth-query PNG is unavailable.");
        })().catch(error => {
          if (depthQueryGridPromise === request) depthQueryGridPromise = null;
          throw error;
        });
        depthQueryGridPromise = request;
      }
      return awaitRasterRequest(depthQueryGridPromise);
    }

    async function getDevelopedQueryGrid() {
      if (!DEVELOPED_QUERY_PNG_URL) return null;
      if (!developedQueryGridPromise) {
        const request = loadDepthQueryPng(DEVELOPED_QUERY_PNG_URL)
          .catch(error => {
            if (developedQueryGridPromise === request) developedQueryGridPromise = null;
            throw error;
          });
        developedQueryGridPromise = request;
      }
      return awaitRasterRequest(developedQueryGridPromise);
    }

    async function getDepthQueryImage() {
      if (!DEPTH_QUERY_COG_URL) throw new Error("Depth query COG is not configured.");
      if (!window.GeoTIFF?.fromUrl) await ensureDepthQueryLibrary();
      if (!depthQueryImagePromise) {
        depthQueryImagePromise = GeoTIFF.fromUrl(DEPTH_QUERY_COG_URL)
          .then(tiff => tiff.getImage())
          .catch(error => {
            depthQueryImagePromise = null;
            throw error;
          });
      }
      return depthQueryImagePromise;
    }

    function decodeHydraulicInt16Base64(encoded) {
      const binary = atob(String(encoded || ""));
      const buffer = new ArrayBuffer(binary.length);
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const view = new DataView(buffer);
      const output = new Int16Array(binary.length / 2);
      for (let i = 0; i < output.length; i += 1) output[i] = view.getInt16(i * 2, true);
      return output;
    }

    async function fetchHydraulicStateContainer(url) {
      const response = await fetch(url, { cache: "force-cache", headers: { "Accept": "application/octet-stream,*/*" } });
      if (!response.ok) throw new Error(`Hydraulic state request failed (${response.status}).`);
      let buffer = await response.arrayBuffer();
      let bytes = new Uint8Array(buffer);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream !== "function") {
          throw new Error("This browser cannot decompress the hydraulic state package.");
        }
        const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        buffer = await new Response(decompressed).arrayBuffer();
        bytes = new Uint8Array(buffer);
      }

      const magic = new TextDecoder().decode(bytes.subarray(0, 8));
      if (magic.startsWith("NWHYD2")) {
        const headerLength = new DataView(buffer, 8, 4).getUint32(0, true);
        const dataStart = 12 + headerLength;
        const payload = JSON.parse(new TextDecoder().decode(bytes.subarray(12, dataStart)));
        payload.decodedPhaseWaterSurface = {};
        Object.entries(payload.phaseArrays || {}).forEach(([phase, record]) => {
          const offset = Number(record?.offset) || 0;
          const length = Number(record?.length) || 0;
          if (payload.valueType === "int16-le") {
            const view = new DataView(buffer, dataStart + offset, length);
            const values = new Int16Array(length / 2);
            for (let index = 0; index < values.length; index += 1) {
              values[index] = view.getInt16(index * 2, true);
            }
            payload.decodedPhaseWaterSurface[phase] = values;
          } else {
            payload.decodedPhaseWaterSurface[phase] = new Uint8Array(buffer, dataStart + offset, length);
          }
        });
        return payload;
      }

      const payload = JSON.parse(new TextDecoder().decode(bytes));
      const encoded = payload?.phaseWaterSurfaceCentift || {};
      payload.decodedPhaseWaterSurfaceCentift = {
        filling: decodeHydraulicInt16Base64(encoded.filling),
        slack: decodeHydraulicInt16Base64(encoded.slack),
        draining: decodeHydraulicInt16Base64(encoded.draining)
      };
      return payload;
    }

    async function getHydraulicStates() {
      if (!HYDRAULIC_STATES_URL) return null;
      if (!hydraulicStatesPromise) {
        hydraulicStatesPromise = fetchHydraulicStateContainer(HYDRAULIC_STATES_URL);
      }
      return hydraulicStatesPromise;
    }

    async function getHydraulicWaterSurfaceFt(zoneId, stage, phase) {
      const payload = await getHydraulicStates();
      if (!payload || !Number.isInteger(zoneId) || zoneId <= 0) return null;
      const stageMin = Number(payload.stageMinNavd88Ft) || 0;
      const stageMax = Number(payload.stageMaxNavd88Ft);
      const stageStep = Number(payload.stageStepFt) || STAGE_STEP;
      const stageCount = Number(payload.stageCount) || Math.round(
        ((Number.isFinite(stageMax) ? stageMax : MAX_STAGE) - stageMin) / stageStep
      ) + 1;
      const stride = Number(payload.zoneStride) || ((Number(payload.zoneCount) || 0) + 1);
      // Operational v20 families stop at 10 ft; higher planning levels retain
      // v19 PNG fallbacks. Use the selected level for a masked point-depth
      // estimate rather than silently returning the v20 10-ft state.
      if (Number.isFinite(stageMax) && Number(stage) > stageMax + 1e-9) return Number(stage);
      const stageIndex = Math.max(0, Math.min(stageCount - 1, Math.round((Number(stage) - stageMin) / stageStep)));
      const binaryValues = payload.decodedPhaseWaterSurface?.[getHydraulicStatePhase(phase)];
      if (binaryValues) {
        const encoded = binaryValues[stageIndex * stride + zoneId];
        if (payload.valueType === "int16-le") {
          const drySentinel = Number(payload.drySentinelCentift ?? -32768);
          return Number.isFinite(encoded) && encoded !== drySentinel ? encoded / 100 : null;
        }
        const drySentinel = Number(payload.drySentinel ?? 255);
        const offset = Number(payload.surfaceOffsetDecifeet ?? -100);
        return Number.isFinite(encoded) && encoded !== drySentinel ? (encoded + offset) / 10 : null;
      }
      const values = payload.decodedPhaseWaterSurfaceCentift?.[getHydraulicStatePhase(phase)];
      const encoded = values?.[stageIndex * stride + zoneId];
      const drySentinel = Number(payload.drySentinelCentift ?? -32768);
      return Number.isFinite(encoded) && encoded !== drySentinel ? encoded / 100 : null;
    }

    // Query grids follow their own georeferencing, not one town's layout.
    // Rotated grids keep the affine transform; north-up catalogs use Mercator Y.
    function latLngToDepthQueryPixel(lat, lng, width, height) {
      if (![lat, lng, width, height].every(Number.isFinite) ||
          width <= 0 || height <= 0 || Math.abs(lat) >= 90) return null;
      if (TOWN_CONFIG?.overlays?.worldFileCornersWgs84) {
        return latLngToWorldFilePixel(lat, lng, width, height);
      }
      const bounds = TOWN_CONFIG?.overlays?.boundsWgs84;
      if (!bounds) return null;
      const { west, east, south, north } = bounds;
      if (![west, east, south, north].every(Number.isFinite) ||
          west >= east || south >= north || south <= -90 || north >= 90) return null;
      const mercY = latitude => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
      const u = (lng - west) / (east - west);
      const v = (mercY(north) - mercY(lat)) / (mercY(north) - mercY(south));
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0 || u >= 1 || v >= 1) return null;
      return { x: Math.floor(u * width), y: Math.floor(v * height), u, v };
    }

    async function samplePackedDepthGrid(lat, lon) {
      const [grid, developedGrid] = await Promise.all([
        getDepthQueryGrid(),
        getDevelopedQueryGrid().catch(error => {
          console.warn("Developed-land query mask is unavailable.", error);
          return null;
        })
      ]);
      if (!grid || !floodLatLngBounds) return null;
      const pixel = latLngToDepthQueryPixel(lat, lon, grid.width, grid.height);
      if (!pixel) return null;
      const { x, y } = pixel;
      const offset = (y * grid.width + x) * 4;
      const encodedElevation = grid.values[offset] * 256 + grid.values[offset + 1];
      if (encodedElevation === 0) return null;
      const elevation10 = encodedElevation - 32768;
      const connectionCode = grid.values[offset + 2];
      const developedOffset = developedGrid &&
        developedGrid.width === grid.width && developedGrid.height === grid.height
        ? (y * developedGrid.width + x) * 4
        : -1;
      const encodedSourceDistance = developedOffset >= 0
        ? developedGrid.values[developedOffset] * 256 + developedGrid.values[developedOffset + 1]
        : 65535;
      return {
        elevation: elevation10 / 10,
        zoneId: 0,
        connectionStage: connectionCode === 255 ? 9999 : (connectionCode - 50) / 10,
        sourceFlag: false,
        hardStructureFlag: false,
        stormGrateFlag: false,
        developedFlag: developedOffset >= 0 && developedGrid.values[developedOffset + 2] >= 128,
        sourceDistanceFt: encodedSourceDistance === 65535 ? null : encodedSourceDistance,
        featureDistanceFt: null
      };
    }

    async function sampleDepthModelFromCog(lat, lon) {
      const image = await getDepthQueryImage();
      const bounds = image.getBoundingBox();
      const width = image.getWidth();
      const height = image.getHeight();
      const x = Math.floor(((lon - bounds[0]) / (bounds[2] - bounds[0])) * width);
      const y = Math.floor(((bounds[3] - lat) / (bounds[3] - bounds[1])) * height);
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      // A one-foot line or point is narrower than one screen pixel at ordinary
      // map zooms. Read a sixteen-foot neighbourhood and snap only when the click
      // is near a supplied hydraulic feature, keeping ordinary terrain clicks
      // exact while making the narrow bulkhead cells realistically usable.
      const featureRadiusPixels = 16;
      const x0 = Math.max(0, x - featureRadiusPixels);
      const y0 = Math.max(0, y - featureRadiusPixels);
      const x1 = Math.min(width, x + featureRadiusPixels + 1);
      const y1 = Math.min(height, y + featureRadiusPixels + 1);
      const sampleCount = 7;
      const windowWidth = x1 - x0;
      const values = await image.readRasters({
        window: [x0, y0, x1, y1],
        samples: [0, 1, 2, 3, 4, 5, 6],
        interleave: true
      });
      let sampleX = x;
      let sampleY = y;
      let featureDistanceFt = null;
      let bestDistanceSquared = Infinity;
      for (let row = 0; row < y1 - y0; row += 1) {
        for (let column = 0; column < windowWidth; column += 1) {
          const offset = (row * windowWidth + column) * sampleCount;
          const candidateElevation = Number(values[offset]);
          const hardFlag = Number(values[offset + 4]);
          const grateFlag = Number(values[offset + 5]);
          const plausibleElevation = Number.isFinite(candidateElevation) &&
            candidateElevation > -100 && candidateElevation < 100;
          const isFeature = plausibleElevation &&
            ((hardFlag >= 0.5 && hardFlag <= 1.5) || (grateFlag >= 0.5 && grateFlag <= 1.5));
          if (!isFeature) continue;
          const candidateX = x0 + column;
          const candidateY = y0 + row;
          const distanceSquared = (candidateX - x) ** 2 + (candidateY - y) ** 2;
          if (distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            sampleX = candidateX;
            sampleY = candidateY;
          }
        }
      }
      const sampleOffset = ((sampleY - y0) * windowWidth + (sampleX - x0)) * sampleCount;
      if (Number.isFinite(bestDistanceSquared)) {
        const feetPerDegreeLatitude = 364000;
        const feetPerDegreeLongitude = feetPerDegreeLatitude * Math.cos(lat * Math.PI / 180);
        const xFeet = (sampleX - x) * ((bounds[2] - bounds[0]) / width) * feetPerDegreeLongitude;
        const yFeet = (sampleY - y) * ((bounds[3] - bounds[1]) / height) * feetPerDegreeLatitude;
        featureDistanceFt = Math.hypot(xFeet, yFeet);
      }
      const elevation = Number(values[sampleOffset]);
      const zoneId = Math.round(Number(values[sampleOffset + 1]));
      const connectionStage = Number(values[sampleOffset + 2]);
      const sourceFlag = Number(values[sampleOffset + 3]);
      const hardStructureFlag = Number(values[sampleOffset + 4]);
      const stormGrateFlag = Number(values[sampleOffset + 5]);
      const developedFlag = Number(values[sampleOffset + 6]);
      if (!Number.isFinite(elevation) || elevation <= -1000 || elevation >= 1000) return null;
      return {
        elevation,
        zoneId,
        connectionStage,
        sourceFlag: sourceFlag >= 0.5,
        hardStructureFlag: hardStructureFlag >= 0.5,
        stormGrateFlag: stormGrateFlag >= 0.5,
        developedFlag: developedFlag >= 0.5,
        featureDistanceFt
      };
    }

    async function sha256Hex(buffer) {
      if (!window.crypto?.subtle) return "";
      const digest = await window.crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest))
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");
    }

    function preloadPhysicsQueryImage(record) {
      const url = record?.url;
      if (!url) return Promise.resolve(null);
      if (physicsQueryImageCache.has(url)) return physicsQueryImageCache.get(url);
      const promise = (async () => {
        const response = await fetch(url, {
          mode: "cors",
          credentials: "omit",
          cache: "force-cache",
          headers: { Accept: "image/png" }
        });
        if (!response.ok) throw new Error(`Physics query PNG returned HTTP ${response.status}.`);
        const buffer = await response.arrayBuffer();
        if (record.sha256 && window.crypto?.subtle) {
          const actual = await sha256Hex(buffer);
          if (actual !== String(record.sha256).toLowerCase()) {
            throw new Error("Physics query PNG failed its SHA-256 integrity check.");
          }
        }
        const objectUrl = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
        const image = new Image();
        image.decoding = "async";
        try {
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error("Physics query PNG could not be decoded."));
            image.src = objectUrl;
          });
          return image;
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      })().catch(error => {
        physicsQueryImageCache.delete(url);
        throw error;
      });
      physicsQueryImageCache.set(url, promise);
      return promise;
    }

    async function samplePhysicsDepth(asset, lat, lon) {
      const bounds = getActivePhysicsManifest()?.boundsWgs84;
      if (!asset?.query?.url || !Array.isArray(bounds) || bounds.length !== 2) return null;
      const south = Number(bounds[0]?.[0]);
      const west = Number(bounds[0]?.[1]);
      const north = Number(bounds[1]?.[0]);
      const east = Number(bounds[1]?.[1]);
      if (
        ![south, west, north, east].every(Number.isFinite) ||
        lat < south || lat > north || lon < west || lon > east
      ) return null;
      const image = await preloadPhysicsQueryImage(asset.query);
      const x = Math.floor(((lon - west) / (east - west)) * image.naturalWidth);
      const y = Math.floor(((north - lat) / (north - south)) * image.naturalHeight);
      if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return null;
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      const wet = pixel[2] === 1;
      return { wet, depthM: wet ? (pixel[0] * 256 + pixel[1]) / 1000 : null };
    }

    async function sampleDepthModel(lat, lon) {
      if (DEPTH_QUERY_PNG_URL) {
        try {
          return await samplePackedDepthGrid(lat, lon);
        } catch (error) {
          console.warn("Packed routed-depth query failed; retrying through the COG.", error);
        }
      }
      if (DEPTH_QUERY_COG_URL) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await sampleDepthModelFromCog(lat, lon);
          } catch (error) {
            lastError = error;
            depthQueryImagePromise = null;
          }
        }
        throw lastError || new Error("Depth query data is unavailable.");
      }
      throw new Error("Depth query data is unavailable.");
    }

    function sampleRenderedFloodPixel(lat, lon) {
      const image = currentFloodLayer?.getElement?.();
      if (
        !image ||
        !image.complete ||
        image.naturalWidth <= 0 ||
        image.naturalHeight <= 0 ||
        !floodLatLngBounds
      ) return null;
      const imageUrl = image.currentSrc || image.src;
      try {
        if (
          !renderedFloodPixelCache ||
          renderedFloodPixelCache.url !== imageUrl ||
          renderedFloodPixelCache.width !== image.naturalWidth ||
          renderedFloodPixelCache.height !== image.naturalHeight
        ) {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return null;
          context.drawImage(image, 0, 0);
          renderedFloodPixelCache = {
            url: imageUrl,
            width: image.naturalWidth,
            height: image.naturalHeight,
            context
          };
        }
        const pixel = currentFloodLayer?._worldFileAffine
          ? latLngToWorldFilePixel(lat, lon, image.naturalWidth, image.naturalHeight)
          : (() => {
            const west = floodLatLngBounds.getWest();
            const east = floodLatLngBounds.getEast();
            const south = floodLatLngBounds.getSouth();
            const north = floodLatLngBounds.getNorth();
            const x = Math.floor(((lon - west) / (east - west)) * image.naturalWidth);
            const y = Math.floor(((north - lat) / (north - south)) * image.naturalHeight);
            return x >= 0 && y >= 0 && x < image.naturalWidth && y < image.naturalHeight ? { x, y } : null;
          })();
        if (!pixel) return null;
        const { x, y } = pixel;
        const rgba = renderedFloodPixelCache.context.getImageData(x, y, 1, 1).data;
        const visible = rgba[3] > 0;
        const green = isDisconnectedRasterPixel(rgba, 0);
        const depthBandIndex = currentOverlayMode === "depth" ? DRAINAGE_DEPTH_COLORS.findIndex(color =>
          color.every((channel, index) => Math.abs(channel - rgba[index]) <= 3)) : -1;
        const depthBandFt = depthBandIndex < 0 ? null : [depthBandIndex ? DRAINAGE_DEPTH_BREAKS_FT[depthBandIndex - 1] : 0,
          DRAINAGE_DEPTH_BREAKS_FT[depthBandIndex] ?? Infinity];
        return { visible, green, flooded: visible && !green, depthBandFt };
      } catch (error) {
        console.warn("Rendered flood-pixel sampling was unavailable.", error);
        renderedFloodPixelCache = null;
        return null;
      }
    }

    function getDepthQueryDisplayDepth(sample, stageValue, renderedFlood = null, phase = "slack") {
      if (!sample) return null;
      const stage = normalizeStageValue(stageValue);
      if (!Number.isFinite(stage)) return null;
      const overlayStage = getOverlayStage(stage);
      const depthStage = normalizeHydraulicPhase(phase) === "filling" ? stage : overlayStage;
      const developed = sample.developedFlag === true;
      const depthModel = getPenalizedConnectedDepth(
        depthStage,
        sample.elevation,
        developed,
        phase,
        sample.sourceDistanceFt
      );
      const adjustedStage = Number(depthModel?.adjustedStage);
      const normalizedPhase = normalizeHydraulicPhase(phase);
      const connectionStageLimit = normalizedPhase === "draining"
        ? adjustedStage
        : overlayStage;
      const modeledConnected = Number.isFinite(adjustedStage) &&
        sample.elevation < adjustedStage - 0.005 &&
        Number.isFinite(sample.connectionStage) &&
        sample.connectionStage <= connectionStageLimit + 0.0001;
      const connected = renderedFlood ? renderedFlood.flooded : modeledConnected;
      const depth = connected && depthModel ? depthModel.depth : null;
      // A visible pooled/feeder pixel is not evidence for an invented point depth.
      if (renderedFlood?.flooded && (!Number.isFinite(depth) || depth <= 0.005)) {
        // Only an actual shallow raster band supports the displayed 0–0.1 ft range.
        return renderedFlood.depthBandFt?.[1] === 0.1 ? 0.05 : null;
      }
      return Number.isFinite(depth) ? depth : 0;
    }

    function getDepthQueryPopupHeading() {
      const displayedMode = currentFloodLayer?._floodmapperFrame?.dataMode || currentDataMode;
      if (displayedMode === "forecast") return "Forecast Water Depth";
      if (displayedMode === "observed") return "Water Depth";
      return "Modeled Water Depth";
    }

    function formatDepthQueryValue(depth) {
      if (!Number.isFinite(depth)) return "N/A";
      if (depth > 0 && depth <= 0.1000001) return "0–1.2 in";
      return formatWaterDepth(depth);
    }

    function buildDepthQueryValueHtml(value) {
      const parts = String(value).match(/^(.*?)\s+(in|ft)$/);
      if (!parts) return '<span class="depth-query-number">' + value + '</span>';
      return '<span class="depth-query-number">' + parts[1] + '</span> ' +
        '<span class="depth-query-unit">' + parts[2] + '</span>';
    }

    function buildDepthQueryPopupHtml(depth) {
      const value = formatDepthQueryValue(depth);
      return '<div class="depth-query-popup" role="status" aria-live="polite">' +
        '<h3>' + getDepthQueryPopupHeading() + '</h3><div class="depth-query-value">' +
        buildDepthQueryValueHtml(value) + '</div></div>';
    }

    function updatePersistentDepthQueryPopup(options = {}) {
      const context = persistentDepthQueryContext;
      const popup = persistentFloodPopup;
      if (!context || !popup || context.popup !== popup || !map?.hasLayer(popup)) return;
      if (context.kind === "structure") {
        popup.setContent(buildNsiStructurePopup(context.feature));
        popup.update();
        return;
      }
      if (context.kind === "physics") {
        // Physics values belong to one frame; close them when navigation starts.
        if (floodFrameState !== "ready") {
          map.removeLayer(popup);
          persistentDepthQueryContext = null;
        }
        return;
      }
      if (context.kind === "building") {
        popup.setContent(buildHouseAlertPopup(context.feature));
        popup.update();
        return;
      }
      const displayedFrame = currentFloodLayer?._floodmapperFrame;
      const stage = displayedFrame ? displayedFrame.stage : getStageValue(currentSeriesHours[currentHourIndex]);
      if (floodFrameState !== "ready") {
        popup.setContent(buildDepthQueryPopupHtml(null));
        popup.update();
        return;
      }
      const renderedFlood = options.useRenderedFlood === false
        ? null
        : sampleRenderedFloodPixel(context.latlng.lat, context.latlng.lng);
      const phase = displayedFrame?.phase || getHydraulicPhaseForEntry(
        currentSeriesHours[currentHourIndex],
        currentHourIndex,
        currentSeriesHours
      );
      const depth = getDepthQueryDisplayDepth(context.sample, stage, renderedFlood, phase);
      popup.setContent(buildDepthQueryPopupHtml(depth));
      popup.update();
    }

    function openDepthQueryPopup(latlng, sample) {
      const displayedFrame = currentFloodLayer?._floodmapperFrame;
      const stage = displayedFrame ? displayedFrame.stage : getStageValue(currentSeriesHours[currentHourIndex]);
      const renderedFlood = sample
        ? sampleRenderedFloodPixel(latlng.lat, latlng.lng)
        : null;
      const phase = displayedFrame?.phase || getHydraulicPhaseForEntry(
        currentSeriesHours[currentHourIndex],
        currentHourIndex,
        currentSeriesHours
      );
      const depth = floodFrameState === "ready"
        ? getDepthQueryDisplayDepth(sample, stage, renderedFlood, phase) : null;
      const popup = openPersistentFloodPopup(latlng, buildDepthQueryPopupHtml(depth), 300);
      if (sample) {
        persistentDepthQueryContext = { popup, latlng, sample };
      }
      return popup;
    }

    async function handleDepthQueryClick(event) {
      if (event?.originalEvent?._parcelHandled || !event?.latlng) return;
      const queryGeneration = ++mapQueryGeneration;
      const queryMode = mapClickMode;
      const queryRenderToken = lastRenderToken;
      const isCurrentQuery = () => queryGeneration === mapQueryGeneration && queryMode === mapClickMode && queryRenderToken === lastRenderToken;
      try {
        if (mapClickMode === "building" && parcelInfoInteractionEnabled()) {
          const nsiEnabled = document.getElementById("nsiStructuresToggle")?.classList.contains("on");
          if (nsiEnabled) {
            const structureFeature = findNsiStructureFeatureForLocation(event.latlng.lat, event.latlng.lng);
            if (structureFeature) {
              openNsiStructurePopup(structureFeature, event.latlng);
              return;
            }
          }
          const parcelLayerEnabled = Boolean(
            document.getElementById("parcelsToggle")?.classList.contains("on") ||
            document.getElementById("buildingsToggle")?.classList.contains("on")
          );
          if (!parcelLayerEnabled) {
            toast("Tap a highlighted NSI structure point or choose Water depth.");
            return;
          }
          const parcelFeature = await findParcelFeatureForLocation(
            event.latlng.lat,
            event.latlng.lng,
            { allowNearest: false }
          );
          if (!isCurrentQuery()) return;
          if (parcelFeature) {
            openParcelFloodPrompt(parcelFeature, event.latlng);
            return;
          }
          toast("No parcel contains that building tap. Tap inside a building or choose Water depth.");
          return;
        }
        const entry = currentSeriesHours[currentHourIndex];
        const physicsAsset = getPhysicsAssetForEntry(entry);
        if (physicsAsset) {
          const queryToken = lastRenderToken;
          const result = await samplePhysicsDepth(physicsAsset, event.latlng.lat, event.latlng.lng);
          if (!isCurrentQuery() || queryToken !== lastRenderToken || entry !== currentSeriesHours[currentHourIndex] || floodFrameState !== "ready") return;
          const depthFt = result?.depthM == null ? null : result.depthM / 0.3048;
          const html = '<div class="depth-query-popup" role="status" aria-live="polite">' +
            '<h3>Physics Water Depth</h3><div class="depth-query-value">' +
            buildDepthQueryValueHtml(result == null ? "N/A" : formatWaterDepth(depthFt == null ? 0 : depthFt)) +
            '</div><div class="house-alert-note">' +
            (result == null ? 'Outside modeled coverage' : result.wet ? 'Hydraulically connected modeled flooding' : 'Dry in this exact time step') +
            ' • cycle ' + escapeTownAddressHtml(getActivePhysicsManifest()?.cycleId || '—') +
            '</div></div>';
          const popup = openPersistentFloodPopup(event.latlng, html, 330);
          persistentDepthQueryContext = { popup, kind: "physics" };
          return;
        }
        const sample = await sampleDepthModel(event.latlng.lat, event.latlng.lng);
        if (!isCurrentQuery()) return;
        if (!sample) {
          await openDepthQueryPopup(event.latlng, null);
          return;
        }
        await openDepthQueryPopup(event.latlng, sample);
      } catch (err) {
        console.error("Depth query failed", err);
        toast("Depth query is temporarily unavailable.");
      }
    }

