const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../logic.js");

const DAY = "2026-11-01";
const at = (h, m = 0, day = DAY) => L.localDate(day, h, m);
const med = (over = {}) => ({ id: "m1", personId: "p1", title: "BP tablet", category: "medicine",
  kind: "schedule", times: ["08:00", "21:00"], food: "after", repeat: "daily", startDate: DAY, ...over });

test("normalizeParsed: cleans a good medicine schedule", () => {
  const r = L.normalizeParsed({ title: " BP tablet ", kind: "schedule", category: "medicine",
    times: ["21:00", "08:00", "08:00", "25:00", "bad"], food: "after", lang: "hi-IN" }, DAY);
  assert.deepEqual(r.times, ["08:00", "21:00"]);
  assert.equal(r.title, "BP tablet");
  assert.equal(r.repeat, "daily");
  assert.equal(r.startDate, DAY);
});

test("normalizeParsed: rejects unsafe or empty model output", () => {
  assert.throws(() => L.normalizeParsed({ title: "", times: ["08:00"] }, DAY));
  assert.throws(() => L.normalizeParsed({ title: "x", kind: "schedule", times: [] }, DAY));
  assert.throws(() => L.normalizeParsed({ title: "Bijli bill", kind: "bill", dueDate: "kal" }, DAY));
  assert.throws(() => L.normalizeParsed(null, DAY));
});

test("normalizeParsed: unknown enums fall back, null amount stays null", () => {
  const r = L.normalizeParsed({ title: "Bijli bill", kind: "bill", dueDate: "2026-11-05",
    category: "weird", food: "maybe", repeat: "weekly", amount: null }, DAY);
  assert.equal(r.category, "bill");
  assert.equal(r.food, "any");
  assert.equal(r.repeat, "none");
  assert.equal(r.amount, null);
  assert.equal(L.normalizeParsed({ title: "b", kind: "bill", dueDate: "2026-11-05", amount: "450" }, DAY).amount, 450);
  assert.equal(L.normalizeParsed({ title: "b", kind: "bill", dueDate: "2026-11-05", amount: -5 }, DAY).amount, null);
});

test("food timing shifts the alert: before = -30 min, after = +20 min", () => {
  const before = L.slotsForDay(med({ food: "before", times: ["13:00"] }), DAY)[0];
  const after = L.slotsForDay(med({ food: "after", times: ["13:00"] }), DAY)[0];
  assert.equal(before.at.getTime(), at(12, 30).getTime());
  assert.equal(after.at.getTime(), at(13, 20).getTime());
  assert.equal(before.key, "m1|2026-11-01|13:00"); // key uses the scheduled time, not the shifted one
});

test("schedules don't fire before their start date", () => {
  assert.equal(L.slotsForDay(med({ startDate: "2026-11-02" }), DAY).length, 0);
});

test("bills: one-time hits only its date; monthly repeats on the same day", () => {
  const once = { id: "b1", personId: "p1", title: "Bill", category: "bill", kind: "bill", dueDate: "2026-11-05", repeat: "none", startDate: DAY };
  assert.equal(L.slotsForDay(once, "2026-11-05").length, 1);
  assert.equal(L.slotsForDay(once, "2026-12-05").length, 0);
  const monthly = { ...once, repeat: "monthly" };
  assert.equal(L.slotsForDay(monthly, "2026-12-05").length, 1);
  assert.equal(L.slotsForDay(monthly, "2026-10-05").length, 0); // not before the first due date
});

test("status: pending inside the grace window, missed after it, recorded wins", () => {
  const slot = L.slotsForDay(med({ food: "any", times: ["08:00"] }), DAY)[0];
  assert.equal(L.statusOf(slot, {}, at(8, 59)), "pending");
  assert.equal(L.statusOf(slot, {}, at(9, 1)), "missed");
  assert.equal(L.statusOf(slot, L.markDose({}, slot.key, "taken"), at(23)), "taken");
});

test("streak counts fully-taken days and stops at a missed dose", () => {
  const r = med({ food: "any", times: ["08:00"], startDate: "2026-10-25" });
  let doses = {};
  for (const d of ["2026-10-29", "2026-10-30", "2026-10-31"]) doses = L.markDose(doses, `m1|${d}|08:00`, "taken");
  // Oct 28 has no record -> missed, so the streak is Oct 29-31 (today pending doesn't count or break).
  assert.equal(L.streak([r], doses, DAY, at(7)), 3);
  doses = L.markDose(doses, `m1|${DAY}|08:00`, "taken");
  assert.equal(L.streak([r], doses, DAY, at(9)), 4);
});

test("family alerts: help is urgent, silent check-in after 11, missed dose", () => {
  const state = {
    people: [{ id: "p1", name: "Dadi", role: "cared" }, { id: "c1", name: "Ravi", role: "caregiver" }],
    reminders: [med({ food: "any", times: ["08:00"] })], doses: {}, checkins: {},
  };
  const quiet = L.collectAlerts(state, at(12));
  assert.ok(quiet.some(a => a.type === "silent"));
  assert.ok(quiet.some(a => a.type === "missed"));
  assert.ok(!quiet.some(a => a.personId === "c1"), "caregivers get no alerts about themselves");

  state.checkins[`p1|${DAY}`] = "help";
  assert.equal(L.collectAlerts(state, at(12))[0].level, "urgent");
  assert.equal(L.collectAlerts({ ...state, checkins: {} }, at(10)).filter(a => a.type === "silent").length, 0);
});

test("dueNow announces each slot once, inside a 15-minute window", () => {
  const r = med({ food: "any", times: ["08:00"] });
  assert.equal(L.dueNow([r], {}, at(7, 59)).length, 0);
  const due = L.dueNow([r], {}, at(8, 5));
  assert.equal(due.length, 1);
  assert.equal(L.dueNow([r], { [due[0].key]: true }, at(8, 6)).length, 0);
  assert.equal(L.dueNow([r], {}, at(8, 20)).length, 0);
});

test("appointments (vaccines, doctor visits) are date-based and keep their category", () => {
  const r = L.normalizeParsed({ title: "Polio vaccine", kind: "bill", category: "appointment", dueDate: "2026-11-10" }, DAY);
  assert.equal(r.category, "appointment");
  assert.equal(L.slotsForDay({ ...r, id: "v1", personId: "b1" }, "2026-11-10").length, 1);
});

test("care home: alerts cover every resident, never staff", () => {
  const state = {
    people: [{ id: "r1", name: "Sharma ji", role: "resident" }, { id: "r2", name: "Kamla ji", role: "resident" },
             { id: "s1", name: "Nurse Priya", role: "caregiver" }],
    reminders: [med({ id: "a", personId: "r1", food: "any", times: ["08:00"] }),
                med({ id: "b", personId: "r2", food: "any", times: ["08:00"] })],
    doses: { [`a|${DAY}|08:00`]: "taken" }, checkins: { [`r1|${DAY}`]: "ok", [`r2|${DAY}`]: "ok" },
  };
  const alerts = L.collectAlerts(state, at(12));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].personId, "r2");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(L.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(L.addDays("2026-03-01", -1), "2026-02-28");
});
