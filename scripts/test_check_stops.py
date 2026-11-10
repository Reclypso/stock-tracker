#!/usr/bin/env python3
"""Unit tests for scripts/check_stops.py. No network, no real picks touched."""

from __future__ import annotations

import math
import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

from check_stops import (
    ET,
    apply_stops,
    close_on_or_before,
    ineligible_session_date,
    is_open_long,
    last_completed_session_date,
    prune_prices,
    return_pct,
    usable_number,
)


def pick(**kwargs):
    base = {
        "id": "2026-11-09-FAKE",
        "ticker": "FAKE",
        "company": "Fake Co",
        "dateCalled": "2026-11-09",
        "priceAtCall": 10.0,
        "thesis": "test",
        "grade": "B",
        "stop": 8.0,
        "targetBase": 15.0,
        "status": "open",
    }
    base.update(kwargs)
    return base


class UsableNumberTests(unittest.TestCase):
    def test_rejects_bad_values(self):
        for value in (None, 0, -1, float("nan"), float("inf"), "", "abc", "0"):
            self.assertIsNone(usable_number(value), msg=repr(value))

    def test_accepts_positive(self):
        self.assertEqual(usable_number("12.5"), 12.5)
        self.assertEqual(usable_number(1), 1.0)


class SessionDateTests(unittest.TestCase):
    def test_before_close_uses_previous_day(self):
        # Monday 15:00 ET — today's session is still open.
        now = datetime(2026, 11, 9, 15, 0, tzinfo=ET)
        self.assertEqual(last_completed_session_date(now), date(2026, 11, 8))

    def test_just_after_grace_uses_today(self):
        now = datetime(2026, 11, 9, 16, 5, tzinfo=ET)
        self.assertEqual(last_completed_session_date(now), date(2026, 11, 9))

    def test_just_before_grace_uses_yesterday(self):
        now = datetime(2026, 11, 9, 16, 4, tzinfo=ET)
        self.assertEqual(last_completed_session_date(now), date(2026, 11, 8))

    def test_late_evening_pt_is_next_morning_et_and_uses_monday(self):
        # Monday 10:40 PM PT = Tuesday 1:40 AM ET; Monday's session is done.
        pt = ZoneInfo("America/Los_Angeles")
        now = datetime(2026, 11, 9, 22, 40, tzinfo=pt)
        self.assertEqual(last_completed_session_date(now), date(2026, 11, 9))

    def test_weekend_morning_points_at_saturday_then_bars_fall_back_to_friday(self):
        now = datetime(2026, 11, 7, 10, 0, tzinfo=ET)  # Saturday
        self.assertEqual(last_completed_session_date(now), date(2026, 11, 6))
        bars = [(date(2026, 11, 5), 10.0), (date(2026, 11, 6), 11.0)]
        # Nov 6 2026 is a Friday. Saturday 10am ET -> session date Nov 6.
        self.assertEqual(close_on_or_before(bars, date(2026, 11, 6)), 11.0)

    def test_ignores_in_progress_today_bar(self):
        # During Monday session, last completed is Sunday 8th, so Monday's
        # partial bar must not be used.
        session = date(2026, 11, 8)
        bars = [
            (date(2026, 11, 6), 10.0),
            (date(2026, 11, 8), 9.5),  # Friday? 2026-11-08 is Sunday — use 11/6
            (date(2026, 11, 9), 4.0),  # in-progress Monday wick
        ]
        # 11/8 is Sunday; last bar on or before is 11/8 if present, else 11/6.
        self.assertEqual(close_on_or_before(bars, session), 9.5)
        # Typical weekday case: Friday close used, Monday partial ignored.
        friday = date(2026, 11, 6)
        weekday_bars = [(date(2026, 11, 5), 10.0), (date(2026, 11, 6), 9.8), (date(2026, 11, 9), 3.0)]
        self.assertEqual(close_on_or_before(weekday_bars, friday), 9.8)

    def test_missing_or_zero_bars_return_none(self):
        session = date(2026, 11, 9)
        self.assertIsNone(close_on_or_before([], session))
        self.assertIsNone(close_on_or_before([(date(2026, 11, 9), 0), (date(2026, 11, 9), float("nan"))], session))
        self.assertIsNone(close_on_or_before([(date(2026, 11, 10), 5.0)], session))  # only future bar


