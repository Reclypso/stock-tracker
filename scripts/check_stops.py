#!/usr/bin/env python3
"""Move open long picks to data/stopped.json when the last completed US
session's official daily close is at or below the stop.

Uses daily closes only — never intraday wicks — and never removes a pick
because of missing, zero, or otherwise invalid price data.
"""

from __future__ import annotations

import io
import json
import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
PICKS_PATH = ROOT / "data" / "picks.json"
STOPPED_PATH = ROOT / "data" / "stopped.json"
PRICES_PATH = ROOT / "data" / "prices.json"

ET = ZoneInfo("America/New_York")
# Regular-session close is 16:00 ET. Wait a few minutes so Yahoo's daily bar
# is the official close, not a last print from the cash session still settling.
CLOSE_GRACE = timedelta(hours=16, minutes=5)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def last_completed_session_date(now: datetime | None = None, *, grace: bool = True) -> date:
    """Calendar date of the most recently completed US regular session.

    Before the official close (16:00 America/New_York, or 16:05 when
    `grace` is set so Yahoo's daily bar can settle), today's bar is
    treated as in-progress and we use the previous calendar day.
    Weekend/holiday dates are fine: callers then take the last daily
    bar on or before that date, which is the prior trading day.
    """
    now_et = (now or datetime.now(timezone.utc)).astimezone(ET)
    session = now_et.date()
    delta = CLOSE_GRACE if grace else timedelta(hours=16)
    cutoff = datetime(now_et.year, now_et.month, now_et.day, tzinfo=ET) + delta
    if now_et < cutoff:
        session -= timedelta(days=1)
    return session


def parse_iso(raw) -> datetime | None:
    if not raw:
        return None
    try:
        text = str(raw).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        ts = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def ineligible_session_date(pick: dict) -> date | None:
    """A daily close on or before this date was already known when the pick was made.

    After-hours and evening calls must not be dropped by that same day's regular
    close (often the pre-news print the lead was reacting to).
    """
    called = parse_iso(pick.get("calledAt") if isinstance(pick, dict) else None)
    if called is not None:
        return last_completed_session_date(called, grace=False)
    # No timestamp: use the start of dateCalled in Pacific time so that day's
    # session close can still count for an intraday call.
    raw = str((pick or {}).get("dateCalled") or "").strip()
    try:
        year, month, day = (int(part) for part in raw.split("-"))
        start_pt = datetime(year, month, day, tzinfo=ZoneInfo("America/Los_Angeles"))
    except (TypeError, ValueError):
        return None
    return last_completed_session_date(start_pt, grace=False)


def usable_number(value) -> float | None:
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num) or num <= 0:
        return None
    return num


def is_open_long(pick: dict) -> bool:
    if not isinstance(pick, dict) or pick.get("status") != "open":
        return False
    stop = usable_number(pick.get("stop"))
    entry = usable_number(pick.get("priceAtCall"))
    # Longs only: a short's stop sits above entry, and close <= stop would
    # almost always fire. Picks with no usable stop or entry are left alone.
    if stop is None or entry is None:
        return False
    return stop < entry


def ticker_of(pick: dict) -> str:
    return str(pick.get("ticker") or "").upper().strip()


def return_pct(entry, close) -> float | None:
    base = usable_number(entry)
    last = usable_number(close)
    if base is None or last is None:
        return None
    return round((last - base) / base * 100.0, 2)


def bar_date(index_val) -> date | None:
    try:
        from datetime import date as date_cls

        if isinstance(index_val, date_cls) and not isinstance(index_val, datetime):
            return index_val
        ts = index_val
        if hasattr(ts, "to_pydatetime"):
            ts = ts.to_pydatetime()
        if not isinstance(ts, datetime):
            ts = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if ts.tzinfo is not None:
            ts = ts.astimezone(ET)
        return ts.date()
    except Exception:
        return None


def close_on_or_before(bars: list[tuple[date, float]], session: date) -> float | None:
    """Official close of the last daily bar on or before `session`."""
    bar = close_bar_on_or_before(bars, session)
    return None if bar is None else bar[1]


