# Export street-name readability

The enlarged reference tiles used a lower source zoom, which omitted most local
street names. Increasing their contrast could not restore those missing names.

PNG and GIF exports now draw town street names from the existing 603 municipal
NJOGIS centerline features, in the mapper's shared font family. Dark semibold
lettering has a white outline above the flood overlay. The renderer joins
connected segments with the same name, keeps text upright on sufficiently
straight visible stretches, and rejects overlapping or clipped labels.

Text size scales with output resolution. Main streets take priority; when space
is limited, their minimum size is 13 pixels per 1080 output pixels. A final
fallback may omit only the trailing “Ave”, retaining direction and the full
source name internally. Wider views deliberately show fewer names.

The initial fractional positions remain the first choice. Missing main-street
names also search road vertices and a bounded grid of positions. This covers
wider system fonts while preserving the same size, straightness, collision and
image-boundary requirements.

Reference tiles remain outside town; the municipal polygon masks their interior
to avoid duplicate labels. Road names OFF hides both sources. Local geometry
loads only when an export needs it, with a 15-second header/body deadline,
retry after failure, and cancellation of the export's wait. The renderer shares
the existing roads pane across preview, PNG, and the GIF compositor.

Fast GIF capture also updates label visibility after fitting the chosen area,
so a camera change across the label zoom threshold uses the new zoom.

Changing the export layout retains a completed flood image when its source,
map owner, rendering mode and geometry still match. This avoids another image
load for the same frame. Changed sources or grids continue to use the existing
20-second image deadline and cancellation checks.

Validation includes ten geometry/loading test groups, exact source parity and
negative mutation cases, all four PNG/GIF aspect ratios in actual browsers,
downloaded image glyph checks, a two-frame GIF, Road names OFF/ON, current-view
cropping, local-data outage recovery, and the existing reference-tile retry test.
Recovery fixtures also check ready-image identity, changed grids, cancellation,
and deadlines. A controlled browser case holds a redundant image load to verify
that layout changes can retain the already completed image.
Hosted release checks continue to gate production publication.

Commands:

```sh
node tools/build_north_wildwood_app.mjs --check
node tools/test_north_wildwood_refactor_parity.mjs --self-test
node tools/test_north_wildwood_export_road_labels.mjs
node tools/test_north_wildwood_export_road_labels_browser.mjs
```
