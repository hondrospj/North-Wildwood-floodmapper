"""Consumed-data contracts for generated North Wildwood release artifacts."""
from datetime import date, datetime, timedelta, timezone
import math
from pathlib import PurePosixPath
import re
from zoneinfo import ZoneInfo

LOCAL_ZONE = ZoneInfo("America/New_York")
CATEGORIES = {"none", "minor", "moderate", "major"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label, nullable=False):
    if nullable and value is None:
        return value
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
            f"{label}: expected a finite number")
    return value


def integer(value, label, minimum=None):
    number(value, label)
    require(int(value) == value and (minimum is None or value >= minimum), f"{label}: invalid integer")
    return int(value)


def utc(value, label):
    require(isinstance(value, str), f"{label}: UTC timestamp is required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0, f"{label}: expected UTC")
    return parsed.astimezone(timezone.utc)


def civil_date(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value), "Invalid civil date")
    return date.fromisoformat(value)


def records(payload, key, allow_empty=False):
    result = payload.get(key)
    require(isinstance(result, list) and (allow_empty or result), f"{key}: expected a nonempty array")
    return result


def schema(payload, expected):
    require(isinstance(payload, dict) and payload.get("schema") == expected, f"Expected schema {expected}")


def datum(payload):
    require(payload.get("datum") == "NAVD88", "Archive datum must be NAVD88")
    if "timeZone" in payload:
        require(payload["timeZone"] == "America/New_York", "Archive time zone must be America/New_York")


def thresholds(payload):
    offset = number(payload.get("navd88OffsetFromMllwFt"), "datum offset")
    require(offset == -2.75, "Unexpected North Wildwood datum conversion")
    levels = []
    for key in ("minorLow", "moderateLow", "majorLow"):
        navd = number(payload.get("thresholdsNAVD88", {}).get(key), key)
        mllw = number(payload.get("thresholdsMLLW", {}).get(key), key)
        require(abs(navd - (mllw + offset)) <= 0.011, "Inconsistent flood-threshold datum conversion")
        levels.append(navd)
    require(levels[0] < levels[1] < levels[2], "Flood thresholds must be increasing")
    require(levels == [3.25, 4.25, 5.25], "Unexpected North Wildwood flood thresholds")
    return offset, levels


def category(peak, levels=(3.25, 4.25, 5.25)):
    return next((name for level, name in reversed(list(zip(levels, ("minor", "moderate", "major"))))
                 if peak is not None and peak >= level), "none")


def ordered_days(payload, key="d"):
    days = records(payload, "days")
    previous = None
    for day in days:
        require(isinstance(day, dict), "Archive day must be an object")
        current = civil_date(day.get(key))
        require(previous is None or current > previous, "Archive dates must be unique and increasing")
        previous = current
    if "archiveStartDate" in payload:
        require(payload["archiveStartDate"] == days[0][key], "Archive start does not match its days")
    if "archiveEndDate" in payload:
        require(payload["archiveEndDate"] == days[-1][key], "Archive end does not match its days")
    return days


