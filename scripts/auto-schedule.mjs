// Creates each month's schedule automatically, 3 days before its first Sunday.
// Run daily by .github/workflows/auto-schedule.yml. The scheduling logic below
// is copied from app.html — keep the two in sync if you change it.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PEOPLE = ["Tony", "Sarah", "Billy", "James", "Airi"];
const POSITIONS = [{ key: "slides", label: "Slides" }, { key: "sound", label: "Sound" }];
const LEAD_DAYS = 3;
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const DRY_RUN = process.env.DRY_RUN === "true";

const pad = n => String(n).padStart(2, "0");
const toDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKeyOf = (y, m) => `${y}-${pad(m + 1)}`;
function sundaysOf(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  const out = [];
  while (d.getMonth() === m - 1) {
    out.push(`${y}-${pad(m)}-${pad(d.getDate())}`);
    d.setDate(d.getDate() + 7);
  }
  return out;
}
function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKeyOf(d.getFullYear(), d.getMonth());
}
function tally(all, excludeKey) {
  const t = Object.fromEntries(PEOPLE.map(p => [p, { slides: 0, sound: 0, total: 0 }]));
  for (const [k, mo] of Object.entries(all)) {
    if (k === excludeKey) continue;
    for (const day of Object.values(mo.schedule || {})) {
      for (const { key } of POSITIONS) {
        const who = day?.[key]?.person;
        if (who && t[who]) { t[who][key]++; t[who].total++; }
      }
    }
  }
  return t;
}

function buildSchedule(sundays, absences, history) {
  const c = structuredClone(history);
  const month = Object.fromEntries(PEOPLE.map(p => [p, 0]));
  const away = (p, d) => (absences?.[p] || []).includes(d);
  const avail = d => PEOPLE.filter(p => !away(p, d));

  // Fill the hardest Sundays (fewest people available) first
  const order = sundays
    .map(d => ({ d, n: avail(d).length, r: Math.random() }))
    .sort((a, b) => a.n - b.n || a.r - b.r)
    .map(x => x.d);

  const out = {};
  for (const d of order) {
    // Fewest shifts this month first, then fewest all-time, then random
    const pool = avail(d)
      .map(p => ({ p, r: Math.random() }))
      .sort((a, b) => month[a.p] - month[b.p] || c[a.p].total - c[b.p].total || a.r - b.r)
      .map(x => x.p);
    const [a, b] = pool;
    let slides = null, sound = null;
    if (a && b) {
      // Pick the position split that best evens out each person's slides/sound mix
      const cost = (s, o) => Math.abs(c[s].slides + 1 - c[s].sound) + Math.abs(c[o].sound + 1 - c[o].slides);
      const c1 = cost(a, b), c2 = cost(b, a);
      if (c1 < c2 || (c1 === c2 && Math.random() < 0.5)) { slides = a; sound = b; }
      else { slides = b; sound = a; }
    } else if (a) {
      if (c[a].slides <= c[a].sound) slides = a; else sound = a;
    }
    const slot = p => ({ person: p, coverRequested: false, coveredFor: null });
    out[d] = { slides: slot(slides), sound: slot(sound) };
    for (const [pos, p] of [["slides", slides], ["sound", sound]]) {
      if (p) { c[p][pos]++; c[p].total++; month[p]++; }
    }
  }
  return out;
}

// Try many randomized schedules and keep the fairest one
function bestSchedule(sundays, absences, history) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 400; i++) {
    const sched = buildSchedule(sundays, absences, history);
    const t = structuredClone(history);
    const m = Object.fromEntries(PEOPLE.map(p => [p, 0]));
    let open = 0;
    for (const day of Object.values(sched)) for (const { key } of POSITIONS) {
      const p = day[key].person;
      if (!p) { open++; continue; }
      t[p][key]++; t[p].total++; m[p]++;
    }
    const spread = o => Math.max(...Object.values(o)) - Math.min(...Object.values(o));
    const totals = Object.fromEntries(PEOPLE.map(p => [p, t[p].total]));
    const mix = PEOPLE.reduce((s, p) => s + (t[p].slides - t[p].sound) ** 2, 0);
    const score = open * 1000 + spread(m) * 100 + spread(totals) * 10 + mix;
    if (score < bestScore) { bestScore = score; best = sched; }
  }
  return best;
}



function autoDate(mKey) {
  const d = toDate(sundaysOf(mKey)[0]);
  d.setDate(d.getDate() - LEAD_DAYS);
  return fmt(d);
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is missing.");
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();

  // "Today" in the team's time zone, as YYYY-MM-DD
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const thisMonth = today.slice(0, 7);
  console.log(`Today in ${TIMEZONE}: ${today}${DRY_RUN ? " (dry run)" : ""}`);

  const all = {};
  (await db.collection("months").get()).forEach(d => { all[d.id] = d.data(); });

  for (const mKey of [thisMonth, shiftMonth(thisMonth, 1)]) {
    const due = autoDate(mKey);
    if (all[mKey]?.schedule) { console.log(`${mKey}: already has a schedule.`); continue; }
    if (today < due) { console.log(`${mKey}: not due until ${due}.`); continue; }
    const sundays = sundaysOf(mKey).filter(d => d >= today);
    if (!sundays.length) { console.log(`${mKey}: no Sundays left.`); continue; }

    const ref = db.collection("months").doc(mKey);
    const made = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      if (data.schedule) return null; // created by someone else meanwhile
      const sched = bestSchedule(sundays, data.absences || {}, tally(all, mKey));
      if (!DRY_RUN) tx.set(ref, { schedule: sched, generatedAt: new Date().toISOString(), autoCreated: true }, { merge: true });
      return sched;
    });
    if (!made) { console.log(`${mKey}: created elsewhere just now.`); continue; }
    console.log(`${mKey}: ${DRY_RUN ? "would create" : "created"} schedule`);
    for (const [d, day] of Object.entries(made).sort()) {
      console.log(`  ${d}  Slides: ${day.slides.person ?? "OPEN"}  Sound: ${day.sound.person ?? "OPEN"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