def close_bar_on_or_before(bars: list[tuple[date, float]], session: date) -> tuple[date, float] | None:
    """Date and official close of the last daily bar on or before `session`."""
    chosen = None
    for day, close in bars:
        if day is None or day > session:
            continue
        price = usable_number(close)
        if price is None:
            continue
        chosen = (day, price)
    return chosen


def bars_from_history(hist) -> list[tuple[date, float]]:
    out: list[tuple[date, float]] = []
    if hist is None or getattr(hist, "empty", True):
        return out
    if "Close" not in getattr(hist, "columns", []):
        return out
    for idx, row in hist.iterrows():
        day = bar_date(idx)
        close = usable_number(row.get("Close") if hasattr(row, "get") else row["Close"])
        if day is None or close is None:
            continue
        out.append((day, close))
    return out


def fetch_daily_bars(ticker: str) -> list[tuple[date, float]]:
    import yfinance as yf

    hist = yf.Ticker(ticker).history(
        period="15d",
        interval="1d",
        auto_adjust=False,
        actions=False,
    )
    return bars_from_history(hist)


def load_json(path: Path, fallback: dict | None, required: bool) -> dict:
    if not path.exists():
        if required:
            print(f"Missing {path}", file=sys.stderr)
            raise SystemExit(1)
        return fallback if fallback is not None else {}
    try:
        with path.open(encoding="utf-8") as handle:
            doc = json.load(handle)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON in {path}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    if not isinstance(doc, dict):
        print(f"{path} must be a JSON object", file=sys.stderr)
        raise SystemExit(1)
    return doc


def serialize(payload) -> str:
    buf = io.StringIO()
    json.dump(payload, buf, indent=2)
    text = buf.getvalue()
    if not text.endswith("\n"):
        text += "\n"
    return text


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize(payload), encoding="utf-8")


def prune_prices(prices_doc: dict, open_tickers: set[str], now: str) -> dict:
    old = prices_doc if isinstance(prices_doc, dict) else {}
    prices = old.get("prices")
    if not isinstance(prices, dict):
        prices = {}
    kept = {k: v for k, v in prices.items() if str(k).upper().strip() in open_tickers}
    if set(kept) == set(prices) and len(kept) == len(prices):
        return old if isinstance(prices_doc, dict) else {"prices": {}, "updated": None}
    updated = now if kept else (None if not open_tickers else now)
    if not kept and not open_tickers:
        updated = None
    return {"prices": kept, "updated": updated}


def apply_stops(
    picks_doc: dict,
    stopped_doc: dict,
    closes: dict,
    session: date,
    prices_doc: dict | None = None,
    now: str | None = None,
) -> tuple[dict, dict, dict, list[dict]]:
    """Pure stop-out pass.

    `closes` maps ticker -> close, or ticker -> (session_date, close). A pick
    is moved only when it is an open long, the close is a usable number at or
    below its stop, and that close belongs to a session after the pick was
    called. Missing/invalid/too-early closes leave the pick in place.
    """
    picks = picks_doc.get("picks") if isinstance(picks_doc, dict) else None
    if not isinstance(picks, list):
        print('data/picks.json must look like {"picks": []}', file=sys.stderr)
        raise SystemExit(1)
    stopped_list = stopped_doc.get("stopped") if isinstance(stopped_doc, dict) else None
    if stopped_list is None:
        stopped_list = []
    if not isinstance(stopped_list, list):
        print('data/stopped.json must look like {"stopped": []}', file=sys.stderr)
        raise SystemExit(1)

    remaining: list = []
    moved: list[dict] = []
    for pick in picks:
        if not is_open_long(pick):
            remaining.append(pick)
            continue
        ticker = ticker_of(pick)
        if not ticker:
            remaining.append(pick)
            continue
        raw_close = closes.get(ticker)
        close_day = session
        if isinstance(raw_close, tuple) and len(raw_close) == 2:
            close_day, close_val = raw_close
            close = usable_number(close_val)
            if isinstance(close_day, datetime):
                close_day = close_day.date()
            elif not isinstance(close_day, date):
                close_day = session
        else:
            close = usable_number(raw_close)
        if close is None:
            remaining.append(pick)
            continue
        cutoff = ineligible_session_date(pick)
        if cutoff is not None and close_day <= cutoff:
            remaining.append(pick)
            continue
        stop = usable_number(pick.get("stop"))
        if stop is None or close > stop:
            remaining.append(pick)
            continue
        record = {
            "stoppedDate": close_day.isoformat() if isinstance(close_day, date) else session.isoformat(),
            "closePrice": round(close, 4),
            "returnPct": return_pct(pick.get("priceAtCall"), close),
            "pick": pick,
        }
        moved.append(record)

    if not moved:
        return picks_doc, stopped_doc if isinstance(stopped_doc, dict) else {"stopped": []}, (
            prices_doc if isinstance(prices_doc, dict) else {"prices": {}, "updated": None}
        ), []

    new_picks = {"picks": remaining}
    new_stopped = {"stopped": moved + list(stopped_list)}
    open_tickers = {
        ticker_of(pick)
        for pick in remaining
        if isinstance(pick, dict) and pick.get("status") == "open" and ticker_of(pick)
    }
    new_prices = prune_prices(prices_doc or {}, open_tickers, now or utc_now_iso())
    return new_picks, new_stopped, new_prices, moved


