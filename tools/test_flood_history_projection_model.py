#!/usr/bin/env python3
"""Executable contract checks for parcel flood-history projections."""

from __future__ import annotations

import math
import json
import tempfile
from pathlib import Path

import build_parcel_alerts as model


def synthetic_slr_payload() -> dict:
    rows = []
    multipliers = {
        "Low": 0.7,
        "Intermediate-Low": 0.9,
        "Intermediate": 1.2,
        "Intermediate-High": 1.6,
        "High": 2.1,
    }
    for scenario, multiplier in multipliers.items():
        for year in (2020, 2030, 2050, 2070, 2100):
            x = year - model.CURRENT_YEAR
            rows.append(
                {
                    "scenario": scenario,
                    "projectionYear": year,
                    "projectionRsl": (20.0 + multiplier * (0.12 * x + 0.003 * x * x)) * 30.48,
                }
            )
    return {"SlrProjections": rows}


assert len(model.ELEVATION_GRID_FT) == 201
assert model.ELEVATION_GRID_FT[0] == 0.0
assert model.ELEVATION_GRID_FT[-1] == 20.0
assert all(
    math.isclose(float(right - left), 0.1, abs_tol=1e-9)
    for left, right in zip(model.ELEVATION_GRID_FT, model.ELEVATION_GRID_FT[1:])
)

deltas, metadata = model.fit_quadratic_slr_deltas(synthetic_slr_payload(), 0.02)
assert list(deltas) == [
    "observedTrend",
    "low",
    "intermediateLow",
    "intermediate",
    "intermediateHigh",
    "high",
]
assert all(len(values) == len(model.YEARS) for values in deltas.values())
assert all(values[0] == 0.0 for values in deltas.values())
assert metadata["intermediate"]["type"] == "quadratic"
assert math.isclose(deltas["observedTrend"][-1], 1.48, abs_tol=1e-9)

historic_peaks = [1.0, 1.1, 1.1001, 1.2]
assert model.historic_flood_count(historic_peaks, 1.0) == 2
assert model.historic_flood_count([1.1], 1.0) == 0

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "survey.tif"
    dataset = model.gdal.GetDriverByName("GTiff").Create(str(path), 12, 12, 1, model.gdal.GDT_Float32)
    projection = model.osr.SpatialReference()
    projection.ImportFromEPSG(4326)
    dataset.SetProjection(projection.ExportToWkt())
    dataset.SetGeoTransform((-75.0, .001, 0, 39.0, 0, -.001))
    terrain = model.np.full((12, 12), -9999, dtype="float32")
    terrain[0, 0] = 8
    terrain[8, 8] = 13
    terrain[5, 9] = 11
    band = dataset.GetRasterBand(1)
    band.SetNoDataValue(-9999)
    band.WriteArray(terrain)
    band = dataset = None
    survey = model.DemSampler(path)
    assert survey.sample(-75.1, 38.9995) == (None, "unavailable")
    assert survey.sample(-74.9995, 38.9995) == (8.0, "centroid")
    assert survey.sample(-74.9945, 38.9945) == (11.0, "nearest-valid-cell-4")

peaks = [1.0, 2.0, 3.0, 4.0]
events = [
    {"year": 2024, "rebasedNavd88Ft": 1.0},
    {"year": 2024, "rebasedNavd88Ft": 2.0},
    {"year": 2025, "rebasedNavd88Ft": 3.0},
    {"year": 2025, "rebasedNavd88Ft": 4.0},
]
thresholds = model.np.asarray([[3.0, 2.5, 2.0]], dtype=float)
estimate, lower95, upper95, fit = model.fit_continuous_exceedance_cdf(
    peaks, events, [thresholds]
)
curve = estimate[0][0]
assert curve[0] < curve[1] < curve[2]
assert 0.3 < curve[0] < 0.5
assert lower95[0].shape == thresholds.shape
assert upper95[0].shape == thresholds.shape
assert fit["type"] == "continuous Gaussian-kernel CDF"
assert fit["bootstrapReplicates"] == model.KDE_BOOTSTRAP_REPLICATES

