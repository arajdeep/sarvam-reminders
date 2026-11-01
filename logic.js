// Pure scheduling and alert logic. No DOM, no network: testable with `node --test`.
(function (root) {
  const FOOD_OFFSET = { before: -30, after: 20, with: 0, any: 0 }; // minutes from the scheduled time
  const CATEGORIES = ["medicine", "meal", "bill", "payment", "appointment", "other"];
  const REPEATS = ["none", "daily", "monthly"];
  const GRACE_MIN = 60;          // a dose is "missed" after this many minutes
  const CHECKIN_DEADLINE = 11;   // hour after which a silent check-in raises a watch alert
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const pad = n => String(n).padStart(2, "0");

  function todayStr(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }

  function localDate(dateStr, hh, mm) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }

  // Turn whatever the model returned into a safe reminder, or throw. Never trust raw model output.
  function normalizeParsed(raw, today) {
    const r = raw || {};
    const kind = r.kind === "bill" ? "bill" : "schedule";
    const title = String(r.title || "").trim().slice(0, 120);
    if (!title) throw new Error("Reminder ka title nahi mila.");

    const amountNum = r.amount === null || r.amount === undefined || r.amount === "" ? NaN : Number(r.amount);
    const out = {
      title,
      kind,
      category: CATEGORIES.includes(r.category) ? r.category : (kind === "bill" ? "bill" : "other"),
      food: Object.prototype.hasOwnProperty.call(FOOD_OFFSET, r.food) ? r.food : "any",
      repeat: REPEATS.includes(r.repeat) ? r.repeat : "none",
      amount: Number.isFinite(amountNum) && amountNum >= 0 ? amountNum : null,
      lang: typeof r.lang === "string" && r.lang ? r.lang : "hi-IN",
      times: [],
      dueDate: null,
    };

    if (kind === "bill") {
      const due = String(r.dueDate || "");
      if (!DATE_RE.test(due)) throw new Error("Bill ki due date nahi mili.");
      out.dueDate = due;
      out.times = [];
    } else {
      const times = Array.isArray(r.times) ? r.times.map(String).filter(t => TIME_RE.test(t)) : [];
      const unique = [...new Set(times)].sort();
      if (!unique.length) throw new Error("Dawai ka time nahi mila (HH:MM).");
      out.times = unique;
      out.repeat = out.repeat === "none" ? "daily" : out.repeat; // schedules recur by default
    }
    out.startDate = today;
    return out;
  }

  // All dose slots for one calendar day.
  function slotsForDay(reminder, dateStr) {
    if (dateStr < (reminder.startDate || dateStr)) return [];
    const base = { reminderId: reminder.id, personId: reminder.personId, title: reminder.title,
      category: reminder.category, food: reminder.food || "any" };

    if (reminder.kind === "bill") {
      const due = reminder.dueDate;
      const hit = reminder.repeat === "monthly"
        ? dateStr >= due && dateStr.slice(8, 10) === due.slice(8, 10)
        : dateStr === due;
      return hit ? [{ ...base, key: `${reminder.id}|${dateStr}|bill`, at: localDate(dateStr, 9, 0), food: "any" }] : [];
    }

    return reminder.times.map(hhmm => {
      const [hh, mm] = hhmm.split(":").map(Number);
      const scheduled = localDate(dateStr, hh, mm);
      const at = new Date(scheduled.getTime() + (FOOD_OFFSET[base.food] || 0) * 60000);
      return { ...base, key: `${reminder.id}|${dateStr}|${hhmm}`, at, scheduledTime: hhmm };
    });
  }

  function statusOf(slot, doses, now = new Date()) {
    const recorded = doses[slot.key];
    if (recorded) return recorded; // taken | snoozed | missed
    return now - slot.at > GRACE_MIN * 60000 ? "missed" : "pending";
  }

  function markDose(doses, key, status) {
    return { ...doses, [key]: status };
  }

  // Consecutive days (ending at endDate) where every medicine dose was taken.
  // Pending days don't break the streak; a missed dose does.
  function streak(reminders, doses, endDate, now = new Date(), maxDays = 90) {
    let count = 0;
    for (let i = 0; i < maxDays; i++) {
      const day = addDays(endDate, -i);
      const meds = reminders.filter(r => r.category === "medicine")
        .flatMap(r => slotsForDay(r, day));
      if (!meds.length) { if (i === 0) continue; break; }
      const statuses = meds.map(s => statusOf(s, doses, now));
      if (statuses.includes("missed")) break;
      if (statuses.every(s => s === "taken")) count++;
    }
    return count;
  }

  // Alerts for caregivers: missed doses, check-in answers, and silent check-ins.
  function collectAlerts(state, now = new Date()) {
    const { people, reminders, doses, checkins } = state;
    const date = todayStr(now);
    const alerts = [];
    const cared = people.filter(p => p.role !== "caregiver");

    for (const person of cared) {
      const answer = checkins[`${person.id}|${date}`];
      if (answer === "help") alerts.push({ level: "urgent", personId: person.id, message: `${person.name}: madad chahiye` });
      else if (answer === "unwell") alerts.push({ level: "watch", personId: person.id, message: `${person.name}: thoda theek nahi` });
      else if (!answer && now.getHours() >= CHECKIN_DEADLINE) {
        alerts.push({ level: "watch", personId: person.id, message: `${person.name}: aaj ka check-in abhi nahi aaya` });
      }

      for (const r of reminders.filter(x => x.personId === person.id)) {
        for (const slot of slotsForDay(r, date)) {
          if (statusOf(slot, doses, now) === "missed") {
            alerts.push({ level: "watch", personId: person.id, message: `${person.name}: ${slot.title} miss hui` });
          }
        }
      }
    }
    const rank = { urgent: 0, watch: 1, info: 2 };
    return alerts.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  // Slots whose time has arrived in the last `windowMin` minutes and haven't been announced yet.
  function dueNow(reminders, notified, now = new Date(), windowMin = 15) {
    const date = todayStr(now);
    const out = [];
    for (const r of reminders) {
      for (const slot of slotsForDay(r, date)) {
        const delta = now - slot.at;
        if (delta >= 0 && delta <= windowMin * 60000 && !notified[slot.key]) out.push(slot);
      }
    }
    return out;
  }

  function foodHint(food, lang) {
    const hi = { before: "khane se pehle", after: "khane ke baad", with: "khane ke saath", any: "" };
    const en = { before: "before food", after: "after food", with: "with food", any: "" };
    return (lang === "hi-IN" ? hi : en)[food] ?? "";
  }

  const Logic = {
    FOOD_OFFSET, CATEGORIES, GRACE_MIN, CHECKIN_DEADLINE,
    todayStr, addDays, localDate, normalizeParsed, slotsForDay,
    statusOf, markDose, streak, collectAlerts, dueNow, foodHint,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Logic;
  else root.Logic = Logic;
})(typeof self !== "undefined" ? self : globalThis);
