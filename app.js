// Sarvam Reminders: app state, Sarvam calls and rendering. Scheduling rules live in logic.js, text in i18n.js.
const API = "https://api.sarvam.ai";
const STORE_KEY = "sarvam_reminders_v2";
const CACHE_VERSION = "v3"; // bump when interface strings change
const LANG_CODES = Object.keys(I18n.LANGS);
const $ = id => document.getElementById(id);

let key = localStorage.getItem("sarvam_key") || "";
let state = loadState();
let dict = I18n.EN;
let draft = null, recorder = null, chunks = [], onboardStep = "lang";

// ---------- text ----------
function t(k, vars = {}) {
  const s = dict[k] ?? I18n.EN[k] ?? k;
  return s.replace(/\{(\w+)\}/g, (_, v) => (v in vars ? vars[v] : ""));
}
function applyStatic() {
  document.documentElement.lang = (state.lang || "en-IN").split("-")[0];
  document.documentElement.dir = I18n.LANGS[state.lang]?.rtl ? "rtl" : "ltr";
  document.querySelectorAll("[data-t]").forEach(n => { n.textContent = t(n.dataset.t); });
  document.querySelectorAll("[data-tp]").forEach(n => { n.placeholder = t(n.dataset.tp); });
  document.title = t("app_title");
}

// Text we can show right now, without waiting on the network.
function cachedDict(lang) {
  if (!lang) return null;
  if (I18n.BUILTIN[lang]) return I18n.BUILTIN[lang];
  try {
    const c = localStorage.getItem(`ui_${lang}_${CACHE_VERSION}`);
    return c ? I18n.validateTranslation(JSON.parse(c)) : null;
  } catch { return null; }
}
// Translations are pre-built with Sarvam (tools/translate.mjs) and shipped as lang/<code>.json.
async function loadLanguage(lang) {
  const ready = cachedDict(lang);
  if (ready) { if (state.lang === lang) dict = ready; return; }
  try {
    const res = await fetch(`lang/${lang}.json`, { cache: "no-cache" });
    if (res.ok) {
      const shipped = I18n.validateTranslation(await res.json());
      localStorage.setItem(`ui_${lang}_${CACHE_VERSION}`, JSON.stringify(shipped));
      if (state.lang === lang) dict = shipped;
      return;
    }
  } catch {}
  if (state.lang === lang) { dict = I18n.EN; setTimeout(() => toast(t("translate_failed")), 0); }
}

// ---------- state ----------
function blankState() {
  return { lang: null, mode: null, people: [{ id: uid(), name: "", role: "self", profile: "adult" }],
    reminders: [], doses: {}, checkins: {}, notified: {}, snoozes: {}, code: makeCode() };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.people) && Array.isArray(s.reminders)) {
      return { lang: null, mode: null, doses: {}, checkins: {}, notified: {}, snoozes: {}, code: makeCode(), ...s };
    }
  } catch {}
  return blankState();
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); render(); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
const members = () => state.people.filter(p => p.role !== "caregiver");
const caregivers = () => state.people.filter(p => p.role === "caregiver");
const isGroup = () => state.mode === "family" || state.mode === "care";
function displayName(p) {
  if (!p) return "";
  if (p.name) return p.name;
  return members().indexOf(p) === 0 ? t("default_me") : t("default_partner2");
}
const personName = id => displayName(state.people.find(p => p.id === id));

function setMode(mode) {
  const role = { solo: "self", family: "cared", couples: "partner", care: "resident" }[mode];
  if (mode === "couples" && members().length < 2) state.people.push({ id: uid(), name: "", role: "partner", profile: "adult" });
  members().forEach(p => { p.role = role; });
  state.mode = mode;
}
function activeMembers() {
  if (state.mode === "solo") return members().slice(0, 1);
  if (state.mode === "couples") return members().slice(0, 2);
  return members();
}

// ---------- feedback ----------
function setStatus(msg) { $("status").textContent = msg || ""; }
let toastTimer;
function toast(msg) {
  if (!msg) return;
  const n = $("toast");
  n.textContent = msg;
  n.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove("show"), 3500);
}
function busy(btn, on) { btn.classList.toggle("busy", on); btn.disabled = on; }
const errText = e => (/^missing_/.test(e.message) ? t("err_" + e.message) : e.message);

