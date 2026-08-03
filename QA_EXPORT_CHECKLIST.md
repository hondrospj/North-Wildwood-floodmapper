# North Wildwood export QA checklist

Completed: August 2, 2026

## Modeled return-interval behavior

- [x] Modeled start and end dates display `xx/xx/xxxx` and cannot be edited.
- [x] Modeled start and end times remain editable.
- [x] GIF titles contain only the return-interval storm label, such as `20-Year Storm`.
- [x] Exact title output is covered for every interval: 1, 2, 5, 10, 20, 50, 100, 200, 500, 1,000, 2,000, 5,000, and 10,000 years.
- [x] The longest title, `10,000-Year Storm`, was generated and visually checked at square size with a clear gap from the key.

## Export appearance

- [x] The simulation-extent row is omitted from the exported key.
- [x] The Simulation Extent control is absent from Layers; the municipal outline is permanently enabled.
- [x] The municipal outline is solid black on the live map and in generated GIFs.
- [x] Parcel boundaries are red on the live map and in a generated GIF with Parcels enabled.
- [x] The stray grey/green cap after the deepest legend color is gone; the scale ends cleanly in deep navy.
- [x] Deep-water areas no longer contain the grey/green GIF quantization dots.
- [x] The old palette-seed strip is absent from generated GIFs.
- [x] GIFs use one precomputed global palette, so the flood-depth key does not recolor between frames.
- [x] A four-frame 1920×1080 forecast GIF produced identical key pixel hashes in every frame, with zero changed key pixels.
- [x] Title and key sizing was visually checked in generated 16:9, 1:1, and 9:16 GIFs.
- [x] The title and key remain unclipped, separated, and readable in each aspect ratio.

## Regression checks

- [x] `python3 tools/test_return_intervals.py`
- [x] `node tools/test_north_wildwood_browser_contract.mjs`
- [x] `git diff --check`

## Sidebar follow-up

- [x] The Layers pane contains exactly four controls: Satellite, Road names, Buildings, and Parcels.
- [x] No Simulation Extent control or label remains anywhere in the interface.
- [x] The solid black municipal outline remains visible with no user setting that can disable it.
- [x] Desktop Layers controls render as a balanced 2×2 grid, and all right-rail cards share consistent widths, corners, spacing, and backgrounds.
- [x] The desktop control pane follows the logical order Flood Data → scenario → Overlay → Datum → Opacity → Interval → key.
- [x] The pane scrolls instead of clipping controls on shorter screens.
- [x] Forecast and modeled-flood layouts were visually checked at 1280×720.
- [x] Forecast and modeled-flood layouts were visually checked at 430×900, including the Layers, export, address, and tour sections.

## Water-depth popup follow-up

- [x] The water-depth popup X is anchored inside the upper-right corner of the card on desktop and phone layouts.
- [x] Forecast depth popups are titled exactly `Forecast Water Depth`.
- [x] Historical-tide depth popups are titled exactly `Water Depth`.
- [x] Modeled-storm depth popups remain clearly titled `Modeled Water Depth`.
- [x] The experimental pill and control text-size increases were reverted at the user's request.
- [x] Existing control, pill, tide-card, and action typography matches the pre-typography state.
- [x] The restored typography and retained popup fixes were visually checked at 1280×720 and 430×900.

## Visual samples inspected

- [x] 20-year storm, 16:9 GIF: title, key, black outline, clean depth colors, and red exported parcels.
- [x] 20-year storm, 1:1 GIF: title/key spacing and sizing.
- [x] 20-year storm, 9:16 GIF: portrait title/key sizing and spacing.
- [x] 10,000-year storm, 1:1 GIF: longest-label fit and separation from the key.
