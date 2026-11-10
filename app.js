// Stock Bot leads feed.
// Polls picks, prices and stopped-out leads every 60s. On *.github.io, fetch
// raw.githubusercontent.com first so the GitHub Pages CDN cannot serve a stale
// copy. Sort survives those refreshes (and reloads, via localStorage). Renders
// are keyed DOM patches, so a poll only animates what changed: open "why"
// sections, expanded cards, focus, scroll and running animations are left alone.
// Lead cards start collapsed; the summary is a button (aria-expanded).

import {
  EASE, canAnimate, reducedMotion, finePointer, shown, morphHtml, countUp, roll,
  addTransient, burst, installTilt, installMagnetic, installRipple, captureRects, flip,
} from "./fx.js";
import { startBackground } from "./bg.js";

export const OWNER = "Reclypso";
export const REPO = "stock-tracker";
export const BRANCH = "main";
// Optional one-click delete via worker/ (Cloudflare Worker). Empty = GitHub issue flow.
export const DELETE_ENDPOINT = "";
export const POLL_MS = 60 * 1000;
export const FAST_POLL_MS = 5 * 1000;
export const STALE_MS = 24 * 60 * 60 * 1000;
export const PENDING_DELETE_MS = 15 * 60 * 1000;
// Same id shape scripts/pick.mjs makes and the delete-pick workflow accepts.
export const ID_RE = /^\d{4}-\d{2}-\d{2}-[A-Z][A-Z0-9.-]{0,14}(?:-\d{1,3})?$/;

const SORTS = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["best", "Most up since called"],
  ["worst", "Most down since called"],
  ["ticker", "Ticker A–Z"],
  ["grade", "Grade"],
];
const SORT_VALUES = new Set(SORTS.map(([value]) => value));
const GRADE_CLASS = { A: "g-a", B: "g-b", C: "g-c", Lottery: "g-lot" };
const GRADE_RANK = { A: 0, B: 1, C: 2, Lottery: 3 };

const state = {
  sort: "newest",
  filter: "all",
  openKeys: new Set(),
  expandedKeys: new Set(),
  picks: [],
  stopped: [],
  pricesDoc: { updated: null, prices: {} },
  picksText: null,
  pricesText: null,
  stoppedText: null,
  checkedAt: null,
  error: null,
  loading: true,
  loaded: false,
  pending: new Map(),
  demoDeleted: new Set(),
};

let polling = false;

export function num(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isGithubPages(hostname) {
  return typeof hostname === "string" && hostname.endsWith("github.io");
}

export function isLocalDemo(loc) {
  if (!loc) return false;
  const host = loc.hostname || "";
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (!local) return false;
  const params = new URLSearchParams(loc.search || "");
  return params.get("demo") === "1";
}

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res || !res.ok) {
    throw new Error(`${url} (${res ? res.status : "no-response"})`);
  }
  const text = await res.text();
  JSON.parse(text);
  return text;
}

