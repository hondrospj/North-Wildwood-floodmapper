/* Official North Wildwood camera players. No video requests until a camera is opened. */
(() => {
  "use strict";
  const CITY_URL = "https://northwildwood.com/north-wildwood-surf-cams/";
  // Site locations, not surveyed camera mounting coordinates. Sources in docs/webcams.md.
  const cameras = [
    { id: "bay", name: "5th Avenue Bay / Flood Cam", short: "Bay / flood", location: "5th Avenue boat ramp · approximate location",
      lat: 39.007333, lng: -74.798667,
      url: "https://g1.ipcamlive.com/player/player.php?alias=5d49c2c217415",
      description: "View the back bay and boat ramp for visible tidal conditions." },
    { id: "beach", name: "15th Avenue Lifeguard Station", short: "15th Avenue beach", location: "15th Avenue and the beach · approximate location",
      lat: 38.994620, lng: -74.795285,
      url: CITY_URL, external: true,
      description: "View beach and surf conditions. This camera does not show bayside street flooding." }
  ];
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="4"/></svg>';
  const toggle = document.getElementById("webcamsToggle");
  const browse = document.getElementById("webcamsBrowse");
  if (!toggle || !browse) return;

  const panel = document.createElement("section");
  panel.id = "webcamPanel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", "webcamTitle");
  panel.setAttribute("data-html2canvas-ignore", "true");
  panel.innerHTML = `
    <div class="webcam-heading"><div><p class="webcam-eyebrow">NORTH WILDWOOD CAMERAS</p><h2 id="webcamTitle"></h2></div>
      <button type="button" id="webcamClose" aria-label="Close camera viewer">×</button></div>
    <div class="webcam-choices" role="group" aria-label="Choose camera"></div>
    <p id="webcamLocation" class="webcam-location"></p>
    <div id="webcamFrame" class="webcam-frame"></div>
    <p id="webcamStatus" role="status" aria-live="polite"></p>
    <p class="webcam-time-note"><strong>Current camera view</strong> — independent of the map’s selected time. Check the timestamp in the video; footage may be delayed or unavailable.</p>
    <p id="webcamDescription"></p>
    <div class="webcam-actions"><button type="button" id="webcamRetry">Reload camera</button>
      <a href="${CITY_URL}" target="_blank" rel="noopener noreferrer">Open city cameras ↗</a></div>
    <p class="webcam-credit">Camera source: City of North Wildwood. Camera views do not establish water depth or whether a road is safe.</p>`;
  document.body.append(panel);

  let enabled = false;
  let selected = null;
  let returnFocus = null;
  let frame = null;
  let timeout = null;
  let leafletLayer = null;
  let leafletMap = null;
  let glMap = null;
  let glMarkers = [];
  const status = panel.querySelector("#webcamStatus");
  const frameHost = panel.querySelector("#webcamFrame");
  const closeButton = panel.querySelector("#webcamClose");

  function clearPlayer() {
    clearTimeout(timeout);
    timeout = null;
    if (frame) { frame.onload = frame.onerror = null; frame.remove(); frame = null; }
    frameHost.replaceChildren();
  }

  function loadPlayer(camera) {
    clearPlayer();
    panel.querySelector("#webcamRetry").hidden = Boolean(camera.external);
    if (camera.external) {
      // The provider's frame-ancestors policy excludes ShorelySafe. Use the city page.
      panel.dataset.playerState = "external";
      status.textContent = "The city’s camera page opens in a new tab.";
      const notice = document.createElement("div");
      notice.className = "webcam-external";
      const message = document.createElement("p");
      message.textContent = "Watch the 15th Avenue beach camera on the city website.";
      const link = document.createElement("a");
      link.href = camera.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Watch beach camera ↗";
      notice.append(message, link);
      frameHost.append(notice);
      return;
    }
    status.textContent = "Opening camera player…";
    panel.dataset.playerState = "loading";
    const player = document.createElement("iframe");
    player.title = `${camera.name} — current camera view`;
    player.allow = "autoplay; fullscreen; picture-in-picture";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    const unavailable = () => {
      if (frame !== player) return;
      panel.dataset.playerState = "unconfirmed";
      status.textContent = "Unable to confirm the feed. Reload or open the city cameras if the player is blank or offline.";
    };
    player.onload = () => {
      if (frame !== player) return;
      clearTimeout(timeout);
      // Cross-origin load only confirms the player document, never camera freshness.
      panel.dataset.playerState = "player-open";
      status.textContent = "Player opened · press Play if needed. Stream availability and timestamp are shown by the provider.";
    };
    player.onerror = unavailable;
    frame = player;
    player.src = camera.url;
    timeout = setTimeout(unavailable, 15000);
    frameHost.append(player);
  }

  function showCamera(camera, trigger) {
    if (panel.hidden) returnFocus = trigger || document.activeElement;
    selected = camera;
    panel.querySelector("#webcamTitle").textContent = camera.name;
    panel.querySelector("#webcamLocation").textContent = camera.location;
    panel.querySelector("#webcamDescription").textContent = camera.description;
    for (const button of panel.querySelectorAll("[data-camera]")) {
      button.setAttribute("aria-pressed", String(button.dataset.camera === camera.id));
    }
    panel.hidden = false;
    browse.setAttribute("aria-expanded", "true");
    // Close the mobile controls before moving focus to the camera viewer.
    if (document.body.classList.contains("mobile-controls-open")) document.getElementById("mobileControlsClose")?.click();
    loadPlayer(camera);
    requestAnimationFrame(() => { if (!panel.hidden) closeButton.focus({ preventScroll: true }); });
  }

  function closeCamera(restoreFocus = true) {
    clearPlayer();
    panel.hidden = true;
    selected = null;
    browse.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      const visible = element => element?.isConnected && element.getClientRects().length && !element.closest("[inert],[hidden]") && getComputedStyle(element).visibility !== "hidden";
      const target = visible(returnFocus) ? returnFocus : visible(browse) ? browse : document.getElementById("mobileControlsToggle");
      target?.focus({ preventScroll: true });
    }
  }

  for (const camera of cameras) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.camera = camera.id;
    button.textContent = camera.short;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => showCamera(camera, button));
    panel.querySelector(".webcam-choices").append(button);
  }
  closeButton.addEventListener("click", () => closeCamera());
  panel.querySelector("#webcamRetry").addEventListener("click", () => { if (selected) loadPlayer(selected); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); closeCamera(); }
  });

  function syncMarkers() {
    const currentMap = typeof map !== "undefined" ? map : null;
    const currentGl = window.NORTH_WILDWOOD_3D?.getMap?.();
    const useGl = Boolean(currentGl && document.body.classList.contains("map-3d-ready"));
    if (leafletMap !== currentMap) {
      leafletLayer?.remove();
      leafletLayer = null;
      leafletMap = currentMap;
    }
    if (enabled && currentMap && !useGl) {
      if (!leafletLayer) {
        if (!currentMap.getPane("webcamsPane")) {
          currentMap.createPane("webcamsPane");
          currentMap.getPane("webcamsPane").style.zIndex = "760";
        }
        leafletLayer = L.layerGroup(cameras.map(camera => {
          const marker = L.marker([camera.lat, camera.lng], {
            pane: "webcamsPane", title: `Open ${camera.name}`, alt: camera.name,
            bubblingMouseEvents: false, keyboard: true,
            icon: L.divIcon({ className: "webcam-map-marker", html: icon, iconSize: [40, 40], iconAnchor: [20, 20] })
          });
          marker.on("click", () => showCamera(camera, marker.getElement()));
          marker.on("add", () => {
            const element = marker.getElement();
            element.setAttribute("role", "button");
            element.setAttribute("aria-label", `Open ${camera.name}`);
            element.setAttribute("data-webcam-marker", camera.id);
            element.setAttribute("data-html2canvas-ignore", "true");
            element.addEventListener("keydown", event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                showCamera(camera, element);
              }
            });
          });
          return marker;
        }));
      }
      if (!currentMap.hasLayer(leafletLayer)) leafletLayer.addTo(currentMap);
    } else if (leafletLayer && leafletMap?.hasLayer(leafletLayer)) leafletLayer.remove();

    if (glMap !== currentGl || !enabled || !useGl) {
      glMarkers.forEach(marker => marker.remove());
      glMarkers = [];
      glMap = currentGl;
    }
    if (enabled && useGl && !glMarkers.length && window.maplibregl) {
      glMarkers = cameras.map(camera => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "webcam-map-marker";
        element.innerHTML = icon;
        element.dataset.webcamMarker = camera.id;
        element.setAttribute("data-html2canvas-ignore", "true");
        element.setAttribute("aria-label", `Open ${camera.name}`);
        element.title = camera.name;
        element.addEventListener("click", event => { event.stopPropagation(); showCamera(camera, element); });
        element.addEventListener("dblclick", event => event.stopPropagation());
        return new maplibregl.Marker({ element, anchor: "center" }).setLngLat([camera.lng, camera.lat]).addTo(currentGl);
      });
    }
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    toggle.classList.toggle("on", enabled);
    toggle.setAttribute("aria-checked", String(enabled));
    browse.hidden = !enabled;
    document.body.dataset.webcamsEnabled = String(enabled);
    if (!enabled) closeCamera(false);
    syncMarkers();
  }
  toggle.addEventListener("click", () => setEnabled(!enabled));
  toggle.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEnabled(!enabled); }
  });
  browse.addEventListener("click", () => showCamera(cameras[0], browse));
  new MutationObserver(syncMarkers).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("load", syncMarkers);
  window.addEventListener("pagehide", () => closeCamera(false));
  window.addEventListener("pageshow", event => { if (event.persisted) setEnabled(false); });
  setEnabled(false);
})();
