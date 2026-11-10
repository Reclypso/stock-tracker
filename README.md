# Stock Bot Pick Tracker

A static page two people can open on their phones and see the same stock calls. There is no server and no build step. GitHub Pages hosts the files. The page polls for new picks and prices on its own, so nobody has to reload.

**Live:** https://reclypso.github.io/stock-tracker/

This is not a brokerage feed. Quotes are delayed Yahoo prices via `yfinance`, refreshed by a GitHub Action about every 15 minutes during the US cash session.

## How it stays up to date

- On load, and every 60 seconds after that, the page reads `data/picks.json` and `data/prices.json`.
- On `*.github.io` it fetches `https://raw.githubusercontent.com/Reclypso/stock-tracker/main/data/<file>?t=<timestamp>` with `cache: "no-store"`, so the GitHub Pages CDN does not freeze an old copy. If that request fails, it falls back to `./data/<file>`.
- On localhost it uses `./data/<file>?t=<timestamp>`. Add `?demo=1` on localhost to load `./demo/` instead.
- `OWNER`, `REPO`, and `BRANCH` at the top of `app.js` control the raw URL (`Reclypso`, `stock-tracker`, `main`).
- The header shows **Prices updated** (the timestamp inside `prices.json`, in America/Los_Angeles, labeled PT) and **Checked** (the last poll). A green dot means the page is polling. If prices are older than one day, a stale note appears.
- Sort choice stays put across those refreshes. The list re-renders only when the JSON actually changed.

`.github/workflows/prices.yml` (name **Update prices**) runs `scripts/fetch_prices.py` when:

- you start it by hand (`workflow_dispatch`)
- the schedule fires: `*/15 13-21 * * 1-5` (every 15 minutes, Monday–Friday, 13:00–21:45 UTC, covering both EST and EDT cash hours)
- `data/picks.json` changes on `main` (a new open pick gets a price without waiting for the clock)

The script reads open tickers only, asks Yahoo for the last price, previous close, and day change, and writes `data/prices.json`. One ticker failing keeps that ticker's previous entry. Closed or removed tickers are dropped. `updated` changes only when a stored price changes, so a quiet run does not commit. With no open picks the file stays:

```json
{
  "prices": {},
  "updated": null
}
```

When something did change, the action commits as `github-actions[bot]` with the message `Update prices [skip ci]` and pushes to `main` (`git pull --rebase` first, one retry).

## Pick fields

Each item in `picks[]`:

| Field | Meaning |
| --- | --- |
| `id` | `YYYY-MM-DD-TICKER`, plus `-2`, `-3`, … if that id already exists |
| `ticker` | Uppercase symbol |
| `company` | Display name. May be empty |
| `dateCalled` | Calendar day in America/Los_Angeles (`YYYY-MM-DD`) |
| `calledAt` | ISO timestamp of when the pick was added |
| `priceAtCall` | Price when the idea was called |
| `thesis` | One or two lines |
| `catalyst` | What you are waiting on |
| `grade` | `A`, `B`, `C`, or `Lottery` |
| `stop` | Stop price, or `null` |
| `target` | Alias of `targetBase`. The page uses `target` when `targetBase` is missing |
| `targetBase` | Base target price, or `null` |
| `targetBull` | Bull target price, or `null` |
| `timeframe` | Text such as `"3-6 months"`, or `null` |
| `baseTimeframe` | Optional. Time period for the base case. Falls back to `timeframe` |
| `bullTimeframe` | Optional. Time period for the bull case. Falls back to `timeframe` |
| `bullCase` | Optional. The condition behind the bull target, shown as "if …" (e.g. `"the FDA approves X"`) |
| `horizon` | Optional. `"swing"` (default, 3-12 months) or `"fast"` (about a day to a few weeks). Without it, a thesis starting with `Fast mover:` counts as fast |
| `status` | `open` or `closed` |
| `exitDate` | `YYYY-MM-DD`, or `null` |
| `exitPrice` | Exit price, or `null` |
| `notes` | Free text |
| `reasons` | `{ "text": "...", "sources": [{ "title": "...", "url": "https://..." }] }`. Sources may be empty |

Projected percent is `(target - priceAtCall) / priceAtCall * 100`, shown for the base and bull targets. The progress bar is 0% at the call price and 100% at the base target. Below the call price it draws in red. Chips mark **Base hit**, **Bull hit**, and **Stop hit**.

Each lead card leads with its projection: **Base +55% in 3-6 months** and **Bull +140% in 6-12 months if …**. Open picks without a price say **awaiting price**. Closed picks move to the **Archive** and use `exitPrice`. The page is a feed of leads, not a scorecard: it shows the move since each call for context but no win rate or average return. Fast movers get a **Fast mover** badge, and the **All · Swing · Fast movers** filter (remembered per browser) narrows the active list.

## CLI

Requires Node 18 or newer and git. Run it from any directory. The script finds the repo from its own path.

Publishing (the default) runs `git pull --rebase --autostash` before it edits, then commits only `data/picks.json` and pushes. The push rebases once and retries once if the price bot landed a commit in between.

`--no-push` writes the local file and does not pull, commit, or push. Use it for a dry run.

Grade defaults to `B`. `--date` defaults to today in America/Los_Angeles. `--target` is an alias for `--target-base`. The file stores both `target` and `targetBase` as the same number. Numbers have to be greater than zero. Source URLs have to be `http` or `https`.

`--reason` can be repeated. Each `--source` attaches to the most recent `--reason`. A `--source` before any `--reason` is an error. On `update`, new reasons are appended. `--clear-reasons` wipes them first.

### Add

