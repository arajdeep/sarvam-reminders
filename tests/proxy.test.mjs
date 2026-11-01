import test from "node:test";
import assert from "node:assert/strict";
import { POST, _resetForTests } from "../api/sarvam.mjs";

const env = { SARVAM_API_KEY: "test-key" };
const req = (path, body, ip = "1.1.1.1", type = "application/json") => new Request(
  `https://x.vercel.app/api/sarvam?path=${encodeURIComponent(path)}`,
  { method: "POST", headers: { "content-type": type, "x-forwarded-for": ip }, body });
const okFetch = calls => async (url, opts) => { calls.push({ url, opts }); return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }); };

test("no server key -> 501, nothing forwarded", async () => {
  _resetForTests(); const calls = [];
  const r = await POST(req("text-to-speech", "{}"), { env: {}, fetchImpl: okFetch(calls) });
  assert.equal(r.status, 501); assert.equal(calls.length, 0);
});

test("only the three app endpoints are allowed", async () => {
  _resetForTests(); const calls = [];
  const r = await POST(req("v1/something-else", "{}"), { env, fetchImpl: okFetch(calls) });
  assert.equal(r.status, 400); assert.equal(calls.length, 0);
});

test("chat: wrong model rejected; right model forwarded with server key, capped tokens", async () => {
  _resetForTests(); const calls = [];
  assert.equal((await POST(req("v1/chat/completions", JSON.stringify({ model: "other", messages: [] })), { env, fetchImpl: okFetch(calls) })).status, 400);
  const r = await POST(req("v1/chat/completions", JSON.stringify({ model: "sarvam-105b", messages: [{ role: "user", content: "hi" }], max_tokens: 999999 })), { env, fetchImpl: okFetch(calls) });
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, "https://api.sarvam.ai/v1/chat/completions");
  assert.equal(calls[0].opts.headers["api-subscription-key"], "test-key");
  assert.equal(JSON.parse(calls[0].opts.body).max_tokens, 12000);
});

test("tts: long text rejected", async () => {
  _resetForTests(); const calls = [];
  const r = await POST(req("text-to-speech", JSON.stringify({ model: "bulbul:v3", text: "x".repeat(2000) })), { env, fetchImpl: okFetch(calls) });
  assert.equal(r.status, 400); assert.equal(calls.length, 0);
});

test("speech-to-text keeps the multipart content type", async () => {
  _resetForTests(); const calls = [];
  await POST(req("speech-to-text", "--b\r\n", "1.1.1.1", "multipart/form-data; boundary=b"), { env, fetchImpl: okFetch(calls) });
  assert.equal(calls[0].opts.headers["content-type"], "multipart/form-data; boundary=b");
});

test("rate limit: 41st request from one IP in 10 minutes gets 429; other IPs unaffected", async () => {
  _resetForTests(); const calls = [];
  const body = JSON.stringify({ model: "bulbul:v3", text: "hi" });
  for (let i = 0; i < 40; i++) assert.equal((await POST(req("text-to-speech", body), { env, fetchImpl: okFetch(calls), now: 1000 + i })).status, 200);
  assert.equal((await POST(req("text-to-speech", body), { env, fetchImpl: okFetch(calls), now: 2000 })).status, 429);
  assert.equal((await POST(req("text-to-speech", body, "2.2.2.2"), { env, fetchImpl: okFetch(calls), now: 2000 })).status, 200);
  assert.equal((await POST(req("text-to-speech", body), { env, fetchImpl: okFetch(calls), now: 1000 + 10 * 60 * 1000 + 50 })).status, 200);
});
