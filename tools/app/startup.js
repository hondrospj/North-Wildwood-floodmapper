
(() => {
  const pending = new Map();
  const libraries = {
    html2canvas: ["https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js", () => typeof window.html2canvas === "function"],
    jszip: ["https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js", () => typeof window.JSZip === "function"],
    gif: ["https://cdn.jsdelivr.net/npm/gif.js.optimized@1.0.1/dist/gif.js", () => typeof window.GIF === "function"],
    geotiff: ["https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js", () => Boolean(window.GeoTIFF?.fromUrl)]
  };
  window.floodmapperLoadLibrary = key => {
    const [url, ready] = libraries[key];
    if (ready()) return Promise.resolve();
    if (pending.has(key)) return pending.get(key);
    let script;
    const promise = new Promise((resolve, reject) => {
      script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => ready() ? resolve() : reject(new Error(`${key} did not initialize.`));
      script.onerror = () => reject(new Error(`${key} could not load. Please try again.`));
      document.head.appendChild(script);
    }).catch(error => { pending.delete(key); script?.remove(); throw error; });
    pending.set(key, promise);
    return promise;
  };
  window.floodmapperUiLogoUrl = (value, configuredPath = value) => {
    if (!/(?:\/Logos\/ShorelySafe\.jpg|\/assets\/shorelysafe)(?:[?#].*)?$/i.test(String(configuredPath || ""))) return value;
    const path = "assets/shorelysafe-logo-ui.webp";
    const published = window.SHORELYSAFE_BUNNY_ASSETS;
    return published?.files?.[path] ? published.base + published.files[path] : new URL(path, window.location.href).href;
  };
  window.floodmapperAfterFirstFrame = task => {
    const deadline = performance.now() + 15000;
    const check = () => {
      const image = typeof currentFloodLayer === "undefined" ? null : currentFloodLayer?._image;
      if (image?.complete && image.naturalWidth || performance.now() >= deadline) {
        requestAnimationFrame(() => requestAnimationFrame(task));
      } else setTimeout(check, 50);
    };
    check();
  };
})();