// ---------- Sarvam ----------
// With a personal key, call Sarvam directly; otherwise go through this site's server (/api/sarvam).
async function call(path, options) {
  const direct = Boolean(key);
  const url = direct ? API + path : "/api/sarvam?path=" + encodeURIComponent(path.replace(/^\//, ""));
  const headers = { ...(options.headers || {}) };
  if (direct) headers["api-subscription-key"] = key;
  const res = await fetch(url, { ...options, headers });
  if (!direct && (res.status === 404 || res.status === 501)) throw new Error(t("key_needed"));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
  return data;
}
async function transcribe(blob) {
  const form = new FormData();
  // Browsers label recordings like "audio/webm;codecs=opus"; Sarvam accepts only the bare type.
  const type = (blob.type || "audio/webm").split(";")[0].trim();
  const ext = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav" }[type] || "webm";
  form.append("file", new File([blob], `speech.${ext}`, { type }));
  form.append("model", "saaras:v3");
  form.append("mode", "transcribe");
  return (await call("/speech-to-text", { method: "POST", body: form })).transcript || "";
}
async function parseText(text) {
  const now = new Date();
  const names = activeMembers().map(displayName).join(", ");
  const system = `You turn one reminder request into JSON. Now: ${now.toString()} (Asia/Kolkata). Today: ${Logic.todayStr(now)}.
People: ${names}. The user's chosen language is ${I18n.LANGS[state.lang]?.english || "English"}.
Reply ONLY with a JSON object with keys:
"person": one of the people above (default the first),
"title": short title, in the same language and script as the request,
"kind": "schedule" (daily routine like medicine or meals) or "bill" (something on a date: bill, payment, vaccine, doctor),
"category": "medicine" | "meal" | "bill" | "payment" | "appointment" | "other",
"times": array of "HH:MM" 24h times (for schedule),
"food": "before" | "after" | "with" | "any",
"dueDate": "YYYY-MM-DD" (for bill; next future occurrence),
"repeat": "none" | "daily" | "monthly",
"amount": number in rupees or null,
"lang": the request's language code, one of ${LANG_CODES.join(", ")}.`;
  const data = await call("/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sarvam-105b", temperature: 0, max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: text }] }),
  });
  const raw = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  const clean = Logic.normalizeParsed(raw, Logic.todayStr(now));
  const match = activeMembers().find(p => displayName(p).toLowerCase() === String(raw.person || "").toLowerCase());
  return { ...clean, lang: LANG_CODES.includes(clean.lang) ? clean.lang : state.lang, personId: (match || activeMembers()[0]).id };
}
async function speak(text, lang) {
  if (!I18n.LANGS[lang]?.tts) throw new Error(t("voice_unavailable"));
  const data = await call("/text-to-speech", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1500), language_code: lang, speaker: "shubh", model: "bulbul:v3", output_audio_codec: "wav" }),
  });
  await new Audio("data:audio/wav;base64," + data.audios[0]).play();
}

// ---------- DOM helper ----------
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k !== null && k !== undefined && k !== false));
  return n;
}
const fmtTime = d => d.toLocaleTimeString(state.lang || "en-IN", { hour: "numeric", minute: "2-digit" });
const ROLE_KEY = { self: "role_self", cared: "role_cared", caregiver: "role_caregiver", partner: "role_partner", resident: "role_resident" };
const MODE_ICON = { solo: "🧍", family: "👨‍👩‍👧", couples: "👫", care: "🏥" };
// "😊 I'm fine" → ["😊", "I'm fine"]; works for translations that keep the leading emoji.
function splitEmoji(s) { const m = s.match(/^(\S+)\s+(.+)$/); return m && !/[\p{L}\p{N}]/u.test(m[1]) ? [m[1], m[2]] : ["", s]; }

