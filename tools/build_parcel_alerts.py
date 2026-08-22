#!/usr/bin/env python3
"""Build North Wildwood parcel flood-history and projection analytics."""

from __future__ import annotations

import argparse
import bisect
import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image
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
NOAA_SCENARIO_NAMES = {
    "low": "Low",
    "intermediateLow": "Intermediate-Low",
    "intermediate": "Intermediate",
    "intermediateHigh": "Intermediate-High",
    "high": "High",
}
SCENARIO_LABELS = {
    "observedTrend": "Observed trend",
    "low": "Low",
    "intermediateLow": "Intermediate Low",
    "intermediate": "Intermediate",
    "intermediateHigh": "Intermediate High",
    "high": "High",
}
ELEVATION_GRID_FT = np.round(np.arange(0.0, 20.0 + 0.05, 0.1), 1)
YEARS = list(range(CURRENT_YEAR, 2101))
EXPECTED_HIGH_TIDES_PER_YEAR = 705.0
MINIMUM_FLOOD_DEPTH_FT = 0.1
PARCEL_BOUNDARY_RASTER_SCALE = 0.5
FIVE_FOOT_GRID_STRIDE = 5
FIVE_FOOT_GRID_CENTER_OFFSET = 2
KDE_GRID_STEP_FT = 0.002
KDE_KERNEL_TRUNCATION_SD = 6.0
KDE_BOOTSTRAP_REPLICATES = 400
KDE_BOOTSTRAP_SEED = 20260726


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


def fit_local_gauge_trend(times: list[int], levels: list[float]) -> tuple[float, dict]:
    """Fit the existing local trend to equally weighted monthly means."""
    daily: dict[str, list[float]] = defaultdict(list)
    for stamp, level in zip(times, levels):
        day = datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")
        daily[day].append(float(level))

    monthly: dict[str, list[float]] = defaultdict(list)
    for day, values in daily.items():
        if values:
            monthly[day[:7]].append(float(np.mean(values)))

    xs: list[float] = []
    ys: list[float] = []
    for month, values in sorted(monthly.items()):
        if not values:
            continue
        year, month_number = map(int, month.split("-"))
        xs.append(year + (month_number - 0.5) / 12.0)
        ys.append(float(np.mean(values)))
    if len(xs) < 24:
        raise RuntimeError("At least 24 local-gauge monthly means are required to fit the observed trend")

    slope, intercept = np.polyfit(np.asarray(xs), np.asarray(ys), 1)
    fitted = np.asarray(xs) * slope + intercept
    residual = np.asarray(ys) - fitted
    return float(slope), {
        "method": "ordinary least squares on equally weighted monthly means from the city-primary 15-minute archive",
        "monthlyMeanCount": len(xs),
        "firstMonth": min(monthly),
        "lastMonth": max(monthly),
        "slopeFtPerYear": round(float(slope), 8),
        "interceptFt": round(float(intercept), 6),
        "residualStandardErrorFt": round(float(np.std(residual, ddof=2)), 4),
    }


def extract_high_tide_events(times: list[int], levels: list[float], annual_trend_ft: float) -> tuple[list[dict], list[float]]:
    events: list[dict] = []
    rebased_peaks: list[float] = []
    base_timestamp = datetime(CURRENT_YEAR, 1, 1, tzinfo=timezone.utc).timestamp()
    for segment_times, segment_levels in split_contiguous(times, levels):
        peak_indices, _ = find_peaks(segment_levels, distance=24, prominence=0.20)
        for index in peak_indices:
            stamp = int(segment_times[index])
            level = float(segment_levels[index])
            year = datetime.fromtimestamp(stamp, timezone.utc).year
            years_to_base = (base_timestamp - stamp) / (365.2425 * 86400)
            rebased = level + annual_trend_ft * years_to_base
            events.append(
                {
                    "timeUtc": datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z"),
                    "year": year,
                    "navd88Ft": round(level, 3),
                    "rebasedNavd88Ft": rebased,
                }
            )
            rebased_peaks.append(rebased)
    events.sort(key=lambda row: row["timeUtc"])
    rebased_peaks.sort()
    return events, rebased_peaks


