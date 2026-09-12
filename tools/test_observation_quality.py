"""Behavioral tests for sampling, calibration gates, exposure and trend provenance."""
from pathlib import Path
import json
import math
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from argparse import Namespace

import observation_quality as quality
import update_observed_15min as observed
import merge_north_wildwood_city_gauge as city
import build_parcel_alerts as projection
import build_return_intervals as frequency
import benchmark_north_wildwood_atlas as benchmark


def archive(start, end, slope=0.02):
    days=[];day=start
    origin=datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp()
    while day < end:
        a,b=observed.day_utc_bounds(day);first=int(a.timestamp());n=int((b-a).total_seconds()/900)
        values=[round(100*(1+slope*((first+i*900-origin)/(365.2425*86400)))) for i in range(n)]
        days.append({'d':day.isoformat(),'u':first,'v':values,'q':'M'*n,'s':'S'*n,'g':[0]*n})
        day+=timedelta(days=1)
    return {'qualityPolicyVersion':quality.POLICY_VERSION,'site':'01411360','days':days,
            'archiveStartDate':start.isoformat(),'archiveEndDate':(end-timedelta(days=1)).isoformat()}


class ObservationQualityTests(unittest.TestCase):
    def test_long_gap_is_missing_and_short_interpolation_is_marked(self):
        self.assertTrue(all(observed.interpolate_at(t,[0,11*3600],[1,1]) is None for t in range(900,11*3600,900)))
        day=date(2025,1,1);a,_=observed.day_utc_bounds(day);stamp=int(a.timestamp())
        compact,_=observed.build_compact_day(day,[(stamp,1),(stamp+1800,2)])
        self.assertEqual(compact['v'][:4],[100,150,200,None])
        self.assertEqual(compact['q'][:4],'MIM-');self.assertEqual(compact['g'][:4],[0,1800,0,None])

    def test_ambiguous_times_do_not_become_averaged_measurements(self):
        for value in ['2025-11-02 01:15:00','2025-03-09 02:15:00']:
            with self.assertRaises(ValueError):city.timestamp_second(value)
        self.assertEqual(city.timestamp_second('2025-11-02T01:15:00-05:00')-city.timestamp_second('2025-11-02T01:15:00-04:00'),3600)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'2025.json';p.write_text(json.dumps({'readings':[['2025-11-02 01:15:00',4],['2025-11-02 01:15:00',6]]}))
            rows,counts=city.load_city_readings(Path(d));self.assertEqual(rows,[]);self.assertEqual(counts['ambiguousTimeRows'],2)

    def test_paired_excursion_is_removed_without_changing_raw_source(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'2025.json';p.write_text(json.dumps({'readings':[[f'2025-01-01 00:{m:02}:00',v] for m,v in [(0,4),(3,8),(6,8),(9,4)]]}))
            before=p.read_bytes();rows,counts=city.load_city_readings(Path(d))
            self.assertEqual(len(rows),2);self.assertEqual(counts['isolatedSpikes'],2);self.assertEqual(before,p.read_bytes())

    def test_flagged_city_interval_cannot_override_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'index.json').write_text(json.dumps({'years':[{'status':'review','year':2026,'firstTimestampUtc':'2026-01-01T00:00:00Z','lastTimestampUtc':'2026-12-31T23:59:59Z'}]}))
            (root/'2026.json').write_text(json.dumps({'readings':[['2026-04-18 22:30:00',3.45]]}))
            rows,counts=city.load_city_readings(root,city.calibration_windows(root));self.assertEqual(rows,[])
            self.assertEqual(counts['calibrationExcludedRows'],1)
            stone={'days':[{'d':'2026-04-18','u':1776565800,'v':[378],'q':'M','g':[0]}]}
            days,_=city.merge_compact_days(stone,rows);self.assertEqual(days[0]['v'],[378]);self.assertEqual(days[0]['s'],'S')

    def test_daily_drift_is_rejected_even_in_an_aligned_year(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'index.json').write_text(json.dumps({'years':[{'year':2025,'status':'aligned'}]}))
            points=[]
            for day,offset in [(0,0),(1,-300)]:
                for i in range(96):
                    stone=round(200*math.sin(i/96*4*math.pi))
                    points.append([1735689600+day*86400+i*900,stone+offset,stone])
            (root/'2025.json').write_text(json.dumps({'points':points}))
            windows=city.calibration_windows(root)
            self.assertEqual(windows,[(1735689600,1735689600+95*900)])

    def test_unknown_provenance_and_mixed_station_trends_are_rejected(self):
        with self.assertRaises(ValueError):quality.analytical_samples({'days':[]})
        payload={'qualityPolicyVersion':quality.POLICY_VERSION,'days':[{'u':0,'v':[100,200],'q':'MI','s':'NS','g':[0,900]}]}
        with self.assertRaisesRegex(ValueError,'homogeneous'):quality.analytical_samples(payload,require_single_station=True)
        payload['days'][0]['q']='UU'
        with self.assertRaises(ValueError):quality.analytical_samples(payload)

    def test_annual_exposure_rejects_missing_season_and_long_gap(self):
        payload=archive(date(2019,10,1),date(2020,10,1));rows=quality.analytical_samples(payload)
        self.assertTrue(quality.annual_exposure(rows,2020)['eligible'])
        self.assertFalse(quality.annual_exposure(rows[3000:],2020)['eligible'])
        self.assertFalse(quality.annual_exposure(rows[:500]+rows[529:],2020)['eligible'])
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'observed.json';payload['days'][0]['n']=1;payload['days'][0]['s']='N'+'S'*95
            payload['days'][0]['v'][3]=600;p.write_text(json.dumps(payload))
            result=frequency.continuous_annual_maxima(p)[2020]
            self.assertEqual(result['stationId'],'01411360','Daily city count must not label a Stone Harbor maximum as municipal')
            payload['days']=payload['days'][:10];p.write_text(json.dumps(payload))
            self.assertEqual(frequency.continuous_annual_maxima(p),{})

    def test_partial_months_cannot_define_a_trend(self):
        stamps=[int(datetime(2020+y,m,1,tzinfo=timezone.utc).timestamp()) for y in range(3) for m in range(1,13)]
        with self.assertRaises(RuntimeError):projection.fit_local_gauge_trend(stamps,[1]*len(stamps))

    def test_event_frequency_uses_complete_years_only(self):
        rows = quality.analytical_samples(archive(date(2019,10,1), date(2020,11,1)))
        kept, exposure = quality.complete_water_year_samples(rows)
        self.assertTrue(exposure[2020]['eligible'])
        self.assertFalse(exposure[2021]['eligible'])
        self.assertEqual(len(kept), exposure[2020]['validQuarterHours'])
        self.assertLess(len(kept), len(rows))
        with self.assertRaisesRegex(ValueError, 'No complete'):
            quality.complete_water_year_samples(rows[-96:])

    def test_negative_trend_does_not_write_projection_artifact(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'observed.json';p.write_text(json.dumps(archive(date(2019,1,1),date(2021,1,1),slope=-0.02)))
            slr=root/'slr.json';slr.write_text('{}');output=root/'out'
            with self.assertRaisesRegex(ValueError,'Nonpositive'):
                projection.build(Namespace(output=output,observed=p,trend_observed=None,slr=slr))
            self.assertEqual(list(output.iterdir()),[])

    def test_rising_benchmark_samples_crest(self):
        bottleneck=benchmark.BOTTLENECKS[0]
        routed=benchmark.route_event(benchmark.Hydrograph(5,0.79,0,0.79),bottleneck)
        crest=int(routed["stage_ft"].argmax())
        self.assertEqual(benchmark.route_to_stage(bottleneck,5,0.79),routed["volume_ft3"][crest])
        self.assertNotEqual(routed["volume_ft3"][crest],routed["volume_ft3"][-1])

    def test_rebase_sign_and_qualified_trend(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'observed.json';p.write_text(json.dumps(archive(date(2019,1,1),date(2021,1,1),slope=0.02)))
            times,values,meta=projection.decode_observed_archive(p,require_single_station=True)
            slope,fit=projection.fit_local_gauge_trend(times,values)
            self.assertAlmostEqual(slope,0.02,delta=0.002);self.assertGreaterEqual(fit['monthlyMeanCount'],24)
            self.assertGreater(4+slope*(2026-1950),4)
            self.assertEqual(meta['sourceArchiveSha256'],quality.file_sha256(p))
            self.assertEqual(meta['qualifiedStationIds'], ['01411360'])

    def test_trend_station_comes_from_samples_not_composite_label(self):
        payload = archive(date(2020,1,1), date(2020,1,2))
        payload['site'] = '1005'
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'composite.json'
            path.write_text(json.dumps(payload))
            _, _, meta = projection.decode_observed_archive(path, require_single_station=True)
            self.assertEqual(meta['qualifiedStationIds'], ['01411360'])


if __name__=='__main__':unittest.main()
