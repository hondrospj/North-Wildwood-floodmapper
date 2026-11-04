"""Verify issued PETSS levels plus offline generation and failure recovery."""
from pathlib import Path
from datetime import datetime, timezone
import copy
from contextlib import contextmanager
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def local_http_response(serve):
    """Use a private background HTTP server and stop/join every test thread."""
    stop = threading.Event()
    handlers = []
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def do_GET(self):
            handlers.append(threading.current_thread())
            self.close_connection = True
            try:
                serve(self, stop)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # The client closes its response when the deadline expires.
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/fixture'
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        for handler in handlers:
            handler.join(timeout=2)
        if thread.is_alive() or any(handler.is_alive() for handler in handlers):
            raise RuntimeError('Local HTTP fixture left a running thread')


def generator():
    """Import a fresh, side-effect-free instance for tests that replace globals."""
    path = ROOT / 'tools/update_north_wildwood_forecast.py'
    spec = importlib.util.spec_from_file_location('forecast_generation_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return vars(module)

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

def test_committed_forecast():
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


class ForecastGenerationFixtures(unittest.TestCase):
    """Exercise the scheduled path without NOAA access or repository writes."""

    # This is the byte-for-byte CLI output from the former embedded generator
    # at commit fef860f, with the fixture archive and fixed clock below. It
    # freezes payload schema, numbers, row ordering, dates, and serialization.
    LEGACY_OUTPUT_SHA256 = 'badd5aef498ead04de33f2c8f4ad40ab25caa0224f4e5991c6b9862cce28cd5e'
    NOW = datetime(2026, 10, 23, 3, tzinfo=timezone.utc)

    def setUp(self):
        self.g = generator()
        self.fixture = (ROOT / 'tools/fixtures/north-wildwood-petss-station.csv').read_bytes()

    def archive(self, member='stations/8535581.csv'):
        """A tar fixture includes an almost-matching station to catch bad IDs."""
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for name, content in [('stations/85355810.csv', b'wrong station'), (member, self.fixture)]:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        return output.getvalue()

    def test_offline_cli_matches_legacy_output_bytes(self):
        class FixedClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 23, 3, 37, 48, tzinfo=timezone.utc)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'forecast.json'
            fetch = Mock(return_value=self.archive())
            with patch.dict(self.g, {'OUT_PATH': destination, 'fetch_bytes': fetch, 'datetime': FixedClock}):
                self.g['main']()
            serialized = destination.read_bytes()
        self.assertEqual(hashlib.sha256(serialized).hexdigest(), self.LEGACY_OUTPUT_SHA256)
        data = json.loads(serialized)
        self.assertEqual(data['issuedUtc'], '2026-10-23T03:00:00Z')
        self.assertEqual(data['petssCycleUtc'], '2026-10-23T00:00:00Z')
        self.assertEqual(data['forecastStartUtc'], '2026-10-23T03:00:00Z')
        self.assertEqual(data['forecastEndUtc'], '2026-10-26T18:00:00Z')
        self.assertEqual(len(data['hours']), 85)
        fetch.assert_called_once_with(
            'https://nomads.ncep.noaa.gov/pub/data/nccf/com/petss/prod/petss.20261023/petss.t00z.csv.tar.gz')

    def test_alignment_rejects_missing_bounds_and_uses_last_duplicate(self):
        products = self.g['parse_station_csv'](self.fixture.decode(), self.g['ZONES'][0])
        aligned = self.g['align_products'](products, self.NOW)
        expected_times = [row['timeUtc'] for row in aligned['mean']]
        self.assertEqual(len(expected_times), 85)
        for key in ('lowEnd', 'mean', 'highEnd'):
            self.assertEqual([row['timeUtc'] for row in aligned[key]], expected_times)
            self.assertEqual([row['hourIndex'] for row in aligned[key]], list(range(85)))
        for hour in (4, 7, 11):
            self.assertNotIn(f'2026-10-23T{hour:02}:00:00Z', expected_times)
        replaced = next(row for row in aligned['mean'] if row['timeUtc'] == '2026-10-23T05:00:00Z')
        self.assertEqual(replaced['rawPetssValue'], 2.345)
        self.assertEqual(replaced['navd88StageFt'], -0.4)
        with self.assertRaisesRegex(RuntimeError, 'only 11 usable forecast rows'):
            self.g['align_products']({key: rows[:11] for key, rows in aligned.items()}, self.NOW)

    def test_station_archive_requires_exact_station_id(self):
        with patch.dict(self.g, {'fetch_bytes': Mock(return_value=self.archive())}):
            text, member = self.g['extract_station_csv']('fixture', '8535581')
        self.assertEqual(member, 'stations/8535581.csv')
        self.assertEqual(text, self.fixture.decode())
        with patch.dict(self.g, {'fetch_bytes': Mock(return_value=self.archive('stations/0000000.csv'))}):
            with self.assertRaisesRegex(RuntimeError, 'station CSV 8535581.csv not found'):
                self.g['extract_station_csv']('fixture', '8535581')

    def test_unusable_newest_cycle_falls_back_to_previous_cycle(self):
        fetch = Mock(side_effect=[RuntimeError('missing station'), self.archive()])
        with patch.dict(self.g, {'fetch_bytes': fetch}):
            result = self.g['build_forecast'](self.NOW)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(result['issuedUtc'], '2026-10-23T03:00:00Z')
        self.assertEqual(result['petssCycleUtc'], '2026-10-22T18:00:00Z')
        self.assertEqual(result['forecastStartUtc'], '2026-10-23T03:00:00Z')
        self.assertEqual(result['products']['mean']['petssCycleUtc'], result['petssCycleUtc'])
        self.assertNotIn('zoneId', result)
        self.assertNotIn('zoneName', result)

    def test_cycle_exhaustion_does_not_overwrite_saved_forecast(self):
        cycle = {'ymd': '20261023', 'hh': 0, 'cycleUtc': self.NOW}
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'forecast.json'
            destination.write_bytes(b'previous valid forecast\n')
            with patch.dict(self.g, {
                'OUT_PATH': destination,
                'recent_cycles': Mock(return_value=[cycle]),
                'fetch_bytes': Mock(side_effect=RuntimeError('unavailable')),
            }):
                with self.assertRaisesRegex(RuntimeError, 'No usable PETSS forecast'):
                    self.g['main']()
            self.assertEqual(destination.read_bytes(), b'previous valid forecast\n')

    def test_http_retry_delays_and_request_configuration(self):
        throttled = urllib.error.HTTPError('fixture', 429, 'busy', {}, None)
        disconnected = urllib.error.URLError('disconnected')
        with patch.object(self.g['urllib'].request, 'urlopen', side_effect=[throttled, disconnected, io.BytesIO(b'archive')]) as open_url:
            with patch.object(self.g['time'], 'sleep') as sleep:
                with patch.object(self.g['random'], 'random', return_value=0.25):
                    self.assertEqual(self.g['fetch_bytes']('https://example.invalid/fixture'), b'archive')
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2.5, 4.5])
        self.assertEqual(open_url.call_count, 3)
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'), 'North Wildwood-floodmapper/2.0')
        self.assertEqual(open_url.call_args.kwargs['timeout'], 180)

    def test_http_missing_cycle_fails_immediately_and_transients_stop_at_five(self):
        missing = urllib.error.HTTPError('fixture', 404, 'missing', {}, None)
        with patch.object(self.g['urllib'].request, 'urlopen', side_effect=missing) as open_url:
            with patch.object(self.g['time'], 'sleep') as sleep:
                with self.assertRaises(urllib.error.HTTPError):
                    self.g['fetch_bytes']('https://example.invalid/fixture')
        self.assertEqual(open_url.call_count, 1)
        sleep.assert_not_called()
        failure = urllib.error.URLError('offline')
        with patch.object(self.g['urllib'].request, 'urlopen', side_effect=failure) as open_url:
            with patch.object(self.g['time'], 'sleep') as sleep:
                with patch.object(self.g['random'], 'random', return_value=0):
                    with self.assertRaises(urllib.error.URLError):
                        self.g['fetch_bytes']('https://example.invalid/fixture')
        self.assertEqual(open_url.call_count, 5)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2.0, 4.0, 8.0, 16.0])

    def test_stalled_newest_cycle_leaves_time_for_healthy_older_guidance(self):
        clock = [0.0]
        requests = []
        def transport(request, timeout):
            requests.append((request.full_url, timeout, clock[0]))
            if 'petss.20261023/petss.t00z' in request.full_url:
                clock[0] += timeout
                raise TimeoutError('Latest cycle transport stalled')
            return io.BytesIO(self.archive())
        def advance(seconds):
            clock[0] += seconds
        with patch.object(self.g['urllib'].request, 'urlopen', side_effect=transport):
            with patch.object(self.g['time'], 'monotonic', side_effect=lambda: clock[0]):
                with patch.object(self.g['time'], 'sleep', side_effect=advance):
                    with patch.object(self.g['random'], 'random', return_value=0):
                        result = self.g['build_forecast'](self.NOW)
        older = next(request for request in requests if 'petss.20261022/petss.t18z' in request[0])
        self.assertLess(older[2], 900, 'Healthy fallback must be attempted before the workflow is killed')
        self.assertEqual(older[2], self.g['FETCH_RETRY_BUDGET_SECONDS'])
        self.assertEqual(result['petssCycleUtc'], '2026-10-22T18:00:00Z')
        self.assertEqual(len(result['hours']), 85)
        self.assertEqual([request[1] for request in requests[:2]], [180, 58])

    def test_retry_budget_caps_backoff_without_waiting_past_the_deadline(self):
        clock = [0.0]
        def fail_near_deadline(request, timeout):
            clock[0] += timeout - 1
            raise urllib.error.URLError('Disconnected near the deadline')
        with patch.dict(self.g, {'FETCH_RETRY_BUDGET_SECONDS': 1.0}):
            with patch.object(self.g['urllib'].request, 'urlopen', side_effect=fail_near_deadline) as open_url:
                with patch.object(self.g['time'], 'monotonic', side_effect=lambda: clock[0]):
                    with patch.object(self.g['time'], 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)) as sleep:
                        with patch.object(self.g['random'], 'random', return_value=0):
                            with self.assertRaises(urllib.error.URLError):
                                self.g['fetch_bytes']('https://example.invalid/fixture')
        self.assertEqual(clock[0], 1.0)
        self.assertEqual(open_url.call_count, 1)
        self.assertEqual(sleep.call_args.args[0], 1.0)


    def test_real_http_drip_body_cannot_outlive_transfer_budget(self):
        requests = []
        def drip(handler, stop):
            requests.append(handler.path)
            handler.send_response(200)
            handler.send_header('Content-Length', '100')
            handler.end_headers()
            for _ in range(100):
                handler.wfile.write(b'x')
                handler.wfile.flush()
                if stop.wait(0.04):
                    break
        with local_http_response(drip) as url:
            with patch.dict(self.g, {'FETCH_RETRY_BUDGET_SECONDS': 0.25}):
                started = time.perf_counter()
                with self.assertRaises((TimeoutError, urllib.error.URLError)):
                    self.g['fetch_bytes'](url)
                elapsed = time.perf_counter() - started
        self.assertEqual(len(requests), 1)
        self.assertLess(elapsed, 1.5, 'Progressing bytes must not reset the total transfer deadline')

    def test_real_http_held_body_uses_budget_remaining_after_headers(self):
        timeouts = []
        def held(handler, stop):
            stop.wait(0.08)  # Headers consume part of this request's total budget.
            handler.send_response(200)
            handler.send_header('Content-Length', '1')
            handler.end_headers()
            stop.wait(3)
        original = http.client.HTTPResponse.read1
        def observed_read1(response, size):
            sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
            if sock is not None:
                timeouts.append(sock.gettimeout())
            return original(response, size)
        with local_http_response(held) as url:
            with patch.dict(self.g, {'FETCH_RETRY_BUDGET_SECONDS': 0.30}):
                with patch.object(http.client.HTTPResponse, 'read1', new=observed_read1):
                    with self.assertRaises((TimeoutError, urllib.error.URLError)):
                        self.g['fetch_bytes'](url)
        self.assertTrue(timeouts)
        self.assertGreater(timeouts[0], 0)
        self.assertLess(timeouts[0], 0.26, 'Body read must use the remaining budget, not a fresh timeout')

    def test_real_http_truncated_body_retries_same_cycle_then_succeeds(self):
        requests = []
        def truncated_then_healthy(handler, stop):
            requests.append(handler.path)
            payload = b'partial' if len(requests) == 1 else b'healthy archive'
            handler.send_response(200)
            handler.send_header('Content-Length', str(len(payload) + (6 if len(requests) == 1 else 0)))
            handler.end_headers()
            handler.wfile.write(payload)
            handler.wfile.flush()
        with local_http_response(truncated_then_healthy) as url:
            with patch.object(self.g['time'], 'sleep') as sleep:
                with patch.object(self.g['random'], 'random', return_value=0):
                    self.assertEqual(self.g['fetch_bytes'](url), b'healthy archive')
        self.assertEqual(len(requests), 2)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2.0])


if __name__ == '__main__':
    test_committed_forecast()
    unittest.main()
