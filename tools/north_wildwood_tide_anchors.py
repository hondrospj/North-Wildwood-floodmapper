"""Dated Mean tide anchors and a Minimum offset; raw NOAA stays untouched."""
import math

ANCHOR_VERSION = "north-wildwood-20260925-26-three-tides-v2"
MINIMUM_OFFSET_FT = -2.0 / 12.0
MINIMUM_TIDE_TARGETS = {"friday-evening-20260925": 7.2}
TROUGH_WINDOWS = (
    ("2026-09-25T12:00:00Z", "2026-09-25T20:00:00Z"),
    ("2026-09-26T03:00:00Z", "2026-09-26T09:00:00Z"),
    ("2026-09-26T16:00:00Z", "2026-09-26T23:00:00Z"),
    ("2026-09-27T04:00:00Z", "2026-09-27T10:00:00Z"),
)
ANCHORS = (
    ("friday-evening-20260925", 7.6, "2026-09-25T21:00:00Z", "2026-09-26T02:00:00Z"),
    ("saturday-morning-20260926", 7.9, "2026-09-26T10:00:00Z", "2026-09-26T15:00:00Z"),
    ("saturday-evening-20260926", 7.5, "2026-09-26T23:00:00Z", "2026-09-27T04:00:00Z"),
)


def collect_source_hours(raw_hours, previous_context=()):
    """Retain expired troughs as new cycles advance beyond the event's start."""
    by_time = {}
    for row in [*previous_context, *raw_hours]:
        stamp = row["timeUtc"]
        if TROUGH_WINDOWS[0][0] <= stamp <= TROUGH_WINDOWS[-1][1]:
            value = float(row["rawPetssValue"])
            if not math.isfinite(value):
                raise ValueError("Non-finite tide anchor source")
            by_time[stamp] = {"timeUtc": stamp, "rawPetssValue": value}
    return [by_time[stamp] for stamp in sorted(by_time)]


def anchor_mean_curve(mean_hours, source_hours, datum_offset, stage_key):
    """Scale each tidal limb about its trough, retaining timing and shape.

    The source context contains raw TWL90p; the -0.25 ft forecast adjustment
    is applied once before fitting. Positive affine limb scaling preserves
    the hourly rise/fall shape, reaches the requested crest exactly, and
    joins the unchanged curve at both troughs without a water-level jump.
    """
    plans = []
    if not any(TROUGH_WINDOWS[0][0] <= h["timeUtc"] <= TROUGH_WINDOWS[-1][1]
               for h in mean_hours):
        return plans
    baseline = [{"timeUtc": h["timeUtc"], "value": h["rawPetssValue"] - 0.25}
                for h in source_hours]
    for index, (anchor_id, target, peak_start, peak_end) in enumerate(ANCHORS):
        left_window, right_window = TROUGH_WINDOWS[index:index + 2]
        if not any(left_window[0] <= h["timeUtc"] <= right_window[1] for h in mean_hours):
            continue
        troughs = []
        for start, end in (left_window, right_window):
            candidates = [h for h in baseline if start <= h["timeUtc"] <= end]
            if not candidates:
                raise ValueError(f"Missing source trough for {anchor_id}: {start} to {end}")
            troughs.append(min(candidates, key=lambda h: h["value"]))
        left, right = troughs
        lobe = [h for h in baseline if left["timeUtc"] <= h["timeUtc"] <= right["timeUtc"]]
        peak = max(lobe, key=lambda h: h["value"])
        if not peak_start <= peak["timeUtc"] <= peak_end:
            raise ValueError(f"Unexpected peak time for {anchor_id}: {peak['timeUtc']}")
        if target <= max(left["value"], right["value"]):
            raise ValueError(f"Target must exceed both low tides for {anchor_id}")
        plan = {"id": anchor_id, "scenario": "mean", "datum": "MLLW",
                "targetMllwFt": target, "peakTimeUtc": peak["timeUtc"],
                "sourcePeakMllwFt": peak["value"],
                "leftTimeUtc": left["timeUtc"], "leftMllwFt": left["value"],
                "rightTimeUtc": right["timeUtc"], "rightMllwFt": right["value"]}
        plans.append(plan)
        for row in mean_hours:
            stamp = row["timeUtc"]
            if not left["timeUtc"] <= stamp <= right["timeUtc"]:
                continue
            # Start from the raw source on every call, never a previously fitted value.
            original = row["sourceTwl90pMllwFt"] - 0.25
            trough = left if stamp <= peak["timeUtc"] else right
            fraction = (original - trough["value"]) / (peak["value"] - trough["value"])
            if not -1e-9 <= fraction <= 1 + 1e-9:
                raise ValueError(f"Source leaves tidal limb bounds for {anchor_id} at {stamp}")
            value = trough["value"] + fraction * (target - trough["value"])
            navd88 = round(value + datum_offset + 1e-9, 2)
            matched, clamped = stage_key(navd88)
            row.update({"preAnchorMllwFt": round(original + 1e-9, 3),
                        "tideAnchorId": anchor_id,
                        "tideAnchorAdjustmentFt": round(value - original, 9),
                        "estimatedTwlMllwFt": round(value + 1e-9, 3),
                        "mllwStageFt": round(value + 1e-9, 2),
                        "twlMllwFt": round(value + 1e-9, 2),
                        "sourceStageFt": navd88, "navd88StageFt": navd88,
                        "matchedStageKey": matched, "wasClamped": clamped})
    return plans