def fit_quadratic_slr_deltas(noaa_payload: dict, annual_trend_ft: float) -> tuple[dict[str, list[float]], dict]:
    rows = noaa_payload.get("SlrProjections", [])
    deltas: dict[str, list[float]] = {
        "observedTrend": [round(annual_trend_ft * (year - CURRENT_YEAR), 4) for year in YEARS]
    }
    curve_metadata: dict[str, dict] = {
        "observedTrend": {
            "label": SCENARIO_LABELS["observedTrend"],
            "type": "linear",
            "baseYear": CURRENT_YEAR,
            "coefficientsForXYearMinus2026": {"a": 0.0, "b": round(annual_trend_ft, 10), "c": 0.0},
        }
    }

    for key, noaa_name in NOAA_SCENARIO_NAMES.items():
        selected = [
            row
            for row in rows
            if row.get("scenario") == noaa_name
            and CURRENT_YEAR - 6 <= int(row.get("projectionYear", 0)) <= 2100
        ]
        if len(selected) < 3:
            raise RuntimeError(f"NOAA 2022 payload did not contain enough {noaa_name} projection points")
        projection_years = np.asarray([float(row["projectionYear"]) - CURRENT_YEAR for row in selected], dtype=float)
        projection_feet = np.asarray([float(row["projectionRsl"]) / 30.48 for row in selected], dtype=float)
        a, b, c = np.polyfit(projection_years, projection_feet, 2)
        base_value = c
        deltas[key] = [
            round(max(0.0, float(a * (year - CURRENT_YEAR) ** 2 + b * (year - CURRENT_YEAR) + c - base_value)), 4)
            for year in YEARS
        ]
        curve_metadata[key] = {
            "label": SCENARIO_LABELS[key],
            "type": "quadratic",
            "baseYear": CURRENT_YEAR,
            "sourceScenario": noaa_name,
            "fitProjectionYears": [int(min(row["projectionYear"] for row in selected)), int(max(row["projectionYear"] for row in selected))],
            "coefficientsForXYearMinus2026": {
                "a": round(float(a), 12),
                "b": round(float(b), 10),
                "c": 0.0,
            },
        }
    return deltas, curve_metadata


def gaussian_kde_bandwidth(samples: np.ndarray) -> float:
    """Silverman's normal-reference bandwidth for a one-dimensional Gaussian KDE."""
    if samples.size < 2:
        return 0.05
    standard_deviation = float(np.std(samples, ddof=1))
    if not math.isfinite(standard_deviation) or standard_deviation <= 0.0:
        return 0.05
    return max(0.02, 1.06 * standard_deviation * samples.size ** (-0.2))


def historic_flood_count(sorted_peaks: list[float], elevation_ft: float) -> int:
    """Count peaks producing strictly more than 0.1 ft above parcel elevation."""
    threshold = float(elevation_ft) + MINIMUM_FLOOD_DEPTH_FT
    return len(sorted_peaks) - bisect.bisect_right(sorted_peaks, threshold)


def _smoothed_cdf_from_histogram(
    histogram: np.ndarray,
    kernel_fft: np.ndarray,
    fft_size: int,
    kernel_center: int,
) -> np.ndarray:
    smoothed = np.fft.irfft(np.fft.rfft(histogram, fft_size) * kernel_fft, fft_size)
    smoothed = np.maximum(smoothed[kernel_center : kernel_center + histogram.size], 0.0)
    cumulative = np.cumsum(smoothed)
    total = float(cumulative[-1]) if cumulative.size else 0.0
    if total <= 0.0:
        return np.zeros(histogram.size, dtype=np.float64)
    return cumulative / total


