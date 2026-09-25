"""Exercise the dated crests, intervening limbs, refreshes and expiration."""
import copy
import json
from datetime import datetime, timedelta
from pathlib import Path
from test_north_wildwood_forecast_generation import generator
from north_wildwood_tide_anchors import anchor_mean_curve, collect_source_hours, minimum_below_mean

g = generator()
zone = g['ZONES'][0]
fixture = json.loads((Path(__file__).parent / 'fixtures/north-wildwood-tide-anchors-20260925.json').read_text())['hours']


def scenarios(source):
    raw = {key: [{**h, 'rawPetssValue': h['rawPetssValue'] + delta} for h in source]
           for key, delta in [('lowEnd', 0), ('mean', .4), ('highEnd', .9)]}
    return g['remap_percentiles'](raw, zone)


def fit(rows, source):
    return anchor_mean_curve(rows, source, zone['navd88OffsetFromMllwFt'], g['stage_key'])


source_before = copy.deepcopy(fixture)
before = scenarios(fixture)
after = copy.deepcopy(before)
plans = fit(after['mean'], fixture)
assert fixture == source_before
assert after['highEnd'] == before['highEnd']
assert [(p['peakTimeUtc'], p['targetMllwFt']) for p in plans] == [
    ('2026-09-26T00:00:00Z', 7.6), ('2026-09-26T13:00:00Z', 7.9),
    ('2026-09-27T01:00:00Z', 7.5)]
old_by_time = {h['timeUtc']: h for h in before['mean']}
for p in plans:
    lobe = [h for h in after['mean'] if p['leftTimeUtc'] <= h['timeUtc'] <= p['rightTimeUtc']]
    peak = max(lobe, key=lambda h: h['mllwStageFt'])
    assert peak['timeUtc'] == p['peakTimeUtc']
    assert peak['mllwStageFt'] == p['targetMllwFt']
    for trough in [lobe[0], lobe[-1]]:
        assert trough['mllwStageFt'] == old_by_time[trough['timeUtc']]['mllwStageFt']
    for left, right in zip(lobe, lobe[1:]):
        original_change = old_by_time[right['timeUtc']]['mllwStageFt'] - old_by_time[left['timeUtc']]['mllwStageFt']
        new_change = right['mllwStageFt'] - left['mllwStageFt']
        assert new_change * original_change >= 0, 'Preserve the rise/fall direction'
        for fraction in [.25, .5, .75]:
            value = left['mllwStageFt'] + fraction * new_change
            assert value <= p['targetMllwFt'], 'Quarter-hour interpolation must not overshoot'
for h in after['mean']:
    if not any(p['leftTimeUtc'] <= h['timeUtc'] <= p['rightTimeUtc'] for p in plans):
        assert h == old_by_time[h['timeUtc']], 'Other tides must remain unchanged'
    assert abs(h['mllwStageFt'] - h['navd88StageFt'] - 2.75) < 1e-9
    assert (h['matchedStageKey'], h['wasClamped']) == g['stage_key'](h['navd88StageFt'])
once = copy.deepcopy(after['mean'])
fit(after['mean'], fixture)
assert after['mean'] == once, 'Repeated fitting must not compound the anchor'
minimum = minimum_below_mean(after['mean'], g['stage_key'])
for low, mean in zip(minimum, after['mean']):
    for field in ['mllwStageFt', 'navd88StageFt']:
        assert abs((mean[field] - low[field]) * 12 - 2) < 1e-9
for left, right, low_left, low_right in zip(after['mean'], after['mean'][1:], minimum, minimum[1:]):
    for fraction in [.25, .5, .75]:
        mean_value = left['navd88StageFt'] + fraction * (right['navd88StageFt'] - left['navd88StageFt'])
        low_value = low_left['navd88StageFt'] + fraction * (low_right['navd88StageFt'] - low_left['navd88StageFt'])
        assert abs((mean_value - low_value) * 12 - 2) < 1e-9

# A newer model cycle moves the source levels, but retains the requested crests.
new_source = [{**h, 'rawPetssValue': h['rawPetssValue'] + .3} for h in fixture]
new_mean = scenarios(new_source)['mean']
new_plans = fit(new_mean, collect_source_hours(new_source, fixture))
for p in new_plans:
    assert max(h['mllwStageFt'] for h in new_mean if p['leftTimeUtc'] <= h['timeUtc'] <= p['rightTimeUtc']) == p['targetMllwFt']

# A later forecast horizon must not turn its first remaining row into a new peak.
for start in ['2026-09-25T20:00:00Z', '2026-09-26T02:00:00Z', '2026-09-26T14:00:00Z', '2026-09-27T03:00:00Z']:
    remaining = [h for h in fixture if h['timeUtc'] >= start]
    context = collect_source_hours(remaining, fixture)
    mean = scenarios(remaining)['mean']
    fit(mean, context)
    assert mean == [h for h in once if h['timeUtc'] >= start]

# No recurring Friday/Saturday override, and no extrapolation onto later tides.
for days in [2, 7, 365]:
    future = [{**h, 'timeUtc': (datetime.fromisoformat(h['timeUtc'].replace('Z', '+00:00')) + timedelta(days=days)).isoformat().replace('+00:00', 'Z')}
              for h in fixture if h['timeUtc'] >= '2026-09-26T00:00:00Z']
    mean = scenarios(future)['mean']
    saved = copy.deepcopy(mean)
    assert fit(mean, fixture) == []
    assert mean == saved

# Missing the earlier trough is an error, not a guess at the anchor shape.
try:
    tail = [h for h in fixture if h['timeUtc'] >= '2026-09-25T23:00:00Z']
    fit(scenarios(tail)['mean'], tail)
    raise AssertionError('Missing source context must fail')
except ValueError as error:
    assert 'Missing source trough' in str(error)

print('Passed three exact Mean peaks, two-inch Minimum gap, unchanged Maximum/other tides, trough continuity, limb direction, quarter-hour bounds, datums, raster keys, idempotency, new cycles, advancing horizons, and dated expiration')
