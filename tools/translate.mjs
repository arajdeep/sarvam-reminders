// One-time build step: translate the interface into every language with Sarvam and save lang/<code>.json.
// Usage: SARVAM_API_KEY=... node tools/translate.mjs [codes...]   (no codes = all missing files)
import fs from "node:fs";
import { createRequire } from "node:module";
const I18n = createRequire(import.meta.url)("../i18n.js");

const SCRIPT = {
  "bn-IN": ["Bengali", /[ঀ-৿]/], "mr-IN": ["Devanagari", /[ऀ-ॿ]/], "te-IN": ["Telugu", /[ఀ-౿]/],
  "ta-IN": ["Tamil", /[஀-௿]/], "gu-IN": ["Gujarati", /[઀-૿]/], "ur-IN": ["Perso-Arabic (Urdu Nastaliq)", /[؀-ۿ]/],
  "kn-IN": ["Kannada", /[ಀ-೿]/], "od-IN": ["Odia", /[଀-୿]/], "ml-IN": ["Malayalam", /[ഀ-ൿ]/],
  "pa-IN": ["Gurmukhi", /[਀-੿]/], "as-IN": ["Assamese (Bengali-Assamese)", /[ঀ-৿]/], "mai-IN": ["Devanagari", /[ऀ-ॿ]/],
  "sat-IN": ["Ol Chiki", /[᱐-᱿]/], "ks-IN": ["Perso-Arabic", /[؀-ۿ]/], "ne-IN": ["Devanagari", /[ऀ-ॿ]/],
  "sd-IN": ["Perso-Arabic (Sindhi)", /[؀-ۿ]/], "kok-IN": ["Devanagari", /[ऀ-ॿ]/], "doi-IN": ["Devanagari", /[ऀ-ॿ]/],
  "mni-IN": ["Meitei Mayek", /[ꯀ-꯿]/], "brx-IN": ["Devanagari", /[ऀ-ॿ]/], "sa-IN": ["Devanagari", /[ऀ-ॿ]/],
};
const key = process.env.SARVAM_API_KEY;
if (!key) { console.error("SARVAM_API_KEY not set"); process.exit(1); }
const asked = process.argv.slice(2);
const codes = asked.length ? asked : Object.keys(SCRIPT).filter(c => !fs.existsSync(`lang/${c}.json`));

const RAW_DIR = process.env.RAW_DIR || "/tmp";
const placeholders = str => (str.match(/\{\w+\}/g) || []).sort().join(",");

async function translateBatch(code, items, tag) {
  const name = I18n.LANGS[code].english, [script] = SCRIPT[code];
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST", headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify({ model: "sarvam-105b", temperature: 0, max_tokens: 12000, reasoning_effort: null,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `You translate app interface text from English into ${name}. Write ONLY in ${script} script (no English words, no transliteration${code === "sd-IN" ? "; Sindhi must be in the Arabic/Perso-Arabic script, NOT Devanagari" : ""}), in simple everyday ${name}. Keep {placeholders}, emoji, "Sarvam AI", "API key", "WhatsApp", "BP", "112" and times like 08:00 unchanged. You receive a JSON array of ${items.length} English strings. Reply ONLY with {"t": [...]} containing exactly ${items.length} translated strings in the same order.` },
        { role: "user", content: JSON.stringify(items) }] }),
  });
  const data = await res.json().catch(() => ({}));
  const raw = data?.choices?.[0]?.message?.content || "";
  let arr = null;
  try { arr = JSON.parse(raw).t; } catch {}
  if (!res.ok || !Array.isArray(arr) || arr.length !== items.length) {
    fs.writeFileSync(`${RAW_DIR}/${code}-${tag}.raw.txt`, `HTTP ${res.status}\n${JSON.stringify(data?.error || {})}\n${raw}`);
    return { arr: null, tokens: data.usage?.total_tokens || 0, why: !res.ok ? `HTTP ${res.status}` : !Array.isArray(arr) ? "no array" : `length ${arr.length}/${items.length}` };
  }
  return { arr, tokens: data.usage?.total_tokens || 0 };
}

async function translate(code) {
  const [script, re] = SCRIPT[code];
  const keys = Object.keys(I18n.EN), values = keys.map(k => I18n.EN[k]);
  const n = Number(process.env.BATCHES || 3);
  const size = Math.ceil(values.length / n);
  const batches = Array.from({ length: n }, (_, i) => values.slice(i * size, (i + 1) * size));
  const results = await Promise.all(batches.map((b, i) => translateBatch(code, b, i)));
  const out = {}; let tokens = 0, good = 0, inScript = 0; const problems = [];
  results.forEach((r, i) => {
    tokens += r.tokens;
    if (!r.arr) problems.push(`batch ${i}: ${r.why}`);
    batches[i].forEach((en, j) => {
      const k = keys[i * size + j], v = r.arr?.[j];
      const ok = typeof v === "string" && v.trim() && placeholders(v) === placeholders(en) && re.test(v);
      out[k] = ok ? v : en;
      if (ok) good++;
      if (re.test(out[k])) inScript++;
    });
  });
  const ratio = good / keys.length;
  if (ratio >= 0.9) fs.writeFileSync(`lang/${code}.json`, JSON.stringify(out, null, 1) + "\n");
  return `${code}: ${good}/${keys.length} good in ${script}${ratio >= 0.9 ? " -> saved" : " -> NOT saved"}, tokens ${tokens}${problems.length ? " | " + problems.join("; ") : ""}`;
}

// A few at a time, to be gentle on the rate limit.
const results = [];
for (let i = 0; i < codes.length; i += 4) results.push(...await Promise.all(codes.slice(i, i + 4).map(translate)));
console.log(results.join("\n"));
