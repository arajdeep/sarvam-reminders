// Server-side proxy so users never need their own Sarvam key.
// The key lives in the Vercel env var SARVAM_API_KEY and never reaches the browser.
const ALLOWED = { "speech-to-text": "multipart", "text-to-speech": "json", "v1/chat/completions": "json" };
const LIMIT = 40;                  // requests per IP per window (best effort: per server instance)
const WINDOW_MS = 10 * 60 * 1000;
const MAX_BYTES = 2_000_000;       // ~1 minute of speech
const hits = new Map();

const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const fail = (message, status) => json({ error: { message } }, status);

// Only allow the exact models and sizes the app uses, so the key can't be used for anything else.
function checkJson(path, body) {
  if (path === "v1/chat/completions") {
    if (body.model !== "sarvam-105b") return "model not allowed";
    if (!Array.isArray(body.messages) || body.messages.length > 4) return "bad messages";
    body.max_tokens = Math.min(Number(body.max_tokens) || 1500, 12000);
    body.stream = false;
  } else if (path === "text-to-speech") {
    if (body.model !== "bulbul:v3") return "model not allowed";
    if (typeof body.text !== "string" || body.text.length > 1500) return "text too long";
  }
  return null;
}

export async function POST(request, { fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  const key = env.SARVAM_API_KEY;
  if (!key) return fail("Server key not configured", 501);

  const path = new URL(request.url).searchParams.get("path") || "";
  if (!ALLOWED[path]) return fail("Not allowed", 400);

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const recent = (hits.get(ip) || []).filter(ts => now - ts < WINDOW_MS);
  if (recent.length >= LIMIT) return fail("Too many requests. Please try again in a few minutes.", 429);
  recent.push(now);
  hits.set(ip, recent);

  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BYTES) return fail("Request too large", 413);

  let body = raw;
  const headers = { "api-subscription-key": key };
  const contentType = request.headers.get("content-type");
  if (ALLOWED[path] === "json") {
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { return fail("Bad JSON", 400); }
    const problem = checkJson(path, parsed);
    if (problem) return fail(problem, 400);
    body = JSON.stringify(parsed);
    headers["content-type"] = "application/json";
  } else if (contentType) {
    headers["content-type"] = contentType; // keep the multipart boundary
  }

  const upstream = await fetchImpl(`https://api.sarvam.ai/${path}`, { method: "POST", headers, body });
  return new Response(upstream.body, { status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" } });
}

export function _resetForTests() { hits.clear(); }