// ---------- onboarding ----------
function renderOnboard() {
  $("stepLang").hidden = onboardStep !== "lang";
  $("stepMode").hidden = onboardStep !== "mode";
  $("stepKey").hidden = onboardStep !== "key";
  $("langGrid").replaceChildren(...LANG_CODES.map(code => {
    const info = I18n.LANGS[code];
    const b = el("button", { lang: code.split("-")[0], dir: info.rtl ? "rtl" : "ltr", className: state.lang === code ? "on" : "" },
      el("span", { textContent: info.native }),
      code === "en-IN" ? null : el("span", { className: "meta", textContent: info.english }));
    b.onclick = () => {
      state.lang = code;
      dict = cachedDict(code) || I18n.EN; // show immediately; the shipped file loads in the background
      onboardStep = state.mode ? "done" : "mode";
      save();
      if (!cachedDict(code)) loadLanguage(code).then(render);
    };
    return b;
  }));
  $("modeList").replaceChildren(...["solo", "family", "couples", "care"].map(m => {
    const b = el("button", { className: "choice" + (state.mode === m ? " on" : "") },
      el("span", { className: "emoji", textContent: MODE_ICON[m], ariaHidden: "true" }),
      el("span", {}, el("strong", { textContent: t("mode_" + m) }), el("span", { className: "desc", textContent: t("mode_" + m + "_desc") })));
    b.onclick = () => { setMode(m); onboardStep = "done"; save(); };
    return b;
  }));
}
$("modeBack").onclick = () => { onboardStep = "lang"; render(); };
$("obKeySave").onclick = () => {
  key = $("obKey").value.trim();
  if (key) localStorage.setItem("sarvam_key", key);
  state.keyAsked = true; onboardStep = "done"; save();
};
$("obKeyLater").onclick = () => { state.keyAsked = true; onboardStep = "done"; save(); };
$("langBtn").onclick = () => { onboardStep = "lang"; render(); };
$("modeBtn").onclick = () => { onboardStep = "mode"; render(); };

// ---------- compose ----------
function showDraft(d) {
  draft = d;
  $("dPerson").replaceChildren(...activeMembers().map(p => new Option(displayName(p), p.id, false, p.id === d.personId)));
  $("dTitle").value = d.title || "";
  $("dKind").value = d.kind || "schedule";
  $("dCategory").value = d.category || "other";
  $("dTimes").value = (d.times || []).join(", ");
  $("dFood").value = d.food || "any";
  $("dDue").value = d.dueDate || "";
  $("dRepeat").value = d.repeat === "monthly" ? "monthly" : "none";
  $("dAmount").value = d.amount ?? "";
  toggleKind();
  $("draft").hidden = false;
}
function toggleKind() {
  const dated = $("dKind").value === "bill";
  $("scheduleFields").hidden = dated;
  $("billFields").hidden = !dated;
}
$("dKind").onchange = toggleKind;

async function understand(text) {
  setStatus(t("thinking"));
  busy($("addBtn"), true);
  try { showDraft(await parseText(text)); setStatus(t("check_save")); }
  catch (e) { setStatus(e instanceof SyntaxError ? t("not_understood") : errText(e)); }
  finally { busy($("addBtn"), false); }
}
$("addBtn").onclick = () => { const v = $("typed").value.trim(); if (v) understand(v); };
$("typed").onkeydown = e => { if (e.key === "Enter") $("addBtn").click(); };

$("mic").onclick = async () => {
  const mic = $("mic");
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return setStatus(t("mic_permission")); }
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = e => chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach(tr => tr.stop());
    mic.classList.remove("rec"); mic.textContent = t("speak");
    busy(mic, true);
    setStatus(t("thinking"));
    try {
      const text = await transcribe(new Blob(chunks, { type: recorder.mimeType }));
      if (!text.trim()) return setStatus(t("heard_nothing"));
      $("typed").value = text;
      await understand(text);
    } catch (e) { setStatus(t("error", { msg: errText(e) })); }
    finally { busy(mic, false); }
  };
  recorder.start();
  mic.classList.add("rec"); mic.textContent = t("stop");
  setStatus(t("listening"));
};

