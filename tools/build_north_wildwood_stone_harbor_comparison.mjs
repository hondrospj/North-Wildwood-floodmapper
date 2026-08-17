import fs from "node:fs/promises";
import path from "node:path";

const northDataDir = path.resolve("city-gauge/data");
const outputDir = path.resolve("city-gauge/comparison");
const currentYear = new Date().getUTCFullYear();
const years = Array.from({ length: currentYear - 2017 + 1 }, (_, index) => 2017 + index);
const stoneSite = "01411360";
const stoneParameter = "72279";
const northOffsetFt = -2.75;
const quarterMs = 15 * 60 * 1000;
const maxInterpolationGapMs = 30 * 60 * 1000;
const isolatedSpikeThresholdFt = 3;
const schema = "north-wildwood-stone-harbor-comparison-year-v2";

function epoch(timestamp) {
  const [date, time] = timestamp.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const marchDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const novemberDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const dstStart = Date.UTC(year, 2, 8 + (7 - marchDay) % 7, 2);
  const dstEnd = Date.UTC(year, 10, 1 + (7 - novemberDay) % 7, 2);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  return wall + (wall >= dstStart && wall < dstEnd ? 4 : 5) * 3_600_000;
}

function deduplicate(rows) {
  const values = new Map();
  for (const row of rows) {
    if (Number.isFinite(row.time) && Number.isFinite(row.value)) values.set(row.time, row.value);
  }
  return [...values].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);
}

function removeIsolatedSpikes(rows) {
  const kept = [];
  let excluded = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const next = rows[index + 1];
    const close = previous && next && current.time - previous.time <= maxInterpolationGapMs && next.time - current.time <= maxInterpolationGapMs;
    const fromPrevious = close ? current.value - previous.value : 0;
    const fromNext = close ? current.value - next.value : 0;
    const isolated = close && (
      (fromPrevious >= isolatedSpikeThresholdFt && fromNext >= isolatedSpikeThresholdFt) ||
      (fromPrevious <= -isolatedSpikeThresholdFt && fromNext <= -isolatedSpikeThresholdFt)
    );
    if (isolated) excluded += 1;
    else kept.push(current);
  }
  return { rows: kept, excluded };
}

async function fetchJson(url, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "North-Wildwood-city-gauge-comparison/1.0" },
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
    }
  }
  throw new Error(`USGS request failed: ${lastError}`);
}

function usgsUrl(start, end) {
  const url = new URL("https://waterservices.usgs.gov/nwis/iv/");
  url.searchParams.set("format", "json");
  url.searchParams.set("sites", stoneSite);
  url.searchParams.set("parameterCd", stoneParameter);
  url.searchParams.set("startDT", new Date(start).toISOString());
  url.searchParams.set("endDT", new Date(end).toISOString());
  url.searchParams.set("siteStatus", "all");
  return url;
}

function parseStone(payload) {
  const rows = [];
  for (const series of payload?.value?.timeSeries ?? []) {
    for (const bucket of series?.values ?? []) {
      for (const row of bucket?.value ?? []) {
        const time = Date.parse(row.dateTime);
        const value = Number(row.value);
        if (Number.isFinite(time) && Number.isFinite(value) && Math.abs(value) < 100) rows.push({ time, value });
      }
    }
  }
  return rows;
}

async function fetchStoneYear(year) {
  const now = Date.now();
  const start = Date.UTC(year, 0, 1) - 86_400_000;
  const end = Math.min(now, Date.UTC(year + 1, 0, 1) + 86_400_000);
  const rows = [];
  for (let cursor = start; cursor < end;) {
    const chunkEnd = Math.min(end, cursor + 89 * 86_400_000);
    const payload = await fetchJson(usgsUrl(cursor, chunkEnd));
    rows.push(...parseStone(payload));
    cursor = chunkEnd + 1;
  }
  return deduplicate(rows);
}