def fit_continuous_exceedance_cdf(
    rebased_peaks: list[float],
    events: list[dict],
    evaluation_thresholds: list[np.ndarray],
) -> tuple[list[np.ndarray], list[np.ndarray], list[np.ndarray], dict]:
    """Fit a continuous Gaussian-kernel CDF and bootstrap its 95% interval by year."""
    samples = np.asarray(rebased_peaks, dtype=np.float64)
    if samples.size < 2:
        raise RuntimeError("At least two rebased high-tide peaks are required to fit the CDF")
    bandwidth = gaussian_kde_bandwidth(samples)
    threshold_min = min(float(np.min(values)) for values in evaluation_thresholds)
    threshold_max = max(float(np.max(values)) for values in evaluation_thresholds)
    margin = KDE_KERNEL_TRUNCATION_SD * bandwidth
    grid_min = math.floor((min(float(np.min(samples)), threshold_min) - margin) / KDE_GRID_STEP_FT) * KDE_GRID_STEP_FT
    grid_max = math.ceil((max(float(np.max(samples)), threshold_max) + margin) / KDE_GRID_STEP_FT) * KDE_GRID_STEP_FT
    grid = np.arange(grid_min, grid_max + KDE_GRID_STEP_FT * 0.5, KDE_GRID_STEP_FT, dtype=np.float64)
    edges = np.concatenate(
        (
            np.asarray([grid[0] - KDE_GRID_STEP_FT / 2.0]),
            grid + KDE_GRID_STEP_FT / 2.0,
        )
    )

    kernel_radius = int(math.ceil(KDE_KERNEL_TRUNCATION_SD * bandwidth / KDE_GRID_STEP_FT))
    kernel_offsets = np.arange(-kernel_radius, kernel_radius + 1, dtype=np.float64) * KDE_GRID_STEP_FT
    kernel = np.exp(-0.5 * (kernel_offsets / bandwidth) ** 2)
    kernel /= np.sum(kernel)
    fft_size = 1 << (grid.size + kernel.size - 2).bit_length()
    kernel_fft = np.fft.rfft(kernel, fft_size)
    kernel_center = (kernel.size - 1) // 2

    central_histogram = np.histogram(samples, bins=edges)[0].astype(np.float64)
    central_cdf = _smoothed_cdf_from_histogram(
        central_histogram, kernel_fft, fft_size, kernel_center
    )

    peak_blocks: dict[int, list[float]] = defaultdict(list)
    for event in events:
        rebased = event.get("rebasedNavd88Ft")
        if rebased is not None and math.isfinite(float(rebased)):
            peak_blocks[int(event["year"])].append(float(rebased))
    block_histograms = np.asarray(
        [np.histogram(values, bins=edges)[0] for _, values in sorted(peak_blocks.items())],
        dtype=np.float64,
    )
    if block_histograms.shape[0] < 2:
        raise RuntimeError("At least two calendar-year blocks are required for CDF uncertainty")

    rng = np.random.default_rng(KDE_BOOTSTRAP_SEED)
    block_weights = rng.multinomial(
        block_histograms.shape[0],
        np.full(block_histograms.shape[0], 1.0 / block_histograms.shape[0]),
        size=KDE_BOOTSTRAP_REPLICATES,
    )
    bootstrap_cdfs = np.empty((KDE_BOOTSTRAP_REPLICATES, grid.size), dtype=np.float32)
    for index, weights in enumerate(block_weights):
        bootstrap_histogram = weights @ block_histograms
        bootstrap_cdfs[index] = _smoothed_cdf_from_histogram(
            bootstrap_histogram, kernel_fft, fft_size, kernel_center
        )

    estimates: list[np.ndarray] = []
    lower95: list[np.ndarray] = []
    upper95: list[np.ndarray] = []
    for thresholds in evaluation_thresholds:
        flat_thresholds = thresholds.ravel()
        central_survival = 1.0 - np.interp(
            flat_thresholds, grid, central_cdf, left=0.0, right=1.0
        )
        bootstrap_survival = np.empty(
            (KDE_BOOTSTRAP_REPLICATES, flat_thresholds.size), dtype=np.float32
        )
        for index, bootstrap_cdf in enumerate(bootstrap_cdfs):
            bootstrap_survival[index] = 1.0 - np.interp(
                flat_thresholds, grid, bootstrap_cdf, left=0.0, right=1.0
            )
        interval = np.percentile(bootstrap_survival, [2.5, 97.5], axis=0)
        shape = thresholds.shape
        estimates.append(central_survival.reshape(shape))
        lower95.append(interval[0].reshape(shape))
        upper95.append(interval[1].reshape(shape))

    return estimates, lower95, upper95, {
        "type": "continuous Gaussian-kernel CDF",
        "bandwidthMethod": "Silverman normal-reference rule",
        "bandwidthFt": round(bandwidth, 6),
        "evaluationGridStepFt": KDE_GRID_STEP_FT,
        "kernelTruncationStandardDeviations": KDE_KERNEL_TRUNCATION_SD,
        "uncertaintyMethod": "calendar-year block bootstrap percentile interval",
        "bootstrapReplicates": KDE_BOOTSTRAP_REPLICATES,
        "bootstrapSeed": KDE_BOOTSTRAP_SEED,
        "bootstrapBlockCount": int(block_histograms.shape[0]),
    }