$("saveDraft").onclick = () => {
  const kind = $("dKind").value;
  const raw = {
    title: $("dTitle").value, kind, category: $("dCategory").value, food: $("dFood").value,
    times: $("dTimes").value.split(/[,\s]+/).filter(Boolean), dueDate: $("dDue").value,
    repeat: kind === "bill" ? $("dRepeat").value : "daily", amount: $("dAmount").value,
    lang: draft?.lang || state.lang,
  };
  let clean;
  try { clean = Logic.normalizeParsed(raw, Logic.todayStr()); }
  catch (e) { return setStatus(errText(e)); }
  state.reminders.push({ ...clean, id: uid(), personId: $("dPerson").value });
  draft = null; $("draft").hidden = true; $("typed").value = ""; setStatus("");
  toast(t("saved"));
  save();
};
$("cancelDraft").onclick = () => { draft = null; $("draft").hidden = true; setStatus(""); };

// ---------- render ----------
function render() {
  const onboarding = !state.lang || !state.mode || onboardStep !== "done";
  applyStatic();
  $("onboard").hidden = !onboarding;
  $("app").hidden = onboarding;
  if (onboarding) return renderOnboard();
  $("langBtn").textContent = "🌐 " + I18n.LANGS[state.lang].native;
  $("modeBtn").textContent = MODE_ICON[state.mode] + " " + t("mode_" + state.mode);
  renderToday(); renderCheckins(); renderBoard(); renderAlerts(); renderTemplates(); renderPeople(); renderAll();
}

function todaySlots() {
  const date = Logic.todayStr();
  const ids = new Set(activeMembers().map(p => p.id));
  return state.reminders.filter(r => ids.has(r.personId)).flatMap(r => Logic.slotsForDay(r, date)).sort((a, b) => a.at - b.at);
}
function empty(icon, text) { return el("div", { className: "empty" }, el("span", { className: "ic", textContent: icon, ariaHidden: "true" }), text); }

function renderToday() {
  const now = new Date(), multi = activeMembers().length > 1;
  const slots = todaySlots();
  $("today").replaceChildren(...(slots.length ? slots.map(s => {
    const r = state.reminders.find(x => x.id === s.reminderId);
    const st = Logic.statusOf(s, state.doses, now);
    const meta = el("div", { className: "item-meta" },
      el("span", { className: "tag", textContent: t("cat_" + s.category) }),
      s.food !== "any" ? el("span", { textContent: t("food_" + s.food) }) : null,
      multi ? el("span", { textContent: personName(s.personId) }) : null,
      r?.amount != null ? el("span", { textContent: `₹${r.amount}` }) : null);
    const pill = st !== "pending" && el("span", { className: "pill " + st, textContent: t("st_" + st)
      + (st === "snoozed" && state.snoozes[s.key] ? " · " + fmtTime(new Date(state.snoozes[s.key])) : "") });
    // Segmented control: the chosen state lights up; "Done" is the primary action until something is chosen.
    const mark = (status, label) => {
      const chosen = st === status;
      const cls = chosen ? "on-" + status : (status === "taken" && st === "pending" ? "primary" : "");
      const b = el("button", { className: cls, textContent: t(label), ariaPressed: String(chosen) });
      b.onclick = () => {
        state.doses = Logic.markDose(state.doses, s.key, status);
        if (status === "snoozed") state.snoozes[s.key] = Date.now() + 10 * 60000; else delete state.snoozes[s.key];
        save();
      };
      return b;
    };
    return el("div", { className: "item" + (st === "taken" ? " done" : "") },
      el("div", { className: "item-time", textContent: fmtTime(s.at) }),
      el("div", {}, el("div", { className: "item-title", textContent: s.title }), meta, pill || null),
      st !== "taken" && el("div", { className: "seg", role: "group" },
        mark("taken", "taken_btn"), mark("snoozed", "snooze_btn"), mark("missed", "missed_btn")));
  }) : [empty("🗓️", t("nothing_today"))]));

  const date = Logic.todayStr();
  $("streaks").replaceChildren(...activeMembers().map(p => {
    const n = Logic.streak(state.reminders.filter(r => r.personId === p.id), state.doses, date, now);
    return n > 0 ? el("div", { className: "streak", textContent: t("streak", { who: multi ? displayName(p) + ": " : "", n }) }) : null;
  }).filter(Boolean));
}

