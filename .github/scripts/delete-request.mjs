#!/usr/bin/env node
// Validates a delete-pick request for .github/workflows/delete-pick.yml.
// Every piece of event text arrives through environment variables, never
// through the workflow expression syntax, so titles cannot inject shell.
//
// Env in:
//   EVENT_NAME     "issues" or "workflow_dispatch"
//   ISSUE_TITLE    issue title (issues only)
//   ISSUE_AUTHOR   issue author login (issues only)
//   ISSUE_NUMBER   issue number (issues only)
//   INPUT_ID       pick id (workflow_dispatch only)
//   ACTOR          github.actor (workflow_dispatch only)
//   PICKS_PATH     defaults to data/picks.json
//   ALLOWLIST_PATH defaults to .github/delete-allowlist.txt
//   OUT_DIR        where message files go (defaults to RUNNER_TEMP or /tmp)
// Out (appended to GITHUB_OUTPUT when set, else printed):
//   action=remove|reject|ignore, id, ticker, message_file, commit_file

import fs from "node:fs";
import path from "node:path";

export const TITLE_PREFIX = "delete-pick:";
// Same shape scripts/pick.mjs makes: YYYY-MM-DD-TICKER, optional -N suffix.
// Tickers follow parseTicker there: [A-Z][A-Z0-9.-]{0,14}.
export const ID_RE = /^\d{4}-\d{2}-\d{2}-[A-Z][A-Z0-9.-]{0,14}(?:-\d{1,3})?$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseAllowlist(text) {
  const logins = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (line && LOGIN_RE.test(line)) logins.add(line.toLowerCase());
  }
  return logins;
}

export function idFromTitle(title) {
  const text = String(title || "").trim();
  if (!text.toLowerCase().startsWith(TITLE_PREFIX)) return null;
  return text.slice(TITLE_PREFIX.length).trim();
}

export function decide(env, picksDoc, allowlistText) {
  const event = env.EVENT_NAME;
  let id;
  let requester;
  let via;
  if (event === "issues") {
    id = idFromTitle(env.ISSUE_TITLE);
    if (id == null) return { action: "ignore", message: "Not a delete-pick issue." };
    requester = String(env.ISSUE_AUTHOR || "");
    via = `#${String(env.ISSUE_NUMBER || "").replace(/\D/g, "")}`;
    const allowed = parseAllowlist(allowlistText);
    if (!allowed.has(requester.toLowerCase())) {
      return {
        action: "reject",
        message: `Sorry @${requester}, your account is not on the delete allowlist ` +
          "(`.github/delete-allowlist.txt`), so nothing was removed. " +
          "Ask the repo owner to add your GitHub username there.",
      };
    }
  } else if (event === "workflow_dispatch") {
    id = String(env.INPUT_ID || "").trim();
    requester = String(env.ACTOR || "");
    via = "workflow_dispatch";
  } else {
    return { action: "ignore", message: `Unsupported event ${event}.` };
  }

  if (!ID_RE.test(id)) {
    return {
      action: "reject",
      message: "That does not look like a lead id, so nothing was removed. " +
        "The title must be `delete-pick: YYYY-MM-DD-TICKER` (use the Delete button on the site).",
    };
  }
  const picks = Array.isArray(picksDoc?.picks) ? picksDoc.picks : [];
  const pick = picks.find((item) => item && item.id === id);
  if (!pick) {
    return {
      action: "reject",
      message: `No lead with id \`${id}\` is in data/picks.json (it may already be gone). Nothing changed.`,
    };
  }
  const ticker = String(pick.ticker || "").toUpperCase();
  const safeTicker = /^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker) ? ticker : id;
  const who = LOGIN_RE.test(requester) ? `@${requester}` : "a collaborator";
  return {
    action: "remove",
    id,
    ticker: safeTicker,
    commit: `Remove pick ${safeTicker} (requested by ${who} via ${via})`,
    message: `Removed **${safeTicker}** (\`${id}\`) from data/picks.json. ` +
      "It will disappear from the site for everyone within about 5 minutes (GitHub's raw file cache).",
  };
}

function main() {
  const env = process.env;
  const picksPath = env.PICKS_PATH || "data/picks.json";
  const allowPath = env.ALLOWLIST_PATH || ".github/delete-allowlist.txt";
  const outDir = env.OUT_DIR || env.RUNNER_TEMP || "/tmp";
  let doc = { picks: [] };
  try {
    doc = JSON.parse(fs.readFileSync(picksPath, "utf8"));
  } catch (err) {
    console.error(`Could not read ${picksPath}: ${err.message}`);
    process.exit(1);
  }
  let allow = "";
  try {
    allow = fs.readFileSync(allowPath, "utf8");
  } catch {
    allow = "";
  }
  const result = decide(env, doc, allow);
  const messageFile = path.join(outDir, "delete-pick-message.md");
  const commitFile = path.join(outDir, "delete-pick-commit.txt");
  fs.writeFileSync(messageFile, result.message + "\n");
  if (result.commit) fs.writeFileSync(commitFile, result.commit + "\n");
  const lines = [
    `action=${result.action}`,
    `id=${result.id || ""}`,
    `ticker=${result.ticker || ""}`,
    `message_file=${messageFile}`,
    `commit_file=${result.commit ? commitFile : ""}`,
  ];
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  else console.log(lines.join("\n"));
  console.log(`${result.action}: ${result.message}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
