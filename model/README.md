# North Wildwood nonlinear shallow-water forecast

The forecast path now runs a new two-dimensional hydrodynamic simulation for
every PETSS cycle. It no longer selects a city-wide answer from a stage and
phase lookup. Historical observations and synthetic return-interval storms
continue to use the bundled v19 response atlas until event-specific boundary
curves are defined and validated for them.

## Why this architecture

A connectivity or bathtub map answers whether low terrain could connect to a
water level at equilibrium. It cannot answer when water arrives, how much can
pass through a constriction during a short tide, whether momentum carries a
front, or how much water remains as the boundary falls. Those omissions caused
the reported failure in which one newly connected cell could promote a large
part of North Wildwood immediately.

ANUGA solves the conservative depth-averaged nonlinear shallow-water
(Saint-Venant) equations with finite volumes, wetting/drying, bed slope,
advection, both horizontal momentum equations, and semi-implicit Manning
friction. This is the appropriate step up from the v19 storage-and-weir atlas:

- [ANUGA mathematical model](https://anuga.readthedocs.io/en/latest/mathematical_background.html)
- [ANUGA analytical and experimental validation suite](https://anuga.readthedocs.io/en/stable/reference/validation.html)
- [Gallien et al. on short-duration urban coastal flooding](https://doi.org/10.1016/j.coastaleng.2014.04.007)
- [USGS New Jersey coastal mapping with calibrated ADCIRC-SWAN](https://pubs.usgs.gov/publication/sir20235005/full)
- [HEC-RAS 2D hydraulic reference](https://www.hec.usace.army.mil/software/hec-ras/documentation/HEC-RAS_6.0_Reference_Manual.pdf)

The decision is not that ANUGA is uniquely capable. HEC-RAS 2D, SFINCS, or
another validated shallow-water code could implement the same physical
contract. ANUGA was selected because it is open, scriptable, benchmarked, and
already used by the peer Stone Harbor prototype in this floodmapper family.

## Physics contract

The operational configuration is `model/config/north_wildwood.json`:

- 20 m rectangular-cross mesh (205,000 finite-volume triangles);
- 5 m continuous terrain/bathymetry in EPSG:6347, metres NAVD88;
- exact 15-minute output from an 84-hour PETSS boundary history;
- mean, low-end, and high-end scenario runs;
- Flather characteristic boundary only on perimeter edges with bed at or
  below -1.0 m NAVD88; all other perimeter edges are reflective;
- below-stage initial water only in components touching a qualified open-ocean
  edge—low land touching a map edge is not an ocean source;
- explicit 7.5 ft NAVD88 bulkhead crest, burned into the 5 m terrain and
  conservatively buffered by half a mesh-cell diagonal so centroid sampling
  cannot make the narrow wall disappear;
- elevation-proxy Manning values: 0.025 open water, 0.035 intertidal, 0.055
  developed lowlands, and 0.045 high ground.

The 20 m production benchmark advances the wet front in finite 15-minute
increments and produces identical maxima on one and eight OpenMP threads. The
8-thread run is the operational setting.

## Terrain provenance

`prepare_terrain.py` creates one gap-free NAVD88 surface from:

1. the conditioned local one-foot North Wildwood DEM for terrestrial grading;
2. the supplied North Wildwood bulkhead mask;
3. NOAA's 2020 USACE/USGS Cape May and Atlantic City topobathymetric DEM;
4. NOAA's Southern New Jersey seamless DEM as the datum-consistent fallback;
5. an -8 m offshore bed only where the seamless source uses its ocean
   placeholder.

The local source rasters are deliberately excluded from Git. Their SHA-256
hashes, the selected NOAA tiles, per-source cell counts, vertical conversion,
coverage, and output hashes are written to
`model/cache/terrain_manifest.json`. Terrain preparation fails below 99%
authoritative coverage rather than converting gaps into artificial water.

## Products and browser contract

Each scenario writes:

- `depth/*.png`: exact time-step depth overlays;
- `impact/*.png`: the flood-impact band at which each currently wet cell first
  became hydraulically connected;
- `query/*.png`: 16-bit depth millimetres plus a wet flag for click queries;
- `daily-max/*.png`: cellwise maxima over every 15-minute frame in the local
  calendar day.

The one-hour dashboard view uses exact hourly source points from the same run.
Daily mode uses the true cellwise daily maximum. A published pointer names all
three scenario manifests and is promoted only after their assets, hashes,
CORS, query encodings, visible masks, and daily maxima pass validation. Until
that pointer exists, the browser falls back to v19.

## Run

Create the reproducible environment:

```bash
conda env create --prefix ./.anuga-env --file model/environment.yml
```

Run and validate locally without publication:

```bash
.anuga-env/bin/python -u model/src/run_pipeline.py --no-publish
```

Publish a validated cycle atomically:

```bash
.anuga-env/bin/python -u model/src/run_pipeline.py --setup-key
```

The publisher reads `BUNNY_STORAGE_PASSWORD` or the macOS Keychain service
`shorelysafe.bunny.storage.floodmapperv1`. The `.png` suffix on JSON transport
aliases is intentional because the current Bunny pull zone applies CORS by
extension. `install_launchd.py` can poll for new PETSS cycles while preventing
overlapping runs with an advisory lock.

## Limits and calibration gate

This is a major physical upgrade, not a claim of property-scale certainty. V1
does not yet model storm sewers, culverts, rainfall, building obstructions,
spatial wind stress, wave radiation stress, breach mechanics, or morphology.
The 5 m images are terrain-aware renders of 20 m hydraulics, not 5 m momentum
solutions. PETSS total water level supplies tide and surge and may include some
wave setup, but it is not local wave-current forcing.

Before emergency-decision or engineering use, calibrate Manning roughness and
drainage connections against multiple observed floods, then validate arrival
time, extent, depth, and recession against independent high-water marks or a
trusted ADCIRC/SWAN/SFINCS benchmark. The products are not FEMA insurance
maps, surveys, or guarantees that a property will flood.
