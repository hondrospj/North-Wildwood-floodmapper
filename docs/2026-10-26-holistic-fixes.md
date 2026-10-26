# October 26 holistic audit fixes

The second audit's thirteen active findings and separate model-generation cache
risk are addressed by these changes. The common interface font family is retained.

| Finding | Result |
| --- | --- |
| REL-01 | Graphics restoration recreates the custom flood plane, waits for the latest selected texture, and shows a visible recovery/failure notice. |
| REL-02 | Failed history warmups can retry without reloading the page. |
| REL-03 | The archive-index request has a 15-second deadline covering headers and body; Past clears forecast labels and visibly identifies its pending state before fallback. |
| REL-04 | Optional export scripts have a 12-second deadline; closing Export cancels a Download waiting on preview preparation. |
| REL-05 | Interval loads discard obsolete successes and failures; active failures restore the prior interval. |
| HOL-EXPORT-01 | Historical export initializes availability without a prior visit to Past. Forecast-only ranges remain exportable during a history outage. |
| HOL-EXPORT-02 | Modeled Daily Max exports share the main timeline's storm-relative grouping. |
| DEVICE-01 | The offscreen export stage is inert and its map disables keyboard navigation. |
| DEVICE-02 | Mobile drawer tabs grow with enlarged text. |
| DEVICE-03 | Focus traps exclude inactive roving tabs and contain reverse navigation. |
| DEVICE-04 | Datum and export choices expose button-group semantics. |
| DEVICE-05 | The primary export action uses a darker background for normal-size text contrast. |
| DEVICE-06 | Modal opening focuses synchronously; nested dialogs preserve current focus; legacy controllers defer to the unified owner; closed tutorial callbacks cannot change controls; passive export updates preserve an active date edit. |
| MODEL-LATENT-01 | Simulation/render identities cover effective inputs, settings, implementation and dependencies. Reuse, validation and publication require matching identities. |

The model fix does not enable the optional physics feed. Legacy cache entries
without identities rebuild once. Changed settings invalidate affected products;
unchanged inputs remain reusable. Direct runner/render calls reject stale output
directories with an explicit rebuild instruction.

New regression coverage:

- `tools/test_north_wildwood_history_recovery.mjs`: deadlines, retries, pending-mode presentation and stale interval completion.
- `tools/test_export_holistic.mjs`: archive initialization, forecast-only outage isolation, modeled day grouping and optional-library timeout/retry.
- `tools/test_modal_focus_transitions.mjs`: nested modal isolation, focus restoration and roving-tab exclusion.
- `tools/test_north_wildwood_holistic_ui.mjs`: actual graphics loss/restoration, current selected texture, responsive keyboard navigation, native Firefox enlarged text and rapid date editing.
- `tools/test_north_wildwood_holistic_export.mjs`: real historical previews, modeled frame consistency, a decoded GIF, pending CDN cancellation/retry and forecast-only export with history unavailable.
- `tools/test_north_wildwood_device_matrix.mjs`: desktop/high-DPI/touch-size profiles across browser engines.
- `model/tests/test_generation_identity.py`: five audited identity changes, unchanged reuse, direct overrides, stale validation/publication and pruned-state regeneration.

Windows Chromium, Edge and Firefox regressions join the existing release gate.
Mobile viewport/touch emulation does not establish physical phone or Lenovo
hardware coverage. The model tests use tiny fixtures and execute no new hydraulic
simulation or publication.