function renderCheckins() {
  const date = Logic.todayStr(), multi = activeMembers().length > 1;
  $("checkins").replaceChildren(...activeMembers().map(p => {
    const k = `${p.id}|${date}`, answer = state.checkins[k];
    const moods = ["ok", "unwell", "help"].map(v => {
      const [emoji, label] = splitEmoji(t("ci_" + v));
      const b = el("button", { className: `mood ${v}` + (answer === v ? " on" : ""), ariaPressed: String(answer === v) },
        emoji ? el("span", { className: "emoji", textContent: emoji, ariaHidden: "true" }) : null, el("span", { textContent: label }));
      b.onclick = async () => {
        state.checkins[k] = v;
        save();
        try { await speak(t("ci_reply_" + v), state.lang); } catch (e) { toast(errText(e)); }
      };
      return b;
    });
    // Reply right where the person tapped, also spoken aloud.
    const reply = answer && el("div", { className: "note reply", role: "status" },
      el("div", { textContent: t("ci_reply_" + answer) }),
      answer === "help" && state.mode !== "solo" ? el("div", { textContent: t("ci_help_sent"), style: "margin-top:6px" }) : null,
      answer === "help" ? el("a", { className: "btn danger", href: "tel:112", textContent: t("call_112") }) : null);
    return el("div", { style: "margin-bottom:12px" }, multi && el("div", { className: "person-label", textContent: displayName(p) }),
      el("div", { className: "moods" }, ...moods), reply);
  }));
}

function renderBoard() {
  $("boardCard").hidden = !isGroup();
  if (!isGroup()) return;
  const now = new Date(), date = Logic.todayStr(now);
  const face = { ok: "😊", unwell: "😐", help: "🆘" };
  $("board").replaceChildren(...activeMembers().map(p => {
    const slots = state.reminders.filter(r => r.personId === p.id).flatMap(r => Logic.slotsForDay(r, date));
    const st = slots.map(s => Logic.statusOf(s, state.doses, now));
    const done = st.filter(x => x === "taken").length, missed = st.filter(x => x === "missed").length;
    const answer = state.checkins[`${p.id}|${date}`];
    return el("div", { className: "board-row" },
      el("div", {}, el("strong", { textContent: displayName(p) }),
        el("div", { className: "meta", textContent: `${t("prof_" + (p.profile || "adult"))} · ${t("board_done", { done, total: slots.length })}` })),
      el("div", { className: missed ? "st-missed" : "meta",
        textContent: [answer ? face[answer] : t("board_no_checkin"), missed ? t("board_missed", { n: missed }) : ""].filter(Boolean).join(" · ") }));
  }));
}

function renderAlerts() {
  const shared = state.mode !== "solo";
  $("alertsCard").hidden = !shared;
  if (!shared) return;
  const people = [...activeMembers(), ...caregivers()].map(p => ({ ...p, name: displayName(p) }));
  const alerts = Logic.collectAlerts({ ...state, people });
  $("alerts").replaceChildren(...(alerts.length ? alerts.map(a => {
    const msg = t("al_" + a.type, { name: a.name, title: a.title || "" });
    return el("div", { className: "alert " + a.level }, el("span", { textContent: msg }),
      el("a", { className: "btn secondary", target: "_blank", rel: "noopener", textContent: t("whatsapp"),
        href: "https://wa.me/?text=" + encodeURIComponent(msg) }));
  }) : [empty("✅", t("no_alerts"))]));
}