export async function loadDataFiles(fetchImpl, loc, now = Date.now()) {
  const demo = isLocalDemo(loc);
  async function loadOne(file) {
    if (demo) return fetchText(fetchImpl, `./demo/${file}?t=${now}`);
    const relative = `./data/${file}?t=${now}`;
    if (isGithubPages(loc.hostname)) {
      const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/data/${file}?t=${now}`;
      try {
        return await fetchText(fetchImpl, raw);
      } catch {
        return fetchText(fetchImpl, relative);
      }
    }
    return fetchText(fetchImpl, relative);
  }
  const [picksText, pricesText, stoppedText] = await Promise.all([
    loadOne("picks.json"),
    loadOne("prices.json"),
    loadOne("stopped.json").catch(() => '{"stopped":[]}'),
  ]);
  return { picksText, pricesText, stoppedText };
}

export function todayPT(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatPT(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${formatted} PT`;
}

export function formatDay(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

export function formatPrice(value) {
  const n = num(value);
  if (n == null) return "—";
  const digits = Math.abs(n) >= 1 ? 2 : 4;
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPct(value, digits = 1) {
  const n = num(value);
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(digits) + "%";
}

// Headline projections: "+55%" for big moves, "+7.5%" for small ones.
export function formatProjection(value) {
  const n = num(value);
  if (n == null) return "—";
  return formatPct(n, Math.abs(n) >= 10 ? 0 : 1);
}

export function formatDays(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const unit = Math.abs(value) === 1 ? "day" : "days";
  return `${value} ${unit}`;
}

export function formatAgo(days) {
  if (days == null || !Number.isFinite(days)) return "—";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function daysHeld(pick, today) {
  const start = pick?.dateCalled;
  const end = pick?.status === "closed" && pick.exitDate ? pick.exitDate : today;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function targetBaseOf(pick) {
  const direct = num(pick?.targetBase);
  if (direct != null && direct > 0) return direct;
  const alias = num(pick?.target);
  if (alias != null && alias > 0) return alias;
  return null;
}

export function targetBullOf(pick) {
  const n = num(pick?.targetBull);
  return n != null && n > 0 ? n : null;
}

export function stopOf(pick) {
  const n = num(pick?.stop);
  return n != null && n > 0 ? n : null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Optional per-case timeframes fall back to the shared `timeframe`.
export function baseTimeframeOf(pick) {
  return cleanText(pick?.baseTimeframe) || cleanText(pick?.timeframe) || null;
}

export function bullTimeframeOf(pick) {
  return cleanText(pick?.bullTimeframe) || cleanText(pick?.timeframe) || null;
}

// The "if X happens" condition behind the bull target, without a leading "if".
export function bullCaseOf(pick) {
  const text = cleanText(pick?.bullCase).replace(/^if\s+/i, "");
  return text || null;
}

// Horizon: "fast" (about a day to a few weeks) or "swing" (default, 3-12 months).
// Picks without the field are fast when the thesis starts with "Fast mover:".
const FAST_PREFIX = /^fast mover:\s*/i;

export function horizonOf(pick) {
  const raw = cleanText(pick?.horizon).toLowerCase();
  if (raw === "fast" || raw === "swing") return raw;
  if (raw) return "swing";
  return FAST_PREFIX.test(String(pick?.thesis ?? "").trimStart()) ? "fast" : "swing";
}

export function isFast(pick) {
  return horizonOf(pick) === "fast";
}

// Trade-type tags, parsed from a thesis prefix, then grade, then horizon.
const TRADE_TYPES = [
  { key: "trending", label: "Trending", re: /^trending:\s*/i },
  { key: "macro", label: "Macro", re: /^macro(?:\s*\([^)]*\))?:\s*/i },
  { key: "lottery", label: "Lottery", re: /^lottery:\s*/i },
  { key: "long", label: "Long-term", re: /^long[\s-]?term:\s*/i },
  { key: "medium", label: "Medium-term", re: /^medium[\s-]?term:\s*/i },
  { key: "fast", label: "Fast mover", re: /^fast movers?:\s*/i },
];

export function tradeTypeOf(pick) {
  const thesis = String(pick?.thesis ?? "").trimStart();
  for (const type of TRADE_TYPES) {
    if (type.re.test(thesis)) return type;
  }
  if (String(pick?.grade || "").toLowerCase() === "lottery") {
    return { key: "lottery", label: "Lottery" };
  }
  if (horizonOf(pick) === "fast") {
    return { key: "fast", label: "Fast mover" };
  }
  return { key: "swing", label: "Swing" };
}

// Type badges already name the setup, so drop the matching prefix from the thesis.
function displayThesis(pick) {
  let text = String(pick?.thesis ?? "").trimStart();
  for (const type of TRADE_TYPES) text = text.replace(type.re, "");
  return text;
}

export const FILTERS = [["all", "All"], ["swing", "Swing"], ["fast", "Fast movers"]];
const FILTER_VALUES = new Set(FILTERS.map(([value]) => value));

export function filterLeads(picks, filter) {
  if (filter === "fast") return picks.filter(isFast);
  if (filter === "swing") return picks.filter((pick) => !isFast(pick));
  return picks;
}

export function quoteFor(pick, pricesDoc) {
  if (!pick || pick.status === "closed") return null;
  const prices = pricesDoc?.prices;
  if (!prices) return null;
  const ticker = String(pick.ticker || "");
  const quote = prices[ticker] || prices[ticker.toUpperCase()];
  if (!quote || typeof quote !== "object") return null;
  const price = num(quote.price);
  if (price == null || price <= 0) return null;
  return quote;
}

export function markPrice(pick, pricesDoc) {
  if (pick?.status === "closed") {
    const exit = num(pick.exitPrice);
    return exit != null && exit > 0 ? exit : null;
  }
  const quote = quoteFor(pick, pricesDoc);
  return quote ? num(quote.price) : null;
}

// Move since the lead was called (context, not a P&L).
export function returnPct(pick, pricesDoc) {
  const entry = num(pick?.priceAtCall);
  const current = markPrice(pick, pricesDoc);
  if (entry == null || entry <= 0 || current == null) return null;
  return ((current - entry) / entry) * 100;
}

export function projectedPct(entry, target) {
  const base = num(entry);
  const goal = num(target);
  if (base == null || base <= 0 || goal == null || goal <= 0) return null;
  return ((goal - base) / base) * 100;
}

export function progressToBase(current, entry, target) {
  const price = num(current);
  const called = num(entry);
  const goal = num(target);
  if (price == null || called == null || goal == null || goal === called) return null;
  return ((price - called) / (goal - called)) * 100;
}

function cmpDate(a, b) {
  const byDay = String(a.dateCalled || "").localeCompare(String(b.dateCalled || ""));
  if (byDay) return byDay;
  return String(a.calledAt || "").localeCompare(String(b.calledAt || ""));
}

// Neutral feed facts only: counts, newest lead, quote coverage.
export function computeFeedStats(picks, pricesDoc) {
  const list = picks || [];
  const open = list.filter((pick) => pick.status === "open");
  const closed = list.filter((pick) => pick.status === "closed");
  const awaiting = open.filter((pick) => !quoteFor(pick, pricesDoc)).length;
  let newest = null;
  for (const pick of open) if (!newest || cmpDate(pick, newest) > 0) newest = pick;
  return {
    openCount: open.length,
    closedCount: closed.length,
    awaiting,
    newest,
    tickers: open.map((pick) => String(pick.ticker || "")),
  };
}

export function sortPicks(picks, pricesDoc, mode) {
  const list = (picks || []).slice();
  const cmpTicker = (a, b) => String(a.ticker || "").localeCompare(String(b.ticker || ""));
  list.sort((a, b) => {
    if (mode === "oldest") return cmpDate(a, b) || cmpTicker(a, b);
    if (mode === "ticker") return cmpTicker(a, b);
    if (mode === "grade") {
      const rank = (GRADE_RANK[a.grade] ?? 9) - (GRADE_RANK[b.grade] ?? 9);
      return rank || cmpTicker(a, b);
    }
    if (mode === "best" || mode === "worst") {
      const ra = returnPct(a, pricesDoc);
      const rb = returnPct(b, pricesDoc);
      if (ra == null && rb == null) return cmpTicker(a, b);
      if (ra == null) return 1;
      if (rb == null) return -1;
      const diff = mode === "best" ? rb - ra : ra - rb;
      return diff || cmpTicker(a, b);
    }
    return cmpDate(b, a) || cmpTicker(a, b);
  });
  return list;
}

export function nextSort(current, key) {
  if (key === "ticker") return "ticker";
  if (key === "grade") return "grade";
  if (key === "called") return current === "newest" ? "oldest" : "newest";
  if (key === "return") return current === "best" ? "worst" : "best";
  return SORT_VALUES.has(current) ? current : "newest";
}

function pctClass(value) {
  const n = num(value);
  if (n == null || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

// Card mood: bull / hit (gold), stop (red), near (amber, within 6% of the
// stop), up / down by the move since called, wait (no quote yet).
export function leadTone(pick, current) {
  if (current == null) return "wait";
  const bull = targetBullOf(pick);
  const base = targetBaseOf(pick);
  const stop = stopOf(pick);
  if (bull != null && current >= bull) return "bull";
  if (base != null && current >= base) return "hit";
  if (stop != null && current <= stop) return "stop";
  if (stop != null && current <= stop * 1.06) return "near";
  const entry = num(pick.priceAtCall);
  if (entry == null || current === entry) return "flat";
  return current > entry ? "up" : "down";
}

export function statusMessage(model) {
  const now = model.now instanceof Date ? model.now.getTime() : Date.now();
  if (model.error) return model.error;
  if (!model.loaded) return "";
  const updated = model.pricesDoc?.updated;
  const open = (model.picks || []).some((pick) => pick.status === "open");
  if (!updated) return open ? "No prices yet." : "";
  const t = Date.parse(updated);
  if (Number.isFinite(t) && now - t > STALE_MS) return "Stale: prices are more than 1 day old.";
  return "";
}

export function dotMode(model) {
  const now = model.now instanceof Date ? model.now.getTime() : Date.now();
  if (model.error) return "bad";
  const updated = model.pricesDoc?.updated;
  const t = updated ? Date.parse(updated) : NaN;
  if (Number.isFinite(t) && now - t > STALE_MS) return "stale";
  return "ok";
}

const LIVE_LABEL = { ok: "Live", stale: "Stale", bad: "Retrying" };

export function pickKey(pick) {
  const id = pick?.id;
  if (id != null && id !== "") return String(id);
  return `${pick?.ticker || "?"}-${pick?.dateCalled || ""}`;
}

export function canDelete(pick) {
  return typeof pick?.id === "string" && ID_RE.test(pick.id);
}

export function deleteIssueUrl(pick) {
  const id = String(pick?.id || "");
  const ticker = String(pick?.ticker || "");
  const company = pick?.company ? ` (${pick.company})` : "";
  const title = `delete-pick: ${id}`;
  const body = [
    `Remove lead ${ticker}${company} from the Stock Bot feed.`,
    "",
    `id: ${id}`,
    "",
    "Submitting this issue asks the delete-pick workflow to remove it from data/picks.json for everyone.",
    "Only accounts listed in .github/delete-allowlist.txt can delete. The bot comments and closes this issue when done.",
  ].join("\n");
  return `https://github.com/${OWNER}/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// Hidden debug: ?demo=1&fast=1 on localhost polls every 5s.
export function pollInterval(loc) {
  if (!isLocalDemo(loc)) return POLL_MS;
  return new URLSearchParams(loc.search || "").get("fast") === "1" ? FAST_POLL_MS : POLL_MS;
}

function distancePhrase(level, current) {
  const target = num(level);
  const price = num(current);
  if (target == null || price == null || price === 0) return "";
  const delta = ((target - price) / price) * 100;
  const abs = Math.abs(delta).toFixed(1) + "%";
  if (delta > 0.05) return `${abs} above`;
  if (delta < -0.05) return `${abs} below`;
  return "at price";
}

export function quoteAge(updated, now = Date.now()) {
  const t = updated ? Date.parse(updated) : NaN;
  if (!Number.isFinite(t)) return "No quotes yet";
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return "Quotes just in";
  if (mins < 60) return `Quotes ${mins} min old`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Quotes ${hours} h old`;
  return `Quotes ${Math.round(hours / 24)} days old`;
}

function domId(key) {
  return "k-" + String(key).replace(/[^A-Za-z0-9_-]/g, "_");
}

function hashUnit(text, salt = 0) {
  let h = 2166136261 ^ salt;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Templates. Every dynamic string goes through escapeHtml.

// A number the motion layer can count, flash, roll and diff between polls.
function animNum(key, value, fmt, text, cls = "", opts = {}) {
  const n = num(value);
  if (n == null) return `<span class="${cls}">${escapeHtml(text)}</span>`;
  return `<span class="${cls}" data-anim="${escapeHtml(key)}" data-num="${n}" data-fmt="${fmt}"${opts.count ? " data-count" : ""}${opts.roll ? " data-roll" : ""}>${escapeHtml(text)}</span>`;
}

function gradeBadge(grade) {
  const cls = GRADE_CLASS[grade] || "g-u";
  const label = grade || "—";
  return `<span class="badge ${cls}" title="Grade ${escapeHtml(grade || "none")}"><span class="sr-only">Grade </span>${escapeHtml(label)}</span>`;
}

const FAST_BADGE = '<span class="fast-badge" title="Fast mover: about a day to a few weeks"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z"/></svg><span>Fast mover</span><i class="fb-streak" aria-hidden="true"></i></span>';

function typeBadge(pick) {
  const type = tradeTypeOf(pick);
  const icon = type.key === "fast"
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z"/></svg>'
    : "";
  return `<span class="type-tag type-${type.key}">${icon}<span>${escapeHtml(type.label)}</span></span>`;
}

function compactLevels(pick) {
  const entry = pick.priceAtCall;
  const basePct = projectedPct(entry, targetBaseOf(pick));
  const bullPct = projectedPct(entry, targetBullOf(pick));
  const stop = stopOf(pick);
  const cell = (kind, label, pct, timeframe) => {
    if (pct == null) {
      return `<span class="sum-lv sum-${kind} is-empty"><span class="sum-k">${label}</span><span class="sum-pct flat">—</span></span>`;
    }
    const when = timeframe ? `<span class="sum-when">${escapeHtml(timeframe)}</span>` : "";
    return `<span class="sum-lv sum-${kind}"><span class="sum-k">${label}</span><span class="sum-pct ${pctClass(pct)}">${escapeHtml(formatProjection(pct))}</span>${when}</span>`;
  };
  const stopHtml = stop == null
    ? `<span class="sum-lv sum-stop is-empty"><span class="sum-k">Stop</span><span class="sum-px flat">—</span></span>`
    : `<span class="sum-lv sum-stop"><span class="sum-k">Stop</span><span class="sum-px">${escapeHtml(formatPrice(stop))}</span></span>`;
  return `<div class="sum-levels">${cell("base", "Base", basePct, baseTimeframeOf(pick))}${cell("bull", "Bull", bullPct, bullTimeframeOf(pick))}${stopHtml}</div>`;
}

const ICONS = {
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7M6.5 7l.9 12.2c.1.9.8 1.6 1.7 1.6h5.8c.9 0 1.6-.7 1.7-1.6L17.5 7M10 11v6M14 11v6"/></svg>',
  ext: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3.8C3.4 3 3 3.4 3 3.8v8.4c0 .4.4.8.8.8h8.4c.4 0 .8-.4.8-.8V10M9 3h4v4M13 3 7.5 8.5"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  scan: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><circle cx="10" cy="10" r="3.4"/><path d="M10 10 15.2 4.8"/></svg>',
};

function chips(pick, current, pending) {
  const out = [];
  if (pending) out.push('<span class="chip chip-pending"><i aria-hidden="true"></i>Deletion requested…</span>');
  if (pick.status !== "closed") {
    if (current == null) out.push('<span class="chip chip-wait"><i aria-hidden="true"></i>Awaiting price</span>');
    const bull = targetBullOf(pick);
    const base = targetBaseOf(pick);
    const stop = stopOf(pick);
    if (current != null) {
      if (bull != null && current >= bull) out.push('<span class="chip chip-bull"><i aria-hidden="true"></i>Bull hit</span>');
      if (base != null && current >= base) out.push('<span class="chip chip-hit"><i aria-hidden="true"></i>Base hit</span>');
      if (stop != null && current <= stop) out.push('<span class="chip chip-stop"><i aria-hidden="true"></i>Stop hit</span>');
      else if (stop != null && current <= stop * 1.06) out.push('<span class="chip chip-near"><i aria-hidden="true"></i>Near stop</span>');
    }
  }
  return out.length ? `<div class="chips">${out.join("")}</div>` : "";
}

function whenPhrase(timeframe) {
  if (!timeframe) return "";
  return /^(in|by|within|over|before|after)\b/i.test(timeframe) ? timeframe : `in ${timeframe}`;
}

function projection(pick, current, compact = false) {
  const entry = pick.priceAtCall;
  const base = targetBaseOf(pick);
  const bull = targetBullOf(pick);
  const basePct = projectedPct(entry, base);
  const bullPct = projectedPct(entry, bull);
  if (basePct == null && bullPct == null) {
    return `<div class="proj proj-none"><span class="proj-k">Projection</span><span class="proj-none-t">No targets set for this lead</span></div>`;
  }
  const row = (kind, label, pct, target, timeframe, cond) => {
    if (pct == null) {
      return `<div class="proj-row proj-${kind} is-empty"><span class="proj-k">${label}</span><span class="proj-pct flat">—</span><span class="proj-when">no ${kind} target</span></div>`;
    }
    const reached = pick.status !== "closed" && current != null && current >= target;
    const when = whenPhrase(timeframe);
    return `<div class="proj-row proj-${kind}${reached ? " is-reached" : ""}">
      <span class="proj-k">${label}${reached ? '<span class="proj-check" aria-label="reached">✓</span>' : ""}</span>
      <span class="proj-pct ${pctClass(pct)}">${escapeHtml(formatProjection(pct))}</span>
      <span class="proj-when">${when ? escapeHtml(when) : "no timeframe set"}</span>
      <span class="proj-tgt"><span class="sr-only">${label} target </span>${escapeHtml(formatPrice(target))}</span>
      ${cond ? `<p class="proj-if"><span class="proj-if-k">if</span> ${escapeHtml(cond)}</p>` : ""}
    </div>`;
  };
  return `<div class="proj${compact ? " proj-compact" : ""}" role="group" aria-label="Projection">
    ${row("base", "Base", basePct, base, baseTimeframeOf(pick))}
    ${row("bull", "Bull", bullPct, bull, bullTimeframeOf(pick), bullCaseOf(pick))}
  </div>`;
}

// Two real points (call, latest) drawn as a smooth path, plus the stop/base/
// bull levels. Labelled as a 2-point path so nobody reads it as history.
function chart(pick, current, id, closed = false) {
  const entry = num(pick.priceAtCall);
  if (entry == null || entry <= 0) return "";
  const levels = [["stop", "Stop", stopOf(pick)], ["base", "Base", targetBaseOf(pick)], ["bull", "Bull", targetBullOf(pick)]]
    .filter(([, , v]) => v != null);
  const values = [entry, ...levels.map(([, , v]) => v)];
  if (current != null) values.push(current);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const span = hi - lo || hi * 0.1 || 1;
  lo -= span * 0.12;
  hi += span * 0.16;
  const W = 320;
  const H = 108;
  const x0 = 16;
  const x1 = W - 92;
  const top = 10;
  const bot = H - 10;
  const y = (v) => +(bot - ((v - lo) / (hi - lo)) * (bot - top)).toFixed(2);
  const y0 = y(entry);

  // Level labels: keep at least 11 units apart.
  const marks = levels.map(([k, label, v]) => ({ k, label, v, y: y(v) })).sort((a, b) => b.y - a.y);
  let lastY = Infinity;
  for (const m of marks) {
    m.ty = Math.min(m.y - 4, lastY - 11);
    lastY = m.ty;
  }
  const lines = marks.map((m) => `<line class="lv lv-${m.k}" x1="${x0}" x2="${W - 4}" y1="${m.y}" y2="${m.y}"/><text class="lv-t lv-t-${m.k}" x="${W - 4}" y="${Math.max(9, m.ty).toFixed(1)}" text-anchor="end">${escapeHtml(m.label.toUpperCase())} ${escapeHtml(formatPrice(m.v))}</text>`).join("");
  const label = closed ? "Close" : "Now";
  let body;
  let aria;
  if (current == null) {
    aria = `${pick.ticker}: called at ${formatPrice(entry)}, awaiting first quote`;
    body = `<line class="scan-line" x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}"/>
      <circle class="call-dot" cx="${x0}" cy="${y0}" r="3.4"/>
      <text class="await-t" x="${(x0 + x1) / 2}" y="${Math.max(14, y0 - 10)}" text-anchor="middle">AWAITING FIRST QUOTE</text>`;
  } else {
    const y1 = y(current);
    const mid = (x1 - x0) * 0.5;
    const d = `M${x0} ${y0} C${x0 + mid} ${y0} ${x1 - mid} ${y1} ${x1} ${y1}`;
    aria = `${pick.ticker}: called at ${formatPrice(entry)}, ${label.toLowerCase()} ${formatPrice(current)}`;
    body = `<path class="area" d="${d} L${x1} ${bot + 10} L${x0} ${bot + 10} Z" fill="url(#ga-${id})"/>
      <path class="line" d="${d}" pathLength="1" stroke="url(#gl-${id})"/>
      <circle class="call-dot" cx="${x0}" cy="${y0}" r="3.4"/>
      <text class="pt-t" x="${x0 + 6}" y="${y0 > H / 2 ? y0 - 8 : y0 + 14}">CALL</text>
      <g class="end" transform="translate(${x1} ${y1})"><circle class="end-glow" r="10"/><circle class="end-dot" r="4"/></g>`;
  }
  return `<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(aria)}">
      <defs>
        <linearGradient id="ga-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0.32"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient>
        <linearGradient id="gl-${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x1}" y2="0"><stop offset="0" stop-color="currentColor" stop-opacity="0.3"/><stop offset="1" stop-color="currentColor"/></linearGradient>
      </defs>
      ${lines}${body}
    </svg>
    <figcaption>Call → ${closed ? "close" : "now"} · two-point path, not price history</figcaption>
  </figure>`;
}

// Track from the lowest to the highest level, with stop/call/base/bull
// markers, the call→now fill and a head dot at the current price.
export function rangeModel(pick, current) {
  const call = num(pick?.priceAtCall);
  const base = targetBaseOf(pick);
  const bull = targetBullOf(pick);
  if (call == null || call <= 0 || (base == null && bull == null)) return null;
  const stop = stopOf(pick);
  const vals = [call, stop, base, bull, current].filter((v) => v != null && v > 0);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = hi - lo || hi * 0.1 || 1;
  lo -= span * 0.05;
  hi += span * 0.05;
  const pos = (v) => (v == null ? null : +(((v - lo) / (hi - lo)) * 100).toFixed(2));
  return { call: pos(call), stop: pos(stop), base: pos(base), bull: pos(bull), now: pos(current) };
}

function range(pick, current) {
  const m = rangeModel(pick, current);
  if (!m) return "";
  const entry = num(pick.priceAtCall);
  const base = targetBaseOf(pick);
  const progress = progressToBase(current, entry, base);
  let label = "Awaiting price";
  let mode = "wait";
  if (current != null && progress != null) {
    const below = current < entry;
    const rounded = Math.round(progress);
    label = below ? `${rounded}% vs call` : (rounded >= 100 ? `${rounded}% · base hit` : `${rounded}% to base`);
    mode = below ? "neg" : (rounded >= 100 ? "done" : "pos");
  } else if (current != null) {
    label = "Tracking toward bull";
    mode = current >= entry ? "pos" : "neg";
  }
  const stop = stopOf(pick);
  if (current != null && stop != null && current <= stop) mode = "stop";
  const scale = base != null
    ? `Call ${formatPrice(entry)} → Base ${formatPrice(base)}`
    : `Call ${formatPrice(entry)} → Bull ${formatPrice(targetBullOf(pick))}`;
  const markers = [["stop", "Stop", m.stop], ["call", "Call", m.call], ["base", "Base", m.base], ["bull", "Bull", m.bull]]
    .filter(([, , p]) => p != null)
    .sort((a, b) => a[2] - b[2]);
  let lastLow = -99;
  let lastHigh = -99;
  const labels = markers.map(([k, text, p]) => {
    let row = "low";
    if (p - lastLow < 15) row = p - lastHigh < 15 ? "low" : "high";
    if (row === "low") lastLow = p;
    else lastHigh = p;
    return `<span class="rl rl-${k} rl-${row}" style="--p:${p}">${text}</span>`;
  }).join("");
  const ticks = markers.map(([k, , p]) => `<i class="rm rm-${k}" style="--p:${p}"></i>`).join("");
  let fill = "";
  let head = "";
  if (m.now != null) {
    const l = Math.min(m.call, m.now);
    const w = Math.abs(m.now - m.call);
    const dir = m.now >= m.call ? "up" : "down";
    fill = `<span class="range-fill fill-${dir}" style="--l:${l};--w:${w.toFixed(2)};--c:${m.call}"><span class="shimmer"></span></span>`;
    head = `<span class="range-rail" style="--p:${m.now};--c:${m.call}"><i class="range-dot"></i></span>`;
  }
  const stopZone = m.stop != null ? `<span class="zone zone-stop" style="--a:0;--b:${m.stop}"></span>` : "";
  const goalStart = m.base ?? m.bull;
  const goalZone = `<span class="zone zone-goal" style="--a:${goalStart};--b:100"></span>`;
  return `<div class="range range-${mode}">
    <div class="range-head"><span class="range-label">${escapeHtml(label)}</span><span class="range-scale">${escapeHtml(scale)}</span></div>
    <div class="range-track" role="img" aria-label="${escapeHtml(`${label}. ${scale}`)}">${stopZone}${goalZone}${ticks}${fill}${head}</div>
    <div class="range-labels" aria-hidden="true">${labels}</div>
  </div>`;
}

function levelCell(label, level, current, cls) {
  if (num(level) == null) {
    return `<div class="level ${cls}"><dt>${label}</dt><dd><span class="lv-v">—</span></dd></div>`;
  }
  const dist = distancePhrase(level, current);
  return `<div class="level ${cls}"><dt>${label}</dt><dd><span class="lv-v">${escapeHtml(formatPrice(level))}</span>${dist ? `<span class="dist">${escapeHtml(dist)}</span>` : ""}</dd></div>`;
}

function blurb(label, text) {
  return `<p class="blurb"><span class="k">${label}</span><span class="v">${escapeHtml(text)}</span></p>`;
}

function reasonsBlock(pick, openKeys) {
  const reasons = Array.isArray(pick.reasons) ? pick.reasons : [];
  if (!reasons.length) return "";
  const key = pickKey(pick);
  const open = openKeys.has(key) ? " open" : "";
  const items = reasons.map((reason, i) => {
    const sources = Array.isArray(reason?.sources) ? reason.sources : [];
    const links = sources.map((source) => {
      const href = safeHttpUrl(source?.url);
      if (!href) return "";
      const title = escapeHtml(source?.title || href);
      const host = escapeHtml(new URL(href).hostname.replace(/^www\./, ""));
      return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" data-ripple><span class="src-title">${title}</span><span class="src-host">${host}</span>${ICONS.ext}<span class="sr-only"> (opens in a new tab)</span></a></li>`;
    }).filter(Boolean).join("");
    const list = links ? `<ul class="sources">${links}</ul>` : "";
    return `<li><span class="r-n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><div class="r-body"><p>${escapeHtml(reason?.text ?? "")}</p>${list}</div></li>`;
  }).join("");
  return `<details class="why" data-why="${escapeHtml(key)}"${open}>
    <summary data-ripple><span class="why-icon" aria-hidden="true">${ICONS.scan}</span><span class="why-t">Why Stock Bot flagged it</span><span class="why-n">${reasons.length}</span>${ICONS.chev}</summary>
    <div class="why-body"><ol class="reasons">${items}</ol></div>
  </details>`;
}

function deleteButton(pick, pending) {
  if (!canDelete(pick)) return "";
  const id = escapeHtml(pick.id);
  const ticker = escapeHtml(pick.ticker);
  if (pending) {
    return `<button type="button" class="del-btn is-pending" disabled aria-label="Deletion of ${ticker} requested">${ICONS.trash}</button>`;
  }
  return `<button type="button" class="del-btn" data-delete="${id}" aria-label="Delete ${ticker} lead for everyone…" title="Delete lead" data-ripple>${ICONS.trash}</button>`;
}

function cardShell(inner) {
  return `<div class="card" data-ripple>
      <span class="card-border" aria-hidden="true"></span>
      <span class="card-spot" aria-hidden="true"></span>
      <span class="card-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div class="card-content">${inner}</div>
    </div>`;
}

function renderLead(pick, ctx) {
  const key = pickKey(pick);
  const id = domId(key);
  const current = markPrice(pick, ctx.pricesDoc);
  const quote = quoteFor(pick, ctx.pricesDoc);
  const tone = leadTone(pick, current);
  const move = returnPct(pick, ctx.pricesDoc);
  const day = quote ? num(quote.changePct) : null;
  const pending = ctx.pending.has(key);
  const expanded = ctx.expandedKeys.has(key);
  const type = tradeTypeOf(pick);
  const company = pick.company ? `<p class="company">${escapeHtml(pick.company)}</p>` : "";
  const now = current == null
    ? '<span class="awaiting">awaiting price</span>'
    : animNum(`${key}:price`, current, "price", formatPrice(current), "", { roll: true });
  const dayHtml = day == null ? '<span class="flat">—</span>' : animNum(`${key}:day`, day, "pct", formatPct(day), `pill ${pctClass(day)}`);
  const moveHtml = move == null
    ? '<span class="awaiting">awaiting price</span>'
    : animNum(`${key}:move`, move, "pct", formatPct(move), pctClass(move), { count: true });
  const moveSummary = current == null ? "" : `<p class="now-move">${moveHtml}</p>`;
  const held = daysHeld(pick, ctx.today);
  const summary = `
    <button type="button" class="lead-toggle" data-expand="${escapeHtml(key)}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${id}-detail" id="${id}-toggle">
      <div class="sum-top">
        <div class="lead-id">
          <div class="ticker-line"><h3 class="ticker" id="${id}-t">${escapeHtml(pick.ticker)}</h3></div>
          ${company}
          <div class="sum-tags">${typeBadge(pick)}${tradeTypeOf(pick).label === "Lottery" && pick.grade === "Lottery" ? "" : gradeBadge(pick.grade)}</div>
        </div>
        <div class="lead-now">
          <p class="now-v">${now}</p>
          ${moveSummary}
        </div>
      </div>
      ${compactLevels(pick)}
      <span class="lead-chev" aria-hidden="true">${ICONS.chev}</span>
    </button>`;
  const detail = `
    <div class="lead-detail-wrap" id="${id}-detail"${expanded ? "" : " inert"}>
      <div class="lead-detail">
        ${chips(pick, current, pending)}
        ${projection(pick, current)}
        <dl class="quote">
          <div><dt>Called at</dt><dd><span class="q-v">${escapeHtml(formatPrice(pick.priceAtCall))}</span><span class="q-sub">${escapeHtml(formatDay(pick.dateCalled))}</span></dd></div>
          <div><dt>Since called</dt><dd><span class="q-v">${move == null ? '<span class="awaiting">awaiting price</span>' : animNum(`${key}:move-d`, move, "pct", formatPct(move), pctClass(move))}</span><span class="q-sub">move, for context</span></dd></div>
          <div><dt>Today</dt><dd><span class="q-v">${day == null ? '<span class="flat">—</span>' : animNum(`${key}:day-d`, day, "pct", formatPct(day), `pill ${pctClass(day)}`)}</span><span class="q-sub">day change</span></dd></div>
        </dl>
        ${chart(pick, current, id)}
        ${range(pick, current)}
        <dl class="levels">
          ${levelCell("Stop", stopOf(pick), current, "lv-stop")}
          ${levelCell("Base", targetBaseOf(pick), current, "lv-base")}
          ${levelCell("Bull", targetBullOf(pick), current, "lv-bull")}
        </dl>
        <div class="notes">
          ${blurb("Thesis", displayThesis(pick) || "—")}
          ${pick.catalyst ? blurb("Catalyst", pick.catalyst) : ""}
          ${pick.notes ? blurb("Notes", pick.notes) : ""}
        </div>
        ${reasonsBlock(pick, ctx.openKeys)}
        <footer class="lead-foot">
          <span class="held"><span class="k">Flagged</span> ${escapeHtml(formatAgo(held))}<span class="held-n"> · ${escapeHtml(formatDays(held))} since called</span></span>
          ${deleteButton(pick, pending)}
        </footer>
      </div>
    </div>`;
  const cls = [
    "lead",
    `tone-${tone}`,
    isFast(pick) ? "is-fast" : "",
    `is-type-${type.key}`,
    pending ? "is-pending" : "",
    expanded ? "is-open" : "",
  ].filter(Boolean).join(" ");
  return `<article class="${cls}" data-key="${escapeHtml(key)}" data-flip data-pick="${escapeHtml(key)}|open" data-tone="${tone}" aria-labelledby="${id}-t">${cardShell(summary + detail)}</article>`;
}

function renderArchived(pick, ctx) {
  const key = pickKey(pick);
  const id = domId(key);
  const move = returnPct(pick, ctx.pricesDoc);
  const pending = ctx.pending.has(key);
  const expanded = ctx.expandedKeys.has(key);
  const type = tradeTypeOf(pick);
  const company = pick.company ? `<p class="company">${escapeHtml(pick.company)}</p>` : "";
  const exit = num(pick.exitPrice);
  const moveHtml = move == null ? '<span class="flat">—</span>' : `<span class="${pctClass(move)}">${escapeHtml(formatPct(move))}</span>`;
  const summary = `
    <button type="button" class="lead-toggle" data-expand="${escapeHtml(key)}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${id}-detail" id="${id}-toggle">
      <div class="sum-top">
        <div class="lead-id">
          <div class="ticker-line"><h3 class="ticker" id="${id}-t">${escapeHtml(pick.ticker)}</h3></div>
          ${company}
          <div class="sum-tags">${typeBadge(pick)}${tradeTypeOf(pick).label === "Lottery" && pick.grade === "Lottery" ? "" : gradeBadge(pick.grade)}<span class="tag-archived">Archived</span></div>
        </div>
        <div class="lead-now">
          <p class="now-k">Closed at</p>
          <p class="now-v">${escapeHtml(formatPrice(exit))}</p>
          <p class="now-move">${moveHtml}</p>
        </div>
      </div>
      ${compactLevels(pick)}
      <span class="lead-chev" aria-hidden="true">${ICONS.chev}</span>
    </button>`;
  const detail = `
    <div class="lead-detail-wrap" id="${id}-detail"${expanded ? "" : " inert"}>
      <div class="lead-detail">
        ${chips(pick, exit, pending)}
        ${projection(pick, exit, true)}
        <dl class="quote quote-4">
          <div><dt>Called at</dt><dd><span class="q-v">${escapeHtml(formatPrice(pick.priceAtCall))}</span><span class="q-sub">${escapeHtml(formatDay(pick.dateCalled))}</span></dd></div>
          <div><dt>Closed</dt><dd><span class="q-v">${escapeHtml(formatPrice(pick.exitPrice))}</span><span class="q-sub">${escapeHtml(formatDay(pick.exitDate))}</span></dd></div>
          <div><dt>Call → close</dt><dd><span class="q-v">${moveHtml}</span><span class="q-sub">move</span></dd></div>
          <div><dt>Listed</dt><dd><span class="q-v">${escapeHtml(formatDays(daysHeld(pick, ctx.today)))}</span><span class="q-sub">on the feed</span></dd></div>
        </dl>
        <div class="notes">
          ${blurb("Notes", pick.notes || "—")}
          ${pick.thesis ? blurb("Thesis", displayThesis(pick)) : ""}
        </div>
        ${reasonsBlock(pick, ctx.openKeys)}
        <footer class="lead-foot">
          <span class="held"><span class="k">Flagged</span> ${escapeHtml(formatDay(pick.dateCalled))}</span>
          ${deleteButton(pick, pending)}
        </footer>
      </div>
    </div>`;
  const cls = [
    "lead",
    "lead-archived",
    isFast(pick) ? "is-fast" : "",
    `is-type-${type.key}`,
    pending ? "is-pending" : "",
    expanded ? "is-open" : "",
  ].filter(Boolean).join(" ");
  return `<article class="${cls}" data-key="${escapeHtml(key)}" data-flip data-pick="${escapeHtml(key)}|closed" data-tone="archived" aria-labelledby="${id}-t">${cardShell(summary + detail)}</article>`;
}

function renderStopped(stopped) {
  const raw = Array.isArray(stopped) ? stopped.filter((row) => row && typeof row === "object") : [];
  if (!raw.length) return "";
  const list = raw.slice(0, 10);
  const items = list.map((row) => {
    const original = row.pick && typeof row.pick === "object" ? row.pick : {};
    const ticker = escapeHtml(original.ticker || "—");
    const day = escapeHtml(formatDay(row.stoppedDate) || String(row.stoppedDate || "—"));
    const close = num(row.closePrice);
    const closeText = close == null ? "—" : formatPrice(close);
    const move = num(row.returnPct);
    const moveText = move == null ? "—" : formatPct(move);
    const cls = move == null ? "flat" : pctClass(move);
    return `<li class="stopped-row">
      <span class="stopped-ticker">${ticker}</span>
      <span class="stopped-day">${day}</span>
      <span class="stopped-close">close ${escapeHtml(closeText)}</span>
      <span class="stopped-ret ${cls}">${escapeHtml(moveText)}</span>
    </li>`;
  }).join("");
  return `<section class="block block-stopped" data-key="sec-stopped">
    <details class="stopped-box">
      <summary data-ripple>
        <span class="stopped-title">Recently stopped out</span>
        <span class="count">${list.length}</span>
        ${ICONS.chev}
      </summary>
      <div class="stopped-body">
        <p class="stopped-note">Dropped after a daily close at or below the stop. A ticker can come back later if a new setup appears.</p>
        <ul class="stopped-list">${items}</ul>
      </div>
    </details>
  </section>`;
}

function sortRail(sort) {
  const button = (key, label) => {
    const active = (key === "called" && (sort === "newest" || sort === "oldest"))
      || (key === "return" && (sort === "best" || sort === "worst"))
      || (key === "ticker" && sort === "ticker")
      || (key === "grade" && sort === "grade");
    let arrow = "";
    if (active) arrow = sort === "newest" || sort === "best" ? "↓" : "↑";
    if (key === "ticker" || key === "grade") arrow = active ? "↑" : "";
    return `<button type="button" data-sort="${key}" class="rail-btn${active ? " active" : ""}" aria-pressed="${active}" data-magnetic data-ripple>${label}<span class="arrow" aria-hidden="true">${arrow}</span></button>`;
  };
  return `<div class="rail" role="group" aria-label="Sort leads">${button("called", "Flagged")}${button("return", "Since called")}${button("ticker", "Ticker")}${button("grade", "Grade")}</div>`;
}

function sortSelect(current) {
  const options = SORTS.map(([value, label]) => {
    const selected = value === current ? " selected" : "";
    return `<option value="${value}"${selected}>${label}</option>`;
  }).join("");
  return `<label class="sort" for="sort"><span class="sort-k">Sort</span><span class="select"><select id="sort">${options}</select>${ICONS.chev}</span></label>`;
}

function emptyState() {
  const blips = [[38, 0.62, 0], [128, 0.36, 1], [212, 0.78, 2], [296, 0.5, 3], [170, 0.86, 4]]
    .map(([a, r, i]) => `<span class="blip" style="--a:${a}deg;--r:${r};--i:${i}"></span>`).join("");
  const ghost = `<div class="ghost"><span class="gh gh-a"></span><span class="gh gh-b"></span><span class="gh gh-c"></span><span class="gh gh-d"></span></div>`;
  return `<section class="empty" data-key="empty" aria-labelledby="empty-title">
    <div class="scope" aria-hidden="true">
      <span class="scope-ring r1"></span><span class="scope-ring r2"></span><span class="scope-ring r3"></span><span class="scope-ring r4"></span>
      <span class="scope-ticks"></span>
      <span class="scope-cross"></span>
      <span class="scope-sweep"></span>
      ${blips}
      <span class="orbit o1"><i></i></span><span class="orbit o2"><i></i></span><span class="orbit o3"><i></i></span>
      <span class="scope-core"><svg viewBox="0 0 32 32"><path d="M7 21.5 13 15l4 3.5 8-10" fill="none" stroke="url(#logo-g)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </div>
    <div class="empty-copy">
      <p class="empty-kicker"><span class="caret" aria-hidden="true"></span>Scanning markets</p>
      <h2 id="empty-title" class="empty-title">No leads on the board <span class="grad">yet.</span></h2>
      <p class="empty-text">Stock Bot is watching the tape. The moment it flags something, the lead lands here for both of you — thesis, targets, stop and the reasons behind it.</p>
      <div class="empty-status">
        <span class="es-item"><span class="es-k">Next check</span><b class="mono" data-countdown>—</b></span>
        <span class="es-item"><span class="es-k">Refresh</span><b>Automatic</b></span>
      </div>
    </div>
    <div class="ghosts" aria-hidden="true">${ghost}${ghost}${ghost}</div>
  </section>`;
}

function skeleton() {
  const card = `<div class="card skeleton"><div class="sk sk-a"></div><div class="sk sk-b"></div><div class="sk sk-c"></div><div class="sk sk-d"></div></div>`;
  return `<section class="block" data-key="skeleton" aria-busy="true"><p class="sr-only">Loading leads…</p><div class="leads">${card}${card}${card}</div></section>`;
}

export function renderBoard(model) {
  const picks = model.picks || [];
  const pricesDoc = model.pricesDoc || { updated: null, prices: {} };
  const sort = SORT_VALUES.has(model.sort) ? model.sort : "newest";
  const openKeys = model.openKeys instanceof Set ? model.openKeys : new Set(model.openKeys || []);
  const expandedKeys = model.expandedKeys instanceof Set ? model.expandedKeys : new Set(model.expandedKeys || []);
  const pending = model.pending instanceof Map ? model.pending : new Map();
  const now = model.now instanceof Date ? model.now : new Date();
  const ctx = { pricesDoc, today: todayPT(now), openKeys, expandedKeys, pending };
  const stopped = Array.isArray(model.stopped) ? model.stopped : [];

  if (!model.loaded && model.loading) return skeleton();
  if (!model.loaded && model.error) {
    return `<section class="empty error" data-key="error"><div class="err-mark" aria-hidden="true">!</div><h2 class="empty-title">Leads could not be loaded.</h2><p class="empty-text">Retrying automatically.</p></section>`;
  }
  if (!picks.length) return emptyState();

  const ordered = sortPicks(picks, pricesDoc, sort);
  const open = ordered.filter((pick) => pick.status !== "closed");
  const closed = ordered.filter((pick) => pick.status === "closed");
  const filter = FILTER_VALUES.has(model.filter) ? model.filter : "all";
  const shownOpen = filterLeads(open, filter);
  const sorters = `<div class="sorters">${sortRail(sort)}${sortSelect(sort)}</div>`;
  let activeBody;
  if (!open.length) {
    activeBody = `<div class="none-active" data-key="none-active"><span class="none-dot" aria-hidden="true"></span><p><strong>No active leads right now.</strong> Stock Bot is scanning; past leads are in the archive below.</p></div>`;
  } else if (!shownOpen.length) {
    activeBody = emptyFilter(filter, open);
  } else {
    activeBody = `<div class="leads" data-key="leads-active">${shownOpen.map((pick) => renderLead(pick, ctx)).join("")}</div>`;
  }
  let html = `<section class="block block-active" data-key="sec-active" aria-labelledby="h-active">
    <div class="section-head"><h2 id="h-active"><span class="h-idx" aria-hidden="true">01</span>Active leads <span class="count">${shownOpen.length}</span></h2>${sorters}</div>
    ${open.length ? filterBar(filter, open) : ""}
    ${activeBody}
  </section>`;
  html += renderStopped(stopped);
  if (closed.length) {
    html += `<section class="block block-archive" data-key="sec-archive" aria-labelledby="h-archive">
      <div class="section-head"><h2 id="h-archive"><span class="h-idx" aria-hidden="true">02</span>Archive <span class="count">${closed.length}</span><span class="h-sub">past leads</span></h2></div>
      <div class="leads leads-archive">${closed.map((pick) => renderArchived(pick, ctx)).join("")}</div>
    </section>`;
  }
  return html;
}

function filterBar(filter, open) {
  const counts = { all: open.length, fast: open.filter(isFast).length };
  counts.swing = counts.all - counts.fast;
  const index = FILTERS.findIndex(([value]) => value === filter);
  const buttons = FILTERS.map(([value, label]) => {
    const active = value === filter;
    const icon = value === "fast" ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z"/></svg>' : "";
    return `<button type="button" class="seg-btn seg-${value}${active ? " active" : ""}" data-filter="${value}" aria-pressed="${active}" data-ripple>${icon}<span class="seg-l">${label}</span><span class="seg-n">${counts[value]}</span></button>`;
  }).join("");
  return `<div class="seg" role="group" aria-label="Filter by horizon" data-key="filter-bar" style="--i:${Math.max(0, index)}"><span class="seg-ind seg-ind-${filter}" aria-hidden="true"></span>${buttons}</div>`;
}

function emptyFilter(filter, open) {
  const fast = filter === "fast";
  const other = fast ? open.length - open.filter(isFast).length : open.filter(isFast).length;
  const title = fast ? "No fast movers right now." : "No swing leads right now.";
  const text = fast
    ? "Fast movers are short trades, about a day to a few weeks. Stock Bot flags them when a setup is live."
    : "Swing leads run 3–12 months. Everything active right now is a fast mover.";
  const hint = other ? `${other} other active lead${other === 1 ? "" : "s"} in the feed.` : "";
  return `<div class="empty-filter${fast ? " ef-fast" : ""}" data-key="empty-filter-${filter}">
    <div class="ef-mark" aria-hidden="true"><span class="ef-ring"></span><span class="ef-ring ef-ring-2"></span><svg viewBox="0 0 16 16"><path d="${fast ? "M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z" : "M1.5 10.5c2-4 4-4 6 0s4 4 7-3"}"/></svg></div>
    <div class="ef-copy"><p class="ef-title">${title}</p><p class="ef-text">${text} ${hint}</p></div>
    <button type="button" class="btn btn-ghost ef-btn" data-filter="all" data-ripple data-magnetic>Show all leads</button>
  </div>`;
}

export function renderStats(model) {
  const s = computeFeedStats(model.picks, model.pricesDoc);
  const loaded = model.loaded;
  const now = model.now instanceof Date ? model.now : new Date();
  const blips = s.tickers.slice(0, 24).map((t, i) => {
    const a = Math.round(hashUnit(t, i) * 360);
    const r = (0.3 + hashUnit(t, 7 + i) * 0.6).toFixed(2);
    return `<span class="mb" style="--a:${a}deg;--r:${r};--i:${i % 6}"></span>`;
  }).join("");
  const openValue = loaded ? animNum("stat:open", s.openCount, "int", String(s.openCount), "", { count: true }) : "—";
  const fastCount = (model.picks || []).filter((pick) => pick.status !== "closed" && isFast(pick)).length;
  const quoted = s.awaiting ? `${s.awaiting} awaiting a quote` : "all quoted";
  const awaitingSub = !loaded ? "connecting…" : (s.openCount === 0 ? "scanning" : (fastCount ? `${fastCount} fast mover${fastCount === 1 ? "" : "s"} · ${quoted}` : quoted));
  const newest = s.newest;
  const newestValue = newest ? `<span class="tk-grad" data-anim="stat:newest" data-fmt="text">${escapeHtml(newest.ticker)}</span>` : "—";
  const newestSub = newest
    ? `${escapeHtml(formatDay(newest.dateCalled))} · ${escapeHtml(formatAgo(daysHeld(newest, todayPT(now))))}`
    : (loaded ? "nothing flagged yet" : "connecting…");
  const archiveValue = loaded ? animNum("stat:archive", s.closedCount, "int", String(s.closedCount), "", { count: true }) : "—";
  return `<article class="stat stat-active" data-key="st-active">
      <div class="mini-scope" aria-hidden="true"><span class="ms-ring"></span><span class="ms-ring ms-ring-2"></span><span class="ms-sweep"></span>${blips}</div>
      <div class="stat-body"><p class="label">Active leads</p><p class="value">${openValue}</p><p class="sub">${escapeHtml(awaitingSub)}</p></div>
    </article>
    <article class="stat stat-newest" data-key="st-newest">
      <div class="stat-body"><p class="label">Newest lead</p><p class="value">${newestValue}</p><p class="sub">${newestSub}</p></div>
    </article>
    <article class="stat stat-archive" data-key="st-archive">
      <div class="stat-body"><p class="label">Archive</p><p class="value">${archiveValue}</p><p class="sub">past leads</p></div>
    </article>
    <article class="stat stat-feed" data-key="st-feed">
      <svg class="cd-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="cd-bg" cx="22" cy="22" r="18"/><circle class="cd-fg" cx="22" cy="22" r="18" pathLength="100"/></svg>
      <div class="stat-body"><p class="label">Next check</p><p class="value mono" data-countdown>—</p><p class="sub" data-quote-age>${escapeHtml(quoteAge(model.pricesDoc?.updated, now.getTime()))}</p></div>
    </article>`;
}

// Scrolling ticker tape built from the real feed (decorative duplicate of the
// cards, hidden from screen readers).
export function renderTape(model) {
  const open = sortPicks((model.picks || []).filter((pick) => pick.status !== "closed"), model.pricesDoc, "ticker");
  let items;
  if (!model.loaded) {
    items = ['<span class="tp tp-msg">Connecting to the feed</span>'];
  } else if (!open.length) {
    items = ['<span class="tp tp-msg">Scanning markets</span>', '<span class="tp tp-msg">No active leads yet</span>', '<span class="tp tp-msg">Stock Bot is watching the tape</span>'];
  } else {
    items = open.map((pick) => {
      const quote = quoteFor(pick, model.pricesDoc);
      const tone = leadTone(pick, quote ? num(quote.price) : null);
      const bolt = isFast(pick) ? '<span class="tp-fast">⚡</span>' : "";
      if (!quote) return `<span class="tp tp-${tone}">${bolt}<b>${escapeHtml(pick.ticker)}</b><span class="tp-p">awaiting price</span></span>`;
      const day = num(quote.changePct);
      const arrow = day == null || day === 0 ? "•" : (day > 0 ? "▲" : "▼");
      return `<span class="tp tp-${tone}">${bolt}<b>${escapeHtml(pick.ticker)}</b><span class="tp-p">${escapeHtml(formatPrice(quote.price))}</span><span class="tp-d ${pctClass(day)}">${arrow} ${escapeHtml(formatPct(day))}</span></span>`;
    });
  }
  let run = items.slice();
  while (run.length < 10) run = run.concat(items);
  const half = run.join('<span class="tp-sep">◆</span>') + '<span class="tp-sep">◆</span>';
  return `<div class="tape-track" style="--dur:${Math.max(28, run.length * 4)}s">${half}${half}</div>`;
}

// ---------------------------------------------------------------------------
// Motion orchestration.

const FORMATTERS = {
  pct: (v) => formatPct(v),
  price: (v) => formatPrice(v),
  int: (v) => String(Math.round(v)),
};

let seen = { ready: false, values: new Map(), tones: new Map(), picks: new Set(), updated: undefined };
let intro = null;
const pendingReveals = [];
let bg = null;

function gsapReady() {
  return canAnimate() && typeof window.gsap === "object" && window.gsap && typeof window.gsap.timeline === "function";
}

function scrollTriggerReady() {
  return gsapReady() && typeof window.ScrollTrigger === "function";
}

function readValue(el) {
  return el.dataset.fmt === "text" ? el.textContent : num(el.dataset.num);
}

function snapshot() {
  const values = new Map();
  for (const el of document.querySelectorAll(".page [data-anim]")) {
    values.set(el.dataset.anim, { v: readValue(el), text: el.textContent });
  }
  const tones = new Map();
  const picks = new Set();
  for (const el of document.querySelectorAll("#board [data-pick]")) {
    picks.add(el.dataset.pick);
    tones.set(el.dataset.key, el.dataset.tone);
  }
  return { values, tones, picks };
}

function burstAt(lead) {
  const card = lead.querySelector(".card");
  const dot = lead.querySelector(".range-dot") || lead.querySelector(".end-dot");
  if (!card || !dot) return;
  const c = card.getBoundingClientRect();
  const d = dot.getBoundingClientRect();
  const colors = lead.dataset.tone === "bull"
    ? ["#ffd36b", "#c9a7ff", "#fff3cf", "#7c5cff"]
    : ["#ffd36b", "#fff1c2", "#ffb547", "#2bffa8"];
  burst(card, d.left - c.left + d.width / 2, d.top - c.top + d.height / 2, colors);
}

// Remove is-pre (meters at zero, path undrawn) so CSS transitions play.
function reveal(lead, countFrom = true) {
  if (!lead.isConnected) return;
  lead.classList.remove("is-pre");
  if (countFrom && canAnimate()) {
    for (const el of lead.querySelectorAll("[data-anim][data-count]")) {
      countUp(el, 0, readValue(el), FORMATTERS[el.dataset.fmt], 1300, 150);
    }
  }
  if (lead.dataset.tone === "hit" || lead.dataset.tone === "bull") {
    setTimeout(() => burstAt(lead), 950);
  }
}

function queueReveal(fn, seconds) {
  if (seconds <= 0) {
    fn();
    return;
  }
  const g = window.gsap;
  if (g && typeof g.delayedCall === "function") {
    const call = g.delayedCall(seconds, () => {
      const i = pendingReveals.indexOf(entry);
      if (i >= 0) pendingReveals.splice(i, 1);
      fn();
    });
    const entry = { call, fn };
    pendingReveals.push(entry);
  } else {
    setTimeout(fn, seconds * 1000);
  }
}

function introDelay() {
  if (!intro || !intro.isActive()) return 0;
  return Math.max(0, 0.85 - intro.time());
}

const FROM_CARD = { autoAlpha: 0, y: 70, rotateX: -18, scale: 0.94, filter: "blur(14px)", transformPerspective: 1200, transformOrigin: "50% 0%" };
const TO_CARD = { autoAlpha: 1, y: 0, rotateX: 0, scale: 1, filter: "blur(0px)", duration: 1.15, ease: "expo.out", clearProps: "transform,opacity,visibility,filter" };

// First paint with data: cards rise in with a 3D blur-to-sharp stagger, then
// meters fill, paths draw and numbers count. Archive cards reveal on scroll.
function entrance(board) {
  const motion = canAnimate();
  const active = [...board.querySelectorAll(".block-active .lead")];
  const archive = [...board.querySelectorAll(".block-archive .lead")];
  const heads = [...board.querySelectorAll(".section-head, .none-active")];
  const empty = board.querySelector(".empty");
  for (const el of document.querySelectorAll("#summary [data-anim][data-count]")) {
    if (motion) countUp(el, 0, readValue(el), FORMATTERS[el.dataset.fmt], 1400, introDelay() * 1000);
  }
  if (!motion) return;
  const delay = introDelay();
  const g = gsapReady() ? window.gsap : null;
  for (const el of [...active, ...archive]) el.classList.add("is-pre");

  if (empty) {
    if (g) {
      const tl = g.timeline({ delay });
      tl.fromTo(empty.querySelector(".scope"), { autoAlpha: 0, scale: 0.6, rotate: -40 }, { autoAlpha: 1, scale: 1, rotate: 0, duration: 1.4, ease: "expo.out", clearProps: "transform" })
        .fromTo(empty.querySelectorAll(".empty-copy > *"), { autoAlpha: 0, y: 24, filter: "blur(8px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.9, ease: "expo.out", stagger: 0.08, clearProps: "transform,filter" }, 0.2)
        .fromTo(empty.querySelectorAll(".ghost"), { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.9, ease: "expo.out", stagger: 0.1, clearProps: "transform" }, 0.5);
    } else {
      empty.animate([{ opacity: 0, transform: "translateY(20px)" }, { opacity: 1, transform: "none" }], { duration: 900, easing: EASE, fill: "backwards" });
    }
  }

  if (g) {
    if (heads.length) g.fromTo(heads, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.9, ease: "expo.out", stagger: 0.08, delay, clearProps: "transform,opacity,visibility" });
    if (active.length) {
      g.fromTo(active, FROM_CARD, { ...TO_CARD, stagger: 0.09, delay: delay + 0.08 });
    }
  } else {
    heads.forEach((el) => el.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 800, easing: EASE, fill: "backwards", delay: delay * 1000 }));
    active.forEach((el, i) => el.animate(
      [{ opacity: 0, transform: "translateY(50px) scale(0.96)" }, { opacity: 1, transform: "none" }],
      { duration: 1000, easing: EASE, fill: "backwards", delay: (delay + 0.08 + i * 0.09) * 1000 },
    ));
  }
  active.forEach((el, i) => queueReveal(() => reveal(el), delay + 0.4 + i * 0.09));

  if (scrollTriggerReady()) {
    archive.forEach((el) => {
      window.gsap.set(el, { autoAlpha: 0, y: 60 });
      window.ScrollTrigger.create({
        trigger: el,
        start: "top 92%",
        once: true,
        onEnter: () => {
          window.gsap.fromTo(el, { autoAlpha: 0, y: 60, filter: "blur(10px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 1, ease: "expo.out", clearProps: "transform,opacity,visibility,filter" });
          setTimeout(() => reveal(el, false), 250);
        },
      });
    });
  } else {
    archive.forEach((el) => reveal(el, false));
  }
}

function skipIntro() {
  if (intro && intro.isActive()) intro.progress(1);
  const g = window.gsap;
  if (g) {
    for (const el of document.querySelectorAll("#board .block-active .lead, #board .section-head")) {
      g.getTweensOf(el).forEach((tween) => tween.progress(1));
    }
  }
  while (pendingReveals.length) {
    const { call, fn } = pendingReveals.shift();
    call.kill();
    fn();
  }
}

function slideIn(el, i) {
  if (!canAnimate()) return;
  if (!el.matches(".lead") && el.querySelector(".lead")) {
    el.querySelectorAll(".lead").forEach((child, j) => slideIn(child, i + j));
    return;
  }
  const lead = el.matches(".lead") ? el : null;
  if (lead) lead.classList.add("is-pre");
  const g = gsapReady() ? window.gsap : null;
  if (g) {
    g.fromTo(el, { autoAlpha: 0, x: -40, scale: 0.95, filter: "blur(12px)" }, { autoAlpha: 1, x: 0, scale: 1, filter: "blur(0px)", duration: 0.9, ease: "expo.out", delay: i * 0.08, clearProps: "transform,opacity,visibility,filter" });
  } else {
    el.animate([{ opacity: 0, transform: "translateX(-30px) scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 800, easing: EASE, delay: i * 80, fill: "backwards" });
  }
  if (lead) {
    addTransient(lead, "is-new", 3200);
    setTimeout(() => reveal(lead), 300 + i * 80);
  }
}

function removeAnimated(el, board) {
  el.setAttribute("data-leaving", "");
  el.style.pointerEvents = "none";
  const done = () => {
    const rects = captureRects(board, "[data-flip]");
    el.remove();
    flip(board, "[data-flip]", rects);
  };
  if (!canAnimate() || !shown(el)) {
    done();
    return;
  }
  const g = gsapReady() ? window.gsap : null;
  if (g) {
    g.to(el, { autoAlpha: 0, scale: 0.88, y: -16, rotateX: 12, filter: "blur(12px) saturate(0)", duration: 0.6, ease: "power3.in", onComplete: done });
  } else {
    el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.9) translateY(-12px)" }], { duration: 500, easing: "ease-in", fill: "forwards" }).onfinish = done;
  }
}

// Later renders: only what changed moves.
function animateChanges(prev) {
  const motion = canAnimate();
  const ticks = new Map();
  for (const el of document.querySelectorAll(".page [data-anim]")) {
    if (!shown(el)) continue;
    const key = el.dataset.anim;
    const holder = el.closest("[data-pick]");
    if (holder && !prev.picks.has(holder.dataset.pick)) continue;
    const next = readValue(el);
    const before = prev.values.get(key);
    if (!before) {
      addTransient(el, "flash-new");
      continue;
    }
    if (before.v === next) continue;
    if (el.dataset.fmt === "text" || before.v == null || next == null) {
      addTransient(el, "flash-new");
      continue;
    }
    const dir = next > before.v ? "up" : "down";
    addTransient(el, `flash-${dir}`);
    if (motion) {
      if (el.hasAttribute("data-roll")) roll(el, before.text, el.textContent, dir);
      else countUp(el, before.v, next, FORMATTERS[el.dataset.fmt], 900);
    }
    if (holder && (key.endsWith(":price") || !ticks.has(holder))) ticks.set(holder, dir);
  }
  for (const [holder, dir] of ticks) {
    const card = holder.querySelector(".card");
    if (card) addTransient(card, `tick-${dir}`);
  }
  if (!motion) return;
  for (const lead of document.querySelectorAll("#board .lead[data-tone]")) {
    const before = prev.tones.get(lead.dataset.key);
    const tone = lead.dataset.tone;
    if (before && before !== tone && (tone === "hit" || tone === "bull") && before !== "bull") {
      setTimeout(() => burstAt(lead), 500);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering.

function model() {
  const demo = isLocalDemo(location);
  const picks = demo && state.demoDeleted.size
    ? state.picks.filter((pick) => !state.demoDeleted.has(pickKey(pick)))
    : state.picks;
  return {
    picks,
    pricesDoc: state.pricesDoc,
    sort: state.sort,
    filter: state.filter,
    checkedAt: state.checkedAt,
    error: state.error,
    loading: state.loading,
    loaded: state.loaded,
    openKeys: state.openKeys,
    expandedKeys: state.expandedKeys,
    pending: state.pending,
    stopped: state.stopped,
    now: new Date(),
  };
}

function render(kind = "data") {
  const board = document.getElementById("board");
  const summary = document.getElementById("summary");
  if (!board || !summary) return;
  const m = model();
  const first = !seen.ready && state.loaded;
  const motion = canAnimate();
  const rects = seen.ready && motion ? captureRects(board, "[data-flip]") : null;
  const added = [];
  const hooks = seen.ready
    ? { onAdd: (el) => added.push(el), onRemove: (el) => removeAnimated(el, board) }
    : {};
  morphHtml(summary, renderStats(m));
  const tape = document.getElementById("tape");
  if (tape) morphHtml(tape, renderTape(m));
  morphHtml(board, renderBoard(m), hooks);
  const select = document.getElementById("sort");
  if (select && select.value !== state.sort) select.value = state.sort;
  patchStatus();
  tickCountdown();
  if (!state.loaded) return;

  if (first) {
    entrance(board);
  } else if (seen.ready) {
    if (kind !== "sort" && kind !== "filter") animateChanges(seen);
    if (rects) flip(board, "[data-flip]", rects);
    added.forEach((el, i) => slideIn(el, i));
  }
  const updated = m.pricesDoc?.updated ?? null;
  if (seen.ready && updated !== seen.updated && bg) bg.pulse();
  const next = snapshot();
  seen = { ready: true, ...next, updated };
  setMood(m);
}

// Aurora tint follows the average day change of active leads (market mood).
function setMood(m) {
  if (!bg) return;
  const days = (m.picks || [])
    .map((pick) => quoteFor(pick, m.pricesDoc))
    .filter(Boolean)
    .map((quote) => num(quote.changePct))
    .filter((v) => v != null);
  const avg = days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  bg.setMood(Math.max(-1, Math.min(1, avg / 3)));
}

let lastPricesShown = null;

function patchStatus() {
  const now = new Date();
  const pricesAt = document.getElementById("prices-at");
  if (pricesAt) {
    const text = state.loaded ? formatPT(state.pricesDoc.updated) : "—";
    if (pricesAt.textContent !== text) {
      pricesAt.textContent = text;
      if (lastPricesShown != null && !reducedMotion()) addTransient(pricesAt, "flash-new");
      lastPricesShown = text;
    }
  }
  const checked = document.getElementById("checked-at");
  if (checked) {
    const text = formatPT(state.checkedAt);
    if (checked.textContent !== text) {
      checked.textContent = text;
      if (!reducedMotion()) addTransient(checked, "flash-tick");
    }
  }
  const note = document.getElementById("status-note");
  if (note) {
    note.textContent = statusMessage({ ...state, now });
    note.className = state.error ? "status-note bad" : "status-note";
  }
  const mode = dotMode({ ...state, now });
  const live = document.getElementById("live");
  if (live) live.className = `live ${mode}`;
  const label = document.getElementById("live-label");
  if (label) label.textContent = LIVE_LABEL[mode];
}

// ---------------------------------------------------------------------------
// Polling.

const SORT_STORE = "stock-tracker:sort";
const FILTER_STORE = "stock-tracker:horizon-filter";
const PENDING_STORE = "stock-tracker:pending-deletes";
let pollTimer = null;
let lastPollAt = Date.now();

function loadSort() {
  try {
    const saved = window.localStorage.getItem(SORT_STORE);
    return SORT_VALUES.has(saved) ? saved : "newest";
  } catch {
    return "newest";
  }
}

function saveSort(value) {
  try {
    window.localStorage.setItem(SORT_STORE, value);
  } catch {
    // Private mode or storage disabled: the in-memory sort still holds.
  }
}

function loadFilter() {
  try {
    const saved = window.localStorage.getItem(FILTER_STORE);
    return FILTER_VALUES.has(saved) ? saved : "all";
  } catch {
    return "all";
  }
}

function saveFilter(value) {
  try {
    window.localStorage.setItem(FILTER_STORE, value);
  } catch {
    // Storage disabled: the in-memory filter still holds.
  }
}

function loadPending() {
  const out = new Map();
  try {
    const raw = JSON.parse(window.localStorage.getItem(PENDING_STORE) || "{}");
    const now = Date.now();
    for (const [id, ts] of Object.entries(raw || {})) {
      if (typeof id === "string" && Number.isFinite(ts) && now - ts < PENDING_DELETE_MS) out.set(id, ts);
    }
  } catch {
    // Unreadable storage: start clean.
  }
  return out;
}

function savePending() {
  try {
    window.localStorage.setItem(PENDING_STORE, JSON.stringify(Object.fromEntries(state.pending)));
  } catch {
    // Storage disabled: pending marks last for this page view only.
  }
}

// Drop marks that expired or whose lead is already gone from picks.json.
function prunePending() {
  const now = Date.now();
  const ids = new Set(state.picks.map(pickKey));
  let changed = false;
  for (const [id, ts] of state.pending) {
    if (now - ts >= PENDING_DELETE_MS || (state.loaded && !ids.has(id))) {
      state.pending.delete(id);
      changed = true;
    }
  }
  if (changed) savePending();
  return changed;
}

function pollLine() {
  const line = document.getElementById("poll-line");
  if (!line) return;
  const interval = pollInterval(location);
  line.style.animation = "none";
  void line.offsetWidth;
  line.style.animation = "";
  line.style.animationDuration = `${interval}ms`;
  line.style.animationDelay = `${-Math.min(interval, Date.now() - lastPollAt)}ms`;
}

function tickCountdown() {
  const interval = pollInterval(location);
  const left = Math.max(0, interval - (Date.now() - lastPollAt));
  const secs = Math.ceil(left / 1000);
  const text = `0:${String(Math.min(59, secs)).padStart(2, "0")}`;
  const shownText = secs >= 60 ? "1:00" : text;
  for (const el of document.querySelectorAll("[data-countdown]")) {
    if (el.textContent !== shownText) el.textContent = shownText;
  }
  const ring = document.querySelector(".cd-fg");
  if (ring) ring.style.strokeDashoffset = String(((left / interval) * 100).toFixed(2));
  const age = document.querySelector("[data-quote-age]");
  if (age && state.loaded) {
    const t = quoteAge(state.pricesDoc.updated);
    if (age.textContent !== t) age.textContent = t;
  }
}

function scheduleNext() {
  clearTimeout(pollTimer);
  lastPollAt = Date.now();
  pollTimer = setTimeout(poll, pollInterval(location));
}

function timedFetch(url, options) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(20000)
    : undefined;
  return fetch(url, signal ? { ...options, signal } : options);
}

async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    const { picksText, pricesText, stoppedText } = await loadDataFiles(timedFetch, location, Date.now());
    const picksDoc = JSON.parse(picksText);
    const pricesDoc = JSON.parse(pricesText);
    let stoppedDoc = { stopped: [] };
    try { stoppedDoc = JSON.parse(stoppedText || '{"stopped":[]}'); } catch { stoppedDoc = { stopped: [] }; }
    state.checkedAt = new Date().toISOString();
    state.error = null;
    state.loading = false;
    const changed = picksText !== state.picksText || pricesText !== state.pricesText || stoppedText !== state.stoppedText || !state.loaded;
    state.picksText = picksText;
    state.pricesText = pricesText;
    state.stoppedText = stoppedText;
    state.loaded = true;
    scheduleNext();
    // Same bytes as last time: refresh the clock only, keep everything else.
    if (!changed) {
      const expired = prunePending();
      if (expired) render();
      else patchStatus();
      pollLine();
      return;
    }
    state.picks = Array.isArray(picksDoc?.picks) ? picksDoc.picks.filter((pick) => pick && typeof pick === "object") : [];
    state.stopped = Array.isArray(stoppedDoc?.stopped) ? stoppedDoc.stopped.filter((row) => row && typeof row === "object") : [];
    state.pricesDoc = {
      updated: pricesDoc?.updated ?? null,
      prices: pricesDoc?.prices && typeof pricesDoc.prices === "object" ? pricesDoc.prices : {},
    };
    prunePending();
    render("data");
    pollLine();
  } catch {
    state.checkedAt = new Date().toISOString();
    state.loading = false;
    state.error = "Couldn't refresh data. Will try again shortly.";
    scheduleNext();
    if (!state.loaded) render();
    else patchStatus();
    pollLine();
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Delete flow: confirm dialog → GitHub issue (default), Worker (optional), or
// an in-memory simulation in local demo mode.

const MODAL_HTML = `<dialog id="confirm" class="modal" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
  <form method="dialog" class="modal-card" novalidate>
    <span class="modal-border" aria-hidden="true"></span>
    <div class="modal-icon" aria-hidden="true"><span class="mi-ring"></span><span class="mi-ring mi-ring-2"></span>${ICONS.trash}</div>
    <p class="modal-kicker">Shared delete</p>
    <h2 id="confirm-title" class="modal-title">Delete <span data-f="ticker"></span> for everyone?</h2>
    <div id="confirm-desc" class="modal-desc">
      <p>This removes <b data-f="ticker"></b><span data-f="company"></span> for everyone.</p>
      <p data-mode="issue">You'll be taken to GitHub to confirm — press <b>Create</b> / <b>Submit new issue</b>. Requires a GitHub account on the allowlist.</p>
      <p data-mode="endpoint">Enter the shared passcode. The Stock Bot workflow removes it from the repo for both of you.</p>
      <p data-mode="demo" class="modal-demo">Demo mode: nothing leaves this page. The lead is removed locally to preview the effect.</p>
    </div>
    <label class="field" data-mode="endpoint"><span class="field-k">Passcode</span><input type="password" id="confirm-pass" name="passcode" autocomplete="off" spellcheck="false"></label>
    <p class="modal-error" role="alert"></p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-act="cancel" data-ripple data-magnetic>Cancel</button>
      <button type="submit" class="btn btn-danger" data-act="confirm" data-ripple data-magnetic><span data-f="cta">Continue on GitHub</span></button>
    </div>
    <p class="modal-id"><span>id</span> <code data-f="id"></code></p>
  </form>
</dialog>`;

const modal = { el: null, pick: null, opener: null, busy: false };

function deleteMode() {
  if (isLocalDemo(location)) return "demo";
  return DELETE_ENDPOINT ? "endpoint" : "issue";
}

function setupModal() {
  const holder = document.createElement("div");
  holder.innerHTML = MODAL_HTML;
  const dialog = holder.firstElementChild;
  if (typeof dialog.showModal !== "function") return;
  document.body.appendChild(dialog);
  modal.el = dialog;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeModal();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeModal();
    if (event.target.closest?.("[data-act=cancel]")) closeModal();
  });
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    confirmDelete();
  });
}

function openModal(pick, opener) {
  if (!modal.el) {
    // No <dialog> support: plain confirm, same outcomes.
    const ok = window.confirm(`This removes ${pick.ticker} for everyone. You'll be taken to GitHub to confirm. Requires a GitHub account on the allowlist.`);
    if (ok) {
      modal.pick = pick;
      confirmDelete();
    }
    return;
  }
  const dialog = modal.el;
  const mode = deleteMode();
  modal.pick = pick;
  modal.opener = opener;
  modal.busy = false;
  for (const el of dialog.querySelectorAll("[data-f=ticker]")) el.textContent = String(pick.ticker || "");
  dialog.querySelector("[data-f=company]").textContent = pick.company ? ` (${pick.company})` : "";
  dialog.querySelector("[data-f=id]").textContent = String(pick.id || "");
  dialog.querySelector("[data-f=cta]").textContent = mode === "issue" ? "Continue on GitHub ↗" : (mode === "demo" ? "Delete (demo)" : "Delete for everyone");
  for (const el of dialog.querySelectorAll("[data-mode]")) el.hidden = el.dataset.mode !== mode;
  const error = dialog.querySelector(".modal-error");
  error.textContent = "";
  const pass = dialog.querySelector("#confirm-pass");
  pass.value = "";
  dialog.querySelector("[data-act=confirm]").disabled = false;
  dialog.classList.remove("is-closing");
  dialog.showModal();
  document.documentElement.classList.add("modal-open");
  if (bg) bg.hold(true);
  const focusTarget = mode === "endpoint" ? pass : dialog.querySelector("[data-act=cancel]");
  focusTarget.focus();
  if (canAnimate()) {
    dialog.querySelector(".modal-card").animate(
      [{ opacity: 0, transform: "translateY(24px) scale(0.94)", filter: "blur(10px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
      { duration: 520, easing: EASE },
    );
  }
}

function closeModal() {
  const dialog = modal.el;
  if (!dialog || !dialog.open || dialog.classList.contains("is-closing")) return;
  let finished = false;
  const card = dialog.querySelector(".modal-card");
  const finish = () => {
    if (finished) return;
    finished = true;
    card.getAnimations().forEach((animation) => animation.cancel());
    dialog.classList.remove("is-closing");
    dialog.close();
    document.documentElement.classList.remove("modal-open");
    if (bg) bg.hold(false);
    const opener = modal.opener;
    if (opener && opener.isConnected && !opener.disabled) opener.focus();
    else document.querySelector(`[data-key="${CSS.escape(pickKey(modal.pick || {}))}"] .card`)?.focus?.();
  };
  if (!canAnimate()) {
    finish();
    return;
  }
  dialog.classList.add("is-closing");
  card.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(12px) scale(0.96)" }],
    { duration: 220, easing: "ease-in", fill: "forwards" },
  ).onfinish = finish;
  setTimeout(finish, 400);
}

function markPending(pick) {
  state.pending.set(pickKey(pick), Date.now());
  savePending();
  render("pending");
}

async function confirmDelete() {
  const pick = modal.pick;
  if (!pick || modal.busy) return;
  const mode = deleteMode();
  if (mode === "demo") {
    closeModal();
    markPending(pick);
    setTimeout(() => {
      state.demoDeleted.add(pickKey(pick));
      state.pending.delete(pickKey(pick));
      savePending();
      render("data");
    }, 1400);
    return;
  }
  if (mode === "issue") {
    window.open(deleteIssueUrl(pick), "_blank", "noopener,noreferrer");
    markPending(pick);
    closeModal();
    return;
  }
  const dialog = modal.el;
  const error = dialog?.querySelector(".modal-error");
  const passcode = dialog?.querySelector("#confirm-pass")?.value || "";
  if (!passcode) {
    if (error) error.textContent = "Enter the passcode first.";
    return;
  }
  modal.busy = true;
  const button = dialog.querySelector("[data-act=confirm]");
  button.disabled = true;
  try {
    const res = await timedFetch(DELETE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pick.id, passcode }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${res.status})`);
    }
    markPending(pick);
    modal.busy = false;
    closeModal();
  } catch (err) {
    modal.busy = false;
    button.disabled = false;
    if (error) error.textContent = `Could not delete: ${err?.message || "network error"}.`;
  }
}

// ---------------------------------------------------------------------------
// Intro: HUD frame draws, wordmark decodes, stats and cards rise. Once per load.

function scramble(el, duration = 1000) {
  const final = el.dataset.text || el.textContent;
  if (!canAnimate()) return;
  const chars = [...final];
  el.textContent = "";
  const spans = chars.map((c) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.textContent = c === " " ? " " : c;
    el.appendChild(span);
    return span;
  });
  const widths = spans.map((span) => span.getBoundingClientRect().width);
  spans.forEach((span, i) => { span.style.width = `${widths[i]}px`; });
  el.classList.add("is-scrambling");
  const glyphs = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&▲▼";
  const start = performance.now();
  let lastSwap = 0;
  const step = (t) => {
    const p = (t - start) / duration;
    const swap = t - lastSwap > 55;
    if (swap) lastSwap = t;
    spans.forEach((span, i) => {
      if (chars[i] === " ") return;
      const at = 0.2 + (i / chars.length) * 0.7;
      if (p >= at) {
        if (!span.classList.contains("on")) {
          span.textContent = chars[i];
          span.classList.add("on");
        }
      } else if (swap) {
        span.textContent = glyphs[(Math.random() * glyphs.length) | 0];
      }
    });
    if (p < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = final;
      el.classList.remove("is-scrambling");
      el.classList.add("is-lit");
    }
  };
  requestAnimationFrame(step);
}

function playIntro() {
  const root = document.documentElement;
  const wm = document.querySelector(".wordmark .wm");
  if (!canAnimate()) {
    root.classList.remove("intro-pending");
    return;
  }
  if (!gsapReady()) {
    root.classList.remove("intro-pending");
    const items = document.querySelectorAll(".topbar, .hero-main > *, .hero-side .meta, #summary .stat, .tape");
    items.forEach((el, i) => el.animate(
      [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }],
      { duration: 900, easing: EASE, delay: i * 60, fill: "backwards" },
    ));
    if (wm) scramble(wm, 1000);
    return;
  }
  const g = window.gsap;
  const tl = g.timeline({ defaults: { ease: "expo.out" } });
  tl.fromTo(".topbar", { autoAlpha: 0, y: -26 }, { autoAlpha: 1, y: 0, duration: 0.9, clearProps: "transform" }, 0)
    .fromTo(".hero-frame .fl-t, .hero-frame .fl-b", { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "power3.inOut", stagger: 0.1 }, 0.05)
    .fromTo(".hero-frame .fl-l, .hero-frame .fl-r", { scaleY: 0 }, { scaleY: 1, duration: 1, ease: "power3.inOut" }, 0.2)
    .fromTo(".hero-frame .fc", { autoAlpha: 0, scale: 0.3 }, { autoAlpha: 1, scale: 1, duration: 0.7, stagger: 0.05 }, 0.4)
    .fromTo(".hero-frame .fx", { autoAlpha: 0, x: -10 }, { autoAlpha: 1, x: 0, duration: 0.7, stagger: 0.12 }, 0.7)
    .fromTo(".kicker", { autoAlpha: 0, x: -16 }, { autoAlpha: 1, x: 0, duration: 0.8 }, 0.1)
    .fromTo(".wordmark .wm", { autoAlpha: 0, y: 26, filter: "blur(16px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 1.1, clearProps: "filter" }, 0.08)
    .add(() => { if (wm) scramble(wm, 1050); }, 0.1)
    .fromTo(".wordmark .wm-sub", { autoAlpha: 0, x: -24 }, { autoAlpha: 1, x: 0, duration: 1.1 }, 0.45)
    .fromTo(".tagline", { autoAlpha: 0, y: 18, filter: "blur(8px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 1, clearProps: "filter" }, 0.55)
    .fromTo(".hero-side .meta, .hero-side .status-note", { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 1 }, 0.5)
    .fromTo("#summary .stat", { autoAlpha: 0, y: 40, rotateX: -32, filter: "blur(12px)", transformPerspective: 900, transformOrigin: "50% 100%" },
      { autoAlpha: 1, y: 0, rotateX: 0, filter: "blur(0px)", duration: 1.2, stagger: 0.08, clearProps: "transform,filter" }, 0.55)
    .fromTo(".tape", { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 1, clearProps: "transform" }, 0.8)
    .fromTo("#board", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6 }, 0.75);
  intro = tl;
  root.classList.remove("intro-pending");

  const skip = (event) => {
    if (event.type === "keydown" && !["Escape", "Enter", " "].includes(event.key)) return;
    skipIntro();
    window.removeEventListener("pointerdown", skip, true);
    window.removeEventListener("keydown", skip, true);
  };
  window.addEventListener("pointerdown", skip, true);
  window.addEventListener("keydown", skip, true);
  setTimeout(() => {
    window.removeEventListener("pointerdown", skip, true);
    window.removeEventListener("keydown", skip, true);
  }, 3500);

  if (scrollTriggerReady()) {
    g.registerPlugin(window.ScrollTrigger);
    g.fromTo(".footer", { autoAlpha: 0, y: 50 }, {
      autoAlpha: 1, y: 0, duration: 1.2, ease: "expo.out", clearProps: "transform",
      scrollTrigger: { trigger: ".footer", start: "top 95%", once: true },
    });
  }
}

// ---------------------------------------------------------------------------
// Events.

function onChange(event) {
  const target = event.target;
  if (!target || target.id !== "sort") return;
  if (!SORT_VALUES.has(target.value)) return;
  state.sort = target.value;
  saveSort(state.sort);
  render("sort");
}

function onClick(event) {
  const filterButton = event.target.closest?.("[data-filter]");
  if (filterButton) {
    const value = filterButton.dataset.filter;
    if (FILTER_VALUES.has(value) && value !== state.filter) {
      state.filter = value;
      saveFilter(value);
      render("filter");
      document.querySelector(`.seg-btn[data-filter="${value}"]`)?.focus({ preventScroll: true });
    }
    return;
  }
  const sortButton = event.target.closest?.("[data-sort]");
  if (sortButton) {
    state.sort = nextSort(state.sort, sortButton.dataset.sort);
    saveSort(state.sort);
    render("sort");
    return;
  }
  const del = event.target.closest?.("[data-delete]");
  if (del) {
    const pick = state.picks.find((item) => pickKey(item) === del.dataset.delete);
    if (pick && canDelete(pick)) openModal(pick, del);
    return;
  }
  const toggle = event.target.closest?.("[data-expand]");
  if (toggle) {
    toggleLead(toggle);
    return;
  }
  const summary = event.target.closest?.("details.why > summary");
  if (summary) animateWhy(event, summary);
}

function setLeadOpen(article, open) {
  if (!article) return;
  article.classList.toggle("is-open", open);
  const button = article.querySelector("[data-expand]");
  const panel = article.querySelector(".lead-detail-wrap");
  if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
  if (panel) {
    if (open) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
  }
}

function toggleLead(button) {
  const article = button.closest(".lead");
  if (!article) return;
  const key = button.getAttribute("data-expand") || article.getAttribute("data-key");
  const open = !article.classList.contains("is-open");
  setLeadOpen(article, open);
  if (!key) return;
  if (open) state.expandedKeys.add(key);
  else state.expandedKeys.delete(key);
}

// Smooth height open/close; the native <details> still owns state, keyboard
// and screen reader semantics.
function animateWhy(event, summary) {
  if (!canAnimate()) return;
  const details = summary.parentElement;
  const body = details.querySelector(".why-body");
  if (!body) return;
  event.preventDefault();
  if (details.dataset.animating) return;
  details.dataset.animating = "1";
  const done = () => {
    body.style.height = "";
    body.style.overflow = "";
    delete details.dataset.animating;
  };
  if (!details.open) {
    details.open = true;
    const h = body.scrollHeight;
    body.style.overflow = "hidden";
    body.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 520, easing: EASE }).onfinish = done;
    details.querySelectorAll(".reasons > li").forEach((li, i) => li.animate(
      [{ opacity: 0, transform: "translateY(-10px)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
      { duration: 520, delay: 80 + i * 70, easing: EASE, fill: "backwards" },
    ));
  } else {
    const h = body.offsetHeight;
    body.style.overflow = "hidden";
    body.animate([{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 380, easing: "cubic-bezier(.4,0,.2,1)" }).onfinish = () => {
      details.open = false;
      done();
    };
  }
}

// Remember which "why" sections are open so re-renders restore them.
function onToggle(event) {
  const el = event.target;
  if (!el || el.tagName !== "DETAILS" || !el.classList.contains("why")) return;
  const key = el.getAttribute("data-why");
  if (!key) return;
  if (el.open) state.openKeys.add(key);
  else state.openKeys.delete(key);
}

function boot() {
  const board = document.getElementById("board");
  if (!board) return;
  state.sort = loadSort();
  state.filter = loadFilter();
  state.pending = loadPending();
  document.addEventListener("change", onChange);
  document.addEventListener("click", onClick);
  document.addEventListener("toggle", onToggle, true);
  installTilt(".lead .card");
  installMagnetic();
  installRipple();
  setupModal();

  const canvas = document.getElementById("bg");
  try {
    bg = startBackground(canvas, {
      reduced: reducedMotion(),
      coarse: !finePointer(),
      // Only for local headless screenshots; production keeps the cheaper default.
      preserve: ["localhost", "127.0.0.1"].includes(location.hostname),
    });
  } catch {
    bg = null;
  }
  if (!bg) document.documentElement.classList.add("no-webgl");

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  setInterval(() => {
    if (!document.hidden) tickCountdown();
  }, 1000);

  render();
  playIntro();
  poll();
}

if (typeof document !== "undefined") boot();