class ApplyStopsTests(unittest.TestCase):
    def test_close_below_stop_moves_pick(self):
        p = pick()
        picks, stopped, prices, moved = apply_stops(
            {"picks": [p]},
            {"stopped": []},
            {"FAKE": 7.5},
            date(2026, 11, 9),
            {"prices": {"FAKE": {"price": 7.5, "prevClose": 8, "changePct": -6.25, "time": "t"}}, "updated": "t"},
            "2026-11-09T21:10:00Z",
        )
        self.assertEqual(picks["picks"], [])
        self.assertEqual(len(moved), 1)
        rec = stopped["stopped"][0]
        self.assertEqual(rec["stoppedDate"], "2026-11-09")
        self.assertEqual(rec["closePrice"], 7.5)
        self.assertEqual(rec["returnPct"], -25.0)
        self.assertEqual(rec["pick"]["ticker"], "FAKE")
        self.assertNotIn("FAKE", prices["prices"])

    def test_close_equal_to_stop_moves_pick(self):
        p = pick(stop=8.0)
        _, _, _, moved = apply_stops({"picks": [p]}, {"stopped": []}, {"FAKE": 8.0}, date(2026, 11, 9))
        self.assertEqual(len(moved), 1)

    def test_close_above_stop_stays(self):
        p = pick(stop=8.0)
        picks, stopped, _, moved = apply_stops(
            {"picks": [p]}, {"stopped": []}, {"FAKE": 8.01}, date(2026, 11, 9)
        )
        self.assertEqual(picks["picks"], [p])
        self.assertEqual(moved, [])
        self.assertEqual(stopped["stopped"], [])

    def test_missing_zero_nan_closes_never_remove(self):
        p = pick(stop=8.0)
        for close in (None, 0, -3, float("nan")):
            picks, _, _, moved = apply_stops(
                {"picks": [p]}, {"stopped": []}, {"FAKE": close}, date(2026, 11, 9)
            )
            self.assertEqual(picks["picks"], [p], msg=repr(close))
            self.assertEqual(moved, [], msg=repr(close))

    def test_missing_ticker_in_closes_stays(self):
        p = pick()
        picks, _, _, moved = apply_stops({"picks": [p]}, {"stopped": []}, {}, date(2026, 11, 9))
        self.assertEqual(picks["picks"], [p])
        self.assertEqual(moved, [])

    def test_no_stop_or_invalid_stop_stays(self):
        for kwargs in ({"stop": None}, {"stop": 0}, {"stop": "n/a"}, {"priceAtCall": None}):
            p = pick(**kwargs)
            picks, _, _, moved = apply_stops(
                {"picks": [p]}, {"stopped": []}, {"FAKE": 1.0}, date(2026, 11, 9)
            )
            self.assertEqual(picks["picks"], [p], msg=repr(kwargs))
            self.assertEqual(moved, [], msg=repr(kwargs))

    def test_short_pick_is_not_stopped_by_close_below_stop(self):
        # Stop above entry = short. close 9 is below stop 12, must not fire.
        p = pick(priceAtCall=10.0, stop=12.0)
        self.assertFalse(is_open_long(p))
        picks, _, _, moved = apply_stops(
            {"picks": [p]}, {"stopped": []}, {"FAKE": 9.0}, date(2026, 11, 9)
        )
        self.assertEqual(picks["picks"], [p])
        self.assertEqual(moved, [])

    def test_closed_pick_stays_in_picks(self):
        p = pick(status="closed", exitPrice=7.0)
        picks, _, _, moved = apply_stops(
            {"picks": [p]}, {"stopped": []}, {"FAKE": 7.0}, date(2026, 11, 9)
        )
        self.assertEqual(picks["picks"], [p])
        self.assertEqual(moved, [])

    def test_prepends_new_records_and_leaves_other_picks(self):
        old = {"stoppedDate": "2026-11-01", "closePrice": 1.0, "returnPct": -50, "pick": pick(ticker="OLD", id="2026-11-01-OLD")}
        keep = pick(ticker="KEEP", id="2026-11-09-KEEP", stop=5.0, priceAtCall=10.0)
        gone = pick(ticker="GONE", id="2026-11-09-GONE", stop=8.0, priceAtCall=10.0)
        picks, stopped, _, moved = apply_stops(
            {"picks": [keep, gone]},
            {"stopped": [old]},
            {"KEEP": 9.0, "GONE": 7.0},
            date(2026, 11, 9),
        )
        self.assertEqual([p["ticker"] for p in picks["picks"]], ["KEEP"])
        self.assertEqual(len(moved), 1)
        self.assertEqual(stopped["stopped"][0]["pick"]["ticker"], "GONE")
        self.assertEqual(stopped["stopped"][1], old)

    def test_return_pct_rounding(self):
        self.assertEqual(return_pct(10, 7.5), -25.0)
        self.assertEqual(return_pct(73.85, 66.0), -10.63)
        self.assertIsNone(return_pct(0, 5))
        self.assertTrue(math.isnan(usable_number(float("nan")) or float("nan")) or usable_number(float("nan")) is None)

    def test_prune_prices_only_drops_removed_tickers(self):
        doc = {
            "prices": {
                "KEEP": {"price": 1, "prevClose": 1, "changePct": 0, "time": "t"},
                "GONE": {"price": 1, "prevClose": 1, "changePct": 0, "time": "t"},
            },
            "updated": "old",
        }
        out = prune_prices(doc, {"KEEP"}, "new")
        self.assertEqual(set(out["prices"]), {"KEEP"})
        self.assertEqual(out["updated"], "new")
        same = prune_prices(doc, {"KEEP", "GONE"}, "new")
        self.assertEqual(same["updated"], "old")