const TEMPLATES = {
  baby: [
    { t: "tpl_feeding", kind: "schedule", category: "meal", times: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"] },
    { t: "tpl_vitd", kind: "schedule", category: "medicine", times: ["09:30"], food: "after" },
    { t: "tpl_vaccine", kind: "bill", category: "appointment", needsDate: true },
  ],
  child: [
    { t: "tpl_bag", kind: "schedule", category: "other", times: ["07:00"] },
    { t: "tpl_homework", kind: "schedule", category: "other", times: ["18:30"] },
    { t: "tpl_doctor", kind: "bill", category: "appointment", needsDate: true },
  ],
  adult: [
    { t: "tpl_water", kind: "schedule", category: "other", times: ["11:00", "16:00"] },
    { t: "tpl_electricity", kind: "bill", category: "bill", repeat: "monthly", needsDate: true },
    { t: "tpl_recharge", kind: "bill", category: "payment", repeat: "monthly", needsDate: true },
  ],
  elder: [
    { t: "tpl_sugar", kind: "schedule", category: "medicine", times: ["07:30"], food: "before" },
    { t: "tpl_bp", kind: "schedule", category: "medicine", times: ["08:30", "20:30"], food: "after" },
    { t: "tpl_walk", kind: "schedule", category: "other", times: ["17:30"] },
    { t: "tpl_pension", kind: "bill", category: "payment", repeat: "monthly", needsDate: true },
  ],
};
function renderTemplates() {
  const people = activeMembers(), sel = $("tPerson"), keep = sel.value;
  sel.replaceChildren(...people.map(p => new Option(`${displayName(p)} · ${t("prof_" + (p.profile || "adult"))}`, p.id)));
  sel.hidden = people.length < 2;
  if (people.some(p => p.id === keep)) sel.value = keep;
  const person = people.find(p => p.id === sel.value) || people[0];
  if (!person) return $("templates").replaceChildren();
  $("templates").replaceChildren(...TEMPLATES[person.profile || "adult"].map(tp => {
    const b = el("button", { className: "chip", textContent: "+ " + t(tp.t) });
    b.onclick = () => {
      const base = { ...tp, title: t(tp.t), lang: state.lang, repeat: tp.repeat || "none", personId: person.id };
      if (tp.needsDate) { showDraft(base); setStatus(t("need_date")); $("draft").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      state.reminders.push({ ...Logic.normalizeParsed(base, Logic.todayStr()), id: uid(), personId: person.id });
      toast(t("saved"));
      save();
    };
    return b;
  }));
}
$("tPerson").onchange = renderTemplates;

function renderPeople() {
  const shown = isGroup() ? [...activeMembers(), ...caregivers()] : activeMembers();
  $("people").replaceChildren(...shown.map(p => {
    const name = el("input", { value: p.name, placeholder: displayName(p), ariaLabel: t("name_placeholder") });
    name.onchange = () => { p.name = name.value.trim(); save(); };
    const roleText = p.role === "caregiver" && state.mode === "care" ? t("role_staff") : t(ROLE_KEY[p.role]);
    const row = el("div", { className: "person-row" }, name);
    if (p.role !== "caregiver") {
      const prof = el("select", { ariaLabel: t("f_category") },
        ...["baby", "child", "adult", "elder"].map(v => new Option(t("prof_" + v), v, false, (p.profile || "adult") === v)));
      prof.onchange = () => { p.profile = prof.value; save(); };
      row.append(prof);
    }
    row.append(el("span", { className: "meta", textContent: roleText }));
    if (p.role === "caregiver" || (isGroup() && activeMembers().length > 1)) {
      row.append(confirmButton(t("remove"), () => {
        state.people = state.people.filter(x => x.id !== p.id);
        state.reminders = state.reminders.filter(r => r.personId !== p.id);
        save();
      }));
    }
    return row;
  }));
  $("addMember").hidden = !isGroup();
  $("addCaregiver").hidden = !isGroup();
  $("cgAdd").textContent = state.mode === "care" ? t("add_staff") : t("add_caregiver");
  $("syncNote").hidden = state.mode === "solo";
  $("syncNote").textContent = t("sync_note", { code: state.code });
}
$("cgAdd").onclick = () => {
  const name = $("cgName").value.trim(); if (!name) return;
  state.people.push({ id: uid(), name, role: "caregiver" }); $("cgName").value = ""; save();
};
$("mAdd").onclick = () => {
  const name = $("mName").value.trim(); if (!name) return;
  state.people.push({ id: uid(), name, role: state.mode === "care" ? "resident" : "cared", profile: $("mProfile").value });
  $("mName").value = ""; save();
};

// Destructive actions need a second tap ("Delete" → "Delete?").
function confirmButton(label, action) {
  const b = el("button", { className: "secondary", textContent: label });
  let armed = false, timer;
  b.onclick = () => {
    if (armed) { clearTimeout(timer); action(); return; }
    armed = true; b.textContent = label + "?"; b.className = "danger";
    timer = setTimeout(() => { armed = false; b.textContent = label; b.className = "secondary"; }, 3000);
  };
  return b;
}

function renderAll() {
  $("all").replaceChildren(...(state.reminders.length ? state.reminders.map(r => {
    const when = r.kind === "bill"
      ? r.dueDate + (r.repeat === "monthly" ? " · " + t("repeat_monthly") : "")
      : r.times.join(", ") + (r.food !== "any" ? " · " + t("food_" + r.food) : "");
    return el("div", { className: "list-row" },
      el("div", {}, el("div", { className: "item-title", textContent: r.title }),
        el("div", { className: "item-meta" }, el("span", { className: "tag", textContent: t("cat_" + r.category) }),
          el("span", { textContent: [when, personName(r.personId), r.amount != null ? `₹${r.amount}` : ""].filter(Boolean).join(" · ") }))),
      confirmButton(t("delete"), () => { state.reminders = state.reminders.filter(x => x.id !== r.id); save(); }));
  }) : [empty("📝", t("none_yet"))]));
}

// ---------- summary, key, backup ----------
$("summaryBtn").onclick = async () => {
  const btn = $("summaryBtn");
  const left = todaySlots().filter(s => Logic.statusOf(s, state.doses) !== "taken");
  const text = left.length ? t("summary_left", { items: left.map(s => `${fmtTime(s.at)} ${s.title}`).join(", ") }) : t("summary_done");
  busy(btn, true);
  try { await speak(text, state.lang); } catch (e) { toast(errText(e)); } finally { busy(btn, false); }
};
$("saveKey").onclick = () => {
  key = $("keyInput").value.trim();
  localStorage.setItem("sarvam_key", key);
  $("keyInput").value = "";
  if (key) toast(t("key_saved"));
  render();
};
$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `reminders-${Logic.todayStr()}.json` });
  a.click(); URL.revokeObjectURL(a.href);
};
$("importFile").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const s = JSON.parse(await file.text());
    if (!s || !Array.isArray(s.people) || !Array.isArray(s.reminders)) throw new Error("format");
    state = { doses: {}, checkins: {}, notified: {}, snoozes: {}, code: makeCode(), ...s, lang: state.lang, mode: s.mode || state.mode };
    toast(t("restored")); save();
  } catch { toast(t("restore_failed")); }
  e.target.value = "";
};

