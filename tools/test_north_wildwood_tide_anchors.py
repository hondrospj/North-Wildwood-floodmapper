"""Operational PETSS mean must remain unanchored across dates and model refreshes."""
from datetime import datetime, timezone
import copy
from test_north_wildwood_forecast_generation import generator

g = generator()
zone = g['ZONES'][0]
for date in ['2026-09-26', '2026-10-17', '2027-09-26']:
    for shift in [0, .3]:
        rows = [','.join([g['HEADER_ALIASES']['time'][0], 'TWL', 'TWL10p', 'TWL90p', 'Tide', 'Surge'])]
        values = [7.1, 7.3, 7.2, 6.8, 7.0]
        for hour, value in enumerate(values):
            v = value + shift
            rows.append(f'{date}T{hour:02d}:00:00Z,{v},{v+.5},{v-1},{v-.2},.2')
        products = g['parse_station_csv']('\n'.join(rows), zone)
        original = copy.deepcopy(products)
        now = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
        result = g['payload_for_zone'](zone, {'cycleUtc': now}, 'NOAA-fixture', 'station.csv', products, now)
        for key, delta in [('mean', 0), ('lowEnd', -1), ('highEnd', .5)]:
            hours = result['scenarioForecasts'][key]['hours']
            assert len(hours) == len(values)
            for value, record in zip(values, hours):
                expected = value + shift + delta
                assert abs(record['mllwStageFt'] - expected) < .005001
                assert abs(record['navd88StageFt'] - expected - zone['navd88OffsetFromMllwFt']) < .005001
                assert not any('anchor' in field.lower() for field in record)
        assert result['hours'] == result['scenarioForecasts']['mean']['hours']
        for key in original:
            for before, after in zip(original[key], products[key]):
                for field in before:
                    assert after[field] == before[field], ('Issued source value changed', key, field)
print('Passed direct TWL column mapping, independent published bounds, dated-anchor exclusion and new-cycle refreshes')
