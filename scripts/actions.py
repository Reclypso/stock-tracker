#!/usr/bin/env python3
"""Exit-actions engine: turns open picks + daily bars into the 5 AM actions list.

    python3 scripts/actions.py --picks /tmp/copy/picks.json --prices /tmp/copy/prices.json \
        --out /tmp/actions.json [--md /tmp/actions.md] [--regime ../gates/regime.json] \
        [--bars-json bars.json | --no-fetch] [--dry-run] [--json]

Read-only on tracker data. It writes only --out / --md, refuses to write over
picks.json / stopped.json / prices.json, and writes nothing with --dry-run (or
without --out). The markdown block is printed to stdout for the briefing.
Stops are never changed here: RAISE STOP lines carry the `pick.mjs update`
command to apply them.

Daily bars come from yfinance (no key, ~1 year), only completed sessions up to
the last US close, and only closes after the pick was called count toward
"since entry" figures (same eligibility rule as check_stops.py).

Rules (opus-audit-2026-11-26.md section 2 exit playbook). Entry = entryPrice
or priceAtCall; R = entry - initialStop (initialStop falls back to stop only
while stop < entry). All prices are daily closes unless stated.
  every type : SELL when the close <= stop (what check_stops.py also enforces).
  fast       : TRIM 1/2 at +20% or +2R. After a trim, SELL on a close below the
               prior day's low, else RAISE STOP to today's low. TIME EXIT after
               5 sessions without a +1R close.
  swing/PEAD : TRIM 1/3 at targetBase or +2R. Once a close reaches +1.5R,
               RAISE STOP to breakeven (SELL if already back below it). After a
               trim, trail at highest close since entry - 3 x ATR(14) (2 x in a
               RED regime): RAISE STOP to it, or SELL if the close is below it.
               TIME EXIT after 15 sessions without a new closing high (the
               entry price counts as the first high).
  long       : weekly. SELL only on a completed week's close below the 30-week
               SMA, or <= -30% from entry; mid-week daily dips never trigger.
               TRIM 1/4 at +100%. Quarterly thesis-check note after 63 sessions.
               (check_stops.py still applies the daily close <= stop, so keep a
               long-term pick's `stop` at the -30% disaster level.)
  lottery    : TRIM 1/2 at targetBase. EVENT NEXT SESSION when the next session
               is the last one on or before eventDate. Once eventDate has passed:
               SELL on a close below the prior day's low, else TIME EXIT within
               2 sessions (thesis resolved).
  macro      : SELL on a close below the 50-day SMA, else RAISE STOP to it.
               TRIM 1/3 at targetBase. TIME EXIT after 30 sessions without a trim.
RAISE STOP only ever moves a stop up, by at least 1%, and never to or above the
last close. Missing ATR/history/fields skip that rule with a note in `skipped`.

actions.json schema ("stock-bot/actions@1"):
  {schema, generatedAt, session (calendar date of the last completed session
   window), asOfClose (latest daily bar actually used), regime, counts{SELL,TRIM,...},
   actions: [{action, priority, id, ticker, type, rule, why, close, closeDate,
              entry, stop, newStop?, fraction?, basis ("close"|"quote"), command?}],
   positions: [{id, ticker, type, close, closeDate, entry, stop, returnPct,
                rMultiple, sessions, sessionsSinceHigh, highClose, atr14,
                trimmed, levels{...}, actions[...], notes[...]}],
   skipped: [{id, ticker, why}], markdown}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_stops import (  # noqa: E402
    PICKS_PATH,
    PRICES_PATH,
    ROOT,
    STOPPED_PATH,
    bar_date,
    ineligible_session_date,
    is_open_status,
    last_completed_session_date,
    side_of,
    usable_number,
    utc_now_iso,
)

SCHEMA = "stock-bot/actions@1"
TYPES = ("swing", "fast", "lottery", "long", "macro")
PRIORITY = {"SELL": 1, "TIME EXIT": 2, "EVENT NEXT SESSION": 2, "TRIM": 3, "RAISE STOP": 4}
MIN_RAISE = 0.01
DEFAULT_REGIME = ROOT.parent / "gates" / "regime.json"
PROTECTED = {PICKS_PATH.resolve(), STOPPED_PATH.resolve(), PRICES_PATH.resolve()}

# NYSE full-day closures, so "next session" is right around holidays.
NYSE_HOLIDAYS = {
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3), date(2026, 5, 25),
    date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26), date(2027, 5, 31),
    date(2027, 6, 18), date(2027, 7, 5), date(2027, 9, 6), date(2027, 11, 25), date(2027, 12, 24),
}


@dataclass(frozen=True)
class Bar:
    day: date
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


# ---------------------------------------------------------------- helpers


def sma(values: list[float], n: int) -> float | None:
    return sum(values[-n:]) / n if n > 0 and len(values) >= n else None


def atr(bars: list[Bar], n: int = 14) -> float | None:
    """Wilder ATR(n); needs n+1 bars."""
    trs = [
        max(b.high - b.low, abs(b.high - p.close), abs(b.low - p.close))
        for p, b in zip(bars, bars[1:])
    ]
    if len(trs) < n:
        return None
    value = sum(trs[:n]) / n
    for tr in trs[n:]:
        value = (value * (n - 1) + tr) / n
    return value


def is_session(d: date) -> bool:
    return d.weekday() < 5 and d not in NYSE_HOLIDAYS


def next_session(d: date) -> date:
    d += timedelta(days=1)
    while not is_session(d):
        d += timedelta(days=1)
    return d


def last_session_on_or_before(d: date) -> date:
    while not is_session(d):
        d -= timedelta(days=1)
    return d


def parse_day(raw) -> date | None:
    try:
        return date.fromisoformat(str(raw).strip()[:10])
    except (TypeError, ValueError):
        return None


def px(value) -> float | None:
    if value is None:
        return None
    return round(float(value), 2 if float(value) >= 1 else 4)


def pick_type(pick: dict) -> str:
    """Explicit `type`, else the app.js inference (thesis prefix, grade, horizon)."""
    raw = str(pick.get("type") or "").strip().lower()
    if raw in TYPES:
        return raw
    thesis = str(pick.get("thesis") or "").lstrip().lower()
    if thesis.startswith("macro"):
        return "macro"
    if thesis.startswith("lottery"):
        return "lottery"
    if thesis.startswith(("long-term", "long term", "longterm")):
        return "long"
    if thesis.startswith(("fast mover", "trending")):
        return "fast"
    if str(pick.get("grade") or "").strip().lower() == "lottery":
        return "lottery"
    if str(pick.get("horizon") or "").strip().lower() == "fast":
        return "fast"
    return "swing"


def weekly_closes(bars: list[Bar], session: date) -> list[tuple[date, float]]:
    """(last trading day, close) per completed calendar week (Mon-Fri)."""
    weeks: dict[tuple[int, int], Bar] = {}
    for b in bars:
        if b.day > session:
            continue
        key = b.day.isocalendar()[:2]
        weeks[key] = b  # bars are sorted, so the last one wins
    out = []
    for b in weeks.values():
        friday = b.day + timedelta(days=4 - b.day.weekday())
        if session >= friday or (b.day < session and b.day.isocalendar()[:2] != session.isocalendar()[:2]):
            out.append((b.day, b.close))
    return sorted(out)


def trimmed(pick: dict) -> bool:
    parts = pick.get("partials")
    if not isinstance(parts, list):
        return False
    return any(usable_number((p or {}).get("fraction")) for p in parts if isinstance(p, dict))


# ---------------------------------------------------------------- engine


def evaluate_pick(
    pick: dict,
    bars: list[Bar] | None,
    session: date,
    *,
    quote: float | None = None,
    regime_color: str | None = None,
) -> dict:
    """Actions for one open pick. Pure; never mutates the pick."""
    pid = str(pick.get("id") or "")
    ticker = str(pick.get("ticker") or "").upper().strip()
    ptype = pick_type(pick)
    entry = usable_number(pick.get("entryPrice")) or usable_number(pick.get("priceAtCall"))
    stop = usable_number(pick.get("stop"))
    initial = usable_number(pick.get("initialStop"))
    if initial is None and stop is not None and entry is not None and stop < entry:
        initial = stop
    risk = entry - initial if (entry is not None and initial is not None and initial < entry) else None
    target = usable_number(pick.get("targetBase")) or usable_number(pick.get("target"))
    did_trim = trimmed(pick)
    actions: list[dict] = []
    notes: list[str] = []
    skipped: list[str] = []

    all_bars = sorted([b for b in (bars or []) if b.day <= session], key=lambda b: b.day)
    cutoff = ineligible_session_date(pick)
    eligible = [b for b in all_bars if cutoff is None or b.day > cutoff]
    pos: dict = {"id": pid, "ticker": ticker, "type": ptype, "entry": px(entry), "stop": px(stop),
                 "initialStop": px(initial), "target": px(target), "trimmed": did_trim, "levels": {}}

    def act(kind, rule, why, *, close, basis="close", **extra):
        a = {"action": kind, "priority": PRIORITY[kind], "id": pid, "ticker": ticker, "type": ptype,
             "rule": rule, "why": why, "close": px(close), "closeDate": pos.get("closeDate"),
             "entry": px(entry), "stop": px(stop), "basis": basis}
        a.update({k: v for k, v in extra.items() if v is not None})
        if kind in ("SELL", "TIME EXIT"):
            a["command"] = f'node scripts/pick.mjs close --id {pid} --price <fill> --notes "{rule}"'
        elif kind == "TRIM":
            a["command"] = f'node scripts/pick.mjs update --id {pid} --partial "{extra["fraction"]}@<fill>"'
        elif kind == "RAISE STOP":
            a["command"] = f"node scripts/pick.mjs update --id {pid} --stop {extra['newStop']}"
        actions.append(a)
        return a

    def finish():
        pos["actions"] = [a["action"] for a in actions]
        pos["notes"] = notes
        return {"actions": actions, "position": pos, "skipped": skipped}

    if entry is None:
        skipped.append("no usable entry price")
        return finish()
    if stop is None:
        skipped.append("no usable stop: stop rule skipped")

    # ---- no daily bars: quote-only fallback (prices.json), clearly labeled
    if not eligible:
        if not all_bars and quote is not None:
            pos.update({"close": px(quote), "returnPct": round((quote / entry - 1) * 100, 2)})
            if stop is not None and quote <= stop:
                act("SELL", "stop (quote)", f"last quote {px(quote)} <= stop {px(stop)}; confirm on the official close",
                    close=quote, basis="quote")
            elif target and not did_trim and quote >= target:
                frac = {"fast": "0.5", "lottery": "0.5", "long": "0.25"}.get(ptype, "0.33")
                act("TRIM", "target (quote)", f"last quote {px(quote)} >= base target {px(target)}",
                    close=quote, basis="quote", fraction=frac)
            skipped.append("no daily bars: only the quote-based stop/target check ran")
        elif all_bars:
            notes.append("no completed session since the call yet")
        else:
            skipped.append("no daily bars and no quote: all rules skipped")
        return finish()

    last = eligible[-1]
    prior = all_bars[-2] if len(all_bars) >= 2 else None
    close = last.close
    a14 = atr(all_bars)
    high_close = max(b.close for b in eligible)
    mark, last_high = entry, -1
    for i, b in enumerate(eligible):
        if b.close > mark:
            mark, last_high = b.close, i
    since_high = len(eligible) - 1 - last_high
    r_mult = (close - entry) / risk if risk else None
    pos.update({
        "close": px(close), "closeDate": last.day.isoformat(),
        "returnPct": round((close / entry - 1) * 100, 2),
        "rMultiple": round(r_mult, 2) if r_mult is not None else None,
        "sessions": len(eligible), "sessionsSinceHigh": since_high,
        "highClose": px(high_close), "atr14": round(a14, 4) if a14 else None,
    })

    # ---- every type: the stop itself
    if stop is not None and close <= stop:
        act("SELL", "stop", f"close {px(close)} <= stop {px(stop)}", close=close)
        return finish()

    def raise_to(level, rule, why):
        if level is None or level >= close:
            return
        if stop is not None and level <= stop * (1 + MIN_RAISE):
            return
        act("RAISE STOP", rule, why, close=close, newStop=px(level))

    if risk is None and ptype in ("fast", "swing"):
        skipped.append("no initial risk (initialStop missing and stop >= entry): R-based rules skipped")

    if ptype == "fast":
        trim_at = min(x for x in (entry * 1.20, entry + 2 * risk if risk else None) if x)
        pos["levels"].update({"trimAt": px(trim_at), "plus1R": px(entry + risk) if risk else None})
        if not did_trim and close >= trim_at:
            act("TRIM", "+20% / +2R", f"close {px(close)} >= {px(trim_at)} (+20% or +2R): sell 1/2",
                close=close, fraction="0.5")
        if did_trim:
            if prior is None:
                skipped.append("no prior bar: prior-day-low trail skipped")
            elif close < prior.low:
                act("SELL", "fast trail", f"close {px(close)} below the prior day's low {px(prior.low)} after the trim",
                    close=close)
                return finish()
            else:
                raise_to(last.low, "fast trail", f"after the trim, trail at today's low {px(last.low)} (close below it = exit)")
        if risk and len(eligible) >= 5 and high_close < entry + risk:
            act("TIME EXIT", "5 sessions without +1R",
                f"{len(eligible)} sessions since the call; best close {px(high_close)} never reached +1R {px(entry + risk)}",
                close=close)

    elif ptype == "swing":
        mult = 2.0 if str(regime_color or "").upper() == "RED" else 3.0
        trims = [x for x in (target, entry + 2 * risk if risk else None) if x]
        trim_at = min(trims) if trims else None
        pos["levels"].update({"trimAt": px(trim_at), "breakevenAt": px(entry + 1.5 * risk) if risk else None})
        if trim_at and not did_trim and close >= trim_at:
            which = "base target" if target and trim_at == target else "+2R"
            act("TRIM", "base target / +2R", f"close {px(close)} >= {which} {px(trim_at)}: sell 1/3",
                close=close, fraction="0.33")
        candidates = []
        if risk and high_close >= entry + 1.5 * risk and (stop is None or stop < entry):
            if close <= entry:
                act("SELL", "breakeven", f"reached +1.5R (best close {px(high_close)}) and fell back to {px(close)}, below breakeven {px(entry)}",
                    close=close)
                return finish()
            candidates.append((entry, "breakeven", f"best close {px(high_close)} reached +1.5R ({px(entry + 1.5 * risk)}): stop to breakeven {px(entry)}"))
        if did_trim:
            if a14:
                trail = high_close - mult * a14
                pos["levels"]["trail"] = px(trail)
                if close <= trail:
                    act("SELL", "ATR trail", f"close {px(close)} <= trail {px(trail)} (highest close {px(high_close)} - {mult:g} x ATR {a14:.2f})",
                        close=close)
                    return finish()
                candidates.append((trail, "ATR trail", f"trail = highest close {px(high_close)} - {mult:g} x ATR(14) {a14:.2f}"))
            else:
                skipped.append("ATR(14) unavailable: post-trim trailing stop skipped")
        if candidates:
            level, rule, why = max(candidates, key=lambda c: c[0])
            raise_to(level, rule, why)
        if since_high >= 15:
            act("TIME EXIT", "15 sessions without a new closing high",
                f"{since_high} sessions since the last new closing high (high-water {px(mark)})", close=close)

    elif ptype == "long":
        weeks = weekly_closes(all_bars, session)
        ma30 = sma([c for _, c in weeks], 30)
        pos["levels"].update({"ma30w": px(ma30), "minus30": px(entry * 0.70), "trimAt": px(entry * 2)})
        if weeks:
            wk_day, wk_close = weeks[-1]
            pos["levels"]["lastWeekClose"] = px(wk_close)
            pos["levels"]["lastWeekEnd"] = wk_day.isoformat()
            if cutoff is not None and wk_day <= cutoff:
                notes.append("no completed week since the call yet")
            elif wk_close <= entry * 0.70:
                act("SELL", "-30% weekly", f"week ending {wk_day} closed {px(wk_close)}, -30% or worse from entry {px(entry)}",
                    close=close)
                return finish()
            elif ma30 is not None and wk_close < ma30:
                act("SELL", "30-week MA", f"week ending {wk_day} closed {px(wk_close)} below the 30-week MA {px(ma30)}",
                    close=close)
                return finish()
        if ma30 is None:
            skipped.append(f"only {len(weeks)} completed weeks: 30-week MA rule skipped (needs 30)")
        if not did_trim and close >= entry * 2:
            act("TRIM", "+100%", f"close {px(close)} is +100% from entry {px(entry)}: sell 1/4", close=close, fraction="0.25")
        notes.append("weekly-close system: daily dips below the 30-week MA don't count until Friday's close")
        if len(eligible) >= 63:
            notes.append("quarterly thesis check due: two quarters of revenue slowdown or margin compression = exit")

    elif ptype == "lottery":
        event = parse_day(pick.get("eventDate"))
        pos["levels"]["eventDate"] = event.isoformat() if event else None
        if target and not did_trim and close >= target:
            act("TRIM", "base target", f"close {px(close)} >= base target {px(target)}: sell at least 1/2",
                close=close, fraction="0.5")
        if event is None:
            skipped.append("no eventDate on the pick: event rules skipped (set it with pick.mjs update --event-date)")
        elif session >= event:
            if prior is not None and close < prior.low:
                act("SELL", "event resolved", f"event {event} has passed and the close {px(close)} is below the prior day's low {px(prior.low)}",
                    close=close)
                return finish()
            act("TIME EXIT", "event resolved", f"event {event} has passed: thesis resolved, exit the rest within 2 sessions",
                close=close)
        elif next_session(session) >= last_session_on_or_before(event):
            act("EVENT NEXT SESSION", "binary event", f"decision due {event}: the next session is the last one before it; decide hold-through or exit",
                close=close, eventDate=event.isoformat())

    elif ptype == "macro":
        s50 = sma([b.close for b in all_bars], 50)
        pos["levels"]["sma50"] = px(s50)
        if s50 is None:
            skipped.append(f"only {len(all_bars)} bars: 50-day rule skipped")
        elif close < s50:
            act("SELL", "50-day", f"close {px(close)} below the 50-day {px(s50)}", close=close)
            return finish()
        else:
            raise_to(s50, "50-day trail", f"trail = 50-day SMA {px(s50)} (close below it = exit)")
        if target and not did_trim and close >= target:
            act("TRIM", "target", f"close {px(close)} >= target {px(target)}: sell 1/3", close=close, fraction="0.33")
        if not did_trim and len(eligible) >= 30:
            act("TIME EXIT", "30 sessions", f"{len(eligible)} sessions without reaching the target", close=close)

    return finish()


def build_actions(
    picks: list[dict],
    bars_by_ticker: dict[str, list[Bar]],
    session: date,
    *,
    quotes: dict[str, float] | None = None,
    regime_color: str | None = None,
    fetch_errors: dict[str, str] | None = None,
    now_iso: str | None = None,
) -> dict:
    actions, positions, skipped = [], [], []
    for pick in picks:
        if not isinstance(pick, dict) or not is_open_status(pick):
            continue
        ticker = str(pick.get("ticker") or "").upper().strip()
        if side_of(pick) != "long":
            skipped.append({"id": pick.get("id"), "ticker": ticker, "why": f"side {side_of(pick)}: long rules only"})
            continue
        res = evaluate_pick(pick, bars_by_ticker.get(ticker), session,
                            quote=(quotes or {}).get(ticker), regime_color=regime_color)
        actions.extend(res["actions"])
        positions.append(res["position"])
        for why in res["skipped"]:
            skipped.append({"id": pick.get("id"), "ticker": ticker, "why": why})
        if fetch_errors and ticker in fetch_errors:
            skipped.append({"id": pick.get("id"), "ticker": ticker, "why": fetch_errors[ticker]})
    actions.sort(key=lambda a: (a["priority"], a["ticker"]))
    counts: dict[str, int] = {}
    for a in actions:
        counts[a["action"]] = counts.get(a["action"], 0) + 1
    closes_seen = [p["closeDate"] for p in positions if p.get("closeDate")]
    doc = {
        "schema": SCHEMA,
        "generatedAt": now_iso or utc_now_iso(),
        "session": session.isoformat(),
        "asOfClose": max(closes_seen) if closes_seen else None,
        "regime": regime_color,
        "counts": counts,
        "actions": actions,
        "positions": positions,
        "skipped": skipped,
    }
    doc["markdown"] = render_markdown(doc)
    return doc


FRACTION_TEXT = {"0.5": "1/2", "0.33": "1/3", "0.25": "1/4"}


def render_markdown(doc: dict) -> str:
    sess = doc.get("asOfClose") or doc["session"]
    head = f"**Exit actions after the {sess} close**" + (f" (regime {doc['regime']})" if doc.get("regime") else "")
    lines = [head]
    if not doc["actions"]:
        lines.append("No exit actions today.")
    for i, a in enumerate(doc["actions"], 1):
        label = a["action"]
        if label == "TRIM":
            label = f"TRIM {FRACTION_TEXT.get(a.get('fraction'), a.get('fraction'))}"
        if label == "RAISE STOP":
            text = f"{i}. **RAISE STOP {a['ticker']}** {a['stop']} -> {a['newStop']}: {a['why']}."
        else:
            when = " at the open" if a["action"] in ("SELL", "TIME EXIT", "TRIM") else ""
            text = f"{i}. **{label} {a['ticker']}**{when}: {a['why']}."
        if a.get("basis") == "quote":
            text += " _(quote-based)_"
        if a.get("command"):
            text += f" `{a['command']}`"
        lines.append(text)
    acted = {a["id"] for a in doc["actions"]}
    holds = [
        f"{p['ticker']} {p['returnPct']:+.1f}%" + (f" ({p['rMultiple']:+.1f}R)" if p.get("rMultiple") is not None else "")
        for p in doc["positions"]
        if p["id"] not in acted and p.get("returnPct") is not None
    ]
    if holds:
        lines.append("Hold: " + ", ".join(holds) + ".")
    if doc["skipped"]:
        lines.append("_Rules skipped: " + "; ".join(f"{s['ticker']}: {s['why']}" for s in doc["skipped"]) + "._")
    return "\n".join(lines)


# ---------------------------------------------------------------- I/O


def bars_from_rows(rows) -> list[Bar]:
    out = []
    for row in rows or []:
        try:
            day = parse_day(row[0])
            o, h, l, c = (float(x) for x in row[1:5])
            v = float(row[5]) if len(row) > 5 else 0.0
        except (TypeError, ValueError, IndexError):
            continue
        if day and all(math.isfinite(x) and x > 0 for x in (o, h, l, c)):
            out.append(Bar(day, o, h, l, c, v))
    return sorted(out, key=lambda b: b.day)


def fetch_bars(ticker: str) -> list[Bar]:
    import yfinance as yf

    hist = yf.Ticker(ticker).history(period="1y", interval="1d", auto_adjust=False, actions=False)
    out = []
    if hist is None or getattr(hist, "empty", True):
        return out
    for idx, row in hist.iterrows():
        day = bar_date(idx)
        vals = [usable_number(row.get(k)) for k in ("Open", "High", "Low", "Close")]
        if day is None or vals[3] is None:
            continue
        c = vals[3]
        o, h, l = (vals[0] or c), (vals[1] or c), (vals[2] or c)
        out.append(Bar(day, o, max(h, o, c), min(l, o, c), c, float(row.get("Volume") or 0)))
    return sorted(out, key=lambda b: b.day)


def load_doc(path: Path, key: str) -> dict:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warn: could not read {path}: {exc}", file=sys.stderr)
        return {}
    return doc if isinstance(doc, dict) else {}


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Build the 5 AM exit-actions list (read-only on tracker data).")
    ap.add_argument("--picks", type=Path, default=PICKS_PATH, help="picks.json to read")
    ap.add_argument("--prices", type=Path, default=PRICES_PATH, help="prices.json to read (quotes fallback)")
    ap.add_argument("--out", type=Path, help="write actions.json here (omit = print only)")
    ap.add_argument("--md", type=Path, help="also write the markdown block here")
    ap.add_argument("--regime", type=Path, default=DEFAULT_REGIME, help="gates/regime.json (optional)")
    ap.add_argument("--bars-json", type=Path, help='offline bars {"TICKER": [[date,o,h,l,c,v],...]}')
    ap.add_argument("--no-fetch", action="store_true", help="no yfinance: use --bars-json and/or quotes")
    ap.add_argument("--now", help="ISO timestamp to evaluate as of (default: now)")
    ap.add_argument("--dry-run", action="store_true", help="print only; write nothing")
    ap.add_argument("--json", action="store_true", help="print the JSON document instead of markdown")
    return ap.parse_args(argv)


def main(argv=None, fetch=fetch_bars) -> int:
    args = parse_args(argv)
    for target in (args.out, args.md):
        if target is not None:
            resolved = target.resolve()
            if resolved in PROTECTED or resolved in {args.picks.resolve(), args.prices.resolve()}:
                print(f"Refusing to write {target}: that is tracker data, not an actions file.", file=sys.stderr)
                return 1
    now = None
    if args.now:
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
    session = last_completed_session_date(now)

    picks = load_doc(args.picks, "picks").get("picks")
    if not isinstance(picks, list):
        print(f'{args.picks} must look like {{"picks": []}}', file=sys.stderr)
        return 1
    prices = load_doc(args.prices, "prices").get("prices") or {}
    quotes = {str(k).upper(): usable_number((v or {}).get("price")) for k, v in prices.items() if isinstance(v, dict)}
    quotes = {k: v for k, v in quotes.items() if v is not None}
    regime_doc = load_doc(args.regime, "regime") if args.regime else {}
    regime_color = str(regime_doc.get("color") or "").upper() or None

    tickers = sorted({
        str(p.get("ticker") or "").upper().strip()
        for p in picks
        if isinstance(p, dict) and is_open_status(p) and side_of(p) == "long" and p.get("ticker")
    })
    bars_by: dict[str, list[Bar]] = {}
    errors: dict[str, str] = {}
    if args.bars_json:
        raw = load_doc(args.bars_json, "bars")
        bars_by = {str(k).upper(): bars_from_rows(v) for k, v in raw.items()}
    if not args.no_fetch:
        for t in tickers:
            if t in bars_by:
                continue
            try:
                bars_by[t] = fetch(t)
            except Exception as exc:
                errors[t] = f"daily bars failed ({type(exc).__name__}): rules skipped, quote fallback only"
                bars_by[t] = []

    doc = build_actions(picks, bars_by, session, quotes=quotes, regime_color=regime_color, fetch_errors=errors)
    if args.json:
        print(json.dumps(doc, indent=2))
    else:
        print(doc["markdown"])
    if args.dry_run or args.out is None:
        if args.out is not None or args.md is not None:
            print("(dry run: nothing written)", file=sys.stderr)
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    if args.md:
        args.md.parent.mkdir(parents=True, exist_ok=True)
        args.md.write_text(doc["markdown"] + "\n", encoding="utf-8")
    print(f"wrote {args.out}" + (f" and {args.md}" if args.md else ""), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
