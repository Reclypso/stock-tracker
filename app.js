// Stock Bot Pick Tracker.
// Polls picks and prices every 60s. On *.github.io, fetch raw.githubusercontent.com
// first so the GitHub Pages CDN cannot serve a stale copy. Sort survives those
// refreshes (and reloads, via localStorage). Re-renders animate only what changed.

export const OWNER = "Reclypso";
export const REPO = "stock-tracker";
export const BRANCH = "main";
export const POLL_MS = 60 * 1000;
export const FAST_POLL_MS = 5 * 1000;
export const STALE_MS = 24 * 60 * 60 * 1000;

const SORTS = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["best", "Best return"],
  ["worst", "Worst return"],
  ["ticker", "Ticker A–Z"],
  ["grade", "Grade"],
];
const SORT_VALUES = new Set(SORTS.map(([value]) => value));
const GRADE_CLASS = { A: "g-a", B: "g-b", C: "g-c", Lottery: "g-lot" };
const GRADE_RANK = { A: 0, B: 1, C: 2, Lottery: 3 };
const OPEN_COLS = 11;
const CLOSED_COLS = 7;

const state = {
  sort: "newest",
  openKeys: new Set(),
  picks: [],
  pricesDoc: { updated: null, prices: {} },
  picksText: null,
  pricesText: null,
  checkedAt: null,
  error: null,
  loading: true,
  loaded: false,
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
  const [picksText, pricesText] = await Promise.all([
    loadOne("picks.json"),
    loadOne("prices.json"),
  ]);
  return { picksText, pricesText };
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

export function formatDays(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const unit = Math.abs(value) === 1 ? "day" : "days";
  return `${value} ${unit}`;
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

export function computeSummary(picks, pricesDoc) {
  const list = picks || [];
  const open = list.filter((pick) => pick.status === "open");
  const closed = list.filter((pick) => pick.status === "closed");
  const known = (rows) => rows.filter((pick) => returnPct(pick, pricesDoc) != null);

  let winRate = null;
  let winLabel = "";
  const winsIn = (rows) => rows.filter((pick) => {
    const ret = returnPct(pick, pricesDoc);
    return ret != null && ret > 0;
  }).length;
  if (!list.length) {
    winRate = null;
  } else if (closed.length) {
    winRate = winsIn(closed) / closed.length;
    winLabel = `${closed.length} closed`;
  } else if (!known(list).length) {
    winRate = null;
    winLabel = "incl. open";
  } else {
    // No closes yet: winners / every pick. Unpriced names are not winners.
    winRate = winsIn(list) / list.length;
    winLabel = "incl. open";
  }

  const priced = known(list);
  const avgReturn = priced.length
    ? priced.reduce((sum, pick) => sum + returnPct(pick, pricesDoc), 0) / priced.length
    : null;

  let best = null;
  for (const pick of priced) {
    const ret = returnPct(pick, pricesDoc);
    if (!best || ret > best.ret) best = { ticker: pick.ticker, ret };
  }

  const projections = [];
  for (const pick of list) {
    const pct = projectedPct(pick.priceAtCall, targetBaseOf(pick));
    if (pct != null) projections.push(pct);
  }
  const avgProjected = projections.length
    ? projections.reduce((sum, pct) => sum + pct, 0) / projections.length
    : null;

  return {
    openCount: open.length,
    winRate,
    winLabel,
    avgReturn,
    best,
    avgProjected,
  };
}

export function sortPicks(picks, pricesDoc, mode) {
  const list = (picks || []).slice();
  const cmpTicker = (a, b) => String(a.ticker || "").localeCompare(String(b.ticker || ""));
  const cmpDate = (a, b) => {
    const byDay = String(a.dateCalled || "").localeCompare(String(b.dateCalled || ""));
    if (byDay) return byDay;
    return String(a.calledAt || "").localeCompare(String(b.calledAt || ""));
  };
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

function toneOf(pick, current) {
  if (current == null) return "";
  const bull = targetBullOf(pick);
  const base = targetBaseOf(pick);
  if (bull != null && current >= bull) return "bull";
  if (base != null && current >= base) return "hit";
  const stop = stopOf(pick);
  if (stop != null && current <= stop) return "warn";
  return "";
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

// Hidden debug: ?demo=1&fast=1 on localhost polls every 5s.
export function pollInterval(loc) {
  if (!isLocalDemo(loc)) return POLL_MS;
  return new URLSearchParams(loc.search || "").get("fast") === "1" ? FAST_POLL_MS : POLL_MS;
}

function formatWin(rate) {
  if (rate == null || !Number.isFinite(rate)) return "—";
  const pct = rate * 100;
  const rounded = Math.round(pct * 10) / 10;
  return (Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)) + "%";
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

// A number the animation layer can count, flash, and diff between polls.
// `key` is stable per pick/stat so a re-render can compare old and new values.
function animNum(key, value, fmt, text, cls = "", count = false) {
  const n = num(value);
  if (n == null) return `<span class="${cls}">${escapeHtml(text)}</span>`;
  return `<span class="${cls}" data-anim="${escapeHtml(key)}" data-num="${n}" data-fmt="${fmt}"${count ? " data-count" : ""}>${escapeHtml(text)}</span>`;
}

function gradeBadge(grade) {
  const cls = GRADE_CLASS[grade] || "g-u";
  return `<span class="badge ${cls}">${escapeHtml(grade || "—")}</span>`;
}

function hitChips(pick, current) {
  if (current == null) return "";
  const chips = [];
  if (targetBullOf(pick) != null && current >= targetBullOf(pick)) {
    chips.push('<span class="chip bull"><i aria-hidden="true"></i>Bull hit</span>');
  }
  if (targetBaseOf(pick) != null && current >= targetBaseOf(pick)) {
    chips.push('<span class="chip hit"><i aria-hidden="true"></i>Base hit</span>');
  }
  const stop = stopOf(pick);
  if (stop != null && current <= stop) chips.push('<span class="chip warn"><i aria-hidden="true"></i>Stop hit</span>');
  return chips.length ? `<div class="chips">${chips.join("")}</div>` : "";
}

function renderReasons(pick, openKeys) {
  const reasons = Array.isArray(pick.reasons) ? pick.reasons : [];
  if (!reasons.length) return "";
  const key = pickKey(pick);
  const open = openKeys.has(key) ? " open" : "";
  const items = reasons.map((reason) => {
    const sources = Array.isArray(reason?.sources) ? reason.sources : [];
    const links = sources.map((source) => {
      const href = safeHttpUrl(source?.url);
      if (!href) return "";
      const title = escapeHtml(source?.title || href);
      const host = escapeHtml(new URL(href).hostname.replace(/^www\./, ""));
      return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><span class="src-title">${title}</span><span class="src-host">${host}</span></a></li>`;
    }).filter(Boolean).join("");
    const list = links ? `<ul class="sources">${links}</ul>` : "";
    return `<li><p>${escapeHtml(reason?.text ?? "")}</p>${list}</li>`;
  }).join("");
  return `<details class="why" data-key="${escapeHtml(key)}"${open}><summary><span>Why I picked it <span class="why-count">(${reasons.length})</span></span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><ul class="reasons">${items}</ul></details>`;
}

function renderProgress(pick, current) {
  const entry = pick.priceAtCall;
  const target = targetBaseOf(pick);
  const progress = progressToBase(current, entry, target);
  if (progress == null) return "";
  const below = num(current) < num(entry);
  const width = Math.max(0, Math.min(100, below ? Math.abs(progress) : progress));
  const rounded = Math.round(progress);
  const label = below ? `${rounded}% vs call` : (rounded >= 100 ? `${rounded}% · base hit` : `${rounded}% to base`);
  const mode = below ? " neg" : (rounded >= 100 ? " done" : "");
  const scale = below ? "Below call" : `Call ${escapeHtml(formatPrice(entry))} → Base ${escapeHtml(formatPrice(target))}`;
  return `<div class="progress${mode}">
    <div class="progress-head"><span class="progress-label">${escapeHtml(label)}</span><span class="progress-scale">${scale}</span></div>
    <div class="track" role="img" aria-label="${escapeHtml(label)}"><span class="fill" data-meter="${escapeHtml(pickKey(pick))}:bar" data-to="${width.toFixed(1)}" style="width:${width.toFixed(1)}%"></span></div>
  </div>`;
}

function levelCell(label, level, current, cls) {
  if (num(level) == null) {
    return `<div class="level ${cls}"><span class="k">${label}</span><span class="lv">—</span></div>`;
  }
  const dist = distancePhrase(level, current);
  return `<div class="level ${cls}"><span class="k">${label}</span><span class="lv">${escapeHtml(formatPrice(level))}</span>${dist ? `<span class="dist">${escapeHtml(dist)}</span>` : ""}</div>`;
}

function returnBits(pick, pricesDoc) {
  const ret = returnPct(pick, pricesDoc);
  if (ret == null) {
    const text = pick.status === "closed" ? "—" : "awaiting price";
    return { ret, text, cls: "flat" };
  }
  return { ret, text: formatPct(ret), cls: `${pctClass(ret)} bold` };
}

function returnHtml(pick, bits, extraCls = "") {
  if (bits.ret == null) {
    const waiting = bits.text === "awaiting price" ? " awaiting" : "";
    return `<span class="${bits.cls}${waiting} ${extraCls}">${escapeHtml(bits.text)}</span>`;
  }
  return animNum(`${pickKey(pick)}:ret`, bits.ret, "pct", bits.text, `${bits.cls} ${extraCls}`, true);
}

function nowHtml(pick, current) {
  if (current == null) return '<span class="awaiting">awaiting price</span>';
  return animNum(`${pickKey(pick)}:price`, current, "price", formatPrice(current));
}

function dayHtml(pick, day) {
  if (day == null) return '<span class="flat">—</span>';
  return animNum(`${pickKey(pick)}:day`, day, "pct", formatPct(day), pctClass(day));
}

function sortSelect(current) {
  const options = SORTS.map(([value, label]) => {
    const selected = value === current ? " selected" : "";
    return `<option value="${value}"${selected}>${label}</option>`;
  }).join("");
  return `<label class="sort" for="sort"><span class="sort-k">Sort</span><span class="select"><select id="sort">${options}</select><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span></label>`;
}

function headerCell(label, key, sort, cls = "") {
  const clsAttr = cls ? ` class="${cls}"` : "";
  if (!key) return `<th scope="col"${clsAttr}>${label}</th>`;
  const active = (key === "called" && (sort === "newest" || sort === "oldest"))
    || (key === "return" && (sort === "best" || sort === "worst"))
    || (key === "ticker" && sort === "ticker")
    || (key === "grade" && sort === "grade");
  let arrow = "";
  let aria = "";
  if (active) {
    const down = sort === "newest" || sort === "best";
    arrow = down ? " ↓" : " ↑";
    aria = ` aria-sort="${down ? "descending" : "ascending"}"`;
  }
  return `<th scope="col"${clsAttr}${aria}><button type="button" data-sort="${key}" class="${active ? "active" : ""}">${label}<span class="arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

function projectedLine(pick) {
  const base = projectedPct(pick.priceAtCall, targetBaseOf(pick));
  const bull = projectedPct(pick.priceAtCall, targetBullOf(pick));
  if (base == null && bull == null) return "";
  const baseText = base == null ? "—" : `<strong class="${pctClass(base)}">${formatPct(base)}</strong>`;
  const bullText = bull == null ? "—" : `<strong class="${pctClass(bull)}">${formatPct(bull)}</strong>`;
  const frame = pick.timeframe ? `<span class="timeframe">${escapeHtml(pick.timeframe)}</span>` : "";
  return `<p class="proj"><span class="k">Projected</span><span class="proj-vals">Base ${baseText}<span class="sep">·</span>Bull ${bullText}</span>${frame}</p>`;
}

function blurb(label, text) {
  return `<p class="blurb"><span class="k">${label}</span> ${escapeHtml(text)}</p>`;
}

function pickAttrs(pick, kind) {
  const key = escapeHtml(pickKey(pick));
  return `data-pick="${key}|${pick.status === "closed" ? "closed" : "open"}" data-flip="${key}:${kind}"`;
}

function renderOpenCard(pick, pricesDoc, today, openKeys) {
  const current = markPrice(pick, pricesDoc);
  const quote = quoteFor(pick, pricesDoc);
  const tone = toneOf(pick, current);
  const ret = returnBits(pick, pricesDoc);
  const day = quote ? num(quote.changePct) : null;
  const company = pick.company ? `<p class="company">${escapeHtml(pick.company)}</p>` : "";
  return `<article class="card ${tone}" ${pickAttrs(pick, "card")} data-enter>
    <header class="card-top">
      <div class="card-id">
        <div class="ticker-line"><h3>${escapeHtml(pick.ticker)}</h3>${gradeBadge(pick.grade)}</div>
        ${company}
      </div>
      <div class="ret-block">
        <p class="big">${returnHtml(pick, ret)}</p>
        <p class="ret-cap">since call</p>
      </div>
    </header>
    ${hitChips(pick, current)}
    <dl class="prices">
      <div><dt>Called</dt><dd>${escapeHtml(formatPrice(pick.priceAtCall))}<span class="subdate">${escapeHtml(formatDay(pick.dateCalled))}</span></dd></div>
      <div><dt>Now</dt><dd>${nowHtml(pick, current)}</dd></div>
      <div><dt>Day</dt><dd>${dayHtml(pick, day)}</dd></div>
    </dl>
    ${renderProgress(pick, current)}
    <div class="levels">
      ${levelCell("Stop", stopOf(pick), current, "lv-stop")}
      ${levelCell("Base", targetBaseOf(pick), current, "lv-base")}
      ${levelCell("Bull", targetBullOf(pick), current, "lv-bull")}
    </div>
    ${projectedLine(pick)}
    <div class="notes">
      ${blurb("Thesis", pick.thesis || "—")}
      ${pick.catalyst ? blurb("Catalyst", pick.catalyst) : ""}
      ${pick.notes ? blurb("Notes", pick.notes) : ""}
    </div>
    <p class="held"><span class="k">Held</span> ${escapeHtml(formatDays(daysHeld(pick, today)))}</p>
    ${renderReasons(pick, openKeys)}
  </article>`;
}

function renderOpenRow(pick, pricesDoc, today, openKeys) {
  const current = markPrice(pick, pricesDoc);
  const quote = quoteFor(pick, pricesDoc);
  const tone = toneOf(pick, current);
  const ret = returnBits(pick, pricesDoc);
  const day = quote ? num(quote.changePct) : null;
  const basePct = projectedPct(pick.priceAtCall, targetBaseOf(pick));
  const bullPct = projectedPct(pick.priceAtCall, targetBullOf(pick));
  const company = pick.company ? `<div class="company">${escapeHtml(pick.company)}</div>` : "";
  const stopDist = distancePhrase(stopOf(pick), current);
  const baseDist = distancePhrase(targetBaseOf(pick), current);
  const key = escapeHtml(pickKey(pick));
  return `<tbody class="pick ${tone}" data-pick="${key}|open">
  <tr class="data" data-flip="${key}:row" data-enter>
    <td><div class="ticker">${escapeHtml(pick.ticker)}</div>${company}</td>
    <td>${gradeBadge(pick.grade)}</td>
    <td class="num">${escapeHtml(formatPrice(pick.priceAtCall))}<div class="subdate">${escapeHtml(formatDay(pick.dateCalled))}</div></td>
    <td class="num">${nowHtml(pick, current)}</td>
    <td class="num">${dayHtml(pick, day)}</td>
    <td class="num ret">${returnHtml(pick, ret)}</td>
    <td class="num">Base ${basePct == null ? "—" : `<span class="${pctClass(basePct)}">${formatPct(basePct)}</span>`}<div class="subdate">Bull ${bullPct == null ? "—" : formatPct(bullPct)}</div></td>
    <td class="num">${escapeHtml(formatDays(daysHeld(pick, today)))}</td>
    <td class="num">${stopOf(pick) == null ? "—" : `${escapeHtml(formatPrice(stopOf(pick)))}${stopDist ? `<div class="subdate">${escapeHtml(stopDist)}</div>` : ""}`}</td>
    <td class="num">${targetBaseOf(pick) == null ? "—" : `${escapeHtml(formatPrice(targetBaseOf(pick)))}${baseDist ? `<div class="subdate">${escapeHtml(baseDist)}</div>` : ""}`}</td>
    <td>${escapeHtml(pick.timeframe || "—")}</td>
  </tr>
  <tr class="context" data-flip="${key}:ctx" data-enter>
    <td colspan="${OPEN_COLS}">
      <div class="context-body">
        <div class="context-side">
          ${hitChips(pick, current)}
          ${renderProgress(pick, current)}
        </div>
        <div class="context-main">
          ${blurb("Thesis", pick.thesis || "—")}
          ${blurb("Catalyst", pick.catalyst || "—")}
          ${pick.notes ? blurb("Notes", pick.notes) : ""}
          ${renderReasons(pick, openKeys)}
        </div>
      </div>
    </td>
  </tr>
  </tbody>`;
}

function renderClosedCard(pick, pricesDoc, today, openKeys) {
  const ret = returnBits(pick, pricesDoc);
  const company = pick.company ? `<p class="company">${escapeHtml(pick.company)}</p>` : "";
  const tone = ret.ret == null ? "" : (ret.ret > 0 ? "won" : (ret.ret < 0 ? "lost" : ""));
  return `<article class="card closed ${tone}" ${pickAttrs(pick, "card")} data-enter>
    <header class="card-top">
      <div class="card-id">
        <div class="ticker-line"><h3>${escapeHtml(pick.ticker)}</h3>${gradeBadge(pick.grade)}<span class="closed-tag">Closed</span></div>
        ${company}
      </div>
      <div class="ret-block">
        <p class="big">${returnHtml(pick, ret)}</p>
        <p class="ret-cap">final</p>
      </div>
    </header>
    <dl class="prices">
      <div><dt>Called</dt><dd>${escapeHtml(formatPrice(pick.priceAtCall))}<span class="subdate">${escapeHtml(formatDay(pick.dateCalled))}</span></dd></div>
      <div><dt>Exit</dt><dd>${escapeHtml(formatPrice(pick.exitPrice))}<span class="subdate">${escapeHtml(formatDay(pick.exitDate))}</span></dd></div>
      <div><dt>Held</dt><dd>${escapeHtml(formatDays(daysHeld(pick, today)))}</dd></div>
    </dl>
    ${projectedLine(pick)}
    <div class="notes">
      ${blurb("Notes", pick.notes || "—")}
      ${pick.thesis ? blurb("Thesis", pick.thesis) : ""}
    </div>
    ${renderReasons(pick, openKeys)}
  </article>`;
}

function renderClosedRow(pick, pricesDoc, today, openKeys) {
  const ret = returnBits(pick, pricesDoc);
  const company = pick.company ? `<div class="company">${escapeHtml(pick.company)}</div>` : "";
  const key = escapeHtml(pickKey(pick));
  return `<tbody class="pick" data-pick="${key}|closed">
  <tr class="data" data-flip="${key}:row" data-enter>
    <td><div class="ticker">${escapeHtml(pick.ticker)}</div>${company}</td>
    <td>${gradeBadge(pick.grade)}</td>
    <td class="num">${escapeHtml(formatDay(pick.dateCalled))}<div class="subdate">${escapeHtml(formatPrice(pick.priceAtCall))}</div></td>
    <td class="num">${escapeHtml(formatDay(pick.exitDate))}<div class="subdate">${escapeHtml(formatPrice(pick.exitPrice))}</div></td>
    <td class="num ret">${returnHtml(pick, ret)}</td>
    <td class="num">${escapeHtml(formatDays(daysHeld(pick, today)))}</td>
    <td class="notes-cell">${escapeHtml(pick.notes || "—")}</td>
  </tr>
  <tr class="context" data-flip="${key}:ctx" data-enter>
    <td colspan="${CLOSED_COLS}">
      <div class="context-body">
        <div class="context-side">${projectedLine(pick)}</div>
        <div class="context-main">
          ${blurb("Thesis", pick.thesis || "—")}
          ${renderReasons(pick, openKeys)}
        </div>
      </div>
    </td>
  </tr>
  </tbody>`;
}

const RING_R = 15.5;
const RING_C = 2 * Math.PI * RING_R;

function ringOffset(pct) {
  return (RING_C * (1 - Math.max(0, Math.min(100, pct)) / 100)).toFixed(2);
}

function renderSummary(summary, loaded) {
  const pending = !loaded;
  const avg = summary.avgReturn;
  const avgTone = pctClass(avg);
  const avgHtml = avg == null ? "—" : animNum("stat:avg", avg, "pct", formatPct(avg), avgTone, true);
  const openHtml = pending ? "—" : animNum("stat:open", summary.openCount, "int", String(summary.openCount), "", true);
  const winPct = summary.winRate == null || !Number.isFinite(summary.winRate) ? null : summary.winRate * 100;
  const winHtml = winPct == null ? "—" : animNum("stat:win", winPct, "win", formatWin(summary.winRate), "", true);
  const ring = `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="${RING_R}"/>${winPct == null ? "" : `<circle class="ring-fg" cx="18" cy="18" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" data-meter="stat:win" data-kind="ring" data-to="${winPct.toFixed(1)}" style="stroke-dashoffset:${ringOffset(winPct)}"/>`}</svg>`;
  const best = summary.best;
  const bestValue = best ? `<span data-anim="stat:best" data-fmt="text">${escapeHtml(best.ticker)}</span>` : "—";
  const bestSub = best ? animNum("stat:bestret", best.ret, "pct", formatPct(best.ret), pctClass(best.ret), true) : "—";
  const proj = summary.avgProjected;
  const projHtml = proj == null ? "—" : animNum("stat:proj", proj, "pct", formatPct(proj), pctClass(proj), true);
  return `<section class="summary" aria-label="Summary">
    <article class="stat stat-hero ${avgTone}" data-enter>
      <p class="label">Average return</p>
      <p class="value">${avgHtml}</p>
      <p class="sub">all priced picks</p>
    </article>
    <article class="stat" data-enter><p class="label">Open picks</p><p class="value">${openHtml}</p><p class="sub">active</p></article>
    <article class="stat stat-win" data-enter>
      <div><p class="label">Win rate</p><p class="value">${winHtml}</p>${summary.winLabel ? `<p class="sub">${escapeHtml(summary.winLabel)}</p>` : ""}</div>
      ${ring}
    </article>
    <article class="stat" data-enter><p class="label">Best pick</p><p class="value">${bestValue}</p><p class="sub">${bestSub}</p></article>
    <article class="stat" data-enter><p class="label">Avg projected</p><p class="value">${projHtml}</p><p class="sub">base</p></article>
  </section>`;
}

const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="logo-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#7aa7ff"/><stop offset="1" stop-color="#34e3a4"/></linearGradient></defs><rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="#0d131c" stroke="rgba(255,255,255,0.12)"/><path d="M7 21.5 13 15l4 3.5 8-10" fill="none" stroke="url(#logo-g)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 8.5h5.5V14" fill="none" stroke="url(#logo-g)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const FOOTER = `<footer class="footer" data-enter><p>Not financial advice. Ideas can go to zero.</p><p class="footer-sub">Quotes are delayed. Times shown in Pacific.</p></footer>`;

function skeleton() {
  const card = `<div class="card skeleton" aria-hidden="true"><div class="sk sk-a"></div><div class="sk sk-b"></div><div class="sk sk-c"></div><div class="sk sk-d"></div></div>`;
  return `<section class="block" aria-busy="true"><p class="sr-only loading">Loading picks…</p><div class="cards cards-all">${card}${card}</div></section>`;
}

function emptyState() {
  const ghost = `<div class="ghost-row"><span class="gh gh-t"></span><span class="gh gh-b"></span><span class="gh gh-r"></span></div>`;
  return `<section class="empty" data-enter>
    <div class="radar" aria-hidden="true"><span class="blip b1"></span><span class="blip b2"></span><span class="blip b3"></span></div>
    <p class="empty-kicker">Scanning</p>
    <h2 class="empty-title">No picks yet.</h2>
    <p class="empty-text">Stock Bot's first calls will appear here.</p>
    <p class="empty-hint">This page checks for new picks every minute. No reload needed.</p>
    <div class="ghosts" aria-hidden="true">${ghost}${ghost}</div>
  </section>`;
}

export function renderDashboard(model) {
  const picks = model.picks || [];
  const pricesDoc = model.pricesDoc || { updated: null, prices: {} };
  const sort = SORT_VALUES.has(model.sort) ? model.sort : "newest";
  const openKeys = model.openKeys instanceof Set ? model.openKeys : new Set(model.openKeys || []);
  const now = model.now instanceof Date ? model.now : new Date();
  const today = todayPT(now);
  const summary = computeSummary(picks, pricesDoc);
  const note = statusMessage({ ...model, now });
  const dot = dotMode({ ...model, now });
  const pricesAt = formatPT(pricesDoc.updated);

  const topbar = `<div class="topbar">
    <div class="topbar-inner">
      <div class="brand">${LOGO}<h1><span class="h1-main">Stock Bot</span> <span class="h1-sub">Pick Tracker</span></h1></div>
      <span id="live" class="live ${dot}"><span id="live-dot" class="live-dot ${dot}"></span><span id="live-label">${LIVE_LABEL[dot]}</span></span>
    </div>
    <div class="poll-line" aria-hidden="true"><span id="poll-line"></span></div>
  </div>`;

  const hud = `<section class="hud" data-enter>
    <p class="tag">Refreshes every minute. No reload needed.</p>
    <div class="meta">
      <div class="meta-item"><span class="k">Prices updated</span><strong id="prices-at"${model.loaded ? ` data-anim="meta:prices" data-fmt="text"` : ""}>${escapeHtml(pricesAt)}</strong></div>
      <div class="meta-item"><span class="k">Checked</span><strong id="checked-at">${escapeHtml(formatPT(model.checkedAt))}</strong></div>
    </div>
    <p id="status-note" class="status-note${model.error ? " bad" : ""}">${escapeHtml(note)}</p>
  </section>`;

  const head = `${topbar}<div class="page">${hud}${renderSummary(summary, model.loaded)}`;

  if (!model.loaded && model.loading) {
    return `${head}${skeleton()}${FOOTER}</div>`;
  }
  if (!model.loaded && model.error) {
    return `${head}<section class="empty error" data-enter><div class="err-mark" aria-hidden="true">!</div><h2 class="empty-title">Picks could not be loaded.</h2><p class="empty-text">Retrying automatically.</p></section>${FOOTER}</div>`;
  }

  const ordered = sortPicks(picks, pricesDoc, sort);
  const open = ordered.filter((pick) => pick.status === "open");
  const closed = ordered.filter((pick) => pick.status === "closed");
  let body = "";
  if (!picks.length) {
    body = emptyState();
  } else {
    if (open.length) {
      const headRow = `<tr>${headerCell("Ticker", "ticker", sort)}${headerCell("Grade", "grade", sort)}${headerCell("Called", "called", sort, "num")}${headerCell("Current", "", sort, "num")}${headerCell("Day", "", sort, "num")}${headerCell("Return", "return", sort, "num")}${headerCell("Projected", "", sort, "num")}${headerCell("Days", "", sort, "num")}${headerCell("Stop", "", sort, "num")}${headerCell("Target", "", sort, "num")}${headerCell("Timeframe")}</tr>`;
      body += `<section class="block">
        <div class="section-head" data-enter><h2>Open picks <span class="count">${open.length}</span></h2>${sortSelect(sort)}</div>
        <div class="table-wrap"><table class="grid"><caption class="sr-only">Open picks</caption><thead>${headRow}</thead>${open.map((pick) => renderOpenRow(pick, pricesDoc, today, openKeys)).join("")}</table></div>
        <div class="cards">${open.map((pick) => renderOpenCard(pick, pricesDoc, today, openKeys)).join("")}</div>
      </section>`;
    }
    if (closed.length) {
      const headRow = `<tr>${headerCell("Ticker", "ticker", sort)}${headerCell("Grade", "grade", sort)}${headerCell("Called", "called", sort, "num")}${headerCell("Exit", "", sort, "num")}${headerCell("Return", "return", sort, "num")}${headerCell("Days", "", sort, "num")}${headerCell("Notes")}</tr>`;
      const sortControl = open.length ? "" : sortSelect(sort);
      body += `<section class="block block-closed">
        <div class="section-head" data-enter><h2>Closed picks <span class="count">${closed.length}</span></h2>${sortControl}</div>
        <div class="table-wrap"><table class="grid grid-closed"><caption class="sr-only">Closed picks</caption><thead>${headRow}</thead>${closed.map((pick) => renderClosedRow(pick, pricesDoc, today, openKeys)).join("")}</table></div>
        <div class="cards">${closed.map((pick) => renderClosedCard(pick, pricesDoc, today, openKeys)).join("")}</div>
      </section>`;
    }
  }

  return `${head}<main>${body}</main>${FOOTER}</div>`;
}

// ---------------------------------------------------------------------------
// Motion. Plain Web Animations + requestAnimationFrame, no library. Everything
// renders final values first, so if animation is unavailable or reduced motion
// is on, the page is simply static.

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const FORMATTERS = {
  pct: (v) => formatPct(v),
  price: (v) => formatPrice(v),
  int: (v) => String(Math.round(v)),
  win: (v) => formatWin(v / 100),
};

const seen = { ready: false, values: new Map(), meters: new Map(), picks: new Set() };

function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canAnimate() {
  return !reducedMotion() && typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

function shown(el) {
  return el.getClientRects().length > 0;
}

function readValue(el) {
  return el.dataset.fmt === "text" ? el.textContent : num(el.dataset.num);
}

function snapshot(root) {
  const values = new Map();
  for (const el of root.querySelectorAll("[data-anim]")) values.set(el.dataset.anim, readValue(el));
  const meters = new Map();
  for (const el of root.querySelectorAll("[data-meter]")) meters.set(el.dataset.meter, num(el.dataset.to) ?? 0);
  const picks = new Set([...root.querySelectorAll("[data-pick]")].map((el) => el.dataset.pick));
  return { values, meters, picks };
}

function addTransient(el, cls) {
  el.classList.add(cls);
  const done = (event) => {
    if (event.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
}

function countUp(el, from, to, duration, delay = 0) {
  const fmt = FORMATTERS[el.dataset.fmt];
  if (!fmt || from == null || to == null || from === to) return;
  const final = el.textContent;
  const start = performance.now() + delay;
  el.textContent = fmt(from);
  const step = (t) => {
    if (!el.isConnected) return;
    const p = Math.max(0, Math.min(1, (t - start) / duration));
    if (p >= 1) {
      el.textContent = final;
      return;
    }
    el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - p, 4)));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function meterFrame(el, value) {
  if (el.dataset.kind === "ring") return { strokeDashoffset: ringOffset(value) };
  return { width: `${Math.max(0, Math.min(100, value))}%` };
}

function animateMeter(el, from, to, delay = 0) {
  if (from === to) return;
  el.animate([meterFrame(el, from), meterFrame(el, to)], {
    duration: 1100,
    delay,
    easing: EASE,
    fill: "backwards",
  });
}

function enterTargets(el) {
  return el.tagName === "TBODY" ? [...el.rows] : [el];
}

// First paint with data: staggered entrances, counters from zero, bars from empty.
function intro(root) {
  const items = [...root.querySelectorAll("[data-enter]")].filter(shown);
  const delays = new Map();
  items.forEach((el, i) => {
    const delay = Math.min(i, 14) * 45;
    delays.set(el, delay);
    el.animate(
      [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
      { duration: 700, delay, easing: EASE, fill: "backwards" },
    );
  });
  const delayOf = (el) => (delays.get(el.closest("[data-enter]")) ?? 0) + 120;
  for (const el of root.querySelectorAll("[data-anim][data-count]")) {
    if (shown(el)) countUp(el, 0, readValue(el), 1200, delayOf(el));
  }
  for (const el of root.querySelectorAll("[data-meter]")) {
    if (shown(el)) animateMeter(el, 0, num(el.dataset.to) ?? 0, delayOf(el) + 80);
  }
}

// Later renders: only what changed moves. Up flashes green, down flashes red,
// brand-new picks slide in.
function animateChanges(root, prev, motion) {
  const ticks = new Map();
  for (const el of root.querySelectorAll("[data-anim]")) {
    if (!shown(el)) continue;
    const key = el.dataset.anim;
    const next = readValue(el);
    const holder = el.closest("[data-pick]");
    if (holder && !prev.picks.has(holder.dataset.pick)) continue;
    if (!prev.values.has(key)) {
      addTransient(el, "flash-new");
      continue;
    }
    const before = prev.values.get(key);
    if (before === next) continue;
    if (el.dataset.fmt === "text" || before == null || next == null) {
      addTransient(el, "flash-new");
      continue;
    }
    const dir = next > before ? "up" : "down";
    addTransient(el, `flash-${dir}`);
    if (motion) countUp(el, before, next, 900);
    const box = holder || el.closest(".stat");
    if (box && (!ticks.has(box) || key.endsWith(":price"))) ticks.set(box, dir);
  }
  for (const [box, dir] of ticks) addTransient(box, `tick-${dir}`);

  const fresh = [...root.querySelectorAll("[data-pick]")].filter((el) => shown(el) && !prev.picks.has(el.dataset.pick));
  fresh.forEach((el, i) => {
    addTransient(el, "is-new");
    if (!motion) return;
    for (const target of enterTargets(el)) {
      target.animate(
        [{ opacity: 0, transform: "translateX(-20px) scale(0.985)" }, { opacity: 1, transform: "none" }],
        { duration: 750, delay: i * 80, easing: EASE, fill: "backwards" },
      );
    }
    for (const n of el.querySelectorAll("[data-anim][data-count]")) countUp(n, 0, readValue(n), 1100, i * 80 + 150);
  });

  if (!motion) return;
  for (const el of root.querySelectorAll("[data-meter]")) {
    if (!shown(el)) continue;
    const to = num(el.dataset.to) ?? 0;
    const holder = el.closest("[data-pick]");
    const isNew = holder && !prev.picks.has(holder.dataset.pick);
    const from = isNew || !prev.meters.has(el.dataset.meter) ? 0 : prev.meters.get(el.dataset.meter);
    animateMeter(el, from, to, isNew ? 200 : 0);
  }
}

function captureRects(root) {
  const rects = new Map();
  for (const el of root.querySelectorAll("[data-flip]")) {
    if (shown(el)) rects.set(el.dataset.flip, el.getBoundingClientRect().top);
  }
  return rects;
}

// Sort changes glide rows to their new slots instead of jumping.
function flip(root, rects) {
  const moves = [];
  for (const el of root.querySelectorAll("[data-flip]")) {
    if (!rects.has(el.dataset.flip) || !shown(el)) continue;
    const dy = rects.get(el.dataset.flip) - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) moves.push([el, dy]);
  }
  for (const [el, dy] of moves) {
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 560, easing: EASE });
  }
}

function afterRender(root, kind, rects) {
  if (!state.loaded) return;
  const motion = canAnimate();
  const prev = seen;
  if (!seen.ready) {
    if (motion) intro(root);
  } else if (kind === "sort") {
    if (motion && rects) flip(root, rects);
  } else {
    animateChanges(root, prev, motion);
  }
  const next = snapshot(root);
  seen.ready = true;
  seen.values = next.values;
  seen.meters = next.meters;
  seen.picks = next.picks;
}

// ---------------------------------------------------------------------------
// DOM wiring.

const SORT_STORE = "stock-tracker:sort";
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

function captureFocus() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (el.id) return () => document.getElementById(el.id);
  if (el.dataset?.sort) {
    const index = [...document.querySelectorAll("[data-sort]")].indexOf(el);
    return () => document.querySelectorAll("[data-sort]")[index];
  }
  if (el.tagName === "SUMMARY") {
    const all = [...document.querySelectorAll("details.why > summary")];
    const index = all.indexOf(el);
    return () => document.querySelectorAll("details.why > summary")[index];
  }
  return null;
}

function fullRender(kind = "data") {
  const root = document.getElementById("app");
  if (!root) return;
  const y = window.scrollY;
  const refocus = captureFocus();
  const rects = kind === "sort" && seen.ready && canAnimate() ? captureRects(root) : null;
  root.innerHTML = renderDashboard({
    picks: state.picks,
    pricesDoc: state.pricesDoc,
    sort: state.sort,
    checkedAt: state.checkedAt,
    error: state.error,
    loading: state.loading,
    loaded: state.loaded,
    openKeys: state.openKeys,
    now: new Date(),
  });
  window.scrollTo(0, y);
  const target = refocus?.();
  if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
  afterRender(root, kind, rects);
  syncPollLine();
}

function patchStatus() {
  const now = new Date();
  const checked = document.getElementById("checked-at");
  if (checked) {
    checked.textContent = formatPT(state.checkedAt);
    if (!reducedMotion()) addTransient(checked, "flash-tick");
  }
  const note = document.getElementById("status-note");
  if (note) {
    note.textContent = statusMessage({ ...state, now });
    note.className = state.error ? "status-note bad" : "status-note";
  }
  const mode = dotMode({ ...state, now });
  const dot = document.getElementById("live-dot");
  if (dot) dot.className = `live-dot ${mode}`;
  const live = document.getElementById("live");
  if (live) live.className = `live ${mode}`;
  const label = document.getElementById("live-label");
  if (label) label.textContent = LIVE_LABEL[mode];
}

// Thin bar under the header that fills until the next poll.
function syncPollLine() {
  const line = document.getElementById("poll-line");
  if (!line) return;
  const interval = pollInterval(location);
  line.style.animation = "none";
  void line.offsetWidth;
  line.style.animation = "";
  line.style.animationDuration = `${interval}ms`;
  line.style.animationDelay = `${-Math.min(interval, Date.now() - lastPollAt)}ms`;
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
    const { picksText, pricesText } = await loadDataFiles(timedFetch, location, Date.now());
    const picksDoc = JSON.parse(picksText);
    const pricesDoc = JSON.parse(pricesText);
    state.checkedAt = new Date().toISOString();
    const recovered = state.error != null;
    state.error = null;
    state.loading = false;
    const changed = picksText !== state.picksText || pricesText !== state.pricesText;
    state.picksText = picksText;
    state.pricesText = pricesText;
    state.loaded = true;
    // Same bytes as last time: refresh the clock only, keep sort and open rows.
    if (!changed) {
      scheduleNext();
      patchStatus();
      return;
    }
    state.picks = Array.isArray(picksDoc?.picks) ? picksDoc.picks.filter((pick) => pick && typeof pick === "object") : [];
    state.pricesDoc = {
      updated: pricesDoc?.updated ?? null,
      prices: pricesDoc?.prices && typeof pricesDoc.prices === "object" ? pricesDoc.prices : {},
    };
    scheduleNext();
    fullRender(recovered ? "recover" : "data");
  } catch {
    state.checkedAt = new Date().toISOString();
    state.loading = false;
    state.error = "Couldn't refresh data. Will try again shortly.";
    scheduleNext();
    if (!state.loaded) fullRender();
    else patchStatus();
    syncPollLine();
  } finally {
    polling = false;
  }
}

function onChange(event) {
  const target = event.target;
  if (!target || target.id !== "sort") return;
  if (!SORT_VALUES.has(target.value)) return;
  state.sort = target.value;
  saveSort(state.sort);
  fullRender("sort");
}

function onClick(event) {
  const button = event.target.closest?.("[data-sort]");
  if (!button) return;
  state.sort = nextSort(state.sort, button.dataset.sort);
  saveSort(state.sort);
  fullRender("sort");
}

// Keep the card and table copies of a "Why I picked it" in step, and remember
// which are open so a re-render restores them.
function onToggle(event) {
  const el = event.target;
  if (!el || el.tagName !== "DETAILS" || !el.classList.contains("why")) return;
  const key = el.getAttribute("data-key");
  if (!key) return;
  const wasOpen = state.openKeys.has(key);
  if (el.open) state.openKeys.add(key);
  else state.openKeys.delete(key);
  for (const twin of document.querySelectorAll("details.why")) {
    if (twin !== el && twin.getAttribute("data-key") === key && twin.open !== el.open) twin.open = el.open;
  }
  if (el.open && !wasOpen && canAnimate()) {
    const items = el.querySelectorAll(".reasons > li");
    items.forEach((item, i) => {
      item.animate(
        [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
        { duration: 420, delay: i * 50, easing: EASE, fill: "backwards" },
      );
    });
  }
}

// Soft spotlight that follows the pointer on cards (hover devices only).
function onPointerMove(event) {
  const card = event.target.closest?.(".card, .stat");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  card.style.setProperty("--my", `${event.clientY - rect.top}px`);
}

function boot() {
  const root = document.getElementById("app");
  if (!root) return;
  state.sort = loadSort();
  document.addEventListener("change", onChange);
  document.addEventListener("click", onClick);
  document.addEventListener("toggle", onToggle, true);
  if (typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches) {
    document.addEventListener("pointermove", onPointerMove, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  fullRender();
  poll();
}

if (typeof document !== "undefined") boot();
