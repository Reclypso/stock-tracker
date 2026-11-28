#!/usr/bin/env python3
"""Unit tests for scripts/actions.py. Fake picks and bars only: no network,
no reads or writes of data/."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import actions  # noqa: E402
from actions import Bar, evaluate_pick  # noqa: E402
from check_stops import apply_stops, is_open_long  # noqa: E402

WED = date(2026, 11, 25)  # last session before Thanksgiving


def sessions_ending(end: date, n: int) -> list[date]:
    days, d = [], end
    while len(days) < n:
        if actions.is_session(d):
            days.append(d)
        d -= timedelta(days=1)
    return list(reversed(days))


def mk(closes, end=WED, spread=0.01, lows=None):
    days = sessions_ending(end, len(closes))
    out = []
    for i, (d, c) in enumerate(zip(days, closes)):
        o = closes[i - 1] if i else c
        lo = lows.get(i) if lows and i in lows else min(o, c) * (1 - spread)
        out.append(Bar(d, o, max(o, c) * (1 + spread), lo, c))
    return out


def pick_after(bars, n_after, **kw):
    """Pick called after the close of the session just before the last n_after bars."""
    call_day = bars[-n_after - 1].day
    p = {"id": f"{call_day}-FAKE", "ticker": "FAKE", "status": "open", "grade": "B", "type": "swing",
         "dateCalled": call_day.isoformat(), "calledAt": f"{call_day.isoformat()}T22:00:00Z",
         "priceAtCall": 10.0, "stop": 9.0, "targetBase": 15.0, "thesis": "Medium-term: test"}
    p.update(kw)
    return p


def kinds(res):
    return [a["action"] for a in res["actions"]]


def flat_then(after, before=40, base=10.0):
    return [base] * before + list(after)


class StopOutTests(unittest.TestCase):
    def test_close_at_or_below_stop_sells(self):
        bars = mk(flat_then([10.2, 9.4, 8.9]))
        res = evaluate_pick(pick_after(bars, 3), bars, WED)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["rule"], "stop")
        self.assertEqual(res["actions"][0]["priority"], 1)
        self.assertIn("pick.mjs close", res["actions"][0]["command"])

    def test_raised_breakeven_stop_still_stops_out(self):
        bars = mk(flat_then([11.0, 12.0, 10.5, 9.95]))
        p = pick_after(bars, 4, stop=10.0, initialStop=9.0)
        res = evaluate_pick(p, bars, WED)
        self.assertEqual(kinds(res), ["SELL"])
        # ... and check_stops.py agrees (the old stop < entry bug would skip it).
        self.assertTrue(is_open_long(p))
        _, _, _, moved = apply_stops({"picks": [p]}, {"stopped": []}, {"FAKE": (WED, 9.95)}, WED)
        self.assertEqual(len(moved), 1)

    def test_lock_in_stop_above_entry_sells(self):
        bars = mk(flat_then([12.0, 13.0, 11.4]))
        res = evaluate_pick(pick_after(bars, 3, stop=11.5, initialStop=9.0), bars, WED)
        self.assertEqual(kinds(res), ["SELL"])


class SwingTests(unittest.TestCase):
    def test_winner_past_2r_trims_and_raises_stop(self):
        bars = mk(flat_then([10.5, 11.2, 11.9, 12.5]))  # +2.5R with R = 1
        res = evaluate_pick(pick_after(bars, 4), bars, WED)
        self.assertIn("TRIM", kinds(res))
        self.assertIn("RAISE STOP", kinds(res))
        trim = next(a for a in res["actions"] if a["action"] == "TRIM")
        self.assertEqual(trim["fraction"], "0.33")
        raise_ = next(a for a in res["actions"] if a["action"] == "RAISE STOP")
        self.assertEqual(raise_["newStop"], 10.0)  # breakeven
        self.assertEqual(raise_["rule"], "breakeven")
        self.assertEqual(res["position"]["rMultiple"], 2.5)

    def test_after_trim_trails_highest_close_minus_3atr_once(self):
        bars = mk(flat_then([10.5, 11.2, 11.9, 12.5, 12.8]))
        p = pick_after(bars, 5, stop=10.0, initialStop=9.0,
                       partials=[{"date": "2026-11-24", "fraction": 0.33, "price": 12.5}])
        res = evaluate_pick(p, bars, WED)
        self.assertNotIn("TRIM", kinds(res))
        raise_ = next(a for a in res["actions"] if a["action"] == "RAISE STOP")
        a14 = actions.atr(bars)
        self.assertAlmostEqual(raise_["newStop"], round(12.8 - 3 * a14, 2), places=2)
        self.assertEqual(raise_["rule"], "ATR trail")

    def test_red_regime_tightens_trail_to_2atr(self):
        bars = mk(flat_then([10.5, 11.2, 11.9, 12.5, 12.8]))
        p = pick_after(bars, 5, stop=10.0, initialStop=9.0, partials=[{"fraction": 0.33}])
        normal = next(a for a in evaluate_pick(p, bars, WED)["actions"] if a["action"] == "RAISE STOP")
        red = next(a for a in evaluate_pick(p, bars, WED, regime_color="RED")["actions"] if a["action"] == "RAISE STOP")
        self.assertGreater(red["newStop"], normal["newStop"])

    def test_breakeven_only_after_1_5r(self):
        bars = mk(flat_then([10.5, 11.4]))  # +1.4R: nothing yet
        self.assertEqual(kinds(evaluate_pick(pick_after(bars, 2), bars, WED)), [])
        bars = mk(flat_then([10.5, 11.6]))  # +1.6R: breakeven
        self.assertEqual(kinds(evaluate_pick(pick_after(bars, 2), bars, WED)), ["RAISE STOP"])

    def test_gave_back_after_1_5r_sells_below_breakeven(self):
        bars = mk(flat_then([11.0, 11.7, 10.4, 9.9]))
        res = evaluate_pick(pick_after(bars, 4), bars, WED)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["rule"], "breakeven")

    def test_stale_swing_15_sessions_without_new_high_time_exits(self):
        after = [10.4] + [10.0, 10.2, 9.9, 10.1, 10.3] * 3  # high on day 1, then 15 lower closes
        bars = mk(flat_then(after))
        res = evaluate_pick(pick_after(bars, len(after)), bars, WED)
        self.assertIn("TIME EXIT", kinds(res))
        self.assertEqual(res["position"]["sessionsSinceHigh"], 15)
        # 14 lower closes: not yet.
        bars14 = mk(flat_then(after[:-1]))
        self.assertNotIn("TIME EXIT", kinds(evaluate_pick(pick_after(bars14, len(after) - 1), bars14, WED)))

    def test_stale_swing_that_never_beat_entry_time_exits(self):
        after = [9.8] * 15
        bars = mk(flat_then(after))
        res = evaluate_pick(pick_after(bars, 15), bars, WED)
        self.assertEqual(kinds(res), ["TIME EXIT"])

    def test_missing_initial_risk_is_skipped_not_crashed(self):
        bars = mk(flat_then([11.0, 12.0]))
        p = pick_after(bars, 2, stop=10.5)  # stop above entry, no initialStop: R unknown
        res = evaluate_pick(p, bars, WED)
        self.assertTrue(any("R-based" in s for s in res["skipped"]))
        self.assertIsNone(res["position"]["rMultiple"])


class FastTests(unittest.TestCase):
    def test_plus_20pct_trims_half(self):
        bars = mk(flat_then([11.0, 12.1]))
        res = evaluate_pick(pick_after(bars, 2, type="fast", stop=9.0, targetBase=20.0), bars, WED)
        trim = next(a for a in res["actions"] if a["action"] == "TRIM")
        self.assertEqual(trim["fraction"], "0.5")

    def test_five_sessions_without_1r_time_exits(self):
        bars = mk(flat_then([10.2, 10.4, 10.1, 10.3, 10.5]))
        res = evaluate_pick(pick_after(bars, 5, type="fast"), bars, WED)
        self.assertEqual(kinds(res), ["TIME EXIT"])

    def test_after_trim_close_below_prior_low_sells(self):
        bars = mk(flat_then([11.0, 12.2, 12.6, 11.9]), lows={42: 12.3})
        p = pick_after(bars, 4, type="fast", partials=[{"fraction": 0.5}])
        res = evaluate_pick(p, bars, WED)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["rule"], "fast trail")


class LongTermTests(unittest.TestCase):
    def setUp(self):
        self.closes = [60 + i * 0.25 for i in range(200)]  # steady climb to ~110
        self.p = {"id": "2026-02-02-LT", "ticker": "LT", "status": "open", "grade": "B", "type": "long",
                  "dateCalled": "2026-02-02", "calledAt": "2026-02-02T15:00:00Z", "priceAtCall": 70.0,
                  "stop": 49.0, "targetBase": 150.0, "thesis": "Long-term: compounder"}

    def test_midweek_daily_dip_below_30wk_ma_does_not_sell(self):
        # Mon Nov 23 - Wed Nov 25 crash to 80, below the 30-week MA (~95) and
        # the 50-day; the last completed week (Fri Nov 20) closed ~109.
        bars = mk(self.closes[:-3] + [90.0, 85.0, 80.0], end=WED)
        res = evaluate_pick(self.p, bars, WED)
        self.assertNotIn("SELL", kinds(res))
        lv = res["position"]["levels"]
        self.assertEqual(lv["lastWeekEnd"], "2026-11-20")
        self.assertGreater(lv["ma30w"], 80.0)
        self.assertTrue(any("weekly-close" in n for n in res["position"]["notes"]))

    def test_completed_week_close_below_30wk_ma_sells(self):
        fri = date(2026, 11, 20)
        bars = mk(self.closes[:-5] + [100.0, 95.0, 90.0, 85.0, 80.0], end=fri)
        res = evaluate_pick(self.p, bars, fri)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["rule"], "30-week MA")

    def test_short_history_skips_weekly_rule(self):
        bars = mk([70.0 + i * 0.1 for i in range(60)])
        p = dict(self.p, dateCalled="2026-09-01", calledAt="2026-09-01T15:00:00Z")
        res = evaluate_pick(p, bars, WED)
        self.assertTrue(any("30-week MA rule skipped" in s for s in res["skipped"]))

    def test_doubles_trims_a_quarter(self):
        bars = mk([60 + i * 0.5 for i in range(200)])  # ends ~159.5 vs entry 70
        res = evaluate_pick(self.p, bars, WED)
        trim = next(a for a in res["actions"] if a["action"] == "TRIM")
        self.assertEqual(trim["fraction"], "0.25")


class LotteryTests(unittest.TestCase):
    def lottery(self, bars, **kw):
        return pick_after(bars, 3, type="lottery", grade="Lottery", priceAtCall=6.24, stop=5.3,
                          targetBase=8.1, **kw)

    def test_event_next_session_across_thanksgiving(self):
        bars = mk(flat_then([6.3, 6.5, 6.4], base=6.2))
        res = evaluate_pick(self.lottery(bars, eventDate="2026-11-28"), bars, WED)  # PDUFA on a Saturday
        self.assertEqual(kinds(res), ["EVENT NEXT SESSION"])
        self.assertEqual(actions.next_session(WED), date(2026, 11, 27))

    def test_event_further_out_is_quiet(self):
        bars = mk(flat_then([6.3, 6.5, 6.4], base=6.2))
        self.assertEqual(kinds(evaluate_pick(self.lottery(bars, eventDate="2026-12-11"), bars, WED)), [])

    def test_after_event_time_exit(self):
        mon = date(2026, 11, 30)
        bars = mk(flat_then([6.3, 6.5, 7.0], base=6.2), end=mon)
        res = evaluate_pick(self.lottery(bars, eventDate="2026-11-28"), bars, mon)
        self.assertEqual(kinds(res), ["TIME EXIT"])
        self.assertEqual(res["actions"][0]["rule"], "event resolved")

    def test_base_target_trims_half_and_missing_event_is_noted(self):
        bars = mk(flat_then([6.3, 7.5, 8.2], base=6.2))
        res = evaluate_pick(self.lottery(bars), bars, WED)
        self.assertEqual(kinds(res), ["TRIM"])
        self.assertTrue(any("eventDate" in s for s in res["skipped"]))


class MacroTests(unittest.TestCase):
    def test_close_below_50day_sells(self):
        closes = [50 + i * 0.1 for i in range(80)] + [55.0]
        bars = mk(closes)
        p = pick_after(bars, 3, type="macro", priceAtCall=57.5, stop=52.0, targetBase=70.0)
        res = evaluate_pick(p, bars, WED)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["rule"], "50-day")


class FallbackTests(unittest.TestCase):
    def test_quote_only_stop_check(self):
        p = {"id": "x", "ticker": "Q", "status": "open", "priceAtCall": 10.0, "stop": 9.0, "type": "swing"}
        res = evaluate_pick(p, [], WED, quote=8.8)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["basis"], "quote")

    def test_no_data_at_all_is_skipped(self):
        p = {"id": "x", "ticker": "Q", "status": "open", "priceAtCall": 10.0, "stop": 9.0}
        res = evaluate_pick(p, [], WED)
        self.assertEqual(kinds(res), [])
        self.assertTrue(res["skipped"])

    def test_build_ignores_closed_and_short_picks_and_sorts(self):
        bars = mk(flat_then([10.2, 9.4, 8.9]))
        sell = pick_after(bars, 3, ticker="SEL", id="s")
        winner = pick_after(mk(flat_then([10.5, 11.6])), 2, ticker="WIN", id="w")
        closed = dict(sell, id="c", status="closed")
        short = dict(sell, id="sh", side="short")
        doc = actions.build_actions(
            [winner, closed, short, sell],
            {"SEL": bars, "WIN": mk(flat_then([10.5, 11.6]))},
            WED,
            now_iso="2026-11-26T13:00:00Z",
        )
        self.assertEqual([a["ticker"] for a in doc["actions"]], ["SEL", "WIN"])
        self.assertEqual(doc["counts"], {"SELL": 1, "RAISE STOP": 1})
        self.assertEqual({p["id"] for p in doc["positions"]}, {"w", "s"})
        self.assertIn("**SELL SEL** at the open", doc["markdown"])
        self.assertIn("**RAISE STOP WIN** 9.0 -> 10.0", doc["markdown"])


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        bars = mk(flat_then([10.2, 9.4, 8.9]))
        self.picks = base / "picks.json"
        self.prices = base / "prices.json"
        self.bars = base / "bars.json"
        self.out = base / "out" / "actions.json"
        self.md = base / "out" / "actions.md"
        self.picks.write_text(json.dumps({"picks": [pick_after(bars, 3)]}))
        self.prices.write_text(json.dumps({"prices": {"FAKE": {"price": 8.9}}}))
        self.bars.write_text(json.dumps({"FAKE": [[b.day.isoformat(), b.open, b.high, b.low, b.close, 0] for b in bars]}))
        self.base = ["--picks", str(self.picks), "--prices", str(self.prices), "--bars-json", str(self.bars),
                     "--no-fetch", "--regime", str(base / "none.json"), "--now", "2026-11-26T13:00:00Z"]

    def tearDown(self):
        self.tmp.cleanup()

    def main(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = actions.main(argv, fetch=lambda t: self.fail("must not fetch"))
        return code, out.getvalue()

    def test_dry_run_writes_nothing(self):
        code, out = self.main(self.base + ["--out", str(self.out), "--md", str(self.md), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("**SELL FAKE**", out)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.md.exists())

    def test_writes_only_the_out_files(self):
        before = (self.picks.read_text(), self.prices.read_text())
        code, _ = self.main(self.base + ["--out", str(self.out), "--md", str(self.md)])
        self.assertEqual(code, 0)
        doc = json.loads(self.out.read_text())
        self.assertEqual(doc["schema"], "stock-bot/actions@1")
        self.assertEqual(doc["session"], "2026-11-25")
        self.assertEqual(doc["actions"][0]["action"], "SELL")
        self.assertIn("SELL FAKE", self.md.read_text())
        self.assertEqual((self.picks.read_text(), self.prices.read_text()), before)

    def test_refuses_to_write_over_tracker_data(self):
        for target in (self.picks, actions.PICKS_PATH, actions.STOPPED_PATH, actions.PRICES_PATH):
            code, _ = self.main(self.base + ["--out", str(target)])
            self.assertEqual(code, 1, target)


class ThesisFailedTests(unittest.TestCase):
    def test_thesis_failed_flag_sells(self):
        bars = mk(flat_then([10.2, 10.4, 10.3]))
        p = pick_after(bars, 3, thesisFailed="FDA issued a CRL")
        res = evaluate_pick(p, bars, WED)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["rule"], "thesis failed")
        self.assertIn("FDA issued a CRL", res["actions"][0]["why"])
        self.assertIn("--reason", res["actions"][0]["command"])

    def test_event_outcome_negative_sells(self):
        bars = mk(flat_then([10.2, 10.4]))
        p = pick_after(bars, 2, eventOutcome="denied")
        res = evaluate_pick(p, bars, WED)
        self.assertEqual(res["actions"][0]["rule"], "thesis failed")

    def test_thesis_failed_without_bars_uses_flag_basis(self):
        p = {"id": "x", "ticker": "Q", "status": "open", "priceAtCall": 10.0, "stop": 9.0,
             "type": "swing", "thesisFailed": "deal died"}
        res = evaluate_pick(p, [], WED)
        self.assertEqual(kinds(res), ["SELL"])
        self.assertEqual(res["actions"][0]["basis"], "flag")


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.tmp.name)
        self.backup = self.base_dir / "backups"
        self.picks = self.base_dir / "picks.json"
        self.prices = self.base_dir / "prices.json"
        self.stopped = self.base_dir / "stopped.json"
        self.bars = self.base_dir / "bars.json"
        self.out = self.base_dir / "out" / "actions.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, picks, bars_by, prices=None, stopped=None):
        self.picks.write_text(json.dumps({"picks": picks}))
        self.prices.write_text(json.dumps({"prices": prices or {p["ticker"]: {"price": 10} for p in picks if p.get("ticker")}}))
        self.stopped.write_text(json.dumps({"stopped": stopped or []}))
        payload = {
            t: [[b.day.isoformat(), b.open, b.high, b.low, b.close, 0] for b in bars]
            for t, bars in bars_by.items()
        }
        self.bars.write_text(json.dumps(payload))
        self.snapshot = (self.picks.read_text(), self.prices.read_text(), self.stopped.read_text())

    def argv(self, *extra):
        return ["--picks", str(self.picks), "--prices", str(self.prices), "--stopped", str(self.stopped),
                "--bars-json", str(self.bars), "--no-fetch", "--backup-dir", str(self.backup),
                "--regime", str(self.base_dir / "none.json"), "--now", "2026-11-26T13:00:00Z", *extra]

    def main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = actions.main(argv, fetch=lambda t: self.fail("must not fetch"))
        return code, out.getvalue(), err.getvalue()

    def test_apply_dry_run_is_default_safe(self):
        bars = mk(flat_then([10.2, 9.4, 8.9]))
        self.write([pick_after(bars, 3)], {"FAKE": bars})
        code, out, err = self.main(self.argv("--apply", "--dry-run", "--out", str(self.out)))
        self.assertEqual(code, 0)
        self.assertIn("**SELL FAKE**", out)
        self.assertIn("DRY RUN: would close FAKE", err)
        self.assertFalse(self.out.exists())
        self.assertEqual((self.picks.read_text(), self.prices.read_text(), self.stopped.read_text()), self.snapshot)
        # Without --apply, tracker files stay put even though a SELL is listed.
        code, _, _ = self.main(self.argv("--out", str(self.out)))
        self.assertEqual(code, 0)
        self.assertTrue(self.out.exists())
        self.assertEqual((self.picks.read_text(), self.prices.read_text(), self.stopped.read_text()), self.snapshot)

    def test_apply_moves_stop_out_to_stopped(self):
        bars = mk(flat_then([10.2, 9.4, 8.9]))
        p = pick_after(bars, 3)
        self.write([p], {"FAKE": bars}, prices={"FAKE": {"price": 8.9}})
        code, _, err = self.main(self.argv("--apply"))
        self.assertEqual(code, 0, err)
        doc = json.loads(self.picks.read_text())
        self.assertEqual(doc["picks"], [])
        stopped = json.loads(self.stopped.read_text())["stopped"]
        self.assertEqual(len(stopped), 1)
        self.assertEqual(stopped[0]["pick"]["ticker"], "FAKE")
        self.assertEqual(stopped[0]["pick"]["status"], "closed")
        self.assertEqual(stopped[0]["closePrice"], 8.9)
        self.assertIn("stop", stopped[0]["reason"])
        prices = json.loads(self.prices.read_text())
        self.assertNotIn("FAKE", prices.get("prices", {}))
        self.assertIn("Applied close FAKE", err)
        # Backup of the original picks exists and is valid.
        backups = list(self.backup.glob("picks.json.*"))
        self.assertTrue(backups)
        self.assertEqual(json.loads(backups[0].read_text())["picks"][0]["ticker"], "FAKE")

    def test_apply_closes_time_exit_in_picks(self):
        # 16 sessions, never a new high above entry: TIME EXIT, stays in picks.json closed.
        bars = mk([10.0] * 17)
        p = pick_after(bars, 16)
        self.write([p], {"FAKE": bars})
        code, out, err = self.main(self.argv("--apply"))
        self.assertEqual(code, 0, err)
        self.assertIn("TIME EXIT", out)
        doc = json.loads(self.picks.read_text())
        self.assertEqual(len(doc["picks"]), 1)
        closed = doc["picks"][0]
        self.assertEqual(closed["status"], "closed")
        self.assertEqual(closed["exitPrice"], 10.0)
        self.assertTrue(closed["exitReason"].startswith("15 sessions"))
        self.assertEqual(json.loads(self.stopped.read_text())["stopped"], [])

    def test_apply_skips_quote_sell_and_trim(self):
        # Quote-only stop: SELL is listed but not applied (need the official close).
        quote_pick = {"id": "q-1", "ticker": "QUOT", "status": "open", "priceAtCall": 10.0,
                      "stop": 9.0, "type": "swing", "dateCalled": "2026-11-20",
                      "calledAt": "2026-11-20T22:00:00Z"}
        trim_bars = mk(flat_then([10.5, 11.2, 11.9, 12.5]))
        trim_pick = pick_after(trim_bars, 4, ticker="TRIM", id="2026-11-20-TRIM")
        self.write([quote_pick, trim_pick], {"TRIM": trim_bars},
                   prices={"QUOT": {"price": 8.8}, "TRIM": {"price": 12.5}})
        before = (self.picks.read_text(), self.prices.read_text(), self.stopped.read_text())
        code, out, err = self.main(self.argv("--apply"))
        self.assertEqual(code, 0, err)
        self.assertIn("SELL QUOT", out)
        self.assertIn("TRIM", out)
        self.assertIn("no SELL/TIME EXIT closes", err)
        self.assertEqual((self.picks.read_text(), self.prices.read_text(), self.stopped.read_text()), before)

    def test_apply_invalidate_and_already_closed(self):
        bars = mk(flat_then([10.2, 10.4, 10.3]))
        open_p = pick_after(bars, 3, ticker="LIVE", id="2026-11-20-LIVE")
        done = dict(pick_after(bars, 3, ticker="DEAD", id="2026-11-20-DEAD"), status="closed", exitPrice=9, exitDate="2026-11-24")
        self.write([open_p, done], {"LIVE": bars, "DEAD": bars})
        code, _, err = self.main(self.argv("--apply", "--invalidate", "LIVE=FDA CRL"))
        self.assertEqual(code, 0, err)
        doc = json.loads(self.picks.read_text())
        by_id = {p["id"]: p for p in doc["picks"]}
        self.assertEqual(by_id["2026-11-20-LIVE"]["status"], "closed")
        self.assertIn("FDA CRL", by_id["2026-11-20-LIVE"]["exitReason"])
        self.assertEqual(by_id["2026-11-20-DEAD"]["exitPrice"], 9)  # untouched
        self.assertEqual(json.loads(self.stopped.read_text())["stopped"], [])

    def test_pure_apply_closes_is_idempotent(self):
        bars = mk(flat_then([10.2, 9.4, 8.9]))
        p = pick_after(bars, 3)
        res = evaluate_pick(p, bars, WED)
        picks_doc, stopped_doc, _, applied = actions.apply_closes(
            {"picks": [p]}, {"stopped": []}, {"prices": {"FAKE": {"price": 8.9}}}, res["actions"]
        )
        self.assertEqual(len(applied), 1)
        self.assertEqual(picks_doc["picks"], [])
        # Running again against the already-moved result applies nothing.
        _, _, _, applied2 = actions.apply_closes(picks_doc, stopped_doc, {"prices": {}}, res["actions"])
        self.assertEqual(applied2, [])


class PickCliCloseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.picks = self.dir / "picks.json"
        self.stopped = self.dir / "stopped.json"
        self.prices = self.dir / "prices.json"
        pick = {"id": "2026-11-20-FAKE", "ticker": "FAKE", "status": "open", "grade": "B",
                "dateCalled": "2026-11-20", "priceAtCall": 10.0, "stop": 9.0, "thesis": "Medium-term: x"}
        self.picks.write_text(json.dumps({"picks": [pick]}, indent=2) + "\n")
        self.stopped.write_text(json.dumps({"stopped": []}, indent=2) + "\n")
        self.prices.write_text(json.dumps({"prices": {"FAKE": {"price": 8.5}}, "updated": "x"}, indent=2) + "\n")
        self.script = Path(__file__).resolve().parent / "pick.mjs"

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, args):
        import subprocess
        env = dict(**{k: v for k, v in __import__("os").environ.items() if k != "STOCKBOT_BACKUP_DIR"})
        env["STOCKBOT_BACKUP_DIR"] = str(self.dir / "backups")
        res = subprocess.run(["node", str(self.script), *args], capture_output=True, text=True)
        return res.returncode, res.stdout, res.stderr

    def test_close_by_ticker_dry_run_and_apply(self):
        code, out, err = self.run_cli([
            "close", "FAKE", "--exit-price", "8.50", "--reason", "stop",
            "--date", "2026-11-25", "--to-stopped", "--dry-run",
            "--picks", str(self.picks), "--stopped", str(self.stopped), "--prices", str(self.prices),
        ])
        self.assertEqual(code, 0, err)
        self.assertIn("DRY RUN", out)
        self.assertEqual(json.loads(self.picks.read_text())["picks"][0]["status"], "open")

        code, out, err = self.run_cli([
            "close", "FAKE", "--exit-price", "8.50", "--reason", "stop",
            "--date", "2026-11-25", "--to-stopped",
            "--picks", str(self.picks), "--stopped", str(self.stopped), "--prices", str(self.prices),
        ])
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(self.picks.read_text())["picks"], [])
        stopped = json.loads(self.stopped.read_text())["stopped"]
        self.assertEqual(stopped[0]["pick"]["ticker"], "FAKE")
        self.assertEqual(stopped[0]["pick"]["exitReason"], "stop")
        self.assertEqual(stopped[0]["closePrice"], 8.5)
        self.assertNotIn("FAKE", json.loads(self.prices.read_text())["prices"])

    def test_close_without_to_stopped_keeps_closed_card(self):
        code, _, err = self.run_cli([
            "close", "--id", "2026-11-20-FAKE", "--exit-price", "11.00",
            "--reason", "time exit", "--date", "2026-11-25",
            "--picks", str(self.picks),
        ])
        self.assertEqual(code, 0, err)
        pick = json.loads(self.picks.read_text())["picks"][0]
        self.assertEqual(pick["status"], "closed")
        self.assertEqual(pick["exitPrice"], 11)
        self.assertEqual(pick["exitDate"], "2026-11-25")
        self.assertEqual(pick["exitReason"], "time exit")
        self.assertEqual(json.loads(self.stopped.read_text())["stopped"], [])


if __name__ == "__main__":
    unittest.main()
