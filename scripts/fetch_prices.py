#!/usr/bin/env python3
"""Write data/prices.json for open picks using yfinance.

Closed and removed tickers are dropped. A failed ticker keeps its previous
entry. "updated" changes only when some stored price actually changes, so an
unchanged run produces no diff. With no open tickers the file is exactly
{"prices": {}, "updated": null} (pretty-printed, keys sorted).
"""

from __future__ import annotations

import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PICKS_PATH = ROOT / "data" / "picks.json"
PRICES_PATH = ROOT / "data" / "prices.json"

PRICE_KEYS = ("last_price", "lastPrice", "regular_market_price", "regularMarketPrice")
PREV_KEYS = (
    "previous_close",
    "previousClose",
    "regular_market_previous_close",
    "regularMarketPreviousClose",
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path: Path, required: bool) -> dict:
    if not path.exists():
        if required:
            print(f"Missing {path}", file=sys.stderr)
            raise SystemExit(1)
        return {"prices": {}, "updated": None}
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


def open_tickers_from(doc: dict) -> list[str]:
    picks = doc.get("picks")
    if not isinstance(picks, list):
        print('data/picks.json must look like {"picks": []}', file=sys.stderr)
        raise SystemExit(1)
    tickers: list[str] = []
    seen: set[str] = set()
    for pick in picks:
        if not isinstance(pick, dict) or pick.get("status") != "open":
            continue
        ticker = str(pick.get("ticker") or "").upper().strip()
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        tickers.append(ticker)
    return tickers


def first_number(source, keys: tuple[str, ...]) -> float | None:
    if source is None:
        return None
    for key in keys:
        val = None
        try:
            if isinstance(source, dict):
                val = source.get(key)
            else:
                getter = getattr(source, "get", None)
                if callable(getter):
                    try:
                        val = getter(key)
                    except Exception:
                        val = None
                if val is None:
                    val = getattr(source, key, None)
        except Exception:
            continue
        if val is None:
            continue
        try:
            num = float(val)
        except (TypeError, ValueError):
            continue
        if num != num:  # NaN
            continue
        return num
    return None


def _history_quote(ticker_obj) -> tuple[float, float] | None:
    hist = ticker_obj.history(period="5d", auto_adjust=False)
    if hist is None or getattr(hist, "empty", True) or "Close" not in getattr(hist, "columns", []):
        return None
    closes = hist["Close"].dropna()
    if getattr(closes, "empty", True):
        return None
    last = closes.iloc[-1]
    price = float(last.iloc[0] if hasattr(last, "iloc") else last)
    if len(closes) >= 2:
        prev_cell = closes.iloc[-2]
        prev = float(prev_cell.iloc[0] if hasattr(prev_cell, "iloc") else prev_cell)
    else:
        prev = price
    return price, prev


def _fetch_quote(ticker: str, now: str) -> dict | None:
    import yfinance as yf

    ticker_obj = yf.Ticker(ticker)
    price = None
    prev = None
    try:
        info = ticker_obj.fast_info
        price = first_number(info, PRICE_KEYS)
        prev = first_number(info, PREV_KEYS)
    except Exception as exc:
        print(f"{ticker}: fast_info failed ({exc})", file=sys.stderr)
        price = None
        prev = None

    if price is None or prev is None or price <= 0 or prev <= 0:
        try:
            pair = _history_quote(ticker_obj)
        except Exception as exc:
            print(f"{ticker}: history failed ({exc})", file=sys.stderr)
            return None
        if pair is None:
            return None
        price, prev = pair

    if price is None or prev is None or price <= 0 or prev <= 0:
        return None
    change = (price - prev) / prev * 100.0
    return {
        "changePct": round(change, 2),
        "prevClose": round(float(prev), 4),
        "price": round(float(price), 4),
        "time": now,
    }


def fetch_quote(ticker: str, now: str | None = None) -> dict | None:
    """Latest price for one ticker, or None if both fast_info and history fail."""
    when = now or utc_now_iso()
    try:
        return _fetch_quote(ticker, when)
    except Exception as exc:
        print(f"{ticker}: fetch failed ({exc})", file=sys.stderr)
        return None