def validate_compact(payload, expected_schema, source=None, year=None):
    schema(payload, expected_schema)
    datum(payload)
    require(payload.get("timeZone") == "America/New_York", "Archive time zone is missing")
    interval = integer(payload.get("intervalMinutes"), "archive interval", 1)
    require(interval in (15, 60), "Unexpected archive sampling interval")
    if expected_schema == "north-wildwood-composite-observed-15min-v2":
        require(str(payload.get("site")) == "1005" and str(payload.get("fallbackSite")) == "01411360",
                "Composite archive gauge identities are incorrect")
    elif expected_schema == "north-wildwood-observed-15min-v1":
        require(str(payload.get("site")) == "01411360", "Stone Harbor archive gauge identity is incorrect")
    elif expected_schema == "north-wildwood-lewes-hourly-surrogate-v1":
        require(str(payload.get("stationId")) == "8557380", "Lewes archive gauge identity is incorrect")
    if source:
        require(payload.get("source") == source, "Archive source does not match its path")
        require(str(payload.get("stationId")) == ("01411360" if source == "stone-harbor" else "8557380"),
                "Archive station does not match its source")
    if year is not None:
        require(payload.get("year") == year, "Archive year does not match its filename")
    else:
        require("archiveStartDate" in payload and "archiveEndDate" in payload, "Canonical archive bounds are missing")
    if "thresholdsNAVD88" in payload:
        _, levels = thresholds(payload)
    else:
        levels = (3.25, 4.25, 5.25)
    for day in ordered_days(payload):
        if year is not None:
            require(civil_date(day["d"]).year == year, "Day is outside the archive shard year")
        if source == "lewes" or expected_schema == "north-wildwood-lewes-hourly-surrogate-v1":
            require(day["d"] < "2007-10-01" and interval == 60, "Lewes surrogate crosses the primary-gauge cutoff")
        start = integer(day.get("u"), "day UTC origin")
        local = datetime.fromtimestamp(start, timezone.utc).astimezone(LOCAL_ZONE)
        require(local.date() == civil_date(day["d"]), "Day UTC origin differs from its civil date")
        midnight = datetime.combine(local.date(), datetime.min.time(), LOCAL_ZONE)
        following = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), LOCAL_ZONE)
        require(start == midnight.timestamp(), "Archive origin is not the start of its civil day")
        values = records(day, "v")
        require(len(values) == (following.timestamp() - midnight.timestamp()) // (interval * 60),
                "Archive samples do not cover its full civil day, including DST")
        for value in values:
            if value is not None:
                integer(value, "encoded water level")
        peak = max((value for value in values if value is not None), default=None)
        require(day.get("p") == peak, "Archive peak differs from its samples")
        require(day.get("c") == category(None if peak is None else peak / 100, levels),
                "Archive flood category differs from its peak")
        for key in ("q", "s", "g"):
            if key in day:
                require(isinstance(day[key], str if key in ("q", "s") else list) and len(day[key]) == len(values),
                        f"Archive {key} provenance does not align with samples")
        if interval == 15:
            require(all(key in day for key in ("q", "s", "g")), "Quarter-hour archive lacks sample provenance")
            for value, quality, station, gap in zip(values, day["q"], day["s"], day["g"]):
                require(quality in "MICU-" and station in "NSL-", "Unknown sample provenance")
                if value is None:
                    # Raw USGS artifacts retain S as the requested source even
                    # during a gap; q='-' remains the unavailable marker.
                    require(quality == "-" and station in "-S", "Missing sample is marked as measured")
                else:
                    require(quality != "-" and station != "-", "Available sample has missing provenance")
                if quality == "M":
                    require(gap == 0, "Measured sample has an interpolation gap")
                if quality == "I":
                    require(number(gap, "interpolation gap") > 0 and gap <= 1800, "Interpolation exceeds 30 minutes")
                if quality == "C":
                    legacy_jonas = day["d"] == "2016-01-23" and peak == 669 and isinstance(day.get("j"), str) and station == "S"
                    require(isinstance(day.get("replay"), dict) or legacy_jonas, "Calibrated sample lacks replay provenance")


def validate_hourly(payload):
    schema(payload, "north-wildwood-composite-gauge-hourly-v2")
    datum(payload)
    require(str(payload.get("site")) == "1005" and str(payload.get("fallbackSite")) == "01411360",
            "Hourly archive gauge identities are incorrect")
    require(payload.get("timeZone") == "America/New_York", "Hourly archive time zone is missing")
    require("archiveStartDate" in payload and "archiveEndDate" in payload, "Hourly archive bounds are missing")
    offset, levels = thresholds(payload)
    for day in ordered_days(payload, "date"):
        previous, values = None, []
        for row in records(day, "hours"):
            stamp = utc(row.get("timeUtc"), "hour time")
            require(previous is None or stamp > previous, "Hourly timestamps must be unique and increasing")
            require(stamp.astimezone(LOCAL_ZONE).date() == civil_date(day["date"]), "Hour is outside its civil day")
            previous = stamp
            navd = number(row.get("navd88StageFt"), "hour NAVD88")
            require(abs(navd - (number(row.get("mllwStageFt"), "hour MLLW") + offset)) <= 0.021,
                    "Hourly datum conversion is inconsistent")
            integer(row.get("hourIndex"), "hour index", 0)
            values.append(navd)
        peak = max(values)
        require(abs(number(day.get("peakNAVD88"), "day peak") - peak) <= 0.011, "Hourly daily peak is inconsistent")
        require(abs(number(day.get("peakMLLW"), "day MLLW peak") + offset - peak) <= 0.021,
                "Hourly peak datum conversion is inconsistent")
        require(day.get("classification") == category(peak, levels), "Hourly flood category is inconsistent")


