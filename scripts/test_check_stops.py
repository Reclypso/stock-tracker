#!/usr/bin/env python3
"""Unit tests for scripts/check_stops.py. No network, no real picks touched."""

from __future__ import annotations

import math
import sys
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# Importable from any cwd, e.g. `python3 -m unittest /abs/path/test_check_stops.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_stops import (  # noqa: E402
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
        # Shorts must say so explicitly now (stop > entry alone is a long's
        # lock-in stop). close 9 is below stop 12, must not fire for a short.
        p = pick(priceAtCall=10.0, stop=12.0, side="short")
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


class RaisedStopTests(unittest.TestCase):
    """Regression for the Nov 26, 2026 audit bug: `is_open_long` used to
    return `stop < entry`, so a stop raised to breakeven or above silently
    turned off the automatic stop-out."""

    def run_stops(self, p, close):
        return apply_stops({"picks": [p]}, {"stopped": []}, {"FAKE": close}, date(2026, 11, 20))

    def test_classic_stop_below_entry_is_long(self):
        p = pick(priceAtCall=10.0, stop=8.0)
        self.assertTrue(is_open_long(p))
        self.assertEqual(len(self.run_stops(p, 7.9)[3]), 1)

    def test_stop_raised_to_entry_still_stops_out(self):
        p = pick(priceAtCall=10.0, stop=10.0)
        self.assertTrue(is_open_long(p))
        picks, stopped, _, moved = self.run_stops(p, 10.0)
        self.assertEqual(len(moved), 1)
        self.assertEqual(picks["picks"], [])
        self.assertEqual(stopped["stopped"][0]["returnPct"], 0.0)
        # A close above the breakeven stop keeps it open.
        _, _, _, moved = self.run_stops(p, 10.01)
        self.assertEqual(moved, [])

    def test_stop_raised_above_entry_locks_in_gain(self):
        # AAON-style: entry 73.85, stop trailed up to 80 after a run.
        p = pick(ticker="AAON", id="2026-11-09-AAON", priceAtCall=73.85, stop=80.0)
        self.assertTrue(is_open_long(p))
        picks, stopped, _, moved = apply_stops(
            {"picks": [p]}, {"stopped": []}, {"AAON": 79.5}, date(2026, 11, 20)
        )
        self.assertEqual(len(moved), 1)
        self.assertEqual(picks["picks"], [])
        self.assertEqual(stopped["stopped"][0]["closePrice"], 79.5)
        self.assertEqual(stopped["stopped"][0]["returnPct"], 7.65)
        _, _, _, moved = apply_stops({"picks": [p]}, {"stopped": []}, {"AAON": 85.0}, date(2026, 11, 20))
        self.assertEqual(moved, [])

    def test_missing_stop_is_not_checked(self):
        for stop in (None, 0, "", "n/a"):
            p = pick(stop=stop)
            self.assertFalse(is_open_long(p), msg=repr(stop))
            self.assertEqual(self.run_stops(p, 1.0)[3], [], msg=repr(stop))
        p = pick()
        del p["stop"]
        self.assertFalse(is_open_long(p))

    def test_explicit_short_is_never_treated_as_long(self):
        for stop in (12.0, 8.0, 10.0):
            p = pick(priceAtCall=10.0, stop=stop, side="short")
            self.assertFalse(is_open_long(p), msg=stop)
            self.assertEqual(self.run_stops(p, 5.0)[3], [], msg=stop)

    def test_side_values(self):
        self.assertTrue(is_open_long(pick(side="long")))
        self.assertTrue(is_open_long(pick(side=" LONG ")))
        self.assertTrue(is_open_long(pick(side=None)))
        self.assertTrue(is_open_long(pick(side="")))
        self.assertFalse(is_open_long(pick(side="Short")))
        self.assertFalse(is_open_long(pick(side="sideways")))  # unknown side: leave it alone

    def test_status_must_be_open(self):
        self.assertTrue(is_open_long(pick(status="Open")))
        self.assertFalse(is_open_long(pick(status="closed")))
        self.assertFalse(is_open_long(pick(status=None)))


class MainPathOverrideTests(unittest.TestCase):
    """main() against temp copies with a fake fetcher. Never touches data/."""

    def setUp(self):
        import json
        import tempfile
        from pathlib import Path

        self.json = json
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.picks_path = base / "picks.json"
        self.stopped_path = base / "stopped.json"
        self.prices_path = base / "prices.json"
        be = pick(ticker="BE", id="2026-11-02-BE", priceAtCall=10.0, stop=10.0, calledAt="2026-11-02T15:00:00Z")
        keep = pick(ticker="KEEP", id="2026-11-02-KEEP", priceAtCall=10.0, stop=8.0, calledAt="2026-11-02T15:00:00Z")
        self.picks_path.write_text(json.dumps({"picks": [be, keep]}))
        self.stopped_path.write_text(json.dumps({"stopped": []}))
        self.prices_path.write_text(json.dumps({"prices": {"BE": {"price": 9.9}, "KEEP": {"price": 9.5}}, "updated": "t"}))
        self.argv = ["--picks", str(self.picks_path), "--stopped", str(self.stopped_path), "--prices", str(self.prices_path)]
        self.now = datetime(2026, 11, 20, 22, 0, tzinfo=ET)  # Friday after the close

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def fetch(ticker):
        closes = {"BE": 9.95, "KEEP": 9.5}
        return [(date(2026, 11, 19), 10.5), (date(2026, 11, 20), closes[ticker])]

    def snapshot(self):
        return [p.read_text() for p in (self.picks_path, self.stopped_path, self.prices_path)]

    def quiet_main(self, argv):
        import contextlib
        import io

        from check_stops import main

        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            code = main(argv, fetch=self.fetch, now=self.now)
        return code, out.getvalue()

    def test_dry_run_writes_nothing(self):
        before = self.snapshot()
        code, out = self.quiet_main(self.argv + ["--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("STOPPED_TICKERS=BE", out)
        self.assertEqual(self.snapshot(), before)

    def test_breakeven_stop_moves_pick_in_temp_files(self):
        code, out = self.quiet_main(self.argv)
        self.assertEqual(code, 0)
        self.assertIn("STOPPED_TICKERS=BE", out)
        picks = self.json.loads(self.picks_path.read_text())["picks"]
        stopped = self.json.loads(self.stopped_path.read_text())["stopped"]
        prices = self.json.loads(self.prices_path.read_text())["prices"]
        self.assertEqual([p["ticker"] for p in picks], ["KEEP"])
        self.assertEqual(stopped[0]["pick"]["ticker"], "BE")
        self.assertEqual(stopped[0]["closePrice"], 9.95)
        self.assertEqual(set(prices), {"KEEP"})

    def test_default_paths_are_production(self):
        from check_stops import PICKS_PATH, PRICES_PATH, STOPPED_PATH, parse_args

        args = parse_args([])
        self.assertEqual((args.picks, args.stopped, args.prices), (PICKS_PATH, STOPPED_PATH, PRICES_PATH))
        self.assertFalse(args.dry_run)


if __name__ == "__main__":
    unittest.main()