def build_cdf_payload(
    observed_payload: dict,
    events: list[dict],
    rebased_peaks: list[float],
    annual_trend_ft: float,
    slr_payload: dict,
    trend_metadata: dict,
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
    slr_deltas, curve_metadata = fit_quadratic_slr_deltas(slr_payload, annual_trend_ft)
    evaluation_thresholds = [
        ELEVATION_GRID_FT[:, np.newaxis]
        + MINIMUM_FLOOD_DEPTH_FT
        - np.asarray(deltas, dtype=np.float64)[np.newaxis, :]
        for deltas in slr_deltas.values()
    ]
    estimates, lowers, uppers, cdf_fit_metadata = fit_continuous_exceedance_cdf(
        rebased_peaks, events, evaluation_thresholds
    )
    annual_counts: dict[str, dict[str, list[list[float]]]] = {}
    for index, scenario in enumerate(slr_deltas):
        estimate_rows = np.clip(estimates[index] * tides_per_year, 0.0, tides_per_year)
        lower_rows = np.clip(lowers[index] * tides_per_year, 0.0, tides_per_year)
        upper_rows = np.clip(uppers[index] * tides_per_year, 0.0, tides_per_year)
        annual_counts[scenario] = {
            "estimate": np.round(estimate_rows, 2).tolist(),
            "lower95": np.round(lower_rows, 2).tolist(),
            "upper95": np.round(upper_rows, 2).tolist(),
        }

    historic_peak_levels = sorted(float(row["navd88Ft"]) for row in events)
    historical_counts = [
        historic_flood_count(historic_peak_levels, float(elevation))
        for elevation in ELEVATION_GRID_FT
    ]
    return {
        "schema": "north-wildwood-flood-history-projections-v4",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "currentYear": CURRENT_YEAR,
        "site": {
            "name": "North Wildwood city gauge with Stone Harbor fallback",
            "cityGaugeId": "1005",
            "usgsId": "01411360",
            "noaaScenarioStationId": "8536110",
            "noaaScenarioStationName": "Cape May",
        },
        "sources": {
            "observed": "North Wildwood municipal sensor 1005 where usable, with USGS 01411360 as the earlier and gap-fallback source; regularized to 15-minute anchors",
            "seaLevelScenarios": "NOAA CO-OPS 2022 Interagency Sea Level Report station projections",
            "scenarioReportYear": 2022,
            "localObservedTrend": "city-primary monthly means from the same 15-minute archive",
        },
        "observedArchive": {"startDate": observed_payload.get("archiveStartDate"), "endDate": observed_payload.get("archiveEndDate")},
        "method": {
            "historic": "independent city-primary composite high-tide peaks separated by at least six hours; a parcel floods only when depth is strictly greater than 0.1 foot above the parcel's highest intersecting original five-foot DEM cell",
            "baselineRebase": f"each observed local-gauge peak adjusted to 1 January {CURRENT_YEAR} using the fitted local observed trend",
            "seaLevelCurves": f"quadratic least-squares fits to each NOAA 2022 median scenario, evaluated annually and rebased to zero in {CURRENT_YEAR}; the observed local trend remains linear",
            "cdf": "continuous Gaussian-kernel CDF fitted to present-year-rebased independent high-tide peaks",
            "uncertainty": "two-sided 95 percent calendar-year block-bootstrap percentile interval for the fitted exceedance probability at every elevation, year, and curve",
            "future": "continuous fitted CDF probability of water level being strictly greater than parcel elevation plus 0.1 foot, with its 95 percent bounds multiplied by 705 expected astronomical high tides per year",
        },
        "floodDefinition": {
            "comparison": "strictlyGreaterThan",
            "minimumDepthFt": MINIMUM_FLOOD_DEPTH_FT,
            "elevationRule": "highest original five-foot DEM cell whose center intersects the parcel",
        },
        "cdfFit": cdf_fit_metadata,
        "annualRelativeSeaLevelTrendFt": round(annual_trend_ft, 6),
        "observedTrendFit": trend_metadata,
        "highTidePeakCount": len(events),
        "calendarYearCount": len(years_with_data),
        "observedDurationYears": round(observed_duration_years, 3),
        "detectedIndependentTidesPerObservedYear": round(detected_tides_per_year, 3),
        "independentTidesPerYear": tides_per_year,
        "elevationGridFtNavd88": ELEVATION_GRID_FT.tolist(),
        "years": YEARS,
        "scenarioSlrDeltaFtFrom2026": slr_deltas,
        "scenarioCurves": curve_metadata,
        "scenarioOrder": list(slr_deltas),
        "historicFloodEventCountByElevation": historical_counts,
        "annualFloodEventCount": annual_counts,
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
        self.reverse_transform = osr.CoordinateTransformation(target_srs, source_srs)
        self.geo_transform = self.ds.GetGeoTransform()

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

    @staticmethod
    def _first_grid_index(start: int) -> int:
        remainder = (start - FIVE_FOOT_GRID_CENTER_OFFSET) % FIVE_FOOT_GRID_STRIDE
        return start if remainder == 0 else start + (FIVE_FOOT_GRID_STRIDE - remainder)

    def sample_parcel_highest_five_foot_cell(
        self, source_geometry: ogr.Geometry
    ) -> tuple[float | None, str, float | None, float | None]:
        geometry = source_geometry.Clone()
        geometry.Transform(self.transform)
        min_x, max_x, min_y, max_y = geometry.GetEnvelope()
        corner_pixels = [
            gdal.ApplyGeoTransform(self.inv, x, y)
            for x, y in ((min_x, min_y), (min_x, max_y), (max_x, min_y), (max_x, max_y))
        ]
        cols = [pixel[0] for pixel in corner_pixels]
        rows = [pixel[1] for pixel in corner_pixels]
        col_min = max(0, int(math.floor(min(cols))))
        col_max = min(self.ds.RasterXSize - 1, int(math.ceil(max(cols))))
        row_min = max(0, int(math.floor(min(rows))))
        row_max = min(self.ds.RasterYSize - 1, int(math.ceil(max(rows))))
        first_col = self._first_grid_index(col_min)
        first_row = self._first_grid_index(row_min)
        candidate_cols = list(range(first_col, col_max + 1, FIVE_FOOT_GRID_STRIDE))
        candidate_rows = list(range(first_row, row_max + 1, FIVE_FOOT_GRID_STRIDE))
        if not candidate_cols or not candidate_rows:
            centroid = source_geometry.Centroid()
            value, method = self.sample(centroid.GetX(), centroid.GetY())
            return value, f"{method}-fallback-no-five-foot-center", centroid.GetX(), centroid.GetY()

        xoff, yoff = min(candidate_cols), min(candidate_rows)
        xsize = max(candidate_cols) - xoff + 1
        ysize = max(candidate_rows) - yoff + 1
        data = self.band.ReadAsArray(xoff, yoff, xsize, ysize)
        candidates: list[tuple[float, int, int]] = []
        for row in candidate_rows:
            for col in candidate_cols:
                value = float(data[row - yoff, col - xoff])
                if not math.isfinite(value) or (self.nodata is not None and value == self.nodata):
                    continue
                candidates.append((value, col, row))
        candidates.sort(reverse=True)

        for value, col, row in candidates:
            x = (
                self.geo_transform[0]
                + (col + 0.5) * self.geo_transform[1]
                + (row + 0.5) * self.geo_transform[2]
            )
            y = (
                self.geo_transform[3]
                + (col + 0.5) * self.geo_transform[4]
                + (row + 0.5) * self.geo_transform[5]
            )
            point = ogr.Geometry(ogr.wkbPoint)
            point.AddPoint(x, y)
            if not geometry.Intersects(point):
                continue
            lon, lat, _ = self.reverse_transform.TransformPoint(x, y)
            return value, "highest-intersecting-original-five-foot-cell", lon, lat

        centroid = source_geometry.Centroid()
        value, method = self.sample(centroid.GetX(), centroid.GetY())
        return value, f"{method}-fallback-no-intersecting-five-foot-center", centroid.GetX(), centroid.GetY()


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
        elevation, sample_method, analysis_lon, analysis_lat = sampler.sample_parcel_highest_five_foot_cell(geometry)
        if elevation is None:
            skipped += 1
            continue
        historic_count = historic_flood_count(peak_levels, elevation)
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
                    "analysisLon": round(float(analysis_lon), 7) if analysis_lon is not None else None,
                    "analysisLat": round(float(analysis_lat), 7) if analysis_lat is not None else None,
                    "elevationNavd88Ft": round(elevation, 2),
                    "modelElevationNavd88Ft": elevation_grid[grid_index],
                    "modelElevationIndex": grid_index,
                    "elevationSampleMethod": sample_method,
                    "historicFloodEventCount": historic_count,
                    "minimumFloodDepthFt": MINIMUM_FLOOD_DEPTH_FT,
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
        "name": "North Wildwood MOD-IV parcels with flood history and projections",
        "metadata": {
            "source": "NJGIN Parcels and MOD-IV Composite of New Jersey",
            "municipalityCode": "0507",
            "parcelElevationRule": "highest original five-foot DEM cell whose center intersects the parcel",
            "floodDefinition": "water depth strictly greater than 0.1 foot at the parcel elevation cell",
            "elevationDatum": "NAVD88 feet",
            "parcelCount": len(output_features),
            "skippedParcelCount": skipped,
            "cdfFile": "NorthWildwoodHouseAlertCDF.json",
        },
        "features": output_features,
    }


def refresh_existing_parcel_counts(path: Path, events: list[dict], cdf: dict) -> int:
    """Refresh derived flood counts without resampling parcel geometry or the DEM."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    peak_levels = sorted(float(row["navd88Ft"]) for row in events)
    features = payload.get("features", [])
    refreshed = 0
    for feature in features:
        properties = feature.get("properties") or {}
        elevation = properties.get("elevationNavd88Ft")
        if elevation is None or not math.isfinite(float(elevation)):
            continue
        properties["historicFloodEventCount"] = historic_flood_count(peak_levels, float(elevation))
        properties["minimumFloodDepthFt"] = MINIMUM_FLOOD_DEPTH_FT
        properties["historicStartDate"] = cdf["observedArchive"]["startDate"]
        properties["historicEndDate"] = cdf["observedArchive"]["endDate"]
        refreshed += 1
    metadata = payload.setdefault("metadata", {})
    metadata["floodDefinition"] = "water depth strictly greater than 0.1 foot at the parcel elevation cell"
    metadata["parcelElevationRule"] = "highest original five-foot DEM cell whose center intersects the parcel"
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return refreshed


def build(args: argparse.Namespace) -> dict:
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    observed_times, observed_levels, observed_payload = decode_observed_archive(args.observed.resolve())
    slr_payload = (
        json.loads(args.slr.resolve().read_text(encoding="utf-8"))
        if args.slr
        else fetch_json(NOAA_SLR_URL)
    )
    annual_trend_ft, trend_metadata = fit_local_gauge_trend(observed_times, observed_levels)
    events, rebased_peaks = extract_high_tide_events(observed_times, observed_levels, annual_trend_ft)
    if not rebased_peaks:
        raise RuntimeError("No independent high-tide events could be extracted")
    cdf = build_cdf_payload(
        observed_payload,
        events,
        rebased_peaks,
        annual_trend_ft,
        slr_payload,
        trend_metadata,
    )
    cdf_path = output_dir / "NorthWildwoodHouseAlertCDF.json"
    cdf_path.write_text(json.dumps(cdf, separators=(",", ":")) + "\n", encoding="utf-8")
    refreshed_parcel_count = 0
    if args.refresh_existing_parcels:
        parcel_path = output_dir / "NorthWildwoodParcels.geojson"
        if not parcel_path.exists():
            raise RuntimeError(f"Could not refresh missing parcel asset {parcel_path}")
        refreshed_parcel_count = refresh_existing_parcel_counts(parcel_path, events, cdf)
    manifest_path = output_dir / "NorthWildwoodParcelAlertManifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["highTidePeakCount"] = cdf["highTidePeakCount"]
        manifest["historicStartDate"] = cdf["observedArchive"]["startDate"]
        manifest["historicEndDate"] = cdf["observedArchive"]["endDate"]
        manifest["cdfBytes"] = cdf_path.stat().st_size
        manifest["floodDefinition"] = cdf["floodDefinition"]
        existing_parcel_path = output_dir / "NorthWildwoodParcels.geojson"
        if existing_parcel_path.exists():
            manifest["parcelGeoJsonBytes"] = existing_parcel_path.stat().st_size
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if args.cdf_only:
        return {
            "highTidePeakCount": cdf["highTidePeakCount"],
            "independentTidesPerYear": cdf["independentTidesPerYear"],
            "historicStartDate": cdf["observedArchive"]["startDate"],
            "historicEndDate": cdf["observedArchive"]["endDate"],
            "cdfBytes": cdf_path.stat().st_size,
            "cdfFit": cdf["cdfFit"],
            "refreshedParcelCount": refreshed_parcel_count,
        }

    parcels = fetch_parcels()
    if not args.dem:
        raise RuntimeError("--dem is required unless --cdf-only is used")
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
    parser.add_argument("--dem", type=Path)
    parser.add_argument("--observed", type=Path, default=Path("observed15min.json"))
    parser.add_argument("--slr", type=Path, help="Optional cached NOAA 2022 SLR projection payload")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cdf-only", action="store_true", help="Regenerate only the projection CDF asset")
    parser.add_argument(
        "--refresh-existing-parcels",
        action="store_true",
        help="Refresh counts in the output directory's existing parcel GeoJSON",
    )
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(build(parse_args()), indent=2))