def validate_index(payload, source):
    schema(payload, "north-wildwood-observed-day-index-v1")
    datum(payload)
    require(payload.get("timeZone") == "America/New_York", "Index time zone is missing")
    require("archiveStartDate" in payload and "archiveEndDate" in payload, "Index archive bounds are missing")
    require(payload.get("source") == source, "Index source does not match its filename")
    require(payload.get("shardPathTemplate") == f"./observed_archive/{source}/{{year}}.json", "Unsafe archive shard template")
    require(str(payload.get("stationId")) == ("01411360" if source == "stone-harbor" else "8557380"),
            "Index station differs from its source")
    require(payload.get("intervalMinutes") == (15 if source == "stone-harbor" else 60), "Index interval differs from source")
    for day in ordered_days(payload):
        peak = number(day.get("p"), "index peak", nullable=True)
        require(day.get("c") == category(None if peak is None else peak / 100), "Index category differs from its peak")
        if source == "lewes":
            require(day["d"] < "2007-10-01", "Lewes index crosses the primary-gauge cutoff")


def validate_crests(payload):
    schema(payload, "usgs-nwis-north-wildwood-crests-v1")
    datum(payload)
    thresholds(payload)
    stations = records(payload, "stations")
    station_ids = {str(station.get("site_no")) for station in stations}
    require(all(re.fullmatch(r"\d+", value) for value in station_ids), "Invalid crest station")
    for crest in records(payload, "toptides"):
        civil_date(crest.get("date"))
        number(crest.get("height_ft"), "crest height")
        require(crest.get("datum") == "NAVD88" and str(crest.get("site_no")) in station_ids, "Crest datum/station is inconsistent")
        require(isinstance(crest.get("station_name"), str) and crest["station_name"], "Crest station name is missing")


def city_sensor(payload):
    sensor = payload.get("sensor", {})
    require(sensor.get("id") == 1005 and sensor.get("datum") == "MLLW" and sensor.get("displayDatum") == "NAVD88",
            "Municipal gauge sensor/datum is incorrect")
    require(sensor.get("unit") == "ft", "Municipal gauge units must be feet")
    require(number(sensor.get("navd88OffsetFromMllwFt"), "city datum offset") == -2.75, "Unexpected city datum conversion")


def validate_count_summary(summary):
    for key in ("recordCount", "usableRecordCount", "flaggedRecordCount", "duplicateTimestampRows"):
        integer(summary.get(key), key, 0)
    require(summary["recordCount"] == summary["usableRecordCount"] + summary["flaggedRecordCount"], "City record counts do not reconcile")


def wall_time(value):
    require(isinstance(value, str), "Municipal timestamp is missing")
    parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    return parsed