# Accepted water years, including nonadjacent years, are whole bootstrap blocks.
water_events = [dict(event, waterYear=2020 if i < 2 else 2022) for i, event in enumerate(events)]
_, _, _, water_fit = model.fit_continuous_exceedance_cdf(peaks, water_events, [thresholds])
assert water_fit["bootstrapBlockCount"] == 2
assert water_fit["uncertaintyMethod"].startswith("water-year")

# Refreshing analytics must update the same first-floor grid threshold used by
# the NSI join, together with the coverage dates and original ground count.
with tempfile.TemporaryDirectory() as directory:
    parcel_path = Path(directory) / "parcels.geojson"
    original = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {
                "elevationNavd88Ft": 5.98,
                "nsi2026ModeledFirstFloorNavd88Ft": 6.48,
                "nsi2026ModelElevationIndex": 99,
                "nsi2026HistoricFirstFloorExceedanceCount": 99,
            }},
            {"type": "Feature", "properties": {"elevationNavd88Ft": 2.0}},
            {"type": "Feature", "properties": {
                "elevationNavd88Ft": 10.0,
                "nsi2026ModeledFirstFloorNavd88Ft": 25.0,
                "nsi2026HistoricFirstFloorExceedanceCount": 99,
            }},
        ],
    }
    parcel_path.write_text(json.dumps(original))
    refreshed_cdf = {
        "observedArchive": {"startDate": "2020-01-01", "endDate": "2026-11-02"},
        "elevationGridFtNavd88": [0.0, 3.0, 6.4, 6.5, 20.0],
        "historicFloodEventCountByElevation": [4, 4, 2, 1, 0],
    }
    refresh_events = [{"navd88Ft": level} for level in [6.49, 6.51, 6.6, 6.7]]
    assert model.refresh_existing_parcel_counts(parcel_path, refresh_events, refreshed_cdf) == 3
    refreshed = json.loads(parcel_path.read_text())["features"]
    floor = refreshed[0]["properties"]
    assert floor["nsi2026HistoricFirstFloorExceedanceCount"] == 1
    assert floor["nsi2026ModelElevationIndex"] == 3
    assert floor["nsi2026ModelElevationNavd88Ft"] == 6.5
    assert floor["historicFloodEventCount"] == 4
    assert floor["historicStartDate"] == "2020-01-01"
    assert floor["historicEndDate"] == "2026-11-02"
    assert "nsi2026HistoricFirstFloorExceedanceCount" not in refreshed[1]["properties"]
    assert refreshed[1]["properties"]["historicFloodEventCount"] == 4
    high_floor = refreshed[2]["properties"]
    assert high_floor["nsi2026ModelElevationIndex"] == 4
    assert high_floor["nsi2026ModelElevationNavd88Ft"] == 20.0
    assert high_floor["nsi2026HistoricFirstFloorExceedanceCount"] == 0
    stable_bytes = parcel_path.read_bytes()
    model.refresh_existing_parcel_counts(parcel_path, refresh_events, refreshed_cdf)
    assert parcel_path.read_bytes() == stable_bytes
    # An incomplete replacement CDF must not overwrite a usable parcel file.
    incomplete_cdf = {**refreshed_cdf, "historicFloodEventCountByElevation": []}
    try:
        model.refresh_existing_parcel_counts(parcel_path, refresh_events, incomplete_cdf)
    except ValueError:
        pass
    else:
        raise AssertionError("Missing first-floor CDF counts must fail before writing parcels")
    assert parcel_path.read_bytes() == stable_bytes

print("North Wildwood flood-history projection model checks passed.")

# Fresh high-ground parcels use the current 20-ft grid, rather than the legacy
# 14-ft ceiling. Refreshes repair that ceiling without re-quantizing the original
# full-precision DEM sample from its rounded display value or altering NSI floors.
grid_cdf = {
    "elevationGridFtNavd88": model.ELEVATION_GRID_FT.tolist(),
    "observedArchive": {"startDate": "2007-10-01", "endDate": "2026-08-15"},
    "historicFloodEventCountByElevation": [0] * 201,
}
class HighGroundSampler:
    def sample_parcel_highest_five_foot_cell(self, geometry):
        return 16.83, "test-cell", -74.8, 39.0

