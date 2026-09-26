"""Check scheduled generation against raw NOAA values with one reduction."""
from pathlib import Path
from statistics import NormalDist
from datetime import datetime
import copy
import json
import math
import re
import sys
import textwrap

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

def generator():
    workflow = (ROOT / '.github/workflows/update-forecast.yml').read_text()
    code = re.search(r"python - <<'PY'\n([\s\S]*?)\n          PY", workflow).group(1)
    namespace = {'__name__': 'forecast_generation_test'}
    exec(compile(textwrap.dedent(code), str(ROOT / '.github/workflows/update-forecast.yml'), 'exec'), namespace)
    return namespace

def rebuild(source):
    g = generator()
    products = {key: copy.deepcopy(record['hours']) for key, record in source['forecasts'].items()}
    result = g['payload_for_zone'](g['ZONES'][0],
        {'cycleUtc': datetime.fromisoformat(source['petssCycleUtc'].replace('Z', '+00:00'))},
        source['sourceUrl'], source['sourceMember'], products,
        datetime.fromisoformat(source['issuedUtc'].replace('Z', '+00:00')),
        source.get('tideAnchorSourceHours', []))
    result.pop('zoneId', None)
    result.pop('zoneName', None)
    return result

if __name__ == '__main__':
    source = json.loads((ROOT / 'forecast.json').read_text())
    result = rebuild(source)
    assert result['scenarioVersion'] == 'mean-anchors-min-minus-2in-max-p25-v4'
    assert result['scenarioAdjustmentFt'] == -0.25
    assert result['minimumOffsetFt'] == -2 / 12
    assert result['forecasts'] == source['forecasts'], 'Raw NOAA products must stay intact'
    lower = {h['timeUtc']: h['rawPetssValue'] for h in source['forecasts']['lowEnd']['hours']}
    center = {h['timeUtc']: h['rawPetssValue'] for h in source['forecasts']['mean']['hours']}
    ratios = {k: NormalDist().inv_cdf(p) / NormalDist().inv_cdf(.1)
              for k, p in [('mean', .1), ('highEnd', .25)]}
    total = 0
    for key, ratio in ratios.items():
        for h in result['scenarioForecasts'][key]['hours']:
            stamp = h['timeUtc']
            unadjusted = lower[stamp] if key == 'mean' else center[stamp] - ratio * max(0, center[stamp] - lower[stamp])
            adjusted = unadjusted - .25 + h.get('tideAnchorAdjustmentFt', 0)
            if key != 'mean':
                assert 'tideAnchorAdjustmentFt' not in h, 'Only Mean may be anchored'
            assert abs(h['mllwStageFt'] - adjusted) <= .005001
            assert abs(h['navd88StageFt'] - (adjusted + source['navd88OffsetFromMllwFt'])) <= .005001
            assert h['sourceStageFt'] == h['navd88StageFt']
            assert h['twlMllwFt'] == h['mllwStageFt']
            assert h['scenarioAdjustmentFt'] == -.25
            assert abs(h['unadjustedTwlMllwFt'] - unadjusted) <= .000501
            assert h['isEstimatedPercentile'] == (key != 'mean')
            clamped = max(-2, min(20, h['navd88StageFt']))
            assert abs(float(h['matchedStageKey']) - math.floor((clamped + 1e-9) / .1) * .1) < 1e-8
            total += 1
    for minimum, mean, maximum in zip(*(result['scenarioForecasts'][k]['hours'] for k in ['lowEnd', 'mean', 'highEnd'])):
        assert minimum['timeUtc'] == mean['timeUtc'] == maximum['timeUtc']
        expected_gap = 2 / 12 - minimum.get('minimumTideAnchorAdjustmentFt', 0)
        for field in ['mllwStageFt', 'navd88StageFt', 'twlMllwFt', 'sourceStageFt']:
            assert abs(mean[field] - minimum[field] - expected_gap) < 1e-9, (field, mean, minimum)
        assert abs(minimum['minimumOffsetFt'] + expected_gap) < 1e-9
        assert minimum['product'] == ('mean_minus_2in_with_tide_anchor' if 'minimumTideAnchorId' in minimum else 'mean_minus_2in')
        assert minimum['percentile'] == ''
        assert minimum['isEstimatedPercentile'] is False
        clamped = max(-2, min(20, minimum['navd88StageFt']))
        assert abs(float(minimum['matchedStageKey']) - math.floor((clamped + 1e-9) / .1) * .1) < 1e-8
        assert minimum['navd88StageFt'] < mean['navd88StageFt']
        if 'tideAnchorId' not in mean:
            assert mean['navd88StageFt'] <= maximum['navd88StageFt']
        total += 1
    assert rebuild(result)['scenarioForecasts'] == result['scenarioForecasts'], 'Repeated jobs must not compound the adjustment'
    assert result['scenarioForecasts'] == source['scenarioForecasts'], 'Published scenarios must match scheduled generation'
    print(f'Passed all {total} scenario-hours, Minimum gap and dated override, datum conversion, raster keys, and no double adjustment')
