import fs from "node:fs/promises";
import path from "node:path";

const endpoint = "http://173.15.136.30/datawise/DashBoards/getSingleSensorData.php";
const outputDir = path.resolve("city-gauge/data");
const currentYear = new Date().getUTCFullYear();
const years = Array.from({ length: currentYear - 2017 + 1 }, (_, index) => 2017 + index);
const gapMs = 30 * 60 * 1000;
const eventSeparationMs = 6 * 60 * 60 * 1000;
const isolatedSpikeThresholdFt = 3;
const northNavd88OffsetFromMllwFt = -2.75;
const floodThresholds = {
  minor: 3.25,
  moderate: 4.25,
  major: 5.25,
};

function toNavd88(mllwFeet) {
  return mllwFeet + northNavd88OffsetFromMllwFt;
}

function isUsableValue(value) {
  return Number.isFinite(value) && value > -20 && value < 20;
}

function isIsolatedSpike(previous, current, next, previousTime, currentTime, nextTime) {
  if (![previous, current, next].every((row) => isUsableValue(row[1]))) return false;
  if (currentTime - previousTime > gapMs || nextTime - currentTime > gapMs) return false;
  const fromPrevious = current[1] - previous[1];
  const fromNext = current[1] - next[1];
  return (
    (fromPrevious >= isolatedSpikeThresholdFt && fromNext >= isolatedSpikeThresholdFt) ||
    (fromPrevious <= -isolatedSpikeThresholdFt && fromNext <= -isolatedSpikeThresholdFt)
  );
}

function parseReadings(xml) {
  const readings = [];
  for (const match of xml.matchAll(/<marker\s+v\d+="([^"]+)"\s*\/>/g)) {
    const separator = match[1].lastIndexOf(",");
    if (separator === -1) continue;
    readings.push([
      match[1].slice(0, separator),
      Number(match[1].slice(separator + 1)),
    ]);
  }
  return readings;
}

function readingTime(timestamp) {
  return Date.parse(`${timestamp.replace(" ", "T")}Z`);
}

function findFloodEvents(payloads) {
  const readings = payloads.flatMap((payload) => payload.readings);
  const candidates = [];
  if (readings.length < 3) return candidates;

  let previous = readings[0];
  let current = readings[1];
  let previousTime = readingTime(previous[0]);
  let currentTime = readingTime(current[0]);
  for (let index = 2; index < readings.length; index += 1) {
    const next = readings[index];
    const nextTime = readingTime(next[0]);
    if (
      isUsableValue(previous[1]) &&
      isUsableValue(current[1]) &&
      isUsableValue(next[1]) &&
      !isIsolatedSpike(previous, current, next, previousTime, currentTime, nextTime) &&
      currentTime - previousTime <= gapMs &&
      nextTime - currentTime <= gapMs &&
      current[1] > previous[1] &&
      current[1] >= next[1]
    ) {
      candidates.push({
        timestamp: current[0],
        value: toNavd88(current[1]),
        sourceValueMllw: current[1],
        time: currentTime,
      });
    }
    previous = current;
    current = next;
    previousTime = currentTime;
    currentTime = nextTime;
  }

  const events = [];
  let cluster = null;
  for (const candidate of candidates) {
    if (!cluster) {
      cluster = candidate;
      continue;
    }
    if (candidate.time - cluster.time < eventSeparationMs) {
      if (candidate.value > cluster.value) cluster = candidate;
    } else {
      if (cluster.value >= floodThresholds.minor) events.push(cluster);
      cluster = candidate;
    }
  }
  if (cluster?.value >= floodThresholds.minor) events.push(cluster);
  return events;
}

function buildAnnualFlooding(payloads) {
  const eventsByYear = new Map(years.map((year) => [year, []]));
  for (const event of findFloodEvents(payloads)) {
    eventsByYear.get(Number(event.timestamp.slice(0, 4)))?.push(event);
  }

  return {
    unit: "ft NAVD88",
    sourceDatum: "MLLW",
    navd88OffsetFromMllwFt: northNavd88OffsetFromMllwFt,
    thresholds: floodThresholds,
    eventDefinition: {
      method: "Local tide peaks grouped into distinct tide windows",
      separationHours: eventSeparationMs / 3_600_000,
      maximumGapMinutes: gapMs / 60_000,
      classification: "Each event is counted once at the highest category reached",
    },
    years: payloads.map((payload) => {
      const events = eventsByYear.get(payload.year) ?? [];
      const counts = { minor: 0, moderate: 0, major: 0 };
      for (const event of events) {
        if (event.value >= floodThresholds.major) counts.major += 1;
        else if (event.value >= floodThresholds.moderate) counts.moderate += 1;
        else counts.minor += 1;
      }
      let annualMaximum = null;
      let isolatedSpikeCount = 0;
      for (let index = 0; index < payload.readings.length; index += 1) {
        const [, value] = payload.readings[index];
        const previous = payload.readings[index - 1];
        const next = payload.readings[index + 1];
        const spike = previous && next && isIsolatedSpike(
          previous,
          payload.readings[index],
          next,
          readingTime(previous[0]),
          readingTime(payload.readings[index][0]),
          readingTime(next[0]),
        );
        if (spike) {
          isolatedSpikeCount += 1;
          continue;
        }
        const navd88 = toNavd88(value);
        if (isUsableValue(value) && (annualMaximum === null || navd88 > annualMaximum)) {
          annualMaximum = navd88;
        }
      }
      return {
        year: payload.year,
        coverage: payload.firstTimestamp?.startsWith(`${payload.year}-01-01`) &&
          payload.lastTimestamp?.startsWith(`${payload.year}-12-31`)
          ? "complete"
          : "partial",
        minor: counts.minor,
        moderate: counts.moderate,
        major: counts.major,
        total: events.length,
        annualMaximum,
        isolatedSpikeCount,
      };
    }),
  };
}

