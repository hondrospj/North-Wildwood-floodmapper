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
- [x] Simulation extent remains on by default so the municipal outline is present.
- [x] The municipal outline is solid black on the live map and in generated GIFs.
- [x] Parcel boundaries are red on the live map and in a generated GIF with Parcels enabled.
- [x] The stray grey/green cap after the deepest legend color is gone; the scale ends cleanly in deep navy.
- [x] Deep-water areas no longer contain the grey/green GIF quantization dots.
- [x] The old palette-seed strip is absent from generated GIFs.
- [x] Title and key sizing was visually checked in generated 16:9, 1:1, and 9:16 GIFs.
- [x] The title and key remain unclipped, separated, and readable in each aspect ratio.

## Regression checks

- [x] `python3 tools/test_return_intervals.py`
- [x] `node tools/test_north_wildwood_browser_contract.mjs`
- [x] `git diff --check`

## Visual samples inspected

- [x] 20-year storm, 16:9 GIF: title, key, black outline, clean depth colors, and red exported parcels.
- [x] 20-year storm, 1:1 GIF: title/key spacing and sizing.
- [x] 20-year storm, 9:16 GIF: portrait title/key sizing and spacing.
- [x] 10,000-year storm, 1:1 GIF: longest-label fit and separation from the key.
