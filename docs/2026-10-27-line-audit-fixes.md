# October 27 code-review fixes

The follow-up review's 17 confirmed findings are addressed. The interface keeps
its shared font family. Optional physics remains disabled.

| Finding | Result |
| --- | --- |
| MAP-3D-01 | A pitched 3D frame must upload and commit its current texture before the timeline publishes its new time or water level. Failed, superseded, and context-lost candidates retain the previous selection and show the existing retryable frame failure. |
| MAP-NETWORK-01 | Packed-query and compositor image requests have bounded deadlines, safe cache eviction, and retry. Cancelling an export releases its wait without aborting another consumer of the shared raster. |
| MAP-PLAYBACK-01 | A session generation prevents paused or superseded playback loops from scheduling more frames. |
| LINE-EXPORT-01 | Worker headers and body loading have a deadline and immediate cancellation. Cancelled or late completions cannot poison a retry or retain an unused object URL. |
| LINE-EXPORT-02 | Export progress focuses its visible Cancel button and isolates background controls. Closing progress restores focus; nested dialogs and old completion timers cannot restore or hide a newer job. |
| LINE-STARTUP-01 | The welcome controller starts before blocking core scripts. A stalled or failed dependency exposes Retry while unfinished controls stay inert; late successful startup can recover. Missing Leaflet cannot falsely mark the app ready. |
| LINE-TEXT-01 | Choice rows grow and wrap with native text enlargement; desktop and touch layouts are checked. The mobile header uses equivalent unitless line heights. |
| CITY-DST-RESET | View limits use finite timestamps, retaining ambiguous municipal records for the archive while excluding them from plotted bounds. |
| CITY-RANGE-RACE | A request generation discards old date-range results and failures. |
| CITY-COMPARISON-OUTAGE | Municipal startup and readings remain independent of the optional comparison index and shards. Optional headers and JSON bodies have a 10-second deadline, an availability message, and Retry. |
| DATA-LEWES-BOUND | NOAA request bounds cover the entire New York day, including its following UTC date. Four September 30, 2007 evening gaps were corrected from verified NOAA readings; the daily maximum is unchanged. |
| DATA-WEBP | Existing WebP companions are checked against current PNG pixels and regenerated atomically when stale or corrupt. |
| DATA-COMPARISON-CACHE | Comparison reuse requires municipal-content, builder, and municipal-time policy identities. Existing legacy caches rebuild on the next generator run. |
| MODEL-OUTPUT-INTERVAL | Renderer and validator share output-time alignment, including nondefault intervals and matching boundary stages. The helper participates in render cache identity. |
| TOOLS-QA-DRIFT | Hydraulic QA commands use the current solver and render interfaces and run against tiny fixtures. Their labels describe the current comparison rather than removed routing methods. |
| TOOLS-PUBLISHER-DEFAULT | The manual publisher defaults to the repository's actual application catalog. |
| TEST-DEFAULT-PATH | The UI-state regression defaults to the real application document. |

The original extraction and earlier audit fixtures remain immutable. A separate
October 27 fixture reverses only exact reviewed changes and verifies the complete
restored file hashes before applying earlier audits. Generated outputs remain
checked against authoring source; mutation tests reject additional changes.

Permanent regressions cover image loading and GPU upload failures, request
supersession, real graphics loss, playback sessions, core-library startup stalls,
native text enlargement, worker cancellation and actual GIF retry, progress
focus, city-gauge DST/races/outages, generator freshness, and model time alignment.
Linux browser and required Windows browser jobs run the relevant application
checks in addition to the existing release gate.

The model tests use tiny products and perform no new full hydraulic simulation,
scientific calibration, or physics publication. Phone/touch viewport emulation
does not establish physical phone or Lenovo hardware coverage.
