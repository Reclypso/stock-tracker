#!/usr/bin/env node
/**
 * Edit data/picks.json from anywhere.
 * Repo root is the parent of this script, not the shell's cwd.
 *
 *   node scripts/pick.mjs add --ticker IONQ --price 45.10 --thesis "..." \
 *     --grade B --type swing --stop 40 --entry-trigger 45.50 [flags]
 *   node scripts/pick.mjs update --id ID [flags]
 *   node scripts/pick.mjs add-reason --id ID --reason "..." [--source "Title|https://url"]
 *   node scripts/pick.mjs close --id ID --price N [--date YYYY-MM-DD] [--notes "..."]
 *   node scripts/pick.mjs remove --id ID
 *   node scripts/pick.mjs list
 *
 * `add` runs the entry gate (../gates/vet.py, which also applies the regime
 * caps) and writes nothing if it rejects. --dry-run builds and vets the pick
 * but never writes data/picks.json or touches git.
 *
 * Without --no-push: git pull --rebase --autostash, then commit and push.
 * With --no-push: write the JSON file only (no pull, commit, or push).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PICKS_PATH = path.join(ROOT, "data", "picks.json");

// Entry gate. Lives outside this repo on the bot's box; override with STOCKBOT_VET.
const VET_PATH = process.env.STOCKBOT_VET || path.resolve(ROOT, "..", "gates", "vet.py");
const PYTHON = process.env.PYTHON || "python3";
const TYPES = ["swing", "fast", "lottery", "long", "macro"];

const COMMANDS = new Set(["add", "update", "close", "remove", "list", "add-reason"]);
const BOOLEAN_FLAGS = new Set(["no-push", "clear-reasons", "help", "skip-vet", "dry-run", "pead"]);
const VALUE_FLAGS = new Set([
  "type",
  "entry-trigger",
  "override",
  "sector",
  "event-date",
  "partial",
  "ticker",
  "price",
  "company",
  "thesis",
  "catalyst",
  "grade",
  "stop",
  "target",
  "target-base",
  "target-bull",
  "timeframe",
  "base-timeframe",
  "bull-timeframe",
  "bull-case",
  "horizon",
  "notes",
  "date",
  "id",
  "reason",
  "source",
]);

// Optional projection text. Flag name -> pick field. Empty string clears it on update.
const PROJECTION_FIELDS = {
  "base-timeframe": "baseTimeframe",
  "bull-timeframe": "bullTimeframe",
  "bull-case": "bullCase",
};
const PROJECTION_FLAGS = Object.keys(PROJECTION_FIELDS);

const ALLOWED = {
  add: new Set([
    "ticker", "price", "company", "thesis", "catalyst", "grade", "stop",
    "target", "target-base", "target-bull", "timeframe", "notes", "date", "no-push",
    ...PROJECTION_FLAGS, "horizon",
    "type", "entry-trigger", "override", "sector", "event-date", "pead", "skip-vet", "dry-run",
  ]),
  update: new Set([
    "id", "ticker", "price", "company", "thesis", "catalyst", "grade", "stop",
    "target", "target-base", "target-bull", "timeframe", "notes", "date",
    "no-push", "clear-reasons", ...PROJECTION_FLAGS, "horizon",
    "type", "entry-trigger", "sector", "event-date", "partial", "dry-run",
  ]),
  close: new Set(["id", "price", "date", "notes", "no-push"]),
  remove: new Set(["id", "no-push"]),
  list: new Set(["no-push"]),
  "add-reason": new Set(["id", "no-push"]),
};

const REASON_COMMANDS = new Set(["add", "update", "add-reason"]);

const USAGE = `Stock Bot pick CLI

  node scripts/pick.mjs add --ticker IONQ --company "IonQ" --price 45.10 \\
    --grade B --type swing --entry-trigger 45.50 --stop 40 \\
    --thesis "..." --catalyst "..." \\
    --target-base 70 --target-bull 110 --timeframe "3-6 months" \\
    [--sector "Technology"] [--event-date YYYY-MM-DD] [--pead] \\
    [--override "why a human accepts a failed setup check"] \\
    [--dry-run] [--skip-vet] \\
    [--base-timeframe "3-6 months"] [--bull-timeframe "6-12 months"] \\
    [--bull-case "the DOD contract is signed"] [--horizon swing|fast] \\
    --reason "Revenue +336% y/y" --source "Q3 release|https://example.com" \\
    --reason "Sector momentum"

  node scripts/pick.mjs update --id ID [--ticker T] [--price N] [--company "..."] \\
    [--thesis "..."] [--catalyst "..."] [--grade A|B|C|Lottery] [--stop N] \\
    [--type swing|fast|lottery|long|macro] [--entry-trigger N] [--sector "..."] \\
    [--event-date YYYY-MM-DD] [--partial "FRACTION@PRICE[@YYYY-MM-DD]"] \\
    [--target-base N] [--target-bull N] [--timeframe "..."] [--notes "..."] \\
    [--base-timeframe "..."] [--bull-timeframe "..."] [--bull-case "..."] \\
    [--horizon swing|fast] [--dry-run] \\
    [--date YYYY-MM-DD] [--reason "..." [--source "Title|https://url"] ...] \\
    [--clear-reasons]

  node scripts/pick.mjs add-reason --id ID --reason "..." [--source "Title|https://url"] ...

  node scripts/pick.mjs close --id ID --price N [--date YYYY-MM-DD] [--notes "..."]
  node scripts/pick.mjs remove --id ID
  node scripts/pick.mjs list

--target is an alias for --target-base. Repeat --reason to add several.
Each --source attaches to the most recent --reason. Dates default to today
in America/Los_Angeles.
add requires --ticker, --price, --thesis, --grade (A|B|C|Lottery), --type
(swing|fast|lottery|long|macro), --stop and --entry-trigger (the planned buy
price; R and the ATR stop band are measured from it). There is no default grade.
add runs the entry gate ${VET_PATH}
(trend template / PEAD exception, chase, stop vs ATR, regime + exposure caps).
A rejection writes nothing and exits 2. --override "why" lets a human accept
failed setup checks (stored on the pick); caps and bad inputs can't be overridden.
--skip-vet bypasses the gate with a loud warning (recorded on the pick).
--dry-run builds and vets the pick and prints it: no file write, no git.
New picks get side "long", initialStop = --stop, and a vet summary.
--event-date is the binary's decision date (lottery exit rules use it).
--partial records a trim (e.g. "0.33@15.20") so the exit engine trails the rest.
--base-timeframe and --bull-timeframe override --timeframe for that case.
--bull-case is the condition behind the bull target ("if ..."). On update,
an empty value ("") clears any of these three.
--horizon is "swing" (3-12 months) or "fast" (about a day to a few weeks); on
add it defaults from --type (fast and lottery = fast, others = swing).
--no-push writes data/picks.json only (no pull, commit, or push).
`;

function todayPT(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parsePositive(flag, raw) {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${flag} must be a positive number`);
  }
  return n;
}

function parseGrade(raw) {
  const map = { a: "A", b: "B", c: "C", lottery: "Lottery" };
  const grade = map[String(raw).trim().toLowerCase()];
  if (!grade) throw new Error("--grade must be A, B, C, or Lottery");
  return grade;
}

function parseDate(raw, flag = "date") {
  const s = String(raw).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) throw new Error(`--${flag} must be YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error(`--${flag} must be a real calendar date`);
  }
  return s;
}

function parseHorizon(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value !== "fast" && value !== "swing") {
    throw new Error(`Invalid --horizon "${raw}" (use fast or swing)`);
  }
  return value;
}

function parseType(raw) {
  const value = String(raw).trim().toLowerCase();
  if (!TYPES.includes(value)) {
    throw new Error(`Invalid --type "${raw}" (use ${TYPES.join(", ")})`);
  }
  return value;
}

function parseFraction(raw) {
  const text = String(raw).trim();
  const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  const n = ratio ? Number(ratio[1]) / Number(ratio[2]) : Number(text);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error("--partial fraction must be in (0, 1], e.g. 0.33 or 1/3");
  return Math.round(n * 1000) / 1000;
}

function parsePartial(raw) {
  const parts = String(raw).split("@").map((s) => s.trim());
  if (parts.length < 2 || parts.length > 3) {
    throw new Error('--partial must look like "FRACTION@PRICE" or "FRACTION@PRICE@YYYY-MM-DD"');
  }
  return {
    date: parts[2] ? parseDate(parts[2], "partial date") : todayPT(),
    fraction: parseFraction(parts[0]),
    price: parsePositive("partial price", parts[1]),
  };
}

function parseSector(raw) {
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("--sector cannot be empty");
  return text;
}

function parseTicker(raw) {
  const ticker = String(raw).trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,14}$/.test(ticker)) {
    throw new Error("--ticker must be 1–15 letters, digits, dots, or dashes");
  }
  return ticker;
}

function parseHttpUrl(raw) {
  const text = String(raw).trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL must be http or https: ${raw}`);
  }
  if (!url.hostname) throw new Error(`URL is missing a host: ${raw}`);
  return url.href;
}

function parseSource(raw) {
  const text = String(raw).trim();
  const split = text.indexOf("|");
  if (split <= 0 || split === text.length - 1) {
    throw new Error('Each --source must look like "Title|https://url"');
  }
  const title = text.slice(0, split).trim();
  const href = text.slice(split + 1).trim();
  if (!title) throw new Error("Source title is empty");
  return { title, url: parseHttpUrl(href) };
}

function parseArgs(argv) {
  const flags = {};
  const reasons = [];
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") continue;
    const key = arg.slice(2);
    if (!key || arg.startsWith("---")) throw new Error(`Unknown flag ${arg}`);
    if (!BOOLEAN_FLAGS.has(key) && !VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown flag --${key}`);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Flag --${key} needs a value`);
    }
    i += 1;
    if (key === "reason") {
      if (!String(value).trim()) throw new Error("--reason cannot be empty");
      reasons.push({ text: String(value).trim(), sources: [] });
      continue;
    }
    if (key === "source") {
      if (reasons.length === 0) {
        throw new Error(
          "--source was given before any --reason. Put --reason first, then its --source flags.",
        );
      }
      reasons[reasons.length - 1].sources.push(parseSource(value));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      throw new Error(`Duplicate flag --${key}`);
    }
    flags[key] = value;
  }

  if (positionals.length > 1) {
    throw new Error(`Unexpected argument "${positionals[1]}"`);
  }
  return { command: positionals[0] || "", flags, reasons };
}

function rejectUnknown(command, flags) {
  const allowed = ALLOWED[command];
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for ${command}`);
  }
}

function requireId(flags) {
  if (flags.id === undefined || !String(flags.id).trim()) throw new Error("Missing --id");
  return String(flags.id).trim();
}

function resolveTargets(flags) {
  const hasAlias = flags.target !== undefined;
  const hasBase = flags["target-base"] !== undefined;
  const hasBull = flags["target-bull"] !== undefined;
  const alias = hasAlias ? parsePositive("target", flags.target) : undefined;
  const base = hasBase ? parsePositive("target-base", flags["target-base"]) : undefined;
  const bull = hasBull ? parsePositive("target-bull", flags["target-bull"]) : undefined;
  if (hasAlias && hasBase && alias !== base) {
    throw new Error("--target and --target-base disagree; --target is an alias for --target-base");
  }
  return {
    hasBase: hasAlias || hasBase,
    targetBase: hasBase ? base : alias,
    hasBull,
    targetBull: bull,
  };
}

function readDoc() {
  if (!fs.existsSync(PICKS_PATH)) throw new Error(`Missing ${PICKS_PATH}`);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(PICKS_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${PICKS_PATH}: ${err.message}`);
  }
  if (!doc || !Array.isArray(doc.picks)) {
    throw new Error('data/picks.json must look like {"picks": []}');
  }
  return doc;
}

function writeDoc(doc) {
  fs.mkdirSync(path.dirname(PICKS_PATH), { recursive: true });
  fs.writeFileSync(PICKS_PATH, JSON.stringify(doc, null, 2) + "\n");
}

function findIndex(doc, id) {
  const idx = doc.picks.findIndex((pick) => pick && pick.id === id);
  if (idx === -1) throw new Error(`No pick with id ${id}`);
  return idx;
}

function makeId(date, ticker, picks) {
  const base = `${date}-${ticker}`;
  const ids = new Set(picks.map((pick) => pick && pick.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function money(n) {
  return Number(n).toFixed(2);
}

function blankPick(fields) {
  const targetBase = fields.targetBase ?? null;
  if (!fields.grade) throw new Error("A pick needs an explicit grade (no default)");
  return {
    id: fields.id,
    ticker: fields.ticker,
    company: fields.company ?? "",
    dateCalled: fields.dateCalled,
    calledAt: fields.calledAt,
    priceAtCall: fields.priceAtCall,
    entryTrigger: fields.entryTrigger ?? null,
    side: "long",
    type: fields.type,
    thesis: fields.thesis,
    catalyst: fields.catalyst ?? "",
    grade: fields.grade,
    stop: fields.stop ?? null,
    initialStop: fields.stop ?? null,
    target: targetBase,
    targetBase,
    targetBull: fields.targetBull ?? null,
    timeframe: fields.timeframe ?? null,
    status: "open",
    exitDate: null,
    exitPrice: null,
    notes: fields.notes ?? "",
    reasons: fields.reasons ?? [],
  };
}

function applyProjection(pick, flags) {
  for (const [flag, field] of Object.entries(PROJECTION_FIELDS)) {
    if (flags[flag] === undefined) continue;
    const text = String(flags[flag]).trim();
    if (text) pick[field] = text;
    else delete pick[field];
  }
  return pick;
}

const ADD_REQUIRED = ["ticker", "price", "thesis", "grade", "type", "stop", "entry-trigger"];

function buildAdd(flags, reasons) {
  const missing = ADD_REQUIRED.filter((name) => {
    return flags[name] === undefined || !String(flags[name]).trim();
  });
  if (missing.length) {
    throw new Error(
      "Missing " + missing.map((name) => `--${name}`).join(", ") +
      " (add needs --grade A|B|C|Lottery, --type " + TYPES.join("|") +
      ", --stop and --entry-trigger; nothing defaults)",
    );
  }
  if (flags["skip-vet"] && flags.override !== undefined) {
    throw new Error("--override only applies when the vet runs; drop --skip-vet");
  }
  if (flags.override !== undefined && !String(flags.override).trim()) {
    throw new Error("--override needs a reason");
  }
  const targets = resolveTargets(flags);
  const dateCalled = flags.date !== undefined ? parseDate(flags.date) : todayPT();
  const type = parseType(flags.type);
  const pick = blankPick({
    id: "",
    ticker: parseTicker(flags.ticker),
    company: flags.company !== undefined ? flags.company : "",
    dateCalled,
    calledAt: new Date().toISOString(),
    priceAtCall: parsePositive("price", flags.price),
    entryTrigger: parsePositive("entry-trigger", flags["entry-trigger"]),
    type,
    thesis: String(flags.thesis).trim(),
    catalyst: flags.catalyst !== undefined ? String(flags.catalyst).trim() : "",
    grade: parseGrade(flags.grade),
    stop: parsePositive("stop", flags.stop),
    targetBase: targets.hasBase ? targets.targetBase : null,
    targetBull: targets.hasBull ? targets.targetBull : null,
    timeframe: flags.timeframe !== undefined && String(flags.timeframe).trim()
      ? String(flags.timeframe).trim()
      : null,
    notes: flags.notes !== undefined ? flags.notes : "",
    reasons,
  });
  applyProjection(pick, flags);
  pick.horizon = flags.horizon !== undefined
    ? parseHorizon(flags.horizon)
    : (type === "fast" || type === "lottery" ? "fast" : "swing");
  if (flags.sector !== undefined) pick.sector = parseSector(flags.sector);
  if (flags["event-date"] !== undefined) pick.eventDate = parseDate(flags["event-date"], "event-date");
  if (pick.stop >= pick.entryTrigger) {
    throw new Error(`--stop ${pick.stop} must be below --entry-trigger ${pick.entryTrigger} for a long`);
  }
  return pick;
}

function syncTargetAlias(pick) {
  if (pick.targetBase != null) pick.target = pick.targetBase;
  else if (pick.target != null && pick.targetBase == null) pick.targetBase = pick.target;
}

function applyUpdate(pick, flags, reasons) {
  if (flags.ticker !== undefined) pick.ticker = parseTicker(flags.ticker);
  if (flags.company !== undefined) pick.company = flags.company;
  if (flags.price !== undefined) pick.priceAtCall = parsePositive("price", flags.price);
  if (flags.thesis !== undefined) {
    if (!String(flags.thesis).trim()) throw new Error("--thesis cannot be empty");
    pick.thesis = String(flags.thesis).trim();
  }
  if (flags.catalyst !== undefined) pick.catalyst = String(flags.catalyst).trim();
  if (flags.grade !== undefined) pick.grade = parseGrade(flags.grade);
  if (flags.stop !== undefined) {
    const next = parsePositive("stop", flags.stop);
    // Keep the original risk (R) when a stop is trailed up on an older pick.
    if (pick.initialStop == null && Number(pick.stop) > 0) pick.initialStop = Number(pick.stop);
    pick.stop = next;
  }
  if (flags.type !== undefined) pick.type = parseType(flags.type);
  if (flags["entry-trigger"] !== undefined) pick.entryTrigger = parsePositive("entry-trigger", flags["entry-trigger"]);
  if (flags.sector !== undefined) {
    const sector = String(flags.sector).trim();
    if (sector) pick.sector = parseSector(sector);
    else delete pick.sector;
  }
  if (flags["event-date"] !== undefined) {
    const raw = String(flags["event-date"]).trim();
    if (raw) pick.eventDate = parseDate(raw, "event-date");
    else delete pick.eventDate;
  }
  if (flags.partial !== undefined) {
    if (!Array.isArray(pick.partials)) pick.partials = [];
    pick.partials.push(parsePartial(flags.partial));
  }
  const targets = resolveTargets(flags);
  if (targets.hasBase) {
    pick.targetBase = targets.targetBase;
    pick.target = targets.targetBase;
  }
  if (targets.hasBull) pick.targetBull = targets.targetBull;
  if (flags.timeframe !== undefined) {
    const timeframe = String(flags.timeframe).trim();
    pick.timeframe = timeframe || null;
  }
  applyProjection(pick, flags);
  if (flags.horizon !== undefined) pick.horizon = parseHorizon(flags.horizon);
  if (flags.notes !== undefined) pick.notes = flags.notes;
  if (flags.date !== undefined) pick.dateCalled = parseDate(flags.date);
  if (flags["clear-reasons"]) pick.reasons = [];
  if (!Array.isArray(pick.reasons)) pick.reasons = [];
  if (reasons.length) pick.reasons.push(...reasons);
  syncTargetAlias(pick);
  return pick;
}

function updateTouched(flags, reasons) {
  const keys = Object.keys(flags).filter((key) => !["id", "no-push", "dry-run"].includes(key));
  return keys.length > 0 || reasons.length > 0;
}

class GateError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseVetJson(stdout) {
  const text = String(stdout || "");
  const start = text.startsWith("{") ? 0 : text.lastIndexOf("\n{\n") + 1;
  if (start < 0 || !text.slice(start).trim()) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

// Run ../gates/vet.py (trend/PEAD, chase, ATR stop band, regime + caps).
// Its human report streams to stderr; its JSON verdict comes back on stdout.
function runVet(draft, flags, dryRun) {
  if (!fs.existsSync(VET_PATH)) {
    throw new GateError(
      `Entry gate not found at ${VET_PATH}; nothing written. ` +
      "Set STOCKBOT_VET, or use --skip-vet (prints a warning and is recorded on the pick).",
      1,
    );
  }
  const args = [
    VET_PATH,
    "--ticker", draft.ticker,
    "--price", String(draft.priceAtCall),
    "--stop", String(draft.stop),
    "--grade", draft.grade,
    "--type", draft.type,
    "--entry-trigger", String(draft.entryTrigger),
    "--picks", PICKS_PATH,
    "--json",
  ];
  if (draft.sector) args.push("--sector", draft.sector);
  if (flags.pead) args.push("--pead");
  if (flags.override !== undefined) args.push("--override", String(flags.override).trim());
  if (dryRun) args.push("--dry-run");
  const res = spawnSync(PYTHON, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 180000,
  });
  if (res.error) throw new GateError(`Could not run the entry gate: ${res.error.message}. Nothing written.`, 1);
  const verdict = parseVetJson(res.stdout);
  if (res.status === 0 && verdict && verdict.pass === true) return verdict;
  if (res.status === 2) {
    throw new GateError(`Entry gate REJECTED ${draft.ticker}; data/picks.json not written.`, 2);
  }
  throw new GateError(
    `Entry gate failed (exit ${res.status ?? res.signal}); data/picks.json not written.`,
    1,
  );
}

function vetSummary(verdict) {
  const stop = (verdict.checks && verdict.checks.stop) || {};
  const trend = (verdict.checks && verdict.checks.trend) || {};
  const summary = {
    decision: verdict.decision,
    checkedAt: verdict.checked_at,
    rules: verdict.rules_version,
    regime: verdict.regime_color,
    stage: trend.stage ?? null,
    peadException: Boolean(verdict.pead_exception),
    atr14: stop.atr14 ?? null,
    stopAtr: stop.distance_atr ?? null,
    size: verdict.size,
  };
  if (Array.isArray(verdict.overridden) && verdict.overridden.length) summary.overridden = verdict.overridden;
  if (Array.isArray(verdict.warnings) && verdict.warnings.length) summary.warnings = verdict.warnings.slice(0, 6);
  return summary;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function syncBeforeEdit(noPush) {
  if (noPush) return;
  git(["pull", "--rebase", "--autostash"]);
}

function publish(message, noPush) {
  if (noPush) return;
  git(["add", "--", "data/picks.json"]);
  const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", "data/picks.json"], {
    cwd: ROOT,
  });
  if (staged.status === 0) {
    console.log("No changes to commit.");
    return;
  }
  if (staged.status !== 1) throw new Error("git diff --cached failed");
  git(["commit", "-m", message, "--", "data/picks.json"]);
  git(["pull", "--rebase"]);
  const pushed = spawnSync("git", ["push"], { cwd: ROOT, stdio: "inherit" });
  if (pushed.status !== 0) {
    git(["pull", "--rebase"]);
    git(["push"]);
  }
}

function printPick(verb, pick) {
  console.log(`${verb} ${pick.id}`);
  console.log(JSON.stringify(pick, null, 2));
}

function listPicks(doc) {
  if (!doc.picks.length) {
    console.log("No picks.");
    return;
  }
  for (const pick of doc.picks) {
    const when = pick.status === "closed"
      ? `exit ${pick.exitPrice} on ${pick.exitDate}`
      : `called ${pick.priceAtCall}`;
    console.log(`${pick.id}  ${pick.ticker}  ${pick.status}  ${pick.grade}  ${when}`);
  }
}

function main() {
  const { command, flags, reasons } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  if (!command) {
    console.log(USAGE);
    throw new Error("Missing command");
  }
  if (!COMMANDS.has(command)) throw new Error(`Unknown command "${command}"`);
  rejectUnknown(command, flags);
  if (reasons.length && !REASON_COMMANDS.has(command)) {
    throw new Error(`--reason is not valid for ${command}`);
  }
  const noPush = Boolean(flags["no-push"]);

  if (command === "list") {
    syncBeforeEdit(noPush);
    listPicks(readDoc());
    return;
  }

  if (command === "add") {
    const dryRun = Boolean(flags["dry-run"]);
    const draft = buildAdd(flags, reasons);
    if (!dryRun) syncBeforeEdit(noPush);
    // Vet after the pull so exposure caps see the latest picks.json.
    if (flags["skip-vet"]) {
      console.error(
        `WARNING: --skip-vet: ${draft.ticker} was NOT checked by the entry gate ` +
        "(trend, chase, stop/ATR, regime and exposure caps). This is recorded on the pick.",
      );
      draft.vet = { skipped: true, at: new Date().toISOString() };
    } else {
      const verdict = runVet(draft, flags, dryRun);
      draft.vet = vetSummary(verdict);
      if (verdict.override) draft.override = verdict.override;
      if (!draft.sector && verdict.sector) draft.sector = verdict.sector;
    }
    const doc = readDoc();
    // Re-adding a ticker that lives in data/stopped.json is allowed — a new
    // solid setup can return to the feed. Ids are unique only among open/archived picks.
    draft.id = makeId(draft.dateCalled, draft.ticker, doc.picks);
    if (dryRun) {
      printPick("Dry run (NOT written)", draft);
      console.log("DRY RUN: data/picks.json not written; no git pull, commit, or push.");
      return;
    }
    doc.picks.push(draft);
    writeDoc(doc);
    printPick("Added", draft);
    publish(`Add pick ${draft.ticker} @ ${money(draft.priceAtCall)}`, noPush);
    return;
  }

  if (command === "update") {
    const id = requireId(flags);
    const dryRun = Boolean(flags["dry-run"]);
    if (!updateTouched(flags, reasons)) throw new Error("Nothing to update");
    // Validate flag values before touching git or the file.
    if (flags.ticker !== undefined) parseTicker(flags.ticker);
    if (flags.price !== undefined) parsePositive("price", flags.price);
    if (flags.grade !== undefined) parseGrade(flags.grade);
    if (flags.stop !== undefined) parsePositive("stop", flags.stop);
    if (flags.date !== undefined) parseDate(flags.date);
    if (flags.horizon !== undefined) parseHorizon(flags.horizon);
    if (flags.type !== undefined) parseType(flags.type);
    if (flags["entry-trigger"] !== undefined) parsePositive("entry-trigger", flags["entry-trigger"]);
    if (flags["event-date"] !== undefined && String(flags["event-date"]).trim()) {
      parseDate(flags["event-date"], "event-date");
    }
    if (flags.partial !== undefined) parsePartial(flags.partial);
    resolveTargets(flags);
    if (!dryRun) syncBeforeEdit(noPush);
    const doc = readDoc();
    const pick = doc.picks[findIndex(doc, id)];
    if (dryRun) {
      const preview = applyUpdate(JSON.parse(JSON.stringify(pick)), flags, reasons);
      printPick("Dry run (NOT written)", preview);
      console.log("DRY RUN: data/picks.json not written; no git pull, commit, or push.");
      return;
    }
    applyUpdate(pick, flags, reasons);
    writeDoc(doc);
    printPick("Updated", pick);
    publish(`Update pick ${pick.ticker}`, noPush);
    return;
  }

  if (command === "add-reason") {
    const id = requireId(flags);
    if (!reasons.length) throw new Error("add-reason needs at least one --reason");
    syncBeforeEdit(noPush);
    const doc = readDoc();
    const pick = doc.picks[findIndex(doc, id)];
    if (!Array.isArray(pick.reasons)) pick.reasons = [];
    pick.reasons.push(...reasons);
    writeDoc(doc);
    printPick("Updated", pick);
    publish(`Add reason to ${pick.ticker}`, noPush);
    return;
  }

  if (command === "close") {
    const id = requireId(flags);
    if (flags.price === undefined) throw new Error("Missing --price");
    const exitPrice = parsePositive("price", flags.price);
    const exitDate = flags.date !== undefined ? parseDate(flags.date) : null;
    syncBeforeEdit(noPush);
    const doc = readDoc();
    const pick = doc.picks[findIndex(doc, id)];
    pick.status = "closed";
    pick.exitPrice = exitPrice;
    pick.exitDate = exitDate || todayPT();
    if (flags.notes !== undefined) pick.notes = flags.notes;
    writeDoc(doc);
    printPick("Closed", pick);
    publish(`Close pick ${pick.ticker} @ ${money(exitPrice)}`, noPush);
    return;
  }

  if (command === "remove") {
    const id = requireId(flags);
    syncBeforeEdit(noPush);
    const doc = readDoc();
    const idx = findIndex(doc, id);
    const [removed] = doc.picks.splice(idx, 1);
    writeDoc(doc);
    printPick("Removed", removed);
    publish(`Remove pick ${removed.ticker}`, noPush);
  }
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(err instanceof GateError ? err.exitCode : 1);
}