class EligibilityTests(unittest.TestCase):
    def test_after_hours_call_does_not_use_that_days_close(self):
        # Called Monday 8:14 PM PT (Tue 04:14 UTC) after the cash close.
        p = pick(
            ticker="AAON",
            id="2026-11-09-AAON",
            priceAtCall=73.85,
            stop=66,
            dateCalled="2026-11-09",
            calledAt="2026-11-10T04:14:32.058Z",
        )
        cutoff = ineligible_session_date(p)
        self.assertEqual(cutoff, date(2026, 11, 9))
        picks, _, _, moved = apply_stops(
            {"picks": [p]},
            {"stopped": []},
            {"AAON": (date(2026, 11, 9), 62.87)},
            date(2026, 11, 9),
        )
        self.assertEqual(picks["picks"], [p])
        self.assertEqual(moved, [])

    def test_next_session_close_can_stop_an_after_hours_pick(self):
        p = pick(
            ticker="AAON",
            id="2026-11-09-AAON",
            priceAtCall=73.85,
            stop=66,
            dateCalled="2026-11-09",
            calledAt="2026-11-10T04:14:32.058Z",
        )
        picks, stopped, _, moved = apply_stops(
            {"picks": [p]},
            {"stopped": []},
            {"AAON": (date(2026, 11, 10), 64.0)},
            date(2026, 11, 10),
        )
        self.assertEqual(picks["picks"], [])
        self.assertEqual(len(moved), 1)
        self.assertEqual(stopped["stopped"][0]["stoppedDate"], "2026-11-10")
        self.assertEqual(stopped["stopped"][0]["closePrice"], 64.0)

    def test_intraday_call_can_use_that_days_close(self):
        # Called Monday 10:00 AM ET, well before the close.
        p = pick(
            priceAtCall=10.0,
            stop=8.0,
            dateCalled="2026-11-09",
            calledAt="2026-11-09T15:00:00Z",  # 10:00 ET
        )
        self.assertEqual(ineligible_session_date(p), date(2026, 11, 8))
        _, _, _, moved = apply_stops(
            {"picks": [p]},
            {"stopped": []},
            {"FAKE": (date(2026, 11, 9), 7.5)},
            date(2026, 11, 9),
        )
        self.assertEqual(len(moved), 1)

    def test_plain_close_number_still_works_for_older_tests(self):
        p = pick(calledAt="2026-11-09T15:00:00Z")
        _, _, _, moved = apply_stops(
            {"picks": [p]}, {"stopped": []}, {"FAKE": 7.5}, date(2026, 11, 9)
        )
        self.assertEqual(len(moved), 1)


if __name__ == "__main__":
    unittest.main()
