"""Check scheduled generation against raw NOAA values, including one adjustment."""
from pathlib import Path
from statistics import NormalDist
from datetime import datetime
import copy
import json
import math
import re
import textwrap

ROOT = Path(__file__).resolve().parents[1]

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
        datetime.fromisoformat(source['issuedUtc'].replace('Z', '+00:00')))
    result.pop('zoneId', None)
    result.pop('zoneName', None)
    return result

if __name__ == '__main__':
    source = json.loads((ROOT / 'forecast.json').read_text())
    result = rebuild(source)
    assert result['scenarioVersion'] == 'p01-p10-p25-minus-025-v1'
    assert result['scenarioAdjustmentFt'] == -0.25
    assert result['forecasts'] == source['forecasts'], 'Raw NOAA products must stay intact'
    lower = {h['timeUtc']: h['rawPetssValue'] for h in source['forecasts']['lowEnd']['hours']}
    center = {h['timeUtc']: h['rawPetssValue'] for h in source['forecasts']['mean']['hours']}
    ratios = {k: NormalDist().inv_cdf(p) / NormalDist().inv_cdf(.1)
              for k, p in [('lowEnd', .01), ('mean', .1), ('highEnd', .25)]}
    total = 0
    for key, ratio in ratios.items():
        for h in result['scenarioForecasts'][key]['hours']:
            stamp = h['timeUtc']
            unadjusted = lower[stamp] if key == 'mean' else center[stamp] - ratio * max(0, center[stamp] - lower[stamp])
            adjusted = unadjusted - .25
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
    for rows in zip(*(result['scenarioForecasts'][k]['hours'] for k in ['lowEnd', 'mean', 'highEnd'])):
        assert rows[0]['navd88StageFt'] <= rows[1]['navd88StageFt'] <= rows[2]['navd88StageFt']
    assert rebuild(result)['scenarioForecasts'] == result['scenarioForecasts'], 'Repeated jobs must not compound the adjustment'
    assert result['scenarioForecasts'] == source['scenarioForecasts'], 'Published scenarios must match scheduled generation'
    print(f'Passed all {total} scenario-hours, datum conversion, scenario ordering, raster keys, and no double adjustment')