def _usable_previous(previous) -> bool:
    if not isinstance(previous, dict):
        return False
    try:
        price = float(previous["price"])
        prev = float(previous["prevClose"])
        change = float(previous["changePct"])
    except (KeyError, TypeError, ValueError):
        return False
    if price != price or prev != prev or change != change:
        return False
    return price > 0 and prev > 0


def quotes_equal(previous: dict, quote: dict) -> bool:
    try:
        return (
            round(float(previous["price"]), 4) == round(float(quote["price"]), 4)
            and round(float(previous["prevClose"]), 4) == round(float(quote["prevClose"]), 4)
            and round(float(previous["changePct"]), 2) == round(float(quote["changePct"]), 2)
        )
    except (KeyError, TypeError, ValueError):
        return False


def _coerce_quote(fetched, now: str) -> dict | None:
    if not isinstance(fetched, dict):
        return None
    try:
        price = round(float(fetched["price"]), 4)
        prev = round(float(fetched["prevClose"]), 4)
        change = round(float(fetched["changePct"]), 2)
    except (KeyError, TypeError, ValueError):
        return None
    if price <= 0 or prev <= 0 or price != price or prev != prev or change != change:
        return None
    when = fetched.get("time") or now
    return {"changePct": change, "prevClose": prev, "price": price, "time": when}


def _prices_changed(old_prices: dict, new_prices: dict) -> bool:
    if set(old_prices) != set(new_prices):
        return True
    for ticker, quote in new_prices.items():
        # Same object means we kept the previous entry verbatim.
        if quote is not old_prices.get(ticker):
            return True
    return False


def build_payload(open_tickers, old, fetch, now: str) -> dict:
    """Return the prices document to write.

    `fetch` is callable(ticker) -> quote dict or None. It may raise; a failure
    keeps the previous entry for that ticker.
    """
    old_doc = old if isinstance(old, dict) else {}
    old_prices = old_doc.get("prices")
    if not isinstance(old_prices, dict):
        old_prices = {}

    tickers: list[str] = []
    seen: set[str] = set()
    for raw in open_tickers:
        ticker = str(raw).upper().strip()
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        tickers.append(ticker)

    if not tickers:
        return {"prices": {}, "updated": None}

    new_prices: dict = {}
    for ticker in tickers:
        previous = old_prices.get(ticker)
        fetched = None
        try:
            fetched = fetch(ticker)
        except Exception as exc:
            print(f"{ticker}: fetch failed ({exc})", file=sys.stderr)
            fetched = None
        quote = _coerce_quote(fetched, now) if fetched else None
        if quote is None:
            if _usable_previous(previous):
                print(f"{ticker}: kept previous price", file=sys.stderr)
                new_prices[ticker] = previous
            else:
                print(f"{ticker}: no price", file=sys.stderr)
            continue
        if _usable_previous(previous) and quotes_equal(previous, quote):
            new_prices[ticker] = previous
        else:
            new_prices[ticker] = quote

    changed = _prices_changed(old_prices, new_prices)
    updated = now if changed else old_doc.get("updated")
    return {"prices": new_prices, "updated": updated}


def serialize(payload: dict) -> str:
    buf = io.StringIO()
    json.dump(payload, buf, indent=2, sort_keys=True)
    text = buf.getvalue()
    if not text.endswith("\n"):
        text += "\n"
    return text


def main() -> int:
    picks_doc = load_json(PICKS_PATH, required=True)
    old = load_json(PRICES_PATH, required=False)
    tickers = open_tickers_from(picks_doc)
    now = utc_now_iso()
    payload = build_payload(tickers, old, lambda ticker: fetch_quote(ticker, now), now)
    text = serialize(payload)
    previous_text = PRICES_PATH.read_text(encoding="utf-8") if PRICES_PATH.exists() else None
    if previous_text == text:
        print("Prices unchanged.")
        return 0
    PRICES_PATH.parent.mkdir(parents=True, exist_ok=True)
    PRICES_PATH.write_text(text, encoding="utf-8")
    names = ", ".join(sorted(payload["prices"])) or "(none)"
    print(f"Wrote {PRICES_PATH} for {names}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
