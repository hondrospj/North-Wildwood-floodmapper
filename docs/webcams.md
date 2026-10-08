# North Wildwood camera layer

The Cameras switch is off by default. It adds two approximate site markers in
Leaflet (2D) and MapLibre (3D), plus a View cameras button for keyboard/mobile
access. Opening the bay camera loads its official cross-origin player. The beach
camera links to the city page because its provider restricts embedding.
Switching, closing, disabling the layer or leaving the page removes the old iframe.
Camera imagery never follows the flood forecast/replay time and never enters
depth calculations, road-risk decisions or map exports.

## Sources checked October 8, 2026

- City camera directory and exact embed URLs:
  https://northwildwood.com/north-wildwood-surf-cams/
- Bay/flood player:
  https://g1.ipcamlive.com/player/player.php?alias=5d49c2c217415
  The public player reports domainlockenabled=0. Preserve the official player
  and its attribution; do not extract or proxy its stream.
- Beach player:
  https://streamer-1.magicbrain.io/embed/?v=lifeguard-station
  Its Content-Security-Policy frame-ancestors list excludes cupajoe.live.
  The mapper therefore links to the official city camera directory instead
  of embedding, proxying or bypassing the provider's restriction.
- OEM identifies the bay camera at the 5th Avenue boat ramp:
  https://ready.northwildwood.com/local-weather-resources/
- NJDEP ramp guide lists Bayfront Park at 39°00.44′ N, 74°47.92′ W:
  https://www.nj.gov/dep/fgw/pdf/boat_ramp_guide.pdf
- City identifies Beach Patrol at 15th Avenue and the beach:
  https://northwildwood.com/public-safety/beach-patrol/
  Approximate marker 38.994620, -74.795285 from the ArcGIS World Geocoder's
  North Wildwood Beach Patrol Lifeguard POI, cross-checked against the mapper's
  NJOGIS East 15th Avenue beachfront road endpoint (38.994709, -74.795385).

Neither marker claims a surveyed camera mounting point or exact field of view.

## Availability

Iframe load means the provider's page opened, not that video is live. The UI
does not invent a last-frame timestamp or infer online/offline from iframe load.
The provider displays stream errors and video timestamps. A 15-second load
timeout reports an unconfirmed feed; Reload camera and the city source link
remain available. No recorder, stream scraper, proxy or camera credentials
are introduced. Provider availability and embed policy may change.

## Verification

Serve the repository on port 8765 and run
`node tools/test_north_wildwood_webcams.mjs` with Playwright installed.
`NWW_TEST_URL`, `PLAYWRIGHT_MODULE`, and `CHROME_PATH` can override the defaults.
The browser test covers keyboard activation, 1440/390/320-pixel layouts,
no player requests until selection, beach-provider restrictions, iframe cleanup,
focus restoration, and 2D/3D marker transitions. The provider is mocked in this
test; actual playback must be checked separately. The Chromium reliability job
runs it before the existing full-application checks.

On October 8, 2026, actual bay-camera playback was also checked in Chrome and
the webcam browser tests passed. The existing startup-performance and browser
contract tests failed identically against the unchanged base commit
4875970212f7ddb1abe62d94dc566ab3837551b7; those unrelated assertions were not changed.