fresh = model.build_parcel_geojson([{
    "type": "Feature", "properties": {"PROP_LOC": "High ground"},
    "geometry": {"type": "Polygon", "coordinates": [[
        [-74.8, 39.0], [-74.7999, 39.0], [-74.7999, 39.0001], [-74.8, 39.0]
    ]]},
}], HighGroundSampler(), [], grid_cdf)
assert fresh["features"][0]["properties"]["modelElevationIndex"] == 168
assert fresh["features"][0]["properties"]["modelElevationNavd88Ft"] == 16.8
with tempfile.TemporaryDirectory() as directory:
    parcel_path = Path(directory) / "parcels.geojson"
    rows = [
        {"elevationNavd88Ft": 16.83, "modelElevationNavd88Ft": 14.0, "modelElevationIndex": 140},
        {"elevationNavd88Ft": 7.05, "modelElevationNavd88Ft": 7.1, "modelElevationIndex": 71},
        {"elevationNavd88Ft": 21.04, "modelElevationNavd88Ft": 14.0, "modelElevationIndex": 140,
         "nsi2026ModeledFirstFloorNavd88Ft": 7.35},
        {"elevationNavd88Ft": 14.06, "modelElevationNavd88Ft": 14.0, "modelElevationIndex": 140},
        {"elevationNavd88Ft": 14.10, "modelElevationNavd88Ft": 14.0, "modelElevationIndex": 140},
        {"elevationNavd88Ft": 14.05, "modelElevationNavd88Ft": 14.0, "modelElevationIndex": 140},
    ]
    parcel_path.write_text(json.dumps({"features": [{"properties": row} for row in rows]}))
    model.refresh_existing_parcel_counts(parcel_path, [], grid_cdf)
    result = [row["properties"] for row in json.loads(parcel_path.read_text())["features"]]
    assert result[0]["modelElevationIndex"] == 168
    assert result[1]["modelElevationIndex"] == 71
    assert result[2]["modelElevationIndex"] == 200
    assert result[2]["nsi2026ModelElevationIndex"] == model.model_elevation_record(7.35, grid_cdf)[1]
    assert result[3]["modelElevationIndex"] == 141
    assert result[4]["modelElevationIndex"] == 141
    assert result[5]["modelElevationIndex"] == 140, "Rounded display ties must retain the original full-precision threshold"
    stable = parcel_path.read_bytes()
    model.refresh_existing_parcel_counts(parcel_path, [], grid_cdf)
    assert parcel_path.read_bytes() == stable
print("High-ground grid construction, legacy refresh, sampled ties and NSI priority passed.")

# Verify the committed migration, including every scenario, confidence band and
# forecast year. The current high-ground tails are identical; the sixth parcel
# still uses its NSI floor rather than its higher ground for the visible profile.
asset_root = Path(__file__).resolve().parents[1] / "assets" / "parcel-history-v2"
committed_cdf = json.loads((asset_root / "NorthWildwoodHouseAlertCDF.json").read_text())
committed_parcels = json.loads((asset_root / "NorthWildwoodParcels.geojson").read_text())
parcels_by_id = {feature["properties"]["parcelId"]: feature["properties"] for feature in committed_parcels["features"]}
corrected_ground_indices = {
    "0507_12_1": 168,
    "0507_315.02_1": 150,
    "0507_317.02_2": 173,
    "0507_316.02_1": 192,
    "0507_289.03_1": 150,
    "0507_317.03_1.02": 200,
}
assert len(committed_cdf["annualFloodEventCount"]) == 6
for parcel_id, ground_index in corrected_ground_indices.items():
    properties = parcels_by_id[parcel_id]
    assert properties["modelElevationIndex"] == ground_index
    assert properties["modelElevationNavd88Ft"] == committed_cdf["elevationGridFtNavd88"][ground_index]
    selected_index = properties.get("nsi2026ModelElevationIndex", ground_index)
    previous_selected_index = properties.get("nsi2026ModelElevationIndex", 140)
    if parcel_id == "0507_317.03_1.02":
        assert selected_index == 73, "The occupied-floor threshold keeps priority over parcel ground"
    else:
        assert selected_index == ground_index
    for scenario, record in committed_cdf["annualFloodEventCount"].items():
        for band in ("estimate", "lower95", "upper95"):
            actual = record[band][selected_index]
            assert len(actual) == len(committed_cdf["years"])
            assert actual == record[band][previous_selected_index], (parcel_id, scenario, band)
print("All six committed high-ground metadata repairs preserve every current numeric projection and NSI priority.")
