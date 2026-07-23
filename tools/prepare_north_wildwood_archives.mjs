#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAVD_OFFSET_FROM_MLLW_FT = -2.75;
const THRESHOLDS_NAVD88 = { minorLow: 3.25, moderateLow: 4.25, majorLow: 5.25 };
const THRESHOLDS_MLLW = { minorLow: 6.0, moderateLow: 7.0, majorLow: 8.0 };
const JONAS_DATE = "2016-01-23";
const JONAS_TARGET_NAVD88_FT = 6.69;
const JONAS_TARGET_MLLW_FT = 9.44;

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(REPO, name), "utf8"));
}

function writeJson(name, payload, compact = false) {
  const text = compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.join(REPO, name), `${text}\n`);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function classify(stage) {
  const value = Number(stage);
  if (!Number.isFinite(value) || value < THRESHOLDS_NAVD88.minorLow) return "none";
  if (value < THRESHOLDS_NAVD88.moderateLow) return "minor";
  if (value < THRESHOLDS_NAVD88.majorLow) return "moderate";
  return "major";
}

function stageKey(stage) {
  const value = Math.max(-2, Math.min(14, Number(stage)));
  return (Math.floor((value + 1e-9) * 20) / 20).toFixed(2);
}

function phaseForIndex(rows, index, getter = row => row?.navd88StageFt) {
  const current = Number(getter(rows[index]));
  const previous = index > 0 ? Number(getter(rows[index - 1])) : NaN;
  const next = index + 1 < rows.length ? Number(getter(rows[index + 1])) : NaN;
  const before = Number.isFinite(previous) ? current - previous : NaN;
  const after = Number.isFinite(next) ? next - current : NaN;
  const epsilon = 0.025;
  if (Number.isFinite(before) && Number.isFinite(after) && before > epsilon && after <= epsilon) return "slack";
  if (Number.isFinite(before) && Number.isFinite(after) && before >= -epsilon && after < -epsilon) return "slack";
  if (Number.isFinite(before) && Number.isFinite(after) && before < -epsilon && after >= -epsilon) return "slack";
  if (Number.isFinite(before) && Number.isFinite(after) && before <= epsilon && after > epsilon) return "slack";
  const delta = Number.isFinite(after) && (!Number.isFinite(before) || Math.abs(after) >= Math.abs(before)) ? after : before;
  if (Number.isFinite(delta) && delta > epsilon) return "filling";
  if (Number.isFinite(delta) && delta < -epsilon) return "draining";
  return "slack";
}

function calibrateJonas(values, target) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return values;
  const low = Math.min(...finite);
  const peak = Math.max(...finite);
  if (!(peak > low) || Math.abs(peak - target) < 0.0001) return values;
  const scale = (target - low) / (peak - low);
  return values.map(value => Number.isFinite(value) ? round2(low + (value - low) * scale) : value);
}

function updateForecast() {
  const payload = readJson("forecast.json");
  const forecasts = payload.forecasts || {};
  for (const forecast of Object.values(forecasts)) {
    const rows = Array.isArray(forecast?.hours) ? forecast.hours : [];
    for (const row of rows) {
      const mllw = Number(row.mllwStageFt ?? row.twlMllwFt ?? row.rawPetssValue);
      if (Number.isFinite(mllw)) {
        const navd = round2(mllw + NAVD_OFFSET_FROM_MLLW_FT);
        row.navd88StageFt = navd;
        row.sourceStageFt = navd;
        row.matchedStageKey = stageKey(navd);
        row.wasClamped = navd < -2 || navd > 14;
      }
    }
    rows.forEach((row, index) => {
      row.hydraulicPhase = phaseForIndex(rows, index);
      const before = index > 0 ? Number(rows[index - 1]?.navd88StageFt) : NaN;
      row.riseRateFtPer15Min = Number.isFinite(before) ? round2((Number(row.navd88StageFt) - before) / 4) : 0;
    });
  }
  payload.gaugeName = "Stone Harbor";
  payload.navd88OffsetFromMllwFt = NAVD_OFFSET_FROM_MLLW_FT;
  payload.twlFormula = "navd88StageFt = twlMllwFt - 2.75 ft for North Wildwood.";
  payload.thresholdsMLLW = THRESHOLDS_MLLW;
  payload.thresholdsNAVD88 = THRESHOLDS_NAVD88;
  payload.hydraulicModel = {
    timeStepMinutes: 15,
    phaseField: "hydraulicPhase",
    phases: ["filling", "slack", "draining"],
    note: "The hourly forecast selects a precomputed one-foot-grid hydraulic state; the expensive terrain solve is not repeated hourly."
  };
  payload.hours = forecasts.mean?.hours || payload.hours;
  writeJson("forecast.json", payload);
}

