#!/usr/bin/env python3
"""Build North Wildwood MOD-IV parcel centroids and flood-frequency analytics."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image
from scipy import ndimage
from scipy.signal import find_peaks


gdal.UseExceptions()

CURRENT_YEAR = 2026
PARCEL_SERVICE = "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query"
PARCEL_WHERE = "PCL_MUN = '0507'"
PARCEL_FIELDS = [
    "OBJECTID",
    "PAMS_PIN",
    "PCLBLOCK",
    "PCLLOT",
    "PCLQCODE",
    "PROP_LOC",
    "PROP_CLASS",
    "BLDG_DESC",
    "LAND_DESC",
    "CALC_ACRE",
    "YR_CONSTR",
]
NOAA_SLR_URL = (
    "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/"
    "slr_projections.json?units=metric&station=8536110&report_year=2022"
)
NOAA_TREND_URL = (
    "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/"
    "sealvltrends.json?station=8536110&units=english"
)
SCENARIO_NAMES = {"low": "Low", "intermediate": "Intermediate", "high": "High"}
ELEVATION_GRID_FT = np.round(np.arange(0.0, 14.0 + 0.025, 0.05), 2)
YEARS = list(range(CURRENT_YEAR, 2101))
EXPECTED_HIGH_TIDES_PER_YEAR = 705.0
PARCEL_BOUNDARY_RASTER_SCALE = 0.5


def fetch_json(url: str, params: dict | None = None) -> dict:
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": "North-Wildwood-floodmapper-2.0/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_parcels() -> list[dict]:
    features: list[dict] = []
    offset = 0
    page_size = 1000
    while True:
        payload = fetch_json(
            PARCEL_SERVICE,
            {
                "f": "geojson",
                "where": PARCEL_WHERE,
                "outFields": ",".join(PARCEL_FIELDS),
                "returnGeometry": "true",
                "outSR": "4326",
                "orderByFields": "OBJECTID",
                "resultOffset": offset,
                "resultRecordCount": page_size,
                "geometryPrecision": 7,
            },
        )
        batch = payload.get("features", [])
        if not batch:
            if payload.get("error"):
                raise RuntimeError(payload["error"])
            break
        features.extend(batch)
        print(f"Downloaded {len(features):,} parcel features")
        if len(batch) < page_size:
            break
        offset += len(batch)
    return features


def decode_observed_archive(path: Path) -> tuple[list[int], list[float], dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    times: list[int] = []
    levels: list[float] = []
    for day in payload.get("days", []):
        start = int(day["u"])
        for index, encoded in enumerate(day.get("v", [])):
            if encoded is None:
                continue
            times.append(start + index * 900)
            levels.append(float(encoded) / 100.0)
    order = np.argsort(np.asarray(times, dtype=np.int64))
    return [times[i] for i in order], [levels[i] for i in order], payload


def split_contiguous(times: list[int], levels: list[float]) -> list[tuple[np.ndarray, np.ndarray]]:
    if not times:
        return []
    segments = []
    start = 0
    for index in range(1, len(times)):
        if times[index] - times[index - 1] > 30 * 60:
            if index - start >= 12:
                segments.append((np.asarray(times[start:index], dtype=np.int64), np.asarray(levels[start:index], dtype=np.float32)))
            start = index
    if len(times) - start >= 12:
        segments.append((np.asarray(times[start:], dtype=np.int64), np.asarray(levels[start:], dtype=np.float32)))
    return segments


def extract_high_tide_events(times: list[int], levels: list[float], annual_trend_ft: float) -> tuple[list[dict], list[float]]:
    events: list[dict] = []
    rebased_peaks: list[float] = []
    for segment_times, segment_levels in split_contiguous(times, levels):
        peak_indices, _ = find_peaks(segment_levels, distance=24, prominence=0.20)
        for index in peak_indices:
            stamp = int(segment_times[index])
            level = float(segment_levels[index])
            year = datetime.fromtimestamp(stamp, timezone.utc).year
            rebased = level + annual_trend_ft * (CURRENT_YEAR - year)
            events.append({"timeUtc": datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z"), "year": year, "navd88Ft": round(level, 3)})
            rebased_peaks.append(rebased)
    events.sort(key=lambda row: row["timeUtc"])
    rebased_peaks.sort()
    return events, rebased_peaks


def interpolate_year_value(rows_by_year: dict[int, float], year: int) -> float:
    known_years = sorted(rows_by_year)
    if year <= known_years[0]:
        return rows_by_year[known_years[0]]
    if year >= known_years[-1]:
        return rows_by_year[known_years[-1]]
    right_index = bisect.bisect_right(known_years, year)
    left_year = known_years[right_index - 1]
    right_year = known_years[right_index]
    ratio = (year - left_year) / (right_year - left_year)
    return rows_by_year[left_year] + (rows_by_year[right_year] - rows_by_year[left_year]) * ratio


def build_slr_deltas(noaa_payload: dict) -> dict[str, list[float]]:
    rows = noaa_payload.get("SlrProjections", [])
    output: dict[str, list[float]] = {}
    for key, noaa_name in SCENARIO_NAMES.items():
        by_year = {
            int(row["projectionYear"]): float(row["projectionRsl"]) / 30.48
            for row in rows
            if row.get("scenario") == noaa_name
        }
        current_baseline = interpolate_year_value(by_year, CURRENT_YEAR)
        output[key] = [round(interpolate_year_value(by_year, year) - current_baseline, 4) for year in YEARS]
    return output


def annual_exceedance_count(sorted_peaks: list[float], elevation_ft: float, slr_delta_ft: float, tides_per_year: float) -> float:
    threshold = elevation_ft - slr_delta_ft
    index = bisect.bisect_left(sorted_peaks, threshold)
    probability = (len(sorted_peaks) - index) / len(sorted_peaks) if sorted_peaks else 0.0
    return min(tides_per_year, max(0.0, probability * tides_per_year))


def build_cdf_payload(
    observed_payload: dict,
    events: list[dict],
    rebased_peaks: list[float],
    annual_trend_ft: float,
    slr_payload: dict,
) -> dict:
    years_with_data = sorted({row["year"] for row in events})
    if len(events) >= 2:
        first_event = datetime.fromisoformat(events[0]["timeUtc"].replace("Z", "+00:00"))
        last_event = datetime.fromisoformat(events[-1]["timeUtc"].replace("Z", "+00:00"))
        observed_duration_years = max(1.0, (last_event - first_event).total_seconds() / (365.2425 * 86400))
    else:
        observed_duration_years = 1.0
    detected_tides_per_year = len(events) / observed_duration_years
    tides_per_year = EXPECTED_HIGH_TIDES_PER_YEAR
    slr_deltas = build_slr_deltas(slr_payload)
    annual_counts: dict[str, list[list[float]]] = {}
    cumulative_counts: dict[str, list[float]] = {}
    for scenario, deltas in slr_deltas.items():
        scenario_rows = []
        scenario_cumulative = []
        for elevation in ELEVATION_GRID_FT:
            counts = [round(annual_exceedance_count(rebased_peaks, float(elevation), delta, tides_per_year), 2) for delta in deltas]
            scenario_rows.append(counts)
            scenario_cumulative.append(round(sum(counts), 1))
        annual_counts[scenario] = scenario_rows
        cumulative_counts[scenario] = scenario_cumulative

    historical_counts = [sum(1 for row in events if row["navd88Ft"] >= float(elevation)) for elevation in ELEVATION_GRID_FT]
    return {
        "schema": "north-wildwood-house-alert-cdf-v1",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "currentYear": CURRENT_YEAR,
        "site": {"name": "Great Channel at Stone Harbor", "usgsId": "01411360", "noaaScenarioStationId": "8536110", "noaaScenarioStationName": "Cape May"},
        "sources": {
            "observed": "USGS NWIS parameter 72279, regularized to 15-minute anchors",
            "seaLevelScenarios": "NOAA CO-OPS 2022 Interagency Sea Level Report station projections",
            "scenarioReportYear": 2022,
        },
        "observedArchive": {"startDate": observed_payload.get("archiveStartDate"), "endDate": observed_payload.get("archiveEndDate")},
        "method": {
            "historic": "independent high-tide peaks separated by at least six hours; parcel floods when peak NAVD88 level is at or above centroid elevation",
            "baselineRebase": f"each observed peak adjusted to {CURRENT_YEAR} using Cape May relative sea-level trend",
            "cdf": "empirical CDF of present-year-rebased independent high-tide peaks",
            "future": "empirical exceedance probability multiplied by 705 expected astronomical high tides per year after annual interpolation of rebased NOAA scenario offsets",
        },
        "annualRelativeSeaLevelTrendFt": round(annual_trend_ft, 6),
        "highTidePeakCount": len(events),
        "calendarYearCount": len(years_with_data),
        "observedDurationYears": round(observed_duration_years, 3),
        "detectedIndependentTidesPerObservedYear": round(detected_tides_per_year, 3),
        "independentTidesPerYear": tides_per_year,
        "elevationGridFtNavd88": ELEVATION_GRID_FT.tolist(),
        "years": YEARS,
        "scenarioSlrDeltaFtFrom2026": slr_deltas,
        "historicFloodEventCountByElevation": historical_counts,
        "annualFloodEventCount": annual_counts,
        "cumulativeFloodEventCount2026Through2100": cumulative_counts,
    }


class DemSampler:
    def __init__(self, path: Path):
        self.ds = gdal.Open(str(path), gdal.GA_ReadOnly)
        if self.ds is None:
            raise RuntimeError(f"Could not open DEM {path}")
        self.band = self.ds.GetRasterBand(1)
        self.nodata = self.band.GetNoDataValue()
        self.inv = gdal.InvGeoTransform(self.ds.GetGeoTransform())
        source_srs = osr.SpatialReference()
        source_srs.SetFromUserInput("EPSG:4326")
        target_srs = osr.SpatialReference()
        target_srs.ImportFromWkt(self.ds.GetProjection())
        source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        self.transform = osr.CoordinateTransformation(source_srs, target_srs)

    def sample(self, lon: float, lat: float) -> tuple[float | None, str]:
        x, y, _ = self.transform.TransformPoint(lon, lat)
        pixel_x, pixel_y = gdal.ApplyGeoTransform(self.inv, x, y)
        col, row = int(math.floor(pixel_x)), int(math.floor(pixel_y))
        for radius in range(0, 11):
            xoff = max(0, col - radius)
            yoff = max(0, row - radius)
            xsize = min(self.ds.RasterXSize - xoff, radius * 2 + 1)
            ysize = min(self.ds.RasterYSize - yoff, radius * 2 + 1)
            if xsize <= 0 or ysize <= 0:
                continue
            data = self.band.ReadAsArray(xoff, yoff, xsize, ysize)
            valid = np.isfinite(data)
            if self.nodata is not None:
                valid &= data != self.nodata
            if not np.any(valid):
                continue
            if radius == 0:
                return float(data[0, 0]), "centroid"
            rows, cols = np.where(valid)
            distances = (rows + yoff - row) ** 2 + (cols + xoff - col) ** 2
            best = int(np.argmin(distances))
            return float(data[rows[best], cols[best]]), f"nearest-valid-cell-{radius}"
        return None, "unavailable"


def sanitize(value):
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def write_world_file(path: Path, geo_transform: tuple[float, ...]) -> None:
    origin_x, pixel_w, rot_x, origin_y, rot_y, pixel_h = geo_transform
    center_x = origin_x + pixel_w / 2 + rot_x / 2
    center_y = origin_y + rot_y / 2 + pixel_h / 2
    path.write_text(
        "\n".join(f"{value:.12f}" for value in (pixel_w, rot_y, rot_x, pixel_h, center_x, center_y)) + "\n",
        encoding="utf-8",
    )


def build_parcel_boundary_png(features: list[dict], dem_path: Path, destination: Path) -> None:
    dem_ds = gdal.Open(str(dem_path), gdal.GA_ReadOnly)
    if dem_ds is None:
        raise RuntimeError(f"Could not open DEM {dem_path}")
    source_width, source_height = dem_ds.RasterXSize, dem_ds.RasterYSize
    width = max(1, int(round(source_width * PARCEL_BOUNDARY_RASTER_SCALE)))
    height = max(1, int(round(source_height * PARCEL_BOUNDARY_RASTER_SCALE)))
    source_geo_transform = dem_ds.GetGeoTransform()
    scale_x = source_width / width
    scale_y = source_height / height
    geo_transform = (
        source_geo_transform[0],
        source_geo_transform[1] * scale_x,
        source_geo_transform[2] * scale_y,
        source_geo_transform[3],
        source_geo_transform[4] * scale_x,
        source_geo_transform[5] * scale_y,
    )
    projection = dem_ds.GetProjection()

    source_srs = osr.SpatialReference()
    source_srs.SetFromUserInput("EPSG:4326")
    target_srs = osr.SpatialReference()
    target_srs.ImportFromWkt(projection)
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    coordinate_transform = osr.CoordinateTransformation(source_srs, target_srs)

    vector_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
    boundary_layer = vector_ds.CreateLayer("parcel_boundaries", srs=target_srs, geom_type=ogr.wkbMultiLineString)
    layer_definition = boundary_layer.GetLayerDefn()
    for index, source_feature in enumerate(features, start=1):
        geometry_json = source_feature.get("geometry")
        geometry = ogr.CreateGeometryFromJson(json.dumps(geometry_json)) if geometry_json else None
        if geometry is None or geometry.IsEmpty():
            continue
        geometry.Transform(coordinate_transform)
        boundary = geometry.Boundary()
        if boundary is None or boundary.IsEmpty():
            continue
        output_feature = ogr.Feature(layer_definition)
        output_feature.SetGeometry(boundary)
        boundary_layer.CreateFeature(output_feature)
        output_feature = None
        if index % 1000 == 0:
            print(f"Raster boundary preparation {index:,}/{len(features):,}")

    mask_ds = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Byte)
    mask_ds.SetProjection(projection)
    mask_ds.SetGeoTransform(geo_transform)
    mask_ds.GetRasterBand(1).Fill(0)
    result = gdal.RasterizeLayer(mask_ds, [1], boundary_layer, burn_values=[255], options=["ALL_TOUCHED=TRUE"])
    if result != 0:
        raise RuntimeError("Could not rasterize parcel boundaries")
    mask = mask_ds.GetRasterBand(1).ReadAsArray() > 0
    line_mask = mask
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[line_mask] = (255, 190, 64, 175)
    destination.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(destination, optimize=True)
    write_world_file(destination.with_suffix(".pgw"), geo_transform)
    mask_ds = None
    vector_ds = None
    dem_ds = None


def build_parcel_geojson(features: list[dict], sampler: DemSampler, events: list[dict], cdf: dict) -> dict:
    peak_levels = sorted(float(row["navd88Ft"]) for row in events)
    elevation_grid = cdf["elevationGridFtNavd88"]
    output_features = []
    skipped = 0
    for index, feature in enumerate(features, start=1):
        geometry_json = feature.get("geometry")
        geometry = ogr.CreateGeometryFromJson(json.dumps(geometry_json)) if geometry_json else None
        if geometry is None or geometry.IsEmpty():
            skipped += 1
            continue
        centroid = geometry.Centroid()
        lon, lat = centroid.GetX(), centroid.GetY()
        elevation, sample_method = sampler.sample(lon, lat)
        if elevation is None:
            skipped += 1
            continue
        historic_count = len(peak_levels) - bisect.bisect_left(peak_levels, elevation)
        model_elevation = min(14.0, max(0.0, round(elevation * 10) / 10))
        grid_index = min(range(len(elevation_grid)), key=lambda i: abs(elevation_grid[i] - model_elevation))
        attrs = feature.get("properties", {})
        simplified = geometry.SimplifyPreserveTopology(0.0000015)
        output_features.append(
            {
                "type": "Feature",
                "id": attrs.get("OBJECTID") or index,
                "properties": {
                    "parcelId": sanitize(attrs.get("PAMS_PIN")),
                    "address": sanitize(attrs.get("PROP_LOC")),
                    "block": sanitize(attrs.get("PCLBLOCK")),
                    "lot": sanitize(attrs.get("PCLLOT")),
                    "qualifier": sanitize(attrs.get("PCLQCODE")),
                    "propertyClass": sanitize(attrs.get("PROP_CLASS")),
                    "buildingDescription": sanitize(attrs.get("BLDG_DESC")),
                    "landDescription": sanitize(attrs.get("LAND_DESC")),
                    "acres": sanitize(attrs.get("CALC_ACRE")),
                    "yearBuilt": sanitize(attrs.get("YR_CONSTR")),
                    "centroidLon": round(lon, 7),
                    "centroidLat": round(lat, 7),
                    "elevationNavd88Ft": round(elevation, 2),
                    "modelElevationNavd88Ft": elevation_grid[grid_index],
                    "modelElevationIndex": grid_index,
                    "elevationSampleMethod": sample_method,
                    "historicFloodEventCount": historic_count,
                    "historicStartDate": cdf["observedArchive"]["startDate"],
                    "historicEndDate": cdf["observedArchive"]["endDate"],
                },
                "geometry": json.loads(simplified.ExportToJson()),
            }
        )
        if index % 500 == 0:
            print(f"Processed {index:,}/{len(features):,} parcels")
    return {
        "type": "FeatureCollection",
        "name": "North Wildwood MOD-IV parcels with centroid flood alerts",
        "metadata": {
            "source": "NJGIN Parcels and MOD-IV Composite of New Jersey",
            "municipalityCode": "0507",
            "centroidRule": "geometric polygon centroid",
            "elevationDatum": "NAVD88 feet",
            "parcelCount": len(output_features),
            "skippedParcelCount": skipped,
            "cdfFile": "NorthWildwoodHouseAlertCDF.json",
        },
        "features": output_features,
    }


def cape_may_trend_ft_per_year(payload: dict) -> float:
    rows = payload.get("SeaLvlTrends", [])
    if not rows:
        raise RuntimeError("NOAA Cape May trend response had no rows")
    inches_per_decade = float(rows[0]["trend"])
    return inches_per_decade / 12.0 / 10.0


def build(args: argparse.Namespace) -> dict:
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    observed_times, observed_levels, observed_payload = decode_observed_archive(args.observed.resolve())
    trend_payload = fetch_json(NOAA_TREND_URL)
    slr_payload = fetch_json(NOAA_SLR_URL)
    annual_trend_ft = cape_may_trend_ft_per_year(trend_payload)
    events, rebased_peaks = extract_high_tide_events(observed_times, observed_levels, annual_trend_ft)
    if not rebased_peaks:
        raise RuntimeError("No independent high-tide events could be extracted")
    cdf = build_cdf_payload(observed_payload, events, rebased_peaks, annual_trend_ft, slr_payload)
    cdf_path = output_dir / "NorthWildwoodHouseAlertCDF.json"
    cdf_path.write_text(json.dumps(cdf, separators=(",", ":")) + "\n", encoding="utf-8")

    parcels = fetch_parcels()
    sampler = DemSampler(args.dem.resolve())
    parcel_geojson = build_parcel_geojson(parcels, sampler, events, cdf)
    parcel_path = output_dir / "NorthWildwoodParcels.geojson"
    parcel_path.write_text(json.dumps(parcel_geojson, separators=(",", ":")) + "\n", encoding="utf-8")
    parcel_boundary_path = output_dir / "NorthWildwoodParcelBoundaries.png"
    build_parcel_boundary_png(parcels, args.dem.resolve(), parcel_boundary_path)

    summary = {
        "parcelCount": len(parcel_geojson["features"]),
        "skippedParcelCount": parcel_geojson["metadata"]["skippedParcelCount"],
        "highTidePeakCount": cdf["highTidePeakCount"],
        "independentTidesPerYear": cdf["independentTidesPerYear"],
        "historicStartDate": cdf["observedArchive"]["startDate"],
        "historicEndDate": cdf["observedArchive"]["endDate"],
        "cdfBytes": cdf_path.stat().st_size,
        "parcelGeoJsonBytes": parcel_path.stat().st_size,
        "parcelBoundaryPngBytes": parcel_boundary_path.stat().st_size,
    }
    (output_dir / "NorthWildwoodParcelAlertManifest.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--observed", type=Path, default=Path("observed15min.json"))
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(build(parse_args()), indent=2))