def minimum_below_mean(mean_hours, stage_key, mean_anchors=()):
    """Derive the normal two-inch gap, then fit any dated Minimum crest."""
    minimum = []
    for mean in mean_hours:
        navd88 = mean["navd88StageFt"] + MINIMUM_OFFSET_FT
        mllw = mean["mllwStageFt"] + MINIMUM_OFFSET_FT
        matched, clamped = stage_key(navd88)
        row = dict(mean)
        row.update({"scenario": "lowEnd", "product": "mean_minus_2in", "percentile": "",
                    "isEstimatedPercentile": False, "minimumOffsetFt": MINIMUM_OFFSET_FT,
                    "meanReferenceMllwFt": mean["mllwStageFt"],
                    "meanReferenceNavd88Ft": mean["navd88StageFt"],
                    "estimatedTwlMllwFt": mllw, "mllwStageFt": mllw, "twlMllwFt": mllw,
                    "sourceStageFt": navd88, "navd88StageFt": navd88,
                    "matchedStageKey": matched, "wasClamped": clamped})
        minimum.append(row)
    for plan in mean_anchors:
        target = MINIMUM_TIDE_TARGETS.get(plan["id"])
        if target is None:
            continue
        original_peak = plan["targetMllwFt"] + MINIMUM_OFFSET_FT
        for row in minimum:
            stamp = row["timeUtc"]
            if not plan["leftTimeUtc"] <= stamp <= plan["rightTimeUtc"]:
                continue
            side = "left" if stamp <= plan["peakTimeUtc"] else "right"
            trough = round(plan[side + "MllwFt"] + 1e-9, 2) + MINIMUM_OFFSET_FT
            if target <= trough:
                raise ValueError("Minimum tide target must exceed its low tides")
            original = row["mllwStageFt"]
            fraction = (original - trough) / (original_peak - trough)
            if not -1e-9 <= fraction <= 1 + 1e-9:
                raise ValueError("Minimum leaves its dated tidal limb bounds")
            value = trough + fraction * (target - trough)
            datum_offset = row["meanReferenceNavd88Ft"] - row["meanReferenceMllwFt"]
            navd88 = value + datum_offset
            matched, clamped = stage_key(navd88)
            row.update({"minimumTideAnchorId": plan["id"],
                        "minimumTideTargetMllwFt": target,
                        "preAnchorMinimumMllwFt": original,
                        "minimumTideAnchorAdjustmentFt": value - original,
                        "minimumOffsetFt": value - row["meanReferenceMllwFt"],
                        "product": "mean_minus_2in_with_tide_anchor",
                        "estimatedTwlMllwFt": value, "mllwStageFt": value, "twlMllwFt": value,
                        "sourceStageFt": navd88, "navd88StageFt": navd88,
                        "matchedStageKey": matched, "wasClamped": clamped})
    return minimum
