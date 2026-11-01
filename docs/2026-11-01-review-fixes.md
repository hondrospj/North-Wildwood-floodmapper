# November 1 mapper review fixes

- Changing tabs in the phone controls now opens the selected section at its top. Routine layout changes keep the current section's scroll position.
- Reload invalidates pending observed-history, live backfill, historical crest, and background list work. Responses from the previous load cannot restore old data or clear a newer request.
- Reload also invalidates physics pointer/manifest requests and their failure handlers, preserving the newer forecast catalog.
- Alert refreshes cache successful responses by zone. A failed zone retains unexpired alerts, a healthy empty response clears its own old alerts, and warnings appear before watches/advisories. Partial updates remain marked unavailable/stale and do not claim a complete successful check.

Regression coverage includes held requests resolved or rejected after Reload, a newer request completing first, partial and complete alert outages, expiration, recovery, native phone tab clicks, and keyboard navigation. The existing startup dependency assertion now includes the scalable road-label renderer introduced October 30.

The new parity inverse covers ten named functions in six authoring files, with exact before/after file hashes. All previous parity fixtures and 95 mutation cases remain unchanged; three additional mutation cases reject altered guards, neighboring code changes, and a broadened inverse.

Local verification: 503 responsive checks from 320-pixel phones through desktop and short landscape windows; actual mobile export calendar/time/custom-area controls; 20 rapid mouse interaction cycles; modal focus isolation; build consistency, script syntax, source contracts, and the new regressions. DST replay preserves both distinct 1 a.m. readings on November 1 (25 hours) and skips the missing hour on March 8 (23 hours).

The normal publication gate separately requires Linux Chromium/WebKit, Windows Chrome/Edge/Firefox, export, depth query, and historical replay jobs. Local Chrome evidence alone does not establish results for those other engines or physical devices.
