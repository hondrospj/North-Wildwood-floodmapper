import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheIdentity, existingPayload } from './build_north_wildwood_stone_harbor_comparison.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nww-comparison-cache-'));
try {
  const original = JSON.stringify({recordCount:2,readings:[['2020-01-01 00:00:00',3],['2020-01-01 00:15:00',4]]});
  const corrected = original.replace(',3]', ',8]');
  const identity = cacheIdentity(original);
  const payload = {schema:'north-wildwood-stone-harbor-comparison-year-v3',cacheIdentity:identity,sources:{northWildwood:{recordCount:2}},points:[[1,100,100]]};
  const target = path.join(directory,'2020.json');
  await fs.writeFile(target,JSON.stringify(payload));
  assert.deepEqual(await existingPayload(2020,identity,directory),payload);
  assert.equal(await existingPayload(2020,cacheIdentity(corrected),directory),null,'same-count corrected levels invalidate comparison');
  assert.equal(await existingPayload(2020,{...identity,policySha256:'changed-policy'},directory),null,'policy changes invalidate comparison');
  assert.equal(await existingPayload(new Date().getUTCFullYear(),identity,directory),null,'current year always refreshes USGS data');
  delete payload.cacheIdentity;await fs.writeFile(target,JSON.stringify(payload));
  assert.equal(await existingPayload(2020,identity,directory),null,'legacy count-only caches rebuild');
  console.log('5 comparison cache checks passed');
} finally {await fs.rm(directory,{recursive:true,force:true});}