async function fetchYear(year) {
  const url = new URL(endpoint);
  url.searchParams.set("sid", "1005");
  url.searchParams.set("start", `01/01/${year} 00:00:00`);
  url.searchParams.set("end", `01/01/${year + 1} 00:00:00`);
  const response = await fetch(url, { signal: AbortSignal.timeout(240_000) });
  if (!response.ok) throw new Error(`${year}: HTTP ${response.status}`);
  const readings = parseReadings(await response.text());
  const usable = readings.filter(([, value]) => isUsableValue(value));
  let duplicateTimestampRows = 0;
  const seen = new Set();
  for (const [timestamp] of readings) {
    if (seen.has(timestamp)) duplicateTimestampRows += 1;
    seen.add(timestamp);
  }
  const payload = {
    schema: "north-wildwood-city-gauge-year-v1",
    sensor: {
      id: 1005,
      name: "North Wildwood Tide",
      unit: "ft",
      latitude: 39.007469,
      longitude: -74.798737,
      datum: "MLLW",
      displayDatum: "NAVD88",
      navd88OffsetFromMllwFt: northNavd88OffsetFromMllwFt,
    },
    source: {
      owner: "City of North Wildwood",
      system: "Datawise municipal weather station",
      endpoint,
      retrievedAt: new Date().toISOString(),
      datumConversionSource: "https://ready.northwildwood.com/wp-content/uploads/2021/02/2021-OEM-NGVD88-MLLW-reference-1.pdf",
    },
    year,
    firstTimestamp: readings[0]?.[0] ?? null,
    lastTimestamp: readings.at(-1)?.[0] ?? null,
    recordCount: readings.length,
    usableRecordCount: usable.length,
    flaggedRecordCount: readings.length - usable.length,
    duplicateTimestampRows,
    readings,
  };
  await fs.writeFile(path.join(outputDir, `${year}.json`), `${JSON.stringify(payload)}\n`);
  console.log(JSON.stringify({
    year,
    records: payload.recordCount,
    first: payload.firstTimestamp,
    last: payload.lastTimestamp,
  }));
  return payload;
}

await fs.mkdir(outputDir, { recursive: true });
const payloads = [];
let nextIndex = 0;

async function worker() {
  while (nextIndex < years.length) {
    payloads.push(await fetchYear(years[nextIndex++]));
  }
}

if (process.argv.includes("--from-existing")) {
  for (const year of years) {
    const payload = JSON.parse(await fs.readFile(path.join(outputDir, `${year}.json`), "utf8"));
    payload.sensor = {
      ...payload.sensor,
      datum: "MLLW",
      displayDatum: "NAVD88",
      navd88OffsetFromMllwFt: northNavd88OffsetFromMllwFt,
    };
    payload.source = {
      ...payload.source,
      datumConversionSource: "https://ready.northwildwood.com/wp-content/uploads/2021/02/2021-OEM-NGVD88-MLLW-reference-1.pdf",
    };
    payloads.push(payload);
  }
} else {
  await Promise.all([worker(), worker()]);
}
payloads.sort((a, b) => a.year - b.year);
const nonempty = payloads.filter((payload) => payload.recordCount > 0);
const index = {
  schema: "north-wildwood-city-gauge-index-v1",
  generatedAt: new Date().toISOString(),
  sensor: payloads[0]?.sensor ?? null,
  source: payloads[0]?.source ?? null,
  coverage: {
    firstTimestamp: nonempty[0]?.firstTimestamp ?? null,
    lastTimestamp: nonempty.at(-1)?.lastTimestamp ?? null,
    recordCount: payloads.reduce((sum, payload) => sum + payload.recordCount, 0),
    usableRecordCount: payloads.reduce((sum, payload) => sum + payload.usableRecordCount, 0),
    flaggedRecordCount: payloads.reduce((sum, payload) => sum + payload.flaggedRecordCount, 0),
    duplicateTimestampRows: payloads.reduce((sum, payload) => sum + payload.duplicateTimestampRows, 0),
  },
  annualFlooding: buildAnnualFlooding(payloads),
  years: payloads.map((payload) => ({
    year: payload.year,
    path: `data/${payload.year}.json`,
    firstTimestamp: payload.firstTimestamp,
    lastTimestamp: payload.lastTimestamp,
    recordCount: payload.recordCount,
    usableRecordCount: payload.usableRecordCount,
    flaggedRecordCount: payload.flaggedRecordCount,
    duplicateTimestampRows: payload.duplicateTimestampRows,
  })),
};
await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ coverage: index.coverage }));