function interpolate(series, anchor, state) {
  while (state.index + 1 < series.length && series[state.index + 1].time < anchor) state.index += 1;
  const before = series[state.index];
  const after = series[state.index + 1];
  if (before?.time === anchor) return before.value;
  if (after?.time === anchor) return after.value;
  if (!before || !after || before.time > anchor || after.time < anchor || after.time - before.time > maxInterpolationGapMs) return null;
  return before.value + (after.value - before.value) * ((anchor - before.time) / (after.time - before.time));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function correlation(pairs) {
  if (pairs.length < 3) return null;
  let sumNorth = 0;
  let sumStone = 0;
  for (const pair of pairs) {
    sumNorth += pair.north;
    sumStone += pair.stone;
  }
  const meanNorth = sumNorth / pairs.length;
  const meanStone = sumStone / pairs.length;
  let numerator = 0;
  let northSquares = 0;
  let stoneSquares = 0;
  for (const pair of pairs) {
    const northDelta = pair.north - meanNorth;
    const stoneDelta = pair.stone - meanStone;
    numerator += northDelta * stoneDelta;
    northSquares += northDelta ** 2;
    stoneSquares += stoneDelta ** 2;
  }
  const denominator = Math.sqrt(northSquares * stoneSquares);
  return denominator ? numerator / denominator : null;
}

function round(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function comparisonStats(pairs) {
  if (!pairs.length) return { pairCount: 0 };
  const differences = pairs.map((pair) => pair.north - pair.stone).sort((a, b) => a - b);
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const mae = differences.reduce((sum, value) => sum + Math.abs(value), 0) / differences.length;
  const rmse = Math.sqrt(differences.reduce((sum, value) => sum + value ** 2, 0) / differences.length);
  return {
    pairCount: pairs.length,
    meanDifferenceFt: round(mean),
    medianDifferenceFt: round(percentile(differences, 0.5)),
    meanAbsoluteDifferenceFt: round(mae),
    rmseFt: round(rmse),
    p05DifferenceFt: round(percentile(differences, 0.05)),
    p95DifferenceFt: round(percentile(differences, 0.95)),
    correlation: round(correlation(pairs), 4),
  };
}

function findPeaks(values, startTime) {
  const candidates = [];
  for (let index = 1; index + 1 < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    const next = values[index + 1];
    if (current !== null && previous !== null && next !== null && current > previous && current >= next) {
      candidates.push({ time: startTime + index * quarterMs, value: current });
    }
  }
  const peaks = [];
  let cluster = null;
  for (const candidate of candidates) {
    if (!cluster) cluster = candidate;
    else if (candidate.time - cluster.time < 6 * 3_600_000) {
      if (candidate.value > cluster.value) cluster = candidate;
    } else {
      peaks.push(cluster);
      cluster = candidate;
    }
  }
  if (cluster) peaks.push(cluster);
  return peaks;
}

function matchPeaks(northValues, stoneValues, startTime) {
  const northPeaks = findPeaks(northValues, startTime);
  const stonePeaks = findPeaks(stoneValues, startTime);
  const matches = [];
  const used = new Set();
  for (const north of northPeaks) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < stonePeaks.length; index += 1) {
      if (used.has(index)) continue;
      const distance = Math.abs(stonePeaks[index].time - north.time);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
      if (stonePeaks[index].time > north.time + 3 * 3_600_000) break;
    }
    if (bestIndex >= 0 && bestDistance <= 3 * 3_600_000) {
      used.add(bestIndex);
      const stone = stonePeaks[bestIndex];
      matches.push([Math.round(north.time / 1_000), Math.round(stone.time / 1_000), Math.round(north.value * 100), Math.round(stone.value * 100)]);
    }
  }
  return matches;
}

function peakStats(matches) {
  if (!matches.length) return { matchedPeakCount: 0 };
  const heightDifferences = matches.map((row) => (row[2] - row[3]) / 100).sort((a, b) => a - b);
  const lags = matches.map((row) => (row[1] - row[0]) / 60).sort((a, b) => a - b);
  return {
    matchedPeakCount: matches.length,
    medianPeakHeightDifferenceFt: round(percentile(heightDifferences, 0.5)),
    meanPeakHeightDifferenceFt: round(heightDifferences.reduce((sum, value) => sum + value, 0) / heightDifferences.length),
    medianStoneHarborLagMinutes: round(percentile(lags, 0.5), 1),
    meanStoneHarborLagMinutes: round(lags.reduce((sum, value) => sum + value, 0) / lags.length, 1),
  };
}

function lagStats(northValues, stoneValues) {
  let best = { stoneHarborLagMinutes: 0, correlation: -Infinity, pairCount: 0 };
  for (let lagSteps = -8; lagSteps <= 8; lagSteps += 1) {
    const pairs = [];
    for (let index = 0; index < northValues.length; index += 1) {
      const stoneIndex = index + lagSteps;
      if (stoneIndex < 0 || stoneIndex >= stoneValues.length) continue;
      if (northValues[index] !== null && stoneValues[stoneIndex] !== null) pairs.push({ north: northValues[index], stone: stoneValues[stoneIndex] });
    }
    const value = correlation(pairs);
    if (value !== null && value > best.correlation) best = { stoneHarborLagMinutes: lagSteps * 15, correlation: value, pairCount: pairs.length };
  }
  return { ...best, correlation: round(best.correlation, 4) };
}

async function existingPayload(year, northRecordCount) {
  if (year >= currentYear) return null;
  try {
    const payload = JSON.parse(await fs.readFile(path.join(outputDir, `${year}.json`), "utf8"));
    return payload.schema === schema && payload.sources?.northWildwood?.recordCount === northRecordCount ? payload : null;
  } catch {
    return null;
  }
}

