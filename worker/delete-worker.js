// Optional one-click delete for the Stock Bot leads page (disabled until
// DELETE_ENDPOINT in app.js is set). Accepts POST {id, passcode}, checks the
// passcode against the DELETE_PASSCODE secret, and asks GitHub to run the
// delete-pick workflow with a fine-grained token stored as GITHUB_TOKEN.
// No secret ever reaches the browser.

const OWNER = "Reclypso";
const REPO = "stock-tracker";
const WORKFLOW = "delete-pick.yml";
const BRANCH = "main";
// Same shape scripts/pick.mjs makes: YYYY-MM-DD-TICKER, optional -N suffix.
const ID_RE = /^\d{4}-\d{2}-\d{2}-[A-Z][A-Z0-9.-]{0,14}(?:-\d{1,3})?$/;

function allowedOrigin(origin) {
  if (origin === "https://reclypso.github.io") return origin;
  if (/^http:\/\/localhost(?::\d{1,5})?$/.test(origin || "")) return origin;
  if (/^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/.test(origin || "")) return origin;
  return null;
}

function cors(origin) {
  const allowed = allowedOrigin(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// Constant-time compare over SHA-256 digests (equal length regardless of input).
async function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return allowedOrigin(origin) ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    }
    if (request.method !== "POST") return json(405, { ok: false, error: "POST only" }, origin);
    if (!allowedOrigin(origin)) return json(403, { ok: false, error: "Origin not allowed" }, origin);

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: "Body must be JSON" }, origin);
    }
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!ID_RE.test(id)) return json(400, { ok: false, error: "Invalid id" }, origin);
    if (!(await sameSecret(body?.passcode, env.DELETE_PASSCODE))) {
      return json(401, { ok: false, error: "Wrong passcode" }, origin);
    }
    if (!env.GITHUB_TOKEN) return json(500, { ok: false, error: "Worker is missing GITHUB_TOKEN" }, origin);

    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stock-tracker-delete-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: BRANCH, inputs: { id } }),
    });
    if (res.status !== 204) {
      return json(502, { ok: false, error: `GitHub answered ${res.status}` }, origin);
    }
    return json(202, { ok: true, id }, origin);
  },
};
