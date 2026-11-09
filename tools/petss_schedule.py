#!/usr/bin/env python3
"""Resolve the NOAA cycle for a North Wildwood forecast workflow run."""
import argparse
from datetime import timedelta

from release_data import utc_time


SLOT_HOURS = (0, 6, 12, 18)
SLOT_MINUTE = 40
CYCLE_INTERVAL = timedelta(hours=6)


def target_cycle(queued_at, schedule="", requested_cycle=""):
    queued = utc_time(queued_at, "workflow creation time")
    if schedule:
        slots = {f"{SLOT_MINUTE} {hour} * * *": hour for hour in SLOT_HOURS}
        if schedule not in slots or requested_cycle:
            raise ValueError("Unexpected PETSS schedule or cycle override")
        slot = queued.replace(hour=slots[schedule], minute=SLOT_MINUTE, second=0, microsecond=0)
        if slot > queued:
            slot -= timedelta(days=1)
        return slot.replace(minute=0) - CYCLE_INTERVAL
    if requested_cycle:
        cycle = utc_time(requested_cycle, "requested PETSS cycle")
        if cycle.hour not in SLOT_HOURS or cycle.minute or cycle.second or cycle.microsecond or cycle > queued:
            raise ValueError("Requested PETSS cycle must be a 00Z, 06Z, 12Z or 18Z cycle at or before dispatch")
        return cycle

    adjusted = queued - timedelta(minutes=SLOT_MINUTE)
    slot = adjusted.replace(hour=adjusted.hour // 6 * 6, minute=0, second=0, microsecond=0)
    return slot - CYCLE_INTERVAL


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("queued_at")
    parser.add_argument("schedule", nargs="?", default="")
    parser.add_argument("requested_cycle", nargs="?", default="")
    args = parser.parse_args()
    try:
        cycle = target_cycle(args.queued_at, args.schedule, args.requested_cycle)
    except ValueError as error:
        parser.error(str(error))
    print(cycle.isoformat().replace("+00:00", "Z"))