def validate_city_data(payload, year=None):
    schema(payload, "north-wildwood-city-gauge-index-v1" if year is None else "north-wildwood-city-gauge-year-v1")
    city_sensor(payload)
    if year is not None:
        require(payload.get("year") == year, "Municipal year does not match its filename")
        validate_count_summary(payload)
        readings = records(payload, "readings", allow_empty=True)
        require(payload["recordCount"] == len(readings), "Municipal record count differs from readings")
        usable = 0
        for row in readings:
            require(isinstance(row, list) and len(row) == 2, "Malformed municipal reading")
            require(wall_time(row[0]).year == year, "Municipal reading is outside its year")
            value = number(row[1], "municipal MLLW")
            usable += -20 < value < 20
        require(payload["usableRecordCount"] == usable, "Municipal usable-record count is inconsistent")
        require(payload.get("firstTimestamp") == (readings[0][0] if readings else None)
                and payload.get("lastTimestamp") == (readings[-1][0] if readings else None), "Municipal coverage differs from readings")
    else:
        utc(payload.get("generatedAt"), "municipal index generation")
        years = records(payload, "years")
        require(len({row.get("year") for row in years}) == len(years), "Duplicate municipal year")
        coverage = payload.get("coverage", {})
        validate_count_summary(coverage)
        for row in years:
            integer(row.get("year"), "municipal year", 1900)
            require(row.get("path") == f"data/{row['year']}.json", "Unsafe municipal year path")
            validate_count_summary(row)
        for key in ("recordCount", "usableRecordCount", "flaggedRecordCount", "duplicateTimestampRows"):
            require(coverage[key] == sum(row[key] for row in years), "Municipal index totals differ from year summaries")
        annual = payload.get("annualFlooding", {})
        require(annual.get("unit") == "ft NAVD88", "Municipal annual flooding datum is missing")
        require({row.get("year") for row in records(annual, "years")} == {row["year"] for row in years}, "Annual flooding years differ from the archive")
        for row in annual["years"]:
            for key in ("minor", "moderate", "major", "total"):
                integer(row.get(key), "annual " + key, 0)
            require(row["total"] == row["minor"] + row["moderate"] + row["major"], "Annual flood counts do not reconcile")
            number(row.get("annualMaximum"), "annual maximum", nullable=True)


def comparison_summary(payload):
    stats = payload.get("stats", {})
    count = integer(stats.get("pairCount"), "comparison pair count", 0)
    for key in ("meanDifferenceFt", "medianDifferenceFt", "meanAbsoluteDifferenceFt", "rmseFt",
                "p05DifferenceFt", "p95DifferenceFt", "correlation"):
        number(stats.get(key), "comparison " + key, nullable=count == 0)
    if count:
        require(stats["rmseFt"] >= 0 and stats["meanAbsoluteDifferenceFt"] >= 0 and abs(stats["correlation"]) <= 1,
                "Invalid comparison error/correlation statistics")
    peaks = payload.get("peaks", {})
    integer(peaks.get("matchedPeakCount"), "matched peak count", 0)
    return count


def validate_comparison(payload, year=None):
    schema(payload, "north-wildwood-stone-harbor-comparison-index-v2" if year is None
           else "north-wildwood-stone-harbor-comparison-year-v3")
    datum(payload)
    sources = payload.get("sources", {})
    require(str(sources.get("northWildwood", {}).get("stationId")) == "1005"
            and str(sources.get("stoneHarbor", {}).get("stationId")) == "01411360", "Comparison gauge identities are incorrect")
    require(sources["northWildwood"].get("sourceDatum") == "MLLW"
            and sources["northWildwood"].get("navd88OffsetFromMllwFt") == -2.75
            and sources["stoneHarbor"].get("datum") == "NAVD88", "Comparison source datums are incorrect")
    count = comparison_summary(payload)
    if year is None:
        utc(payload.get("generatedAt"), "comparison index generation")
        years = records(payload, "years")
        require(len({row.get("year") for row in years}) == len(years), "Duplicate comparison year")
        for row in years:
            integer(row.get("year"), "comparison year", 1900)
            require(row.get("path") == f"comparison/{row['year']}.json", "Unsafe comparison year path")
            require(row.get("status") in ("aligned", "review"), "Unknown comparison review status")
            comparison_summary(row)
        require(count == sum(row["stats"]["pairCount"] for row in years), "Comparison index count differs from year summaries")
    else:
        require(payload.get("year") == year and payload.get("intervalMinutes") == 15, "Incorrect comparison year/interval")
        points = records(payload, "points", allow_empty=True)
        require(count == len(points), "Comparison pair count differs from its points")
        previous = None
        for row in points:
            require(isinstance(row, list) and len(row) == 3, "Malformed comparison point")
            timestamp = integer(row[0], "comparison UTC epoch")
            require(previous is None or timestamp > previous, "Comparison timestamps must be increasing")
            require(datetime.fromtimestamp(timestamp, timezone.utc).astimezone(LOCAL_ZONE).year == year, "Comparison point outside its year")
            integer(row[1], "North Wildwood encoded stage")
            integer(row[2], "Stone Harbor encoded stage")
            previous = timestamp
        for key, row in (("firstTimestampUtc", points[0] if points else None), ("lastTimestampUtc", points[-1] if points else None)):
            require((utc(payload[key], key).timestamp() == row[0]) if row else payload.get(key) is None,
                    "Comparison coverage differs from its points")
        matches = records(payload, "peakMatches", allow_empty=True)
        require(payload["peaks"]["matchedPeakCount"] == len(matches), "Matched peak count differs from peak rows")
        for row in matches:
            require(isinstance(row, list) and len(row) == 4, "Malformed matched peak")
            for value in row:
                integer(value, "matched peak value")