def collect_closes(tickers: list[str], session: date, fetch=fetch_daily_bars) -> dict[str, tuple[date, float] | None]:
    closes: dict[str, tuple[date, float] | None] = {}
    for ticker in tickers:
        try:
            bars = fetch(ticker)
        except Exception as exc:
            print(f"{ticker}: daily history failed ({exc})", file=sys.stderr)
            closes[ticker] = None
            continue
        bar = close_bar_on_or_before(bars or [], session)
        if bar is None:
            print(f"{ticker}: no completed daily close on or before {session.isoformat()}", file=sys.stderr)
        else:
            print(f"{ticker}: {bar[0].isoformat()} close {bar[1]}", file=sys.stderr)
        closes[ticker] = bar
    return closes


def main() -> int:
    picks_doc = load_json(PICKS_PATH, None, required=True)
    stopped_doc = load_json(STOPPED_PATH, {"stopped": []}, required=False)
    if not isinstance(stopped_doc.get("stopped"), list):
        if "stopped" not in stopped_doc and isinstance(stopped_doc, dict) and not stopped_doc:
            stopped_doc = {"stopped": []}
        elif not isinstance(stopped_doc.get("stopped"), list):
            print('data/stopped.json must look like {"stopped": []}', file=sys.stderr)
            raise SystemExit(1)
    prices_doc = load_json(PRICES_PATH, {"prices": {}, "updated": None}, required=False)

    picks = picks_doc.get("picks")
    if not isinstance(picks, list):
        print('data/picks.json must look like {"picks": []}', file=sys.stderr)
        raise SystemExit(1)

    session = last_completed_session_date()
    tickers: list[str] = []
    seen: set[str] = set()
    for pick in picks:
        if not is_open_long(pick):
            continue
        ticker = ticker_of(pick)
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        tickers.append(ticker)

    if not tickers:
        print(f"No open long picks with a stop to check (session {session.isoformat()}).")
        print("STOPPED_TICKERS=")
        if not STOPPED_PATH.exists():
            write_json(STOPPED_PATH, {"stopped": []})
        return 0

    closes = collect_closes(tickers, session)
    new_picks, new_stopped, new_prices, moved = apply_stops(
        picks_doc, stopped_doc, closes, session, prices_doc, utc_now_iso()
    )
    if not moved:
        print(f"No stop-outs on close of {session.isoformat()}.")
        print("STOPPED_TICKERS=")
        if not STOPPED_PATH.exists():
            write_json(STOPPED_PATH, {"stopped": []})
        return 0

    write_json(PICKS_PATH, new_picks)
    write_json(STOPPED_PATH, new_stopped)
    write_json(PRICES_PATH, new_prices)
    names = ", ".join(
        f"{rec['pick'].get('ticker')} @ {rec['closePrice']}" for rec in moved
    )
    print(f"Stopped out {len(moved)} pick(s) on close of {session.isoformat()}: {names}")
    print("STOPPED_TICKERS=" + ",".join(str(rec["pick"].get("ticker") or "") for rec in moved))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