function updateObserved15Minute() {
  const payload = readJson("observed15min.json");
  for (const day of payload.days || []) {
    if (day.d === JONAS_DATE) {
      const feet = (day.v || []).map(value => value == null ? NaN : Number(value) / 100);
      const calibrated = calibrateJonas(feet, JONAS_TARGET_NAVD88_FT);
      day.v = calibrated.map(value => Number.isFinite(value) ? Math.round(value * 100) : null);
      day.j = "North Wildwood Winter Storm Jonas calibration to 9.44 ft MLLW / 6.69 ft NAVD88";
    }
    const finite = (day.v || []).filter(value => value != null).map(Number);
    day.p = finite.length ? Math.max(...finite) : null;
    day.c = classify(day.p == null ? null : day.p / 100);
  }
  payload.schema = "north-wildwood-observed-15min-v1";
  payload.navd88OffsetFromMllwFt = NAVD_OFFSET_FROM_MLLW_FT;
  payload.thresholdsNAVD88 = THRESHOLDS_NAVD88;
  payload.thresholdsMLLW = THRESHOLDS_MLLW;
  payload.jonasCalibration = {
    date: JONAS_DATE,
    targetNavd88Ft: JONAS_TARGET_NAVD88_FT,
    targetMllwFt: JONAS_TARGET_MLLW_FT,
    method: "preserve the Stone Harbor 15-minute tide shape and scale its excursion about the day's low water to the documented North Wildwood crest"
  };
  writeJson("observed15min.json", payload, true);
}

function updateObservedHourly() {
  const payload = readJson("observed.json");
  for (const day of payload.days || []) {
    const rows = Array.isArray(day.hours) ? day.hours : [];
    if (day.date === JONAS_DATE) {
      const values = calibrateJonas(rows.map(row => Number(row.navd88StageFt)), JONAS_TARGET_NAVD88_FT);
      rows.forEach((row, index) => {
        if (Number.isFinite(values[index])) row.navd88StageFt = values[index];
      });
      day.jonasCalibration = "9.44 ft MLLW / 6.69 ft NAVD88";
    }
    rows.forEach((row, index) => {
      const navd = Number(row.navd88StageFt);
      if (Number.isFinite(navd)) row.mllwStageFt = round2(navd - NAVD_OFFSET_FROM_MLLW_FT);
      row.hydraulicPhase = phaseForIndex(rows, index);
    });
    const finite = rows.map(row => Number(row.navd88StageFt)).filter(Number.isFinite);
    day.peakNAVD88 = finite.length ? round2(Math.max(...finite)) : null;
    day.peakMLLW = day.peakNAVD88 == null ? null : round2(day.peakNAVD88 - NAVD_OFFSET_FROM_MLLW_FT);
    day.classification = classify(day.peakNAVD88);
  }
  payload.schema = "north-wildwood-stone-harbor-gauge-hourly-v1";
  payload.navd88OffsetFromMllwFt = NAVD_OFFSET_FROM_MLLW_FT;
  payload.thresholdsNAVD88 = THRESHOLDS_NAVD88;
  payload.thresholdsMLLW = THRESHOLDS_MLLW;
  payload.jonasCalibration = {
    date: JONAS_DATE,
    targetNavd88Ft: JONAS_TARGET_NAVD88_FT,
    targetMllwFt: JONAS_TARGET_MLLW_FT
  };
  writeJson("observed.json", payload);
}

function updateLewesArchive() {
  const payload = readJson("lewes_hourly.json");
  for (const day of payload.days || []) {
    const finite = (day.v || []).filter(value => value != null).map(Number);
    day.p = finite.length ? Math.max(...finite) : null;
    day.c = classify(day.p == null ? null : day.p / 100);
  }
  payload.schema = "north-wildwood-lewes-shape-archive-v1";
  payload.thresholdsNAVD88 = THRESHOLDS_NAVD88;
  payload.thresholdsMLLW = THRESHOLDS_MLLW;
  payload.navd88OffsetFromMllwFt = NAVD_OFFSET_FROM_MLLW_FT;
  writeJson("lewes_hourly.json", payload, true);
}

function updateTopTides() {
  const payload = readJson("toptides.json");
  const events = (payload.toptides || []).filter(event => event && typeof event === "object" && event.date !== JONAS_DATE);
  events.push({
    height_ft: JONAS_TARGET_NAVD88_FT,
    height_mllw_ft: JONAS_TARGET_MLLW_FT,
    date: JONAS_DATE,
    display_date: "January 23, 2016",
    datum: "NAVD88",
    site_no: "01411360",
    station_name: "Great Channel at Stone Harbor NJ",
    station_short: "Stone Harbor",
    source_area: "north-wildwood-calibrated",
    station_priority: 4,
    event_name: "Winter Storm Jonas",
    record_type: "North Wildwood documented crest; Stone Harbor 15-minute gauge shape scaled to 9.44 ft MLLW",
    time_est: "08:15"
  });
  events.sort((a, b) => Number(b.height_ft) - Number(a.height_ft) || String(a.date).localeCompare(String(b.date)));
  payload.schema = "north-wildwood-stone-harbor-gauge-crests-v1";
  payload.minimumIncludedStageFt = THRESHOLDS_NAVD88.minorLow;
  payload.thresholdsNAVD88 = THRESHOLDS_NAVD88;
  payload.thresholdsMLLW = THRESHOLDS_MLLW;
  payload.navd88OffsetFromMllwFt = NAVD_OFFSET_FROM_MLLW_FT;
  payload.toptides = events;
  writeJson("toptides.json", payload);
}

updateForecast();
updateObserved15Minute();
updateObservedHourly();
updateLewesArchive();
updateTopTides();
console.log("Prepared North Wildwood forecast and historical archives.");
