# November 1 mapper review fixes

- Changing tabs in the phone controls now opens the selected section at its top. Routine layout changes keep the current section's scroll position.
- Reload invalidates pending observed-history, live backfill, historical crest, and background list work. Responses from the previous load cannot restore old data or clear a newer request.
- Reload also invalidates physics pointer/manifest requests and their failure handlers, preserving the newer forecast catalog.
- Alert refreshes cache successful responses by zone. A failed zone retains unexpired alerts, a healthy empty response clears its own old alerts, and warnings appear before watches/advisories. Partial updates remain marked unavailable/stale and do not claim a complete successful check.

Regression coverage includes held requests resolved or rejected after Reload, a newer request completing first, partial and complete alert outages, expiration, recovery, native phone tab clicks, and keyboard navigation. The existing startup dependency assertion now includes the scalable road-label renderer introduced October 30.

The new parity inverse covers ten named functions in six authoring files, with exact before/after file hashes. All previous parity fixtures and 95 mutation cases remain unchanged; three additional mutation cases reject altered guards, neighboring code changes, and a broadened inverse.

Local verification: 503 responsive checks from 320-pixel phones through desktop and short landscape windows; actual mobile export calendar/time/custom-area controls; 20 rapid mouse interaction cycles; modal focus isolation; build consistency, script syntax, source contracts, and the new regressions. DST replay preserves both distinct 1 a.m. readings on November 1 (25 hours) and skips the missing hour on March 8 (23 hours).

The normal publication gate separately requires Linux Chromium/WebKit, Windows Chrome/Edge/Firefox, export, depth query, and historical replay jobs. Local Chrome evidence alone does not establish results for those other engines or physical devices.

The browser matrix also exposed a wide-view road-label check that assumed six
names would fit with every system font. It now requires five unique names,
explicit coverage of New Jersey, Delaware, Atlantic, and Ocean avenues, and
the existing northern-spit street/route check. All other aspect-ratio density,
font-size, bounds, collision, and downloaded-glyph assertions remain intact.
The investigation fixed a separate genuine bug: the length prefilter now uses
the smallest configured priority font and the same measurement scaling as final
placement. Short roads can reach their already-permitted fallback sizes. A new
regression covers both measurement callback forms, geometry, collision, and 2x
scaling. A separate exact inverse preserves all earlier parity fixtures and
adds four mutation cases, for 102 total.
