import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./archive_north_wildwood_city_gauge.mjs", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "nww-city-refresh-"));
const data = path.join(scratch, "city-gauge", "data");
const saved = JSON.stringify({
  year: 2017, usableRecordCount: 2, firstTimestamp: "2017-01-01 00:00:00",
  lastTimestamp: "2017-12-31 23:59:00",
});
const index = "previous index";
const marker = row => `<marker v1="${row}" />`;

function run(fault) {
  const source = `
    globalThis.fetch = async url => {
      const year = new URL(url).searchParams.get("start").slice(6, 10);
      const endYear = String(Number(year) + 1);
      const marker = ${marker.toString()};
      const rows = [
        year + "-12-31 23:59:00,3.1",
        year + "-01-01 00:00:00,2.0",
        year + "-02-30 00:00:00,4.0",
        year + "-02-01 00:00:00,",
        endYear + "-01-01 00:00:00,7.0",
      ];
      if (${JSON.stringify(fault)} === "blank" && year === "2018") return new Response("<markers />");
      if (${JSON.stringify(fault)} === "truncated" && year === "2017") rows.shift();
      return new Response(rows.map(marker).join("\\n"));
    };
  `;
  return spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(source), script],
    { cwd: scratch, encoding: "utf8", timeout: 15000 });
}

try {
  await mkdir(data, { recursive: true });
  const firstYear = path.join(data, "2017.json");
  const savedIndex = path.join(data, "index.json");
  await writeFile(firstYear, saved);
  await writeFile(savedIndex, index);

  for (const [fault, error] of [
    ["blank", /2018: municipal gauge returned no usable readings/],
    ["truncated", /2017: municipal gauge response would erase previously archived days/],
  ]) {
    const attempt = run(fault);
    assert.equal(attempt.status, 1, attempt.stderr);
    assert.match(attempt.stderr, error);
    assert.equal(await readFile(firstYear, "utf8"), saved);
    assert.equal(await readFile(savedIndex, "utf8"), index);
  }

  const healthy = run(null);
  assert.equal(healthy.status, 0, healthy.stderr);
  const restored = JSON.parse(await readFile(firstYear, "utf8"));
  assert.deepEqual(restored.readings, [["2017-01-01 00:00:00", 2], ["2017-12-31 23:59:00", 3.1]]);
  assert.equal(restored.recordCount, 2);
  assert.equal(restored.usableRecordCount, 2);
  console.log("Municipal archive refresh rejects empty and truncated responses and preserves valid levels.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