// ---------- alerts firing ----------
async function announce(slot) {
  const multi = activeMembers().length > 1;
  const text = [multi ? personName(slot.personId) : "", slot.title, slot.food !== "any" ? t("food_" + slot.food) : ""].filter(Boolean).join(". ");
  if ("Notification" in window && Notification.permission === "granted") new Notification(t("reminder"), { body: text });
  toast("🔔 " + text);
  try { await speak(text, state.lang); } catch (e) { toast(errText(e)); }
}
async function tick() {
  if (!state.mode) return;
  const now = new Date(), ids = new Set(activeMembers().map(p => p.id));
  let changed = false;
  for (const slot of Logic.dueNow(state.reminders.filter(r => ids.has(r.personId)), state.notified, now)) {
    state.notified[slot.key] = true; changed = true;
    if (!state.doses[slot.key]) await announce(slot);
  }
  for (const [k, until] of Object.entries(state.snoozes)) {
    if (now.getTime() >= until) {
      delete state.snoozes[k]; delete state.doses[k]; changed = true;
      const slot = todaySlots().find(s => s.key === k);
      if (slot) await announce(slot);
    }
  }
  if (changed) save();
  else if (!$("app").hidden) { renderToday(); renderBoard(); renderAlerts(); } // keep "missed" and alerts current
}

// ---------- start ----------
(function init() {
  onboardStep = state.lang && state.mode ? "done" : (state.lang ? "mode" : "lang");
  dict = cachedDict(state.lang) || I18n.EN;
  if ("Notification" in window && Notification.permission === "default" && state.mode) Notification.requestPermission();
  render(); // always paint first, so the page is never blank
  if (state.lang && !cachedDict(state.lang)) loadLanguage(state.lang).then(render);
  setInterval(tick, 30000);
})();
