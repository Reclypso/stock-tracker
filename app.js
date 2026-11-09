// Stock Bot Pick Tracker.
// Polls picks and prices every 60s. On *.github.io, fetch raw.githubusercontent.com
// first so the GitHub Pages CDN cannot serve a stale copy. Sort lives in memory
// and survives those refreshes.

export const OWNER = "Reclypso";
export const REPO = "stock-tracker";
export const BRANCH = "main";
export const POLL_MS = 60 * 1000;
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

function gradeBadge(grade) {
  const cls = GRADE_CLASS[grade] || "g-u";
  return `<span class="badge ${cls}">${escapeHtml(grade || "—")}</span>`;
}

function hitChips(pick, current) {
  if (current == null) return "";
  const chips = [];
  if (targetBullOf(pick) != null && current >= targetBullOf(pick)) {
    chips.push('<span class="chip bull">Bull hit</span>');
  }
  if (targetBaseOf(pick) != null && current >= targetBaseOf(pick)) {
    chips.push('<span class="chip hit">Base hit</span>');
  }
  const stop = stopOf(pick);
  if (stop != null && current <= stop) chips.push('<span class="chip warn">Stop hit</span>');
  return chips.join("");
}

function renderReasons(pick, openKeys) {
  const reasons = Array.isArray(pick.reasons) ? pick.reasons : [];
  if (!reasons.length) return "";
  const open = openKeys.has(String(pick.id)) ? " open" : "";
  const items = reasons.map((reason) => {
    const sources = Array.isArray(reason?.sources) ? reason.sources : [];
    const links = sources.map((source) => {
      const href = safeHttpUrl(source?.url);
      if (!href) return "";
      const title = escapeHtml(source?.title || href);
      return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a></li>`;
    }).filter(Boolean).join("");
    const list = links ? `<ul class="sources">${links}</ul>` : "";
    return `<li><p>${escapeHtml(reason?.text ?? "")}</p>${list}</li>`;
  }).join("");
  return `<details class="why" data-key="${escapeHtml(pick.id)}"${open}><summary>Why I picked it (${reasons.length})</summary><ul class="reasons">${items}</ul></details>`;
}

function renderProgress(current, entry, target) {
  const progress = progressToBase(current, entry, target);
  if (progress == null) return "";
  const below = num(current) < num(entry);
  const width = Math.max(0, Math.min(100, below ? Math.abs(progress) : progress));
  const rounded = Math.round(progress);
  const label = below ? `${rounded}% vs call` : (rounded >= 100 ? `${rounded}% · base hit` : `${rounded}% to base`);
  return `<div class="progress${below ? " neg" : ""}"><div class="track" role="img" aria-label="${escapeHtml(label)}"><span style="width:${width.toFixed(1)}%"></span></div><span class="progress-label">${escapeHtml(label)}</span></div>`;
}

function levelRow(label, level, current) {
  if (num(level) == null) {
    return `<div class="level"><span class="k">${label}</span><span>—</span></div>`;
  }
  const dist = distancePhrase(level, current);
  const extra = dist ? ` · ${escapeHtml(dist)}` : "";
  return `<div class="level"><span class="k">${label}</span><span>${escapeHtml(formatPrice(level))}${extra}</span></div>`;
}

function returnBits(pick, pricesDoc) {
  const ret = returnPct(pick, pricesDoc);
  if (ret == null) {
    const text = pick.status === "closed" ? "—" : "awaiting price";
    return { text, cls: "flat" };
  }
  return { text: formatPct(ret), cls: `${pctClass(ret)} bold` };
}

function sortSelect(current) {
  const options = SORTS.map(([value, label]) => {
    const selected = value === current ? " selected" : "";
    return `<option value="${value}"${selected}>${label}</option>`;
  }).join("");
  return `<label class="sort" for="sort">Sort<select id="sort">${options}</select></label>`;
}

function headerCell(label, key, sort) {
  if (!key) return `<th scope="col">${label}</th>`;
  const active = (key === "called" && (sort === "newest" || sort === "oldest"))
    || (key === "return" && (sort === "best" || sort === "worst"))
    || (key === "ticker" && sort === "ticker")
    || (key === "grade" && sort === "grade");
  let arrow = "";
  if (active) {
    arrow = sort === "newest" || sort === "best" ? " ↓" : " ↑";
  }
  return `<th scope="col"><button type="button" data-sort="${key}" class="${active ? "active" : ""}">${label}${arrow}</button></th>`;
}

function projectedLine(pick) {
  const base = projectedPct(pick.priceAtCall, targetBaseOf(pick));
  const bull = projectedPct(pick.priceAtCall, targetBullOf(pick));
  if (base == null && bull == null) return "";
  const baseText = base == null ? "—" : `<strong class="${pctClass(base)}">${formatPct(base)}</strong>`;
  const bullText = bull == null ? "—" : `<strong class="${pctClass(bull)}">${formatPct(bull)}</strong>`;
  const frame = pick.timeframe ? `<span class="timeframe">${escapeHtml(pick.timeframe)}</span>` : "";
  return `<p class="proj">Projected base ${baseText} · bull ${bullText}${frame}</p>`;
}

function renderOpenCard(pick, pricesDoc, today, openKeys) {
  const current = markPrice(pick, pricesDoc);
  const quote = quoteFor(pick, pricesDoc);
  const tone = toneOf(pick, current);
  const ret = returnBits(pick, pricesDoc);
  const day = quote ? num(quote.changePct) : null;
  const dayHtml = day == null ? "—" : `<span class="${pctClass(day)}">${formatPct(day)}</span>`;
  const nowText = current == null ? "awaiting price" : formatPrice(current);
  const company = pick.company ? `<p class="company">${escapeHtml(pick.company)}</p>` : "";
  const catalyst = pick.catalyst ? `<p class="blurb"><span class="k">Catalyst</span> ${escapeHtml(pick.catalyst)}</p>` : "";
  const notes = pick.notes ? `<p class="blurb"><span class="k">Notes</span> ${escapeHtml(pick.notes)}</p>` : "";
  return `<article class="card ${tone}">
    <header class="card-top">
      <div>
        <div class="ticker-line"><h3>${escapeHtml(pick.ticker)}</h3>${gradeBadge(pick.grade)}</div>
        ${company}
      </div>
      <p class="held">${escapeHtml(formatDays(daysHeld(pick, today)))}</p>
    </header>
    <div class="return-line"><p class="big ${ret.cls}">${escapeHtml(ret.text)}</p><div class="chips">${hitChips(pick, current)}</div></div>
    <dl class="prices">
      <div><dt>Called</dt><dd>${escapeHtml(formatPrice(pick.priceAtCall))} <span class="subdate">${escapeHtml(formatDay(pick.dateCalled))}</span></dd></div>
      <div><dt>Now</dt><dd>${escapeHtml(nowText)}</dd></div>
      <div><dt>Day</dt><dd>${dayHtml}</dd></div>
    </dl>
    ${projectedLine(pick)}
    ${renderProgress(current, pick.priceAtCall, targetBaseOf(pick))}
    <div class="levels">
      ${levelRow("Stop", stopOf(pick), current)}
      ${levelRow("Base", targetBaseOf(pick), current)}
      ${levelRow("Bull", targetBullOf(pick), current)}
    </div>
    <p class="blurb"><span class="k">Thesis</span> ${escapeHtml(pick.thesis || "—")}</p>
    ${catalyst}
    ${notes}
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
  const nowText = current == null ? "awaiting price" : formatPrice(current);
  return `<tr class="data ${tone}">
    <td><div class="ticker">${escapeHtml(pick.ticker)}</div>${company}</td>
    <td>${gradeBadge(pick.grade)}</td>
    <td class="num">${escapeHtml(formatPrice(pick.priceAtCall))}<div class="subdate">${escapeHtml(formatDay(pick.dateCalled))}</div></td>
    <td class="num">${escapeHtml(nowText)}</td>
    <td class="num ${day == null ? "flat" : pctClass(day)}">${day == null ? "—" : formatPct(day)}</td>
    <td class="num ${ret.cls}">${escapeHtml(ret.text)}</td>
    <td class="num">Base ${basePct == null ? "—" : formatPct(basePct)}<div>Bull ${bullPct == null ? "—" : formatPct(bullPct)}</div></td>
    <td>${escapeHtml(formatDays(daysHeld(pick, today)))}</td>
    <td>${stopOf(pick) == null ? "—" : `${escapeHtml(formatPrice(stopOf(pick)))}${stopDist ? `<div class="subdate">${escapeHtml(stopDist)}</div>` : ""}`}</td>
    <td>${targetBaseOf(pick) == null ? "—" : `${escapeHtml(formatPrice(targetBaseOf(pick)))}${baseDist ? `<div class="subdate">${escapeHtml(baseDist)}</div>` : ""}`}</td>
    <td>${escapeHtml(pick.timeframe || "—")}</td>
  </tr>
  <tr class="context ${tone}">
    <td colspan="${OPEN_COLS}">
      <div class="context-body">
        ${hitChips(pick, current)}
        ${renderProgress(current, pick.priceAtCall, targetBaseOf(pick))}
        <p class="blurb"><span class="k">Thesis</span> ${escapeHtml(pick.thesis || "—")}</p>
        <p class="blurb"><span class="k">Catalyst</span> ${escapeHtml(pick.catalyst || "—")}</p>
        ${pick.notes ? `<p class="blurb"><span class="k">Notes</span> ${escapeHtml(pick.notes)}</p>` : ""}
        ${renderReasons(pick, openKeys)}
      </div>
    </td>
  </tr>`;
}

function renderClosedCard(pick, pricesDoc, today, openKeys) {
  const ret = returnBits(pick, pricesDoc);
  const company = pick.company ? `<p class="company">${escapeHtml(pick.company)}</p>` : "";
  return `<article class="card closed">
    <header class="card-top">
      <div>
        <div class="ticker-line"><h3>${escapeHtml(pick.ticker)}</h3>${gradeBadge(pick.grade)}</div>
        ${company}
      </div>
      <p class="big ${ret.cls}">${escapeHtml(ret.text)}</p>
    </header>
    <dl class="prices prices-2">
      <div><dt>Called</dt><dd>${escapeHtml(formatDay(pick.dateCalled))} · ${escapeHtml(formatPrice(pick.priceAtCall))}</dd></div>
      <div><dt>Exit</dt><dd>${escapeHtml(formatDay(pick.exitDate))} · ${escapeHtml(formatPrice(pick.exitPrice))}</dd></div>
      <div><dt>Held</dt><dd>${escapeHtml(formatDays(daysHeld(pick, today)))}</dd></div>
    </dl>
    ${projectedLine(pick)}
    <p class="blurb"><span class="k">Notes</span> ${escapeHtml(pick.notes || "—")}</p>
    ${renderReasons(pick, openKeys)}
  </article>`;
}

function renderClosedRow(pick, pricesDoc, today, openKeys) {
  const ret = returnBits(pick, pricesDoc);
  const company = pick.company ? `<div class="company">${escapeHtml(pick.company)}</div>` : "";
  return `<tr class="data">
    <td><div class="ticker">${escapeHtml(pick.ticker)}</div>${company}</td>
    <td>${gradeBadge(pick.grade)}</td>
    <td class="num">${escapeHtml(formatDay(pick.dateCalled))}<div class="subdate">${escapeHtml(formatPrice(pick.priceAtCall))}</div></td>
    <td class="num">${escapeHtml(formatDay(pick.exitDate))}<div class="subdate">${escapeHtml(formatPrice(pick.exitPrice))}</div></td>
    <td class="num ${ret.cls}">${escapeHtml(ret.text)}</td>
    <td>${escapeHtml(formatDays(daysHeld(pick, today)))}</td>
    <td>${escapeHtml(pick.notes || "—")}</td>
  </tr>
  <tr class="context">
    <td colspan="${CLOSED_COLS}">
      <div class="context-body">
        ${projectedLine(pick)}
        <p class="blurb"><span class="k">Thesis</span> ${escapeHtml(pick.thesis || "—")}</p>
        ${renderReasons(pick, openKeys)}
      </div>
    </td>
  </tr>`;
}

function summaryCard(label, value, sub, valueClass) {
  return `<article class="stat"><p class="label">${label}</p><p class="value ${valueClass || ""}">${value}</p>${sub ? `<p class="sub">${sub}</p>` : ""}</article>`;
}

const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#182232"/><path d="M7 21.5 13 15l4 3.5 8-10" fill="none" stroke="#3ee0a2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 8.5h5.5V14" fill="none" stroke="#3ee0a2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
  const bestValue = summary.best ? escapeHtml(summary.best.ticker) : "—";
  const bestSub = summary.best ? `<p class="sub ${pctClass(summary.best.ret)}">${formatPct(summary.best.ret)}</p>` : `<p class="sub">—</p>`;
  const avgClass = pctClass(summary.avgReturn);
  const projClass = pctClass(summary.avgProjected);

  const header = `<header class="top">
    <div class="brand">${LOGO}<div><h1>Stock Bot Pick Tracker</h1><p class="tag">Refreshes every minute. No reload needed.</p></div></div>
    <div class="meta">
      <span class="live"><span id="live-dot" class="live-dot ${dot}"></span> Live</span>
      <span>Prices updated: <strong id="prices-at">${escapeHtml(formatPT(pricesDoc.updated))}</strong></span>
      <span>Checked: <strong id="checked-at">${escapeHtml(formatPT(model.checkedAt))}</strong></span>
    </div>
    <p id="status-note" class="status-note${model.error ? " bad" : ""}">${escapeHtml(note)}</p>
  </header>`;

  const cards = `<section class="summary" aria-label="Summary">
    ${summaryCard("Open picks", String(summary.openCount), "active")}
    ${summaryCard("Win rate", formatWin(summary.winRate), summary.winLabel ? escapeHtml(summary.winLabel) : "")}
    ${summaryCard("Average return", summary.avgReturn == null ? "—" : formatPct(summary.avgReturn), "all priced picks", avgClass)}
    <article class="stat"><p class="label">Best pick</p><p class="value">${bestValue}</p>${bestSub}</article>
    ${summaryCard("Avg projected", summary.avgProjected == null ? "—" : formatPct(summary.avgProjected), "base", projClass)}
  </section>`;

  if (!model.loaded && model.loading) {
    return `${header}${cards}<p class="loading">Loading picks…</p><footer class="footer">Not financial advice. Ideas can go to zero.</footer>`;
  }
  if (!model.loaded && model.error) {
    return `${header}${cards}<section class="empty"><p>Picks could not be loaded.</p></section><footer class="footer">Not financial advice. Ideas can go to zero.</footer>`;
  }

  const ordered = sortPicks(picks, pricesDoc, sort);
  const open = ordered.filter((pick) => pick.status === "open");
  const closed = ordered.filter((pick) => pick.status === "closed");
  let body = "";
  if (!picks.length) {
    body = `<section class="empty"><div class="empty-mark" aria-hidden="true"></div><p>No picks yet. Stock Bot's first calls will appear here.</p></section>`;
  } else {
    if (open.length) {
      const head = `<tr>${headerCell("Ticker", "ticker", sort)}${headerCell("Grade", "grade", sort)}${headerCell("Called", "called", sort)}${headerCell("Current")}${headerCell("Day")}${headerCell("Return", "return", sort)}${headerCell("Projected")}${headerCell("Days")}${headerCell("Stop")}${headerCell("Target")}${headerCell("Timeframe")}</tr>`;
      body += `<section class="block">
        <div class="section-head"><h2>Open picks <span class="count">${open.length}</span></h2>${sortSelect(sort)}</div>
        <div class="table-wrap"><table class="grid"><caption class="sr-only">Open picks</caption><thead>${head}</thead><tbody>${open.map((pick) => renderOpenRow(pick, pricesDoc, today, openKeys)).join("")}</tbody></table></div>
        <div class="cards">${open.map((pick) => renderOpenCard(pick, pricesDoc, today, openKeys)).join("")}</div>
      </section>`;
    }
    if (closed.length) {
      const head = `<tr>${headerCell("Ticker", "ticker", sort)}${headerCell("Grade", "grade", sort)}${headerCell("Called", "called", sort)}${headerCell("Exit")}${headerCell("Return", "return", sort)}${headerCell("Days")}${headerCell("Notes")}</tr>`;
      const sortControl = open.length ? "" : sortSelect(sort);
      body += `<section class="block">
        <div class="section-head"><h2>Closed picks <span class="count">${closed.length}</span></h2>${sortControl}</div>
        <div class="table-wrap"><table class="grid"><caption class="sr-only">Closed picks</caption><thead>${head}</thead><tbody>${closed.map((pick) => renderClosedRow(pick, pricesDoc, today, openKeys)).join("")}</tbody></table></div>
        <div class="cards">${closed.map((pick) => renderClosedCard(pick, pricesDoc, today, openKeys)).join("")}</div>
      </section>`;
    }
  }

  return `${header}${cards}<main>${body}</main><footer class="footer">Not financial advice. Ideas can go to zero.</footer>`;
}

function captureOpen() {
  return new Set(
    [...document.querySelectorAll("details.why[open]")]
      .map((el) => el.getAttribute("data-key"))
      .filter(Boolean),
  );
}

function fullRender() {
  const openKeys = captureOpen();
  const y = window.scrollY;
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = renderDashboard({
    picks: state.picks,
    pricesDoc: state.pricesDoc,
    sort: state.sort,
    checkedAt: state.checkedAt,
    error: state.error,
    loading: state.loading,
    loaded: state.loaded,
    openKeys,
    now: new Date(),
  });
  window.scrollTo(0, y);
}

function patchStatus() {
  const checked = document.getElementById("checked-at");
  if (checked) checked.textContent = formatPT(state.checkedAt);
  const note = document.getElementById("status-note");
  if (note) {
    note.textContent = statusMessage({ ...state, now: new Date() });
    note.className = state.error ? "status-note bad" : "status-note";
  }
  const dot = document.getElementById("live-dot");
  if (dot) dot.className = `live-dot ${dotMode({ ...state, now: new Date() })}`;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const { picksText, pricesText } = await loadDataFiles(fetch, location, Date.now());
    const picksDoc = JSON.parse(picksText);
    const pricesDoc = JSON.parse(pricesText);
    state.checkedAt = new Date().toISOString();
    state.error = null;
    state.loading = false;
    const changed = picksText !== state.picksText || pricesText !== state.pricesText;
    state.picksText = picksText;
    state.pricesText = pricesText;
    state.loaded = true;
    // Same bytes as last time: refresh the clock only, keep sort and open rows.
    if (!changed) {
      patchStatus();
      return;
    }
    state.picks = Array.isArray(picksDoc?.picks) ? picksDoc.picks.filter((pick) => pick && typeof pick === "object") : [];
    state.pricesDoc = {
      updated: pricesDoc?.updated ?? null,
      prices: pricesDoc?.prices && typeof pricesDoc.prices === "object" ? pricesDoc.prices : {},
    };
    fullRender();
  } catch {
    state.checkedAt = new Date().toISOString();
    state.loading = false;
    state.error = "Couldn't refresh data. Will try again shortly.";
    if (!state.loaded) fullRender();
    else patchStatus();
  } finally {
    polling = false;
  }
}

function onChange(event) {
  const target = event.target;
  if (!target || target.id !== "sort") return;
  if (!SORT_VALUES.has(target.value)) return;
  state.sort = target.value;
  fullRender();
}

function onClick(event) {
  const button = event.target.closest?.("[data-sort]");
  if (!button) return;
  state.sort = nextSort(state.sort, button.dataset.sort);
  fullRender();
}

function boot() {
  const root = document.getElementById("app");
  if (!root) return;
  document.addEventListener("change", onChange);
  document.addEventListener("click", onClick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  fullRender();
  poll();
  setInterval(poll, POLL_MS);
}

if (typeof document !== "undefined") boot();
