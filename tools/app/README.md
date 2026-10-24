# North Wildwood application sources

`index.template.html` owns the unchanged HTML controls and layout. The manifest
records each original inline block, its attributes and its source files.

Edit the source files here, then run:

```sh
node tools/build_north_wildwood_app.mjs
node tools/build_north_wildwood_app.mjs --check
node tools/test_north_wildwood_refactor_parity.mjs
```

Styles retain their original cascade order and compile into five bundles,
separated wherever an existing external stylesheet or script intervened. No
selectors, declarations, breakpoints or override precedence were changed by the
extraction. Individual style sources remain separate so future changes can be
reviewed against the original behavior.

The 29 runtime domain files compile into one classic script. They share the
original lexical scope intentionally: splitting them into independently executed
scripts would change hoisting and microtask timing. Other presentation and
integration controllers keep their original execution positions and attributes.
Generated browser assets live in `assets/app` and `assets/styles`; the publisher
already excludes `tools`, so authoring sources are not uploaded.

Source-level regression tests use `tools/app_source.mjs` to reconstruct an
inline document from the built files. The independent parity test
checks pinned baseline hashes and every output, while browser tests exercise the
real external-script and stylesheet loading path. Never edit generated files or
relax the parity fixture to conceal a behavior change.

The sole audited JavaScript exception is month-label idempotence in
`runtime/22-calendar-and-modes.js`: an unchanged month label keeps its existing
Text node so an asynchronous archive refresh cannot invalidate WebKit's held
mouse click. The visible text, CSS and HTML remain unchanged. The parity checker
requires the exact fixed snippet once in `script-004` and its authoring source,
then reverses that one snippet only while verifying the original script and
whole-document hashes. The original baseline fixture is preserved. Generated
outputs and syntax are still checked against the actual fixed code. Running the
parity test with `--self-test` also proves that removing the guard, changing
adjacent code or duplicating the exception is rejected.

The external export preview also defers its final canvas/ready update until an
active pointer gesture has finished. This prevents its existing loading caption
from moving the format controls under a held pointer. Its CSS, markup, labels
and final layout are unchanged: the three UI-producing functions are separately
pinned to upstream `cd99390` in `north-wildwood-export-preview-ui.json`. The only
HTML dependency change is that controller's cache version. The parity check
reverses that exact cache key for the original whole-document hash and rejects
preview CSS/markup changes. A real-browser test completes an actual capture
during a held gesture; unit cases cover cancellation, closure and download
handoff so waiting previews cannot deadlock the exporter.

The municipal boundary is seeded synchronously from the exact committed
`Boundaries/North Wildwood.geojson` before map construction. Startup reuses that
geometry without a second network request or late outline replacement. The
initial camera retains its configured extent independently of boundary loading,
including on narrow screens. If no
valid polygon is available, the map shows neither a fabricated rectangular town
outline nor a world-only gray mask, and its boundary request can be retried.
`test_north_wildwood_boundary_startup.mjs` exercises those startup and recovery
cases. The separately pinned boundary-startup audit reverses only the eight named
functions, new seed helper and exact geometry assignment for original source
parity; the original refactor fixture, UI, CSS and scientific behavior remain
unchanged.
