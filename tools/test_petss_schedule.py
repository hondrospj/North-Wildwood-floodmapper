"""Verify that workflow starts and reruns resolve to the intended NOAA cycle."""
from pathlib import Path
import re
import unittest

from petss_schedule import target_cycle


ROOT = Path(__file__).resolve().parents[1]


class PetssScheduleTest(unittest.TestCase):
    def check_cycle(self, expected, *args):
        self.assertEqual(target_cycle(*args).isoformat(), expected + "+00:00")

    def test_workflow_schedules_all_four_cycles_once(self):
        workflow = (ROOT / ".github/workflows/update-forecast.yml").read_text()
        slots = re.findall(r'^    - cron: "([^"]+)"', workflow, re.M)
        self.assertEqual(slots, [f"40 {hour} * * *" for hour in (0, 6, 12, 18)])
        for slot, hour, expected in zip(slots, (0, 6, 12, 18), (
            "2026-12-31T18:00:00", "2027-01-01T00:00:00",
            "2027-01-01T06:00:00", "2027-01-01T12:00:00",
        )):
            with self.subTest(slot=slot):
                self.check_cycle(expected, f"2027-01-01T{hour:02d}:40:05Z", slot)

    def test_delay_past_another_slot_and_midnight_keeps_original_cycle(self):
        self.check_cycle("2026-11-08T12:00:00", "2026-11-09T02:18:00Z", "40 18 * * *")
        self.check_cycle("2026-11-08T18:00:00", "2026-11-09T08:32:00Z", "40 0 * * *")

    def test_manual_default_switches_when_the_next_cycle_is_due(self):
        self.check_cycle("2026-11-08T12:00:00", "2026-11-09T00:39:59Z")
        self.check_cycle("2026-11-08T18:00:00", "2026-11-09T00:40:00Z")
        self.check_cycle("2026-11-09T00:00:00", "2026-11-09T06:40:00Z")

    def test_explicit_manual_cycle_and_invalid_requests(self):
        queued = "2026-11-09T13:45:00Z"
        cycle = "2026-11-09T12:00:00Z"
        self.check_cycle("2026-11-09T12:00:00", queued, "", cycle)
        for schedule, requested in (("40 14 * * *", ""), ("40 12 * * *", cycle),
                                    ("", "2026-11-09T18:00:00Z"), ("", "2026-11-09T09:00:00Z"),
                                    ("", "2026-11-09T12:01:00Z"), ("", "2026-11-09T07:00:00-05:00")):
            with self.subTest(schedule=schedule, requested=requested):
                with self.assertRaises(ValueError):
                    target_cycle(queued, schedule, requested)


if __name__ == "__main__":
    unittest.main()
