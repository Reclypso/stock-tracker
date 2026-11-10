# One-click delete Worker (optional, off by default)

Out of the box the site deletes a lead through a GitHub issue (see "Deleting
leads" in the main README). This Worker is an upgrade: the Delete dialog asks
for a shared passcode and the lead is removed without visiting GitHub.

It holds two secrets in Cloudflare, never in this repo or in the page:

- `DELETE_PASSCODE`: a passphrase you share with your friend.
- `GITHUB_TOKEN`: a fine-grained personal access token that can only start the
  `delete-pick` workflow on this one repo.

## Setup

1. **Token.** GitHub → Settings → Developer settings → Fine-grained tokens →
   Generate new token.
   - Repository access: *Only select repositories* → `Reclypso/stock-tracker`.
   - Repository permissions: **Actions: Read and write** (needed for
     `workflow_dispatch`) and **Contents: Read and write**. Nothing else.
   - Pick an expiry and copy the token.
2. **Worker.** With Node 18+ installed:
   ```bash
   cd worker
   npx wrangler login
   npx wrangler secret put DELETE_PASSCODE   # paste the passphrase
   npx wrangler secret put GITHUB_TOKEN      # paste the token
   npx wrangler deploy
   ```
   Wrangler prints a URL like `https://stock-tracker-delete.<you>.workers.dev`.
3. **Page.** In `app.js`, set
   `export const DELETE_ENDPOINT = "https://stock-tracker-delete.<you>.workers.dev";`
   and push. The Delete dialog now shows a passcode field and posts to the Worker.

## What it does

`POST {"id": "2026-11-09-IONQ", "passcode": "..."}` →

- Rejects origins other than `https://reclypso.github.io` and `http://localhost:*`.
- Checks the id format (`YYYY-MM-DD-TICKER`, optional `-N`).
- Compares the passcode in constant time.
- Calls `POST /repos/Reclypso/stock-tracker/actions/workflows/delete-pick.yml/dispatches`
  with `{"ref": "main", "inputs": {"id": ...}}`. The workflow does the actual
  removal, commit and push, exactly like the issue path.

Responses: `202 {ok:true}` on success, `400` bad id, `401` wrong passcode,
`403` bad origin, `502` GitHub refused.

To switch back, set `DELETE_ENDPOINT = ""` and delete the Worker. Rotate the
passcode any time with `wrangler secret put DELETE_PASSCODE`.