async function buildYear(year) {
  const northPayload = JSON.parse(await fs.readFile(path.join(northDataDir, `${year}.json`), "utf8"));
  const cached = await existingPayload(year, northPayload.recordCount);
  if (cached) {
    console.log(JSON.stringify({ year, status: "reused", pairs: cached.stats.pairCount }));
    return cached;
  }
  const northFiltered = removeIsolatedSpikes(deduplicate(northPayload.readings.map(([timestamp, value]) => ({ time: epoch(timestamp), value: value + northOffsetFt }))));
  const north = northFiltered.rows;
  const stone = await fetchStoneYear(year);
  if (!north.length || !stone.length) throw new Error(`${year}: one or both gauges returned no usable values`);
  const startTime = Math.ceil(Math.max(north[0].time, stone[0].time) / quarterMs) * quarterMs;
  const endTime = Math.floor(Math.min(north.at(-1).time, stone.at(-1).time) / quarterMs) * quarterMs;
  const northValues = [];
  const stoneValues = [];
  const points = [];
  const northState = { index: 0 };
  const stoneState = { index: 0 };
  const pairs = [];
  for (let anchor = startTime; anchor <= endTime; anchor += quarterMs) {
    const northValue = interpolate(north, anchor, northState);
    const stoneValue = interpolate(stone, anchor, stoneState);
    northValues.push(northValue);
    stoneValues.push(stoneValue);
    if (northValue !== null && stoneValue !== null) {
      points.push([Math.round(anchor / 1_000), Math.round(northValue * 100), Math.round(stoneValue * 100)]);
      pairs.push({ north: northValue, stone: stoneValue });
    }
  }
  const peakMatches = matchPeaks(northValues, stoneValues, startTime);
  const payload = {
    schema,
    year,
    datum: "NAVD88",
    intervalMinutes: 15,
    sources: {
      northWildwood: { stationId: "1005", name: "North Wildwood City Gauge", sourceDatum: "MLLW", navd88OffsetFromMllwFt: northOffsetFt, recordCount: northPayload.recordCount },
      stoneHarbor: { stationId: stoneSite, parameterCode: stoneParameter, name: "USGS Great Channel at Stone Harbor", datum: "NAVD88", sourceResolutionMinutes: 6 },
    },
    method: "Both gauges linearly interpolated to common UTC quarter-hour anchors; gaps over 30 minutes excluded",
    quality: { northWildwoodIsolatedSpikesExcluded: northFiltered.excluded, isolatedSpikeThresholdFt },
    firstTimestampUtc: points.length ? new Date(points[0][0] * 1_000).toISOString() : null,
    lastTimestampUtc: points.length ? new Date(points.at(-1)[0] * 1_000).toISOString() : null,
    stats: comparisonStats(pairs),
    lag: lagStats(northValues, stoneValues),
    peaks: peakStats(peakMatches),
    encoding: { points: "[UTC epoch seconds, North Wildwood NAVD88 hundredths ft, Stone Harbor NAVD88 hundredths ft]", peakMatches: "[North peak UTC seconds, Stone peak UTC seconds, North NAVD88 hundredths ft, Stone NAVD88 hundredths ft]" },
    points,
    peakMatches,
  };
  await fs.writeFile(path.join(outputDir, `${year}.json`), `${JSON.stringify(payload)}\n`);
  console.log(JSON.stringify({ year, status: "built", pairs: points.length, meanDifferenceFt: payload.stats.meanDifferenceFt, correlation: payload.stats.correlation }));
  return payload;
}

await fs.mkdir(outputDir, { recursive: true });
const payloads = [];
for (const year of years) payloads.push(await buildYear(year));
const allPairs = payloads.flatMap((payload) => payload.points.map((row) => ({ north: row[1] / 100, stone: row[2] / 100 })));
const allPeakMatches = payloads.flatMap((payload) => payload.peakMatches);
const index = {
  schema: "north-wildwood-stone-harbor-comparison-index-v2",
  generatedAt: new Date().toISOString(),
  datum: "NAVD88",
  differenceDefinition: "North Wildwood minus Stone Harbor",
  sources: payloads[0]?.sources ?? null,
  method: payloads[0]?.method ?? null,
  coverage: {
    firstTimestampUtc: payloads.find((payload) => payload.firstTimestampUtc)?.firstTimestampUtc ?? null,
    lastTimestampUtc: [...payloads].reverse().find((payload) => payload.lastTimestampUtc)?.lastTimestampUtc ?? null,
  },
  stats: comparisonStats(allPairs),
  peaks: peakStats(allPeakMatches),
  years: payloads.map((payload) => ({
    year: payload.year,
    path: `comparison/${payload.year}.json`,
    status: Math.abs(payload.stats.medianDifferenceFt ?? 0) > 0.75 || (payload.stats.correlation ?? 1) < 0.9 ? "review" : "aligned",
    stats: payload.stats,
    lag: payload.lag,
    peaks: payload.peaks,
    quality: payload.quality,
    firstTimestampUtc: payload.firstTimestampUtc,
    lastTimestampUtc: payload.lastTimestampUtc,
  })),
};
await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ comparison: { coverage: index.coverage, stats: index.stats, peaks: index.peaks } }));