```bash
node scripts/pick.mjs add --ticker IONQ --company "IonQ" --price 45.10 --grade B --thesis "..." --catalyst "..." --stop 40 --target-base 70 --target-bull 110 --timeframe "3-6 months" --reason "Revenue +336% y/y" --source "Q3 release|https://example.com" --reason "Sector momentum"
```

Replace the `...` thesis and catalyst with the real one- or two-line note. Commit message looks like `Add pick IONQ @ 45.10`.

Shorter form (grade becomes B, targets stay empty):

```bash
node scripts/pick.mjs add --ticker TEST --price 10 --thesis "First pass" --no-push
```

`--target 15` does the same thing as `--target-base 15`.

### Update

```bash
node scripts/pick.mjs update --id 2026-11-09-IONQ --stop 38 --notes "Tightened stop" --target-base 75 --target-bull 120 --timeframe "6-12 months"
```

Append a reason:

```bash
node scripts/pick.mjs update --id 2026-11-09-IONQ --reason "New partnership" --source "Press release|https://example.com/pr"
```

Replace every reason:

```bash
node scripts/pick.mjs update --id 2026-11-09-IONQ --clear-reasons --reason "Fresh thesis" --source "Note|https://example.com/note"
```

Projection details and horizon (all optional; `""` clears the three text fields on `update`):

```bash
node scripts/pick.mjs update --id 2026-11-09-IONQ --base-timeframe "3-6 months" --bull-timeframe "6-12 months" --bull-case "the DOD contract is signed" --horizon fast
```

Any add field can be passed to `update` (`--ticker`, `--price`, `--company`, `--thesis`, `--catalyst`, `--grade`, `--stop`, `--target`, `--target-base`, `--target-bull`, `--timeframe`, `--notes`, `--date`). `--price` changes the call price, not the exit.

### Add a reason

```bash
node scripts/pick.mjs add-reason --id 2026-11-09-IONQ --reason "Customer logo" --source "Blog|https://example.com/blog" --source "Transcript|https://example.com/transcript"
```

### Close

```bash
node scripts/pick.mjs close --id 2026-11-09-IONQ --price 72.50 --notes "Base target cleared"
```

`--date` defaults to today in America/Los_Angeles. This sets `status` to `closed`, plus `exitPrice` and `exitDate`.

### Remove

Deletes a pick, including a test row:

```bash
node scripts/pick.mjs remove --id 2026-11-09-TEST
```

### List

```bash
node scripts/pick.mjs list
```

## Trigger a price run by hand

```bash
gh workflow run prices.yml
```

You can also use the Actions tab and run **Update prices**.

To run the same script on your machine:

```bash
python3 -m pip install -r scripts/requirements.txt
python3 scripts/fetch_prices.py
```

## Local preview

From this directory:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/

Fake rows for screenshots (not published; `demo/` is gitignored):

http://localhost:8000/?demo=1

`?demo=1` loads `./demo/*.json` only when the host is localhost. The sample tickers are `DEMO1` through `DEMO10`, covering every card state (up, down, near stop, stop hit, base hit, bull hit, awaiting price, fast movers, archived).

Enable GitHub Pages on the `main` branch, root (`/`), for the live URL above. Push an initial commit yourself before using the CLI without `--no-push`. The price workflow needs that branch on the remote.

## Deleting leads

Either of you can delete a lead for everyone. The delete commits a change to `data/picks.json`; nothing is only hidden locally, and no token lives in the page or the repo.

1. Press the trash icon on a card, then **Continue on GitHub** in the dialog.
2. GitHub opens a pre-filled issue titled `delete-pick: <id>`. Press **Submit new issue**.
3. `.github/workflows/delete-pick.yml` checks that the issue author is listed in `.github/delete-allowlist.txt` and that the id exists, runs `node scripts/pick.mjs remove --id <id> --no-push`, commits `Remove pick TICKER (requested by @login via #N)`, rebases onto `main` and pushes (one retry, never a force push). It then comments and closes the issue. Anyone not on the allowlist gets a comment and nothing changes.
4. The card shows **Deletion requested…** for up to 15 minutes and animates out once the lead is gone from `data/picks.json` (usually within about 5 minutes because of GitHub's raw cache).

Add your friend's GitHub username to `.github/delete-allowlist.txt` (one login per line) and commit it to `main`. A collaborator can also run the **Delete pick** workflow by hand with the id.

Optional one-click delete: `worker/` holds a small Cloudflare Worker that takes a shared passcode and starts the same workflow. It is off until you deploy it and set `DELETE_ENDPOINT` in `app.js`. Setup steps are in `worker/README.md`.

## Design

A live signal feed, built in plain HTML/CSS/JS with no build step. The background is a hand-written WebGL shader (`bg.js`: aurora curtains, a perspective neon grid and a parallax starfield) that pauses when the tab is hidden, caps resolution on phones, and falls back to a CSS gradient. GSAP 3.12.5 and ScrollTrigger are vendored in `vendor/` and drive the intro (HUD frame draw-in, wordmark decode, staggered 3D card entrance) and scroll reveals; without them the page still renders everything. Polls patch the DOM in place (`fx.js` keyed morph), so open "why" sections, sort, filter, focus and scroll survive, and only changes animate: price digits roll and flash, meters glide, new leads slide in, removed ones dissolve. Cards tilt with a cursor spotlight on desktop and ripple on tap. `prefers-reduced-motion` turns motion off. Fonts are Space Grotesk, Inter and JetBrains Mono from Google Fonts with system fallbacks. For local testing, `?demo=1&fast=1` on localhost polls every 5s instead of 60s.

## Disclaimer

Not financial advice. Leads can go to zero.
