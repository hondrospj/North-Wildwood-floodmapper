"""Verify the scheduled generator preserves issued PETSS levels and datum conversion."""
from pathlib import Path
from datetime import datetime
import copy
import json
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
    by_key = {key: {h['timeUtc']: h for h in record['hours']} for key, record in source['forecasts'].items()}
    rows = [','.join([g['HEADER_ALIASES']['time'][0], 'TWL', 'TWL10p', 'TWL90p', 'Tide', 'Surge'])]
    for stamp in sorted(set.intersection(*(set(rows) for rows in by_key.values()))):
        mean = by_key['mean'][stamp]
        values = [stamp, mean['rawPetssValue'], by_key['highEnd'][stamp]['rawPetssValue'], by_key['lowEnd'][stamp]['rawPetssValue'], mean.get('tideMllwFt'), mean.get('surgeFt')]
        rows.append(','.join('' if v is None else str(v) for v in values))
    products = g['parse_station_csv']('\n'.join(rows), g['ZONES'][0])
    result = g['payload_for_zone'](g['ZONES'][0],
        {'cycleUtc': datetime.fromisoformat(source['petssCycleUtc'].replace('Z', '+00:00'))},
        source['sourceUrl'], source['sourceMember'], products,
        datetime.fromisoformat(source['issuedUtc'].replace('Z', '+00:00')))
    result.pop('zoneId', None)
    result.pop('zoneName', None)
    return result

if __name__ == '__main__':
    source = json.loads((ROOT / 'forecast.json').read_text())
    saved = copy.deepcopy(source)
    result = rebuild(source)
    g = generator()
    total = 0
    for key in ['lowEnd', 'mean', 'highEnd']:
        issued = {h['timeUtc']: h for h in source['forecasts'][key]['hours']}
        for h in result['scenarioForecasts'][key]['hours']:
            raw = issued[h['timeUtc']]['rawPetssValue']
            assert abs(h['mllwStageFt'] - raw) <= .005001, (key, h)
            assert abs(h['navd88StageFt'] - (raw + source['navd88OffsetFromMllwFt'])) <= .005001
            assert h['sourceStageFt'] == h['navd88StageFt']
            assert h['twlMllwFt'] == h['mllwStageFt']
            assert (h['matchedStageKey'], h['wasClamped']) == g['stage_key'](h['navd88StageFt'])
            assert not any('anchor' in field.lower() for field in h), 'Operational levels cannot carry a tide anchor'
            total += 1
    assert result['hours'] == result['scenarioForecasts']['mean']['hours']
    assert result['forecasts'] == result['scenarioForecasts']
    assert rebuild(result)['scenarioForecasts'] == result['scenarioForecasts'], 'Repeated jobs changed issued levels'
    assert source == saved, 'Generation mutated input data'
    print(f'Passed {total} issued scenario-hours, independent bounds, mean default, datum conversion, raster keys and idempotency')