def validate_guidance(payload):
    schema(payload, "experimental-petss-guidance-v1")
    utc(payload.get("generatedUtc"), "research guidance generation")
    model = payload.get("model", {})
    require(model.get("official") is False and model.get("useForMapsOrAlerts") is False, "Research guidance must remain non-operational")
    for zone in records(payload, "zones"):
        require(isinstance(zone.get("zoneId"), str) and zone["zoneId"], "Research zone identity is missing")
        require(zone.get("status") in ("experimental", "stale", "unavailable", "unsupported"), "Unknown research guidance status")
        if zone["status"] == "unsupported":
            require(isinstance(zone.get("reason"), str), "Unsupported research zone lacks a reason")
            continue
        utc(zone.get("petssCycleUtc"), "research source cycle")
        previous = None
        for row in records(zone, "hours"):
            stamp = utc(row.get("validUtc"), "research valid time")
            require(previous is None or stamp > previous, "Research valid times must be increasing")
            previous = stamp
            require(row.get("availability") in ("experimental", "unavailable"), "Unknown research availability")
            if row["availability"] == "experimental":
                for key in ("issuedMeanMllwFt", "astronomicalTideMllwFt", "correctedCentralMllwFt"):
                    number(row.get(key), key)
            else:
                require(isinstance(row.get("reason"), str), "Unavailable research hour lacks a reason")


def validate_generated(path, payload):
    """Every inherited artifact must have an explicit consumed-schema validator."""
    if path == "observed.json":
        validate_hourly(payload)
    elif path in ("observed15min.json", "stone_harbor_observed15min.json", "lewes_hourly.json"):
        expected = {"observed15min.json": "north-wildwood-composite-observed-15min-v2",
                    "stone_harbor_observed15min.json": "north-wildwood-observed-15min-v1",
                    "lewes_hourly.json": "north-wildwood-lewes-hourly-surrogate-v1"}[path]
        validate_compact(payload, expected)
    elif path in ("observed_archive_index.json", "lewes_archive_index.json"):
        validate_index(payload, "lewes" if path.startswith("lewes") else "stone-harbor")
    elif match := re.fullmatch(r"observed_archive/(stone-harbor|lewes)/(\d{4})\.json", path):
        validate_compact(payload, "north-wildwood-observed-year-v1", match[1], int(match[2]))
    elif path == "toptides.json":
        validate_crests(payload)
    elif path == "data/experimental_petss_guidance.json":
        validate_guidance(payload)
    elif match := re.fullmatch(r"city-gauge/(data|comparison)/(index|\d{4})\.json", path):
        year = None if match[2] == "index" else int(match[2])
        (validate_city_data if match[1] == "data" else validate_comparison)(payload, year)
    else:
        raise ValueError(f"No generated-data schema validator for {PurePosixPath(path)}")
