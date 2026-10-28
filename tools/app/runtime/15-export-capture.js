    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForStableRender() {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await wait(EXPORT_CAPTURE_DELAY_MS);
    }

    function waitForImageElementReady(img, timeoutMs = 1500) {
      if (!img || !img.src || img.style.display === "none" || !img.classList.contains("is-visible")) {
        return Promise.resolve();
      }
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          img.removeEventListener("load", done);
          img.removeEventListener("error", done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    }

    async function waitForExportChromeReady() {
      const partner = document.getElementById("exportPartnerLogo");
      const brand = document.getElementById("mapTitlePartnerLogo");
      if (partner && !partner.getAttribute?.("src")) {
        const source = partner.dataset?.exportBrandSrc || brand?.getAttribute?.("src");
        if (source) setExportLogoImage("exportPartnerLogo", source, brand?.alt || "ShorelySafe");
      }
      for (const id of ["exportTownLogo", "exportPartnerLogo"]) {
        const image = document.getElementById(id);
        if (image) image.loading = "eager";
      }
      const images = [
        document.getElementById("exportTownLogo"),
        document.getElementById("exportPartnerLogo")
      ];
      await Promise.all(images.map(async img => {
        if (!img?.src || !img.classList.contains("is-visible") || img.style.display === "none") return;
        if (!img.src.startsWith("data:")) {
          const source = await getExportImageElement(img.src);
          throwIfExportCancelled();
          if (!source) throw new Error("The export logo could not load. Please try again.");
          const canvas = document.createElement("canvas");
          try {
            canvas.width = source.naturalWidth;
            canvas.height = source.naturalHeight;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Could not prepare the export logo.");
            context.drawImage(source, 0, 0);
            // html2canvas otherwise fetches the remote logo again for every
            // capture and silently omits it when that second request is slow.
            img.src = canvas.toDataURL("image/png");
          } finally {
            canvas.width = 1;
            canvas.height = 1;
          }
        }
        if (typeof img.decode === "function") await img.decode();
        else await waitForImageElementReady(img);
        throwIfExportCancelled();
      }));
    }


    function waitForTileLayerReady(layer, timeoutMs = 3500) {
      return new Promise(resolve => {
        if (!layer || typeof layer.on !== "function") {
          resolve();
          return;
        }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          layer.off?.("load", done);
          layer.off?.("tileerror", done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        layer.on("load", done);
        layer.on("tileerror", done);
        if (typeof layer.isLoading === "function" && !layer.isLoading()) {
          setTimeout(done, 80);
        }
      });
    }

    async function waitForExportMapReady(extraDelayMs = 120) {
      if (!exportMap) return;
      exportMap.invalidateSize(false);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const waits = [];
      if (exportBasemapColorLayer) waits.push(waitForTileLayerReady(exportBasemapColorLayer));
      if (exportRoadsLayer && Number(exportRoadsLayer.options?.opacity || 0) > 0) waits.push(waitForTileLayerReady(exportRoadsLayer));
      await Promise.race([
        Promise.all(waits),
        wait(3800)
      ]).catch(() => null);
      // Esri's vector layer load event precedes the underlying WebGL render.
      // Capturing then can produce an empty canvas, especially on phones.
      const vectorBasemap = exportBasemapColorLayer;
      try {
        await waitForExportVectorLayerReady(vectorBasemap);
      } catch (error) {
        if (isExportCancelledError(error)) throw error;
        // A stalled vector worker is equivalent to the vector layer's error
        // event. Use the existing raster fallback and verify its actual tiles.
        useExportFallbackBasemap(vectorBasemap);
      }
      await Promise.all([
        waitForExportRasterLayerReady(exportBasemapColorLayer),
        exportSatelliteLayer && exportMap.hasLayer(exportSatelliteLayer)
          ? waitForExportRasterLayerReady(exportSatelliteLayer) : null,
        exportRoadsLayer && Number(exportRoadsLayer.options?.opacity || 0) > 0
          ? waitForExportRasterLayerReady(exportRoadsLayer) : null,
        exportBuildingsLayer && exportMap.hasLayer(exportBuildingsLayer)
          ? waitForExportVectorLayerReady(exportBuildingsLayer) : null
      ]);
      if (extraDelayMs > 0) await wait(extraDelayMs);
    }

    function getFriendlyExportError(err, format = "") {
      const raw = String(err?.message || err || "Download failed.").trim();
      const formatLabel = String(format || "export").toUpperCase();
      if (isExportCancelledError(err)) return "Export cancelled.";
      if (!raw) return `${formatLabel} export failed.`;
      if (/JSZip|zip export library/i.test(raw)) {
        return "PNG export could not package multiple images. Reload the page and try again.";
      }
      if (/gif\.worker|Failed to construct 'Worker'|cannot be accessed from origin/i.test(raw)) {
        return "GIF export was blocked by a worker loading issue. Reload the page and try again.";
      }
      if (/formatNyDateKey|format date key|date key/i.test(raw)) {
        return "The export date picker had an internal date-format issue. Reload the page; if it continues, use MM/DD/YY for both export dates.";
      }
      if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
        return "GIF export failed while loading browser export components. Reload the page and try again.";
      }
      if (/html2canvas|canvasToBlob|CanvasToBlob|Canvas export failed|taint|cross-origin resource/i.test(raw)) {
        return `${formatLabel} export could not capture the map cleanly. Reload the page and try again.`;
      }
      if (raw.length > 140) {
        return `${formatLabel} export failed. Check the browser console for the full error.`;
      }
      return raw;
    }

    function getSameOriginWorkerUrl(sourceUrl, { signal, timeoutMs = 12000 } = {}) {
      // The deadline covers both response headers and the complete body. A
      // separate rejection also releases Cancel when a transport ignores abort.
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let timer = null;
        const finish = (error, url = null) => {
          if (settled) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancelled);
          if (error) {
            controller.abort();
            reject(error);
          } else {
            resolve(url);
          }
        };
        const cancelled = () => finish(makeExportCancelledError());
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) {
          cancelled();
          return;
        }
        timer = setTimeout(() => finish(new Error("The GIF worker download took too long. Please try the export again.")), timeoutMs);
        Promise.resolve().then(async () => {
          if (settled) return;
          const response = await fetch(sourceUrl, { mode: "cors", cache: "force-cache", signal: controller.signal });
          if (settled) return;
          if (!response.ok) throw new Error(`Could not load worker script (${response.status}).`);
          const scriptText = await response.text();
          if (settled) return;
          finish(null, URL.createObjectURL(new Blob([scriptText], { type: "text/javascript" })));
        }).catch(error => finish(error));
      });
    }

    async function waitForExportVectorLayerReady(layer, timeoutMs = 15000) {
      if (!layer || typeof layer._createMaplibreLayer !== "function") return;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        throwIfExportCancelled();
        if (layer._map === null) return; // The layer's error handler installed a fallback.
        const glMap = layer._maplibreGL?._glMap;
        if (glMap?.loaded() && glMap.areTilesLoaded()) {
          glMap.triggerRepaint();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return;
        }
        await wait(100);
      }
      throw new Error("The map background is still loading. Please try the export again.");
    }

    function retryExportRasterLayerTiles(layer) {
      const mapInstance = typeof exportMap === "undefined" ? null : exportMap;
      if (!mapInstance || typeof mapInstance.hasLayer !== "function" || !mapInstance.hasLayer(layer)
          || typeof mapInstance.removeLayer !== "function" || typeof mapInstance.addLayer !== "function") return false;
      const previousContainer = layer.getContainer?.();
      const parent = previousContainer?.parentNode;
      const nextSibling = previousContainer?.nextSibling;
      // Leaflet 1.9.4 redraw() uses the fractional camera zoom as its tile
      // grid zoom. Reattaching uses onAdd/_setView's rounded grid instead, so
      // integer service levels and x/y stay aligned without moving the camera.
      mapInstance.removeLayer(layer);
      mapInstance.addLayer(layer);
      const container = layer.getContainer?.();
      if (parent && container?.parentNode === parent) {
        parent.insertBefore(container, nextSibling?.parentNode === parent ? nextSibling : null);
      }
      return true;
    }

    async function waitForExportRasterLayerReady(layer, timeoutMs = 30000) {
      if (!layer || typeof layer.isLoading !== "function") return;
      const deadline = Date.now() + timeoutMs;
      let retriedFailedTiles = false;
      while (Date.now() < deadline) {
        throwIfExportCancelled();
        const tiles = Array.from(layer.getContainer()?.querySelectorAll("img.leaflet-tile, canvas.leaflet-tile") || []);
        if (tiles.some(tile => tile.complete && !tile.naturalWidth)) {
          // A preview and its download share this layer. Re-request failed tiles
          // once so a transient preview failure cannot poison the next capture.
          if (!retriedFailedTiles && retryExportRasterLayerTiles(layer)) {
            retriedFailedTiles = true;
            await wait(100);
            continue;
          }
          throw new Error("A map tile could not load. Please try the export again.");
        }
        if (!layer.isLoading() && tiles.length && tiles.every(tile => tile.complete && tile.naturalWidth > 0)) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return;
        }
        await wait(100);
      }
      throw new Error("The map background is still loading. Please try the export again.");
    }

    function useExportFallbackBasemap(expectedLayer = exportBasemapColorLayer) {
      if (expectedLayer !== exportBasemapColorLayer) return;
      if (expectedLayer && exportMap.hasLayer(expectedLayer)) {
        // Esri Leaflet 4.3.2 cannot remove a vector layer before its style is
        // ready: onRemove assumes _maplibreGL exists, and its queued ready
        // listener would otherwise re-add the abandoned layer later.
        if (typeof expectedLayer._createMaplibreLayer === "function" && !expectedLayer._maplibreGL) {
          expectedLayer.off("ready");
          expectedLayer.onRemove = () => {};
        }
        exportMap.removeLayer(expectedLayer);
      }
      exportBasemapColorLayer = L.tileLayer(FALLBACK_BASEMAP_URL, {
        attribution: "Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors",
        minZoom: 0, maxZoom: 24, maxNativeZoom: 19,
        subdomains: "abc", crossOrigin: true, updateWhenIdle: true, keepBuffer: 1,
        className: "basemap-color-layer", pane: "basemapColorPane"
      }).addTo(exportMap);
    }

    function isOutsideExportStage(element) {
      // html2canvas clones the document before capturing the requested element.
      // Exclude the live application so its maps/images cannot delay the clone
      // or allocate a second copy of the interactive map during an export.
      const stage = document.getElementById("exportStage");
      return element.parentElement === document.body && element !== stage && !element.contains(stage)
        && !["STYLE", "LINK"].includes(element.tagName);
    }

    async function getExportFrameImage(item) {
      const displayStage = getOverlayStage(getStageValue(item?.entry));
      if (displayStage == null) throw new Error("Stage is not numeric for the selected hour.");
      const phase = getHydraulicPhaseForEntry(item.entry, item.index, item.series);
      // Resolve each frame before using the bounded URL cache. A rounded stage
      // is not an identity for a retained-water or physics forecast raster.
      const physicsRecord = currentOverlayMode === "depth"
        ? getPhysicsDisplayRecord(getPhysicsAssetForEntry(item.entry), "depth") : null;
      const record = physicsRecord
        || await getHydraulicOverlayRecord(currentOverlayMode, displayStage, phase, item.entry, item.series);
      if (!record?.url) throw new Error("The flood image is unavailable for the selected time.");
      const image = await getExportImageElement(record.url);
      throwIfExportCancelled();
      if (!image) throw new Error("The flood image could not load. Please try the export again.");
      return image;
    }

    function createStreamingGifEncoder(options, frameCount) {
      // The gif.js worker protocol emits a header for index 0 and a trailer for
      // the last frame. Encode one transferred RGBA buffer at a time, retaining
      // only compressed Blob parts instead of every full-resolution canvas.
      const worker = new Worker(options.workerScript);
      const parts = [];
      let nextIndex = 0;
      let globalPalette = options.globalPalette;
      let pending = null;
      let closed = false;
      const dispose = (error = new Error("GIF export was aborted.")) => {
        closed = true;
        worker.terminate();
        parts.length = 0;
        if (pending) {
          clearTimeout(pending.timer);
          const reject = pending.reject;
          pending = null;
          reject(error);
        }
      };
      worker.onerror = event => {
        event.preventDefault();
        dispose(new Error("GIF encoding failed. Please try the export again."));
      };
      worker.onmessageerror = () => dispose(new Error("Could not read the encoded GIF frame."));
      worker.onmessage = event => {
        if (!pending || closed) return;
        const frame = event.data;
        if (frame?.index !== nextIndex || !Array.isArray(frame.data) || !frame.data.length) {
          dispose(new Error("The GIF encoder returned an invalid frame."));
          return;
        }
        const pages = frame.data.map((page, index) => index === frame.data.length - 1
          ? page.subarray(0, frame.cursor) : page);
        parts.push(new Blob(pages));
        if (globalPalette === true) globalPalette = frame.globalPalette;
        nextIndex += 1;
        clearTimeout(pending.timer);
        const resolve = pending.resolve;
        pending = null;
        resolve();
      };
      return {
        abort: dispose,
        dispose,
        getGlobalPalette: () => globalPalette,
        async addFrame(canvas, { delay }) {
          throwIfExportCancelled();
          if (closed || pending || nextIndex >= frameCount) throw new Error("GIF encoder is not ready for another frame.");
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Could not read the GIF frame.");
          const data = context.getImageData(0, 0, options.width, options.height).data;
          await new Promise((resolve, reject) => {
            pending = { resolve, reject, timer: setTimeout(() => {
              dispose(new Error("GIF encoding timed out. Please try the export again."));
            }, 120000) };
            try {
              worker.postMessage({
                index: nextIndex, last: nextIndex === frameCount - 1,
                width: options.width, height: options.height,
                quality: options.quality, dither: options.dither,
                globalPalette, repeat: 0,
                transparent: null, delay, canTransfer: true, data
              }, [data.buffer]);
            } catch (error) {
              dispose(error);
            }
          });
          throwIfExportCancelled();
        },
        finish() {
          if (closed || pending || nextIndex !== frameCount) throw new Error("The GIF export is incomplete.");
          return new Blob(parts, { type: "image/gif" });
        }
      };
    }

    let gifWorkerLoadRequest = null;

    function cancelGifWorkerLoad() {
      const request = gifWorkerLoadRequest;
      if (!request) return;
      gifWorkerLoadRequest = null;
      if (gifWorkerUrlPromise === request.promise) gifWorkerUrlPromise = null;
      request.controller.abort();
    }

    async function getGifWorkerUrl() {
      if (gifWorkerUrlPromise) return gifWorkerUrlPromise;
      const request = { controller: new AbortController(), promise: null };
      gifWorkerLoadRequest = request;
      request.promise = getSameOriginWorkerUrl(GIF_WORKER_CDN_URL, { signal: request.controller.signal }).then(url => {
        if (gifWorkerLoadRequest !== request || request.controller.signal.aborted) {
          URL.revokeObjectURL(url);
          throw makeExportCancelledError();
        }
        return url;
      }).catch(error => {
        if (gifWorkerUrlPromise === request.promise) gifWorkerUrlPromise = null;
        throw error;
      }).finally(() => {
        if (gifWorkerLoadRequest === request) gifWorkerLoadRequest = null;
      });
      gifWorkerUrlPromise = request.promise;
      return gifWorkerUrlPromise;
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

