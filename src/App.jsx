import { useState, useEffect } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "pem_log_entries_v2";
const SETTINGS_KEY = "pem_settings_v2";

const BUILTIN_TRIGGERS = [
  "Stress", "Körperl. Aktivität", "Sozialer Kontakt",
  "Hitze", "Kälte", "Emotionale Belastung",
  "Schlechter Schlaf", "Ortswechsel", "Lärm / Reize", "Mahlzeiten"
];

const DEFAULT_SETTINGS = {
  setupDone: false,
  baselineRmssdMin: "", baselineRmssdMax: "",
  eveningTime: "20:00", morningTime: "07:30",
  showStreak: true, notificationsEnabled: false,
  customTriggers: [],
  rollingDays: 3,
  calibrationDays: 90,
};

const DEFAULT_EVENING = {
  fatigue: 5, pain: 5, brainfog: 5,
  unrefreshing_sleep_prev: 5, pem_today: null,
  activity_today: 1, triggers: [], notes: "",
};
const DEFAULT_MORNING = {
  rmssd_garmin: "", hrv_status: "balanced",
  morning_hr: "", breath_rate: "",
  symptom_on_waking: 5, pem_confirmed: null, notes: "",
};

const ACTIVITY_LABELS = ["Bettruhe", "Sehr wenig", "Leicht", "Moderat", "Viel"];
const HRV_OPTIONS = ["balanced", "unbalanced", "low"];
const HRV_LABELS = { balanced: "✓ Balanced", unbalanced: "⚠ Unbalanced", low: "✗ Low" };
const HRV_COLORS = { balanced: "#4ade80", unbalanced: "#facc15", low: "#f87171" };

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function mkDateStr(d) {
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
}
function parseDEDate(str) {
  const m = str.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1])) : null;
}
function shiftDate(str, days) {
  const d = parseDEDate(str);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return mkDateStr(d);
}

// ─── Risk Calculation ─────────────────────────────────────────────────────────

function computeBaseRisk(eve, morn, settings = {}) {
  if (!eve && !morn) return null;
  let eveScore = null, mornScore = null;
  if (eve) {
    const symAvg = ((eve.fatigue || 0) + (eve.pain || 0) + (eve.brainfog || 0)) / 3;
    eveScore = symAvg * 0.40 + (eve.unrefreshing_sleep_prev || 0) * 0.15
      + ((eve.activity_today || 0) / 4) * 10 * 0.20
      + (eve.pem_today ? 10 : 0) * 0.25;
  }
  if (morn) {
    const hrv = morn.hrv_status === "low" ? 10 : morn.hrv_status === "unbalanced" ? 6 : 2;
    let rmssdS = 5;
    const r = parseFloat(morn.rmssd_garmin), bMin = parseFloat(settings.baselineRmssdMin), bMax = parseFloat(settings.baselineRmssdMax);
    if (!isNaN(r) && !isNaN(bMin) && !isNaN(bMax) && bMin > 0) {
      rmssdS = r < bMin ? Math.min(10, 5 + ((bMin - r) / bMin) * 10) : r > bMax ? 2 : 5;
    }
    mornScore = (morn.symptom_on_waking || 0) * 0.50 + hrv * 0.30 + rmssdS * 0.20;
  }
  if (eveScore !== null && mornScore !== null) return eveScore * 0.40 + mornScore * 0.60;
  return eveScore ?? mornScore;
}

function computeDayRisk(entries, dateStr, settings = {}, overrideEve = null, overrideMorn = null) {
  const entry = entries.find(e => e.date === dateStr);
  const eve   = overrideEve  || entry?.evening || null;
  const morn  = overrideMorn || entry?.morning  || null;
  const base  = computeBaseRisk(eve, morn, settings);
  if (base === null) return null;
  const N = Math.max(0, Math.min(7, parseInt(settings.rollingDays) ?? 3));
  if (N === 0) return Math.min(Math.max(Math.round(base), 0), 10);
  let wSum = 0, wTotal = 0;
  for (let i = 1; i <= N; i++) {
    const prev = entries.find(e => e.date === shiftDate(dateStr, -i));
    if (!prev) continue;
    const s = computeBaseRisk(prev.evening, prev.morning, settings);
    if (s === null) continue;
    const w = 1 / Math.pow(i, 0.7);
    wSum += s * w; wTotal += w;
  }
  const bonus = wTotal > 0 ? ((wSum / wTotal) / 10) * 2 : 0;
  return Math.min(Math.max(Math.round(base + bonus), 0), 10);
}

// ─── Calibration ─────────────────────────────────────────────────────────────

function computeCalibration(entries, settings = {}) {
  const windowDays = parseInt(settings.calibrationDays) ?? 90;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
  const labeled = entries.filter(e => {
    const d = parseDEDate(e.date);
    return d && d >= cutoff && (e.morning?.pem_confirmed === true || e.morning?.pem_confirmed === false);
  });
  if (labeled.length < 5) return null;
  const pemS  = labeled.filter(e => e.morning.pem_confirmed === true ).map(e => computeBaseRisk(e.evening, e.morning, settings)).filter(s => s !== null);
  const noS   = labeled.filter(e => e.morning.pem_confirmed === false).map(e => computeBaseRisk(e.evening, e.morning, settings)).filter(s => s !== null);
  if (!pemS.length || !noS.length) return null;
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const avgPem = avg(pemS), avgNoPem = avg(noS);
  return { threshold: Math.round((avgPem + avgNoPem) / 2), avgPem: avgPem.toFixed(1), avgNoPem: avgNoPem.toFixed(1), n: labeled.length, windowDays };
}

// ─── Correlation Analysis — 3 separate blocks ────────────────────────────────

// Shared helper: get labeled entries within calibration window
function getLabeledInWindow(entries, settings) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (parseInt(settings.calibrationDays) ?? 90));
  const inWin = entries.filter(e => { const d = parseDEDate(e.date); return d && d >= cutoff; });
  const labeled = inWin.filter(e => e.morning?.pem_confirmed === true || e.morning?.pem_confirmed === false);
  const pem   = labeled.filter(e => e.morning.pem_confirmed === true);
  const noPem = labeled.filter(e => e.morning.pem_confirmed === false);
  return { labeled, pem, noPem };
}

function avgArr(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

function mkFactor(key, label, get) {
  return { key, label, get };
}

const SYMPTOM_FACTORS = [
  mkFactor("fatigue",  "Fatigue",           e => e.evening?.fatigue),
  mkFactor("pain",     "Schmerz",           e => e.evening?.pain),
  mkFactor("brainfog", "Brainfog",          e => e.evening?.brainfog),
  mkFactor("sleep",    "Schlafqualität",    e => e.evening?.unrefreshing_sleep_prev),
  mkFactor("sym_wake", "Sym. Aufwachen",    e => e.morning?.symptom_on_waking),
  mkFactor("hrv",      "HFV-Status",        e => e.morning?.hrv_status === "low" ? 10 : e.morning?.hrv_status === "unbalanced" ? 5 : 0),
  mkFactor("rmssd",    "rMSSD",             e => parseFloat(e.morning?.rmssd_garmin) || null),
  mkFactor("hr",       "Morgenpuls",        e => parseFloat(e.morning?.morning_hr) || null),
  mkFactor("breath",   "Atemfrequenz",      e => parseFloat(e.morning?.breath_rate) || null),
];

function scoreFactor(factor, pem, noPem) {
  const pV = pem.map(e => factor.get(e)).filter(v => v !== null && v !== undefined);
  const nV = noPem.map(e => factor.get(e)).filter(v => v !== null && v !== undefined);
  if (pV.length < 2 || nV.length < 2) return null;
  const ap = avgArr(pV), an = avgArr(nV), delta = ap - an;
  if (Math.abs(delta) <= 0.05) return null;
  return { ...factor, avgPem: ap.toFixed(1), avgNoPem: an.toFixed(1), delta, sig: Math.abs(delta) > 1.5 ? "high" : Math.abs(delta) > 0.5 ? "med" : "low" };
}

// Block 1: Same-day — symptoms & biometrics only
function computeSameDayCorrelations(entries, settings = {}) {
  const { pem, noPem, labeled } = getLabeledInWindow(entries, settings);
  if (labeled.length < 7 || !pem.length || !noPem.length) return null;
  return SYMPTOM_FACTORS.map(f => scoreFactor(f, pem, noPem)).filter(Boolean).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// Block 2: Prodromal — same factors but from 1-2 days BEFORE PEM
function computeProdromeCorrelations(entries, settings = {}) {
  const { pem, noPem, labeled } = getLabeledInWindow(entries, settings);
  if (labeled.length < 7 || !pem.length || !noPem.length) return null;

  // For each entry, get average of the factor over the 1-2 days prior
  const getProdrome = (entry, getter) => {
    const vals = [1, 2].map(lag => {
      const prev = entries.find(e => e.date === shiftDate(entry.date, -lag));
      return prev ? getter(prev) : null;
    }).filter(v => v !== null && v !== undefined);
    return vals.length ? avgArr(vals) : null;
  };

  const proFactors = SYMPTOM_FACTORS.map(f => ({
    ...f,
    key: `pro_${f.key}`,
    get: entry => getProdrome(entry, f.get),
  }));

  return proFactors.map(f => scoreFactor(f, pem, noPem)).filter(Boolean).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// Block 3: Trigger & activity lag — uses settings.rollingDays
function computeTriggerLagCorrelations(entries, allTriggers, settings = {}) {
  const lagDays = Math.max(1, Math.min(7, parseInt(settings.rollingDays) ?? 3));
  const { pem, noPem, labeled } = getLabeledInWindow(entries, settings);
  if (labeled.length < 5 || !pem.length || !noPem.length) return null;

  const getLagEntry = entry => entries.find(e => e.date === shiftDate(entry.date, -lagDays));

  const results = [];

  // Triggers (binary: selected or not on lag day)
  for (const t of allTriggers) {
    const pV  = pem.map(e   => (getLagEntry(e)?.evening?.triggers || []).includes(t) ? 1 : 0);
    const nV  = noPem.map(e => (getLagEntry(e)?.evening?.triggers || []).includes(t) ? 1 : 0);
    if (pV.length < 2 || nV.length < 2) continue;
    const ap = avgArr(pV), an = avgArr(nV), delta = ap - an;
    if (Math.abs(delta) <= 0.1) continue;
    results.push({
      key: `t_${t}`, label: t, type: "trigger",
      delta,
      pemRate:   (ap * 100).toFixed(0),
      noPemRate: (an * 100).toFixed(0),
      sig: Math.abs(delta) > 0.4 ? "high" : Math.abs(delta) > 0.2 ? "med" : "low",
    });
  }

  // Activity level (treated as trigger: was activity ≥ "Leicht" on lag day?)
  const actPV  = pem.map(e   => (getLagEntry(e)?.evening?.activity_today ?? 0) >= 2 ? 1 : 0);
  const actNV  = noPem.map(e => (getLagEntry(e)?.evening?.activity_today ?? 0) >= 2 ? 1 : 0);
  if (actPV.length >= 2 && actNV.length >= 2) {
    const ap = avgArr(actPV), an = avgArr(actNV), delta = ap - an;
    if (Math.abs(delta) > 0.1) {
      results.push({
        key: "activity", label: "Aktivitätsniveau (≥ Leicht)", type: "activity",
        delta,
        pemRate:   (ap * 100).toFixed(0),
        noPemRate: (an * 100).toFixed(0),
        sig: Math.abs(delta) > 0.4 ? "high" : Math.abs(delta) > 0.2 ? "med" : "low",
      });
    }
  }

  return results.length ? results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)) : null;
}

// ─── Other Helpers ────────────────────────────────────────────────────────────

function computeStreak(entries) {
  if (!entries.length) return { current: 0, total: 0, complete: 0 };
  const today = new Date();
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const entry = entries.find(e => e.date === mkDateStr(d));
    if (entry && (entry.evening || entry.morning)) streak++;
    else if (i > 0) break;
  }
  return { current: streak, total: entries.length, complete: entries.filter(e => e.evening && e.morning).length };
}

function getTrend14Days(entries, settings) {
  const today = new Date();
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - (13 - i));
    const ds = mkDateStr(d);
    const entry = entries.find(e => e.date === ds);
    return {
      date:  d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      score: computeDayRisk(entries, ds, settings),
      pem:   entry?.morning?.pem_confirmed === true,
    };
  });
}

function buildCSV(entries) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const h = ["Datum","Ab_Fatigue","Ab_Schmerz","Ab_Brainfog","Ab_Schlaf","Ab_PEM_heute","Ab_Aktivitaet","Ab_Trigger","Ab_Notiz","Mo_rMSSD","Mo_HFV","Mo_Puls","Mo_Atemfreq","Mo_Sym_Aufwachen","Mo_PEM_bestaetigt","Mo_Notiz","PEM_Score"];
  const rows = entries.map(e => {
    const ev = e.evening || {}, mo = e.morning || {};
    return [e.date, ev.fatigue??"", ev.pain??"", ev.brainfog??"", ev.unrefreshing_sleep_prev??"",
      ev.pem_today===true?"Ja":ev.pem_today===false?"Nein":"",
      ev.activity_today!==undefined?ACTIVITY_LABELS[ev.activity_today]:"",
      (ev.triggers||[]).join(", "), ev.notes||"",
      mo.rmssd_garmin??"", mo.hrv_status??"", mo.morning_hr??"", mo.breath_rate??"",
      mo.symptom_on_waking??"",
      mo.pem_confirmed===true?"Ja":mo.pem_confirmed===false?"Nein":"",
      mo.notes||"", computeBaseRisk(e.evening,e.morning)?.toFixed(1)??"",
    ].map(q).join(";");
  });
  return "\uFEFF" + [h.map(q).join(";"), ...rows].join("\r\n");
}

function generateTestData() {
  const today = new Date();
  const mkD = ago => { const d = new Date(today); d.setDate(d.getDate()-ago); return mkDateStr(d); };
  const plan = [
    {i:13,e:{f:4,p:3,b:4,s:5,pem:false,act:3,tr:["Körperl. Aktivität"],n:"Kurzer Spaziergang"},m:{r:32,hrv:"balanced",hr:62,br:14,sw:3,pc:false,n:""}},
    {i:12,e:{f:6,p:4,b:5,s:6,pem:false,act:1,tr:[],n:"Etwas erschöpft"},m:{r:25,hrv:"unbalanced",hr:67,br:15,sw:5,pc:false,n:""}},
    {i:11,e:{f:9,p:7,b:8,s:7,pem:true,act:0,tr:[],n:"PEM nach Spaziergang"},m:{r:16,hrv:"low",hr:76,br:17,sw:8,pc:true,n:"Sehr schwer aufgestanden"}},
    {i:10,e:{f:8,p:6,b:7,s:8,pem:false,act:0,tr:[],n:""},m:{r:18,hrv:"low",hr:74,br:16,sw:7,pc:false,n:"Immer noch schlecht"}},
    {i:9, e:{f:6,p:5,b:5,s:6,pem:false,act:0,tr:[],n:"Etwas ruhiger"},m:{r:22,hrv:"unbalanced",hr:70,br:15,sw:5,pc:false,n:""}},
    {i:8, e:{f:5,p:4,b:4,s:5,pem:false,act:2,tr:["Sozialer Kontakt"],n:"Besuch von Tochter"},m:{r:30,hrv:"balanced",hr:63,br:14,sw:4,pc:false,n:""}},
    {i:7, e:{f:7,p:5,b:7,s:6,pem:false,act:1,tr:["Sozialer Kontakt","Emotionale Belastung"],n:""},m:{r:19,hrv:"low",hr:73,br:16,sw:6,pc:false,n:""}},
    {i:6, e:{f:9,p:8,b:9,s:8,pem:true,act:0,tr:[],n:"PEM nach Besuch"},m:{r:14,hrv:"low",hr:80,br:18,sw:9,pc:true,n:"Schlimmste Nacht seit Wochen"}},
    {i:5, e:{f:8,p:6,b:7,s:7,pem:false,act:0,tr:[],n:""},m:{r:17,hrv:"low",hr:76,br:17,sw:7,pc:false,n:""}},
    {i:4, e:{f:6,p:4,b:5,s:6,pem:false,act:0,tr:[],n:"Langsam besser"},m:{r:24,hrv:"unbalanced",hr:68,br:15,sw:5,pc:false,n:""}},
    {i:3, e:{f:5,p:4,b:5,s:5,pem:false,act:2,tr:["Stress","Körperl. Aktivität"],n:"Arzttermin"},m:{r:27,hrv:"balanced",hr:64,br:14,sw:4,pc:false,n:""}},
    {i:2, e:{f:8,p:6,b:8,s:7,pem:true,act:0,tr:[],n:"Nach Arzttermin zusammengebrochen"},m:{r:16,hrv:"low",hr:78,br:17,sw:8,pc:true,n:""}},
    {i:1, e:{f:7,p:5,b:6,s:7,pem:false,act:0,tr:[],n:""},m:{r:21,hrv:"unbalanced",hr:71,br:16,sw:6,pc:false,n:"Etwas besser"}},
    {i:0, e:{f:5,p:4,b:5,s:6,pem:false,act:0,tr:[],n:""},m:{r:26,hrv:"unbalanced",hr:66,br:15,sw:5,pc:null,n:""}},
  ];
  return plan.map(({i,e,m}) => ({
    id: Date.now() - i * 86400000,
    date: mkD(i),
    evening: {fatigue:e.f,pain:e.p,brainfog:e.b,unrefreshing_sleep_prev:e.s,pem_today:e.pem,activity_today:e.act,triggers:e.tr,notes:e.n},
    morning: {rmssd_garmin:String(m.r),hrv_status:m.hrv,morning_hr:String(m.hr),breath_rate:String(m.br),symptom_on_waking:m.sw,pem_confirmed:m.pc,notes:m.n}
  }));
}

// ─── Small UI Components ──────────────────────────────────────────────────────

function SliderField({ label, value, onChange, hint }) {
  return (
    <div style={{ marginBottom: "1.2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.3rem" }}>
        <label style={{ fontSize: "0.78rem", color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</label>
        <span style={{ fontSize: "1.4rem", fontFamily: "monospace", color: "#e2e8f0", fontWeight: 600 }}>{value}</span>
      </div>
      <input type="range" min={0} max={10} value={value} onChange={e => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: "#818cf8" }} />
      {hint && <div style={{ fontSize: "0.7rem", color: "#64748b", marginTop: "0.2rem" }}>{hint}</div>}
    </div>
  );
}

function NumberField({ label, value, onChange, unit, placeholder }) {
  return (
    <div style={{ marginBottom: "1.2rem" }}>
      <label style={{ display: "block", fontSize: "0.78rem", color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "0.4rem" }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input type="number" value={value} placeholder={placeholder || "—"} onChange={e => onChange(e.target.value)}
          style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: "6px", color: "#e2e8f0", padding: "0.45rem 0.7rem", fontSize: "1rem", width: "110px", fontFamily: "monospace" }} />
        {unit && <span style={{ color: "#64748b", fontSize: "0.85rem" }}>{unit}</span>}
      </div>
    </div>
  );
}

function ScoreBar({ value }) {
  const c = value <= 3 ? "#4ade80" : value <= 6 ? "#facc15" : "#f87171";
  return <div style={{ height: "5px", background: "#0f172a", borderRadius: "3px", overflow: "hidden" }}><div style={{ height: "100%", width: `${value * 10}%`, background: c, borderRadius: "3px" }} /></div>;
}

function RiskBadge({ score, threshold }) {
  if (score === null) return null;
  const thresh = threshold ?? 6;
  const color = score <= Math.max(thresh - 3, 2) ? "#4ade80" : score <= thresh ? "#facc15" : "#f87171";
  const label = score <= Math.max(thresh - 3, 2) ? "Niedriges Risiko" : score <= thresh ? "Mittleres Risiko" : "Hohes PEM-Risiko";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.45rem 0.75rem", background: "#1e293b", borderRadius: "10px", border: `1px solid ${color}44` }}>
      <div style={{ width: "9px", height: "9px", borderRadius: "50%", background: color, boxShadow: `0 0 7px ${color}`, flexShrink: 0 }} />
      <div>
        <div style={{ color, fontSize: "0.67rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
        <div style={{ color: "#64748b", fontSize: "0.6rem" }}>Score {score}/10{threshold ? ` · Schwelle ${threshold}` : ""}</div>
      </div>
    </div>
  );
}

function TriggerChips({ selected, onChange, allTriggers, onAddCustom }) {
  const [newTag, setNewTag] = useState("");
  const toggle = t => onChange(selected.includes(t) ? selected.filter(x => x !== t) : [...selected, t]);
  const add = () => { const v = newTag.trim(); if (v && !allTriggers.includes(v)) { onAddCustom(v); setNewTag(""); } };
  return (
    <div style={{ marginBottom: "1.2rem" }}>
      <label style={{ display: "block", fontSize: "0.78rem", color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "0.5rem" }}>Mögliche Trigger heute</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginBottom: "0.5rem" }}>
        {allTriggers.map(t => (
          <button key={t} onClick={() => toggle(t)} style={{ padding: "0.28rem 0.6rem", borderRadius: "20px", cursor: "pointer", fontSize: "0.68rem", fontFamily: "inherit", border: `1px solid ${selected.includes(t) ? "#818cf8" : "#334155"}`, background: selected.includes(t) ? "#1e1b4b" : "#0f172a", color: selected.includes(t) ? "#818cf8" : "#475569" }}>{t}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <input value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => e.key === "Enter" && add()} placeholder="Eigener Trigger…" style={{ flex: 1, background: "#0f172a", border: "1px solid #1e293b", borderRadius: "6px", color: "#e2e8f0", padding: "0.3rem 0.6rem", fontSize: "0.72rem", fontFamily: "inherit" }} />
        <button onClick={add} style={{ padding: "0.3rem 0.7rem", borderRadius: "6px", border: "none", background: "#1e1b4b", color: "#818cf8", cursor: "pointer", fontSize: "0.78rem", fontFamily: "inherit" }}>+ Hinzufügen</button>
      </div>
    </div>
  );
}

// ─── Trend Chart ──────────────────────────────────────────────────────────────

function TrendChart({ data, threshold }) {
  const W = 320, H = 110, P = { t:8, r:8, b:22, l:22 };
  const iW = W-P.l-P.r, iH = H-P.t-P.b;
  const xOf = i => (i/(data.length-1))*iW, yOf = v => iH-(v/10)*iH;
  if (data.filter(d=>d.score!==null).length < 2)
    return <div style={{ height:`${H}px`, display:"flex", alignItems:"center", justifyContent:"center", color:"#334155", fontSize:"0.78rem" }}>Noch zu wenig Daten</div>;
  let pathD = "";
  data.forEach((d,i) => {
    if (d.score===null) return;
    pathD += `${!pathD||data[i-1]?.score===null?"M":"L"}${xOf(i).toFixed(1)} ${yOf(d.score).toFixed(1)} `;
  });
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:"visible", display:"block" }}>
      <g transform={`translate(${P.l},${P.t})`}>
        {[0,3,6,10].map(v => (<g key={v}><line x1={0} x2={iW} y1={yOf(v)} y2={yOf(v)} stroke="#1e293b" strokeWidth={1}/><text x={-4} y={yOf(v)+3} textAnchor="end" fontSize={7} fill="#334155">{v}</text></g>))}
        {threshold && <line x1={0} x2={iW} y1={yOf(threshold)} y2={yOf(threshold)} stroke="#6366f1" strokeWidth={1} strokeDasharray="4,3" opacity={0.7}/>}
        <path d={pathD} fill="none" stroke="#4f46e5" strokeWidth={2} strokeLinejoin="round"/>
        {data.map((d,i) => { if(d.score===null) return null; const c=d.pem?"#f87171":d.score<=3?"#4ade80":d.score<=6?"#facc15":"#f87171"; return (<g key={i}>{d.pem&&<circle cx={xOf(i)} cy={yOf(d.score)} r={8} fill="none" stroke="#f87171" strokeWidth={1} opacity={0.35}/>}<circle cx={xOf(i)} cy={yOf(d.score)} r={d.pem?5:3.5} fill={c} stroke="#020617" strokeWidth={1.5}/></g>); })}
        {data.filter((_,i)=>i%2===0).map((d,idx)=><text key={idx} x={xOf(idx*2)} y={iH+14} textAnchor="middle" fontSize={7} fill="#334155">{d.date}</text>)}
      </g>
    </svg>
  );
}

// ─── Analysis Panels ──────────────────────────────────────────────────────────

function CalibrationPanel({ entries, settings }) {
  const cal = computeCalibration(entries, settings);
  const n   = getLabeledInWindow(entries, settings).labeled.length;
  return (
    <div style={{ background:"#0f172a", borderRadius:"12px", padding:"1rem 1.2rem", border:"1px solid #1e293b", marginBottom:"1rem" }}>
      <div style={{ fontSize:"0.68rem", color:"#818cf8", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"0.7rem" }}>
        Persönliche Kalibrierung · letzte {settings.calibrationDays || 90} Tage
      </div>
      {cal ? (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.6rem", marginBottom:"0.6rem" }}>
            {[["Ø bei PEM",cal.avgPem,"#f87171"],["Ø kein PEM",cal.avgNoPem,"#4ade80"],["Meine Schwelle",cal.threshold,"#818cf8"]].map(([l,v,c])=>(
              <div key={l} style={{ textAlign:"center", background:"#1e293b", borderRadius:"8px", padding:"0.55rem 0.3rem" }}>
                <div style={{ fontSize:"1.2rem", fontFamily:"monospace", fontWeight:700, color:c }}>{v}</div>
                <div style={{ fontSize:"0.58rem", color:"#64748b", marginTop:"0.15rem", lineHeight:1.3 }}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize:"0.68rem", color:"#475569" }}>Basiert auf {n} Tagen · Score ≥ {cal.threshold} = hohes Risiko</div>
        </>
      ) : (
        <div style={{ fontSize:"0.78rem", color:"#475569" }}>Noch nicht genug Daten. <span style={{ color:"#818cf8" }}>{Math.max(0,5-n)} weitere Tage</span> mit Bestätigung nötig.</div>
      )}
    </div>
  );
}

function CorrelationBlock({ title, subtitle, data, barType = "delta" }) {
  if (!data || !data.length) return null;
  const maxAbs = Math.max(...data.map(c => Math.abs(c.delta)));
  return (
    <div style={{ background:"#0f172a", borderRadius:"12px", padding:"1rem 1.2rem", border:"1px solid #1e293b" }}>
      <div style={{ fontSize:"0.68rem", color:"#818cf8", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"0.25rem" }}>{title}</div>
      <div style={{ fontSize:"0.65rem", color:"#334155", marginBottom:"0.8rem" }}>{subtitle}</div>
      {data.map(c => {
        const color = c.sig==="high"?"#f87171":c.sig==="med"?"#facc15":"#475569";
        const isPct = c.pemRate !== undefined;
        return (
          <div key={c.key} style={{ marginBottom:"0.65rem" }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"0.2rem" }}>
              <span style={{ fontSize:"0.7rem", color:"#94a3b8" }}>{c.label}</span>
              {isPct
                ? <span style={{ fontSize:"0.62rem", color, fontFamily:"monospace" }}>{c.pemRate}% PEM · {c.noPemRate}% sonst</span>
                : <span style={{ fontSize:"0.62rem", color, fontFamily:"monospace" }}>Δ {c.delta>0?"+":""}{Number(c.delta).toFixed(1)}</span>
              }
            </div>
            <div style={{ height:"4px", background:"#1e293b", borderRadius:"2px" }}>
              <div style={{ height:"100%", width:`${(Math.abs(c.delta)/maxAbs)*100}%`, background:color, borderRadius:"2px" }}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AnalysisPanel({ entries, allTriggers, settings }) {
  const n = getLabeledInWindow(entries, settings).labeled.length;
  const lagDays = parseInt(settings.rollingDays) || 3;

  if (n < 7) return (
    <div style={{ background:"#0f172a", borderRadius:"12px", padding:"1rem 1.2rem", border:"1px solid #1e293b" }}>
      <div style={{ fontSize:"0.68rem", color:"#818cf8", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"0.5rem" }}>Faktoranalyse</div>
      <div style={{ fontSize:"0.78rem", color:"#475569" }}>Ab 7 bestätigten Tagen wird die Analyse freigeschaltet. <span style={{ color:"#818cf8" }}>Noch {Math.max(0,7-n)} Tage nötig.</span></div>
    </div>
  );

  const sameDay  = computeSameDayCorrelations(entries, settings);
  const prodrome = computeProdromeCorrelations(entries, settings);
  const triggers = computeTriggerLagCorrelations(entries, allTriggers, settings);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"1rem" }}>
      <CorrelationBlock
        title="Am PEM-Tag selbst"
        subtitle={`Symptome & Biometrik — was zeigt der Körper, wenn PEM da ist? · ${n} bestätigte Tage`}
        data={sameDay}
      />
      <CorrelationBlock
        title="Frühwarnsignale (1–2 Tage vorher)"
        subtitle="Waren diese Werte schon vor dem Schub erhöht? Δ = Unterschied zu normalen Vortagen."
        data={prodrome}
      />
      <CorrelationBlock
        title={`Trigger & Aktivität (vor ${lagDays} ${lagDays===1?"Tag":"Tagen"})`}
        subtitle={`Welche Auslöser ${lagDays} ${lagDays===1?"Tag":"Tage"} vor PEM-Tagen traten öfter auf als vor normalen Tagen? Lag-Fenster in Einstellungen anpassen.`}
        data={triggers}
      />
    </div>
  );
}

function StreakBanner({ streak }) {
  const { current, total, complete } = streak;
  const compliance = total > 0 ? Math.round((complete/total)*100) : 0;
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.5rem", marginBottom:"1rem" }}>
      {[["🔥",current,"Tage Streak"],["📋",total,"Einträge"],["✓",`${compliance}%`,"Vollständig"]].map(([icon,val,label])=>(
        <div key={label} style={{ background:"#0f172a", borderRadius:"10px", padding:"0.7rem 0.5rem", textAlign:"center", border:"1px solid #1e293b" }}>
          <div style={{ fontSize:"1rem" }}>{icon}</div>
          <div style={{ fontSize:"1.1rem", fontFamily:"monospace", fontWeight:700, color:"#e2e8f0" }}>{val}</div>
          <div style={{ fontSize:"0.58rem", color:"#475569", marginTop:"0.1rem" }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Entry Card ───────────────────────────────────────────────────────────────

function EntryCard({ entry, onDelete, onEdit, entries, settings }) {
  const [expanded, setExpanded] = useState(false);
  const score = computeDayRisk(entries, entry.date, settings);
  const ev = entry.evening, mo = entry.morning;
  return (
    <div style={{ background:"#1e293b", borderRadius:"12px", border:"1px solid #334155", marginBottom:"0.7rem", overflow:"hidden" }}>
      <div onClick={() => setExpanded(x=>!x)} style={{ padding:"0.9rem 1.1rem 0.7rem", cursor:"pointer" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ color:"#e2e8f0", fontWeight:600, fontSize:"0.88rem" }}>{entry.date}</div>
            <div style={{ color:"#64748b", fontSize:"0.65rem", marginTop:"0.1rem" }}>
              {ev?"🌙 ✓":"🌙 —"}&nbsp;&nbsp;{mo?"🌅 ✓":"🌅 —"}
              {mo?.pem_confirmed===true&&<span style={{ color:"#f87171", marginLeft:"0.4rem" }}>· PEM</span>}
              {mo?.pem_confirmed===false&&<span style={{ color:"#4ade80", marginLeft:"0.4rem" }}>· kein PEM</span>}
            </div>
          </div>
          <div style={{ display:"flex", gap:"0.4rem", alignItems:"center" }}>
            {score!==null&&<div style={{ padding:"0.18rem 0.5rem", borderRadius:"20px", fontSize:"0.68rem", fontWeight:700, background:score<=3?"#16a34a22":score<=6?"#ca8a0422":"#dc262622", color:score<=3?"#4ade80":score<=6?"#facc15":"#f87171" }}>{score}/10</div>}
            <span style={{ color:"#334155", fontSize:"0.8rem" }}>{expanded?"▲":"▼"}</span>
          </div>
        </div>
        {ev&&(<div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.4rem", marginTop:"0.5rem" }}>{[["Fatigue",ev.fatigue],["Schmerz",ev.pain],["Brainfog",ev.brainfog]].map(([l,v])=>(<div key={l}><div style={{ fontSize:"0.6rem", color:"#64748b", marginBottom:"0.15rem" }}>{l}: {v}</div><ScoreBar value={v}/></div>))}</div>)}
        {ev?.triggers?.length>0&&(<div style={{ display:"flex", flexWrap:"wrap", gap:"0.25rem", marginTop:"0.4rem" }}>{ev.triggers.map(t=><span key={t} style={{ fontSize:"0.58rem", padding:"0.1rem 0.35rem", background:"#1e1b4b", color:"#818cf8", borderRadius:"10px" }}>{t}</span>)}</div>)}
        {mo?.hrv_status&&(<div style={{ fontSize:"0.67rem", color:HRV_COLORS[mo.hrv_status], marginTop:"0.3rem" }}>HFV: {HRV_LABELS[mo.hrv_status]}{mo.rmssd_garmin?` · ${mo.rmssd_garmin} ms`:""}{mo.morning_hr?` · ${mo.morning_hr} bpm`:""}</div>)}
      </div>
      {expanded&&(
        <div style={{ padding:"0 1.1rem 0.9rem", borderTop:"1px solid #334155" }}>
          <div style={{ paddingTop:"0.8rem", display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0.5rem 1rem", marginBottom:"0.7rem" }}>
            {[["Schlaf Vornacht",ev?.unrefreshing_sleep_prev,"/10"],["Aktivität",ev?.activity_today!==undefined?ACTIVITY_LABELS[ev.activity_today]:"—",""],["PEM heute",ev?.pem_today===true?"Ja":ev?.pem_today===false?"Nein":"—",""],["Morgen-rMSSD",mo?.rmssd_garmin?`${mo.rmssd_garmin} ms`:"—",""],["Morgenpuls",mo?.morning_hr?`${mo.morning_hr} bpm`:"—",""],["Atemfrequenz",mo?.breath_rate?`${mo.breath_rate}/min`:"—",""],["Sym. Aufwachen",mo?.symptom_on_waking!==undefined?mo.symptom_on_waking:"—",mo?.symptom_on_waking!==undefined?"/10":""]].map(([l,v,u])=>(<div key={l}><div style={{ fontSize:"0.6rem", color:"#475569", marginBottom:"0.1rem" }}>{l}</div><div style={{ fontSize:"0.82rem", color:"#e2e8f0", fontFamily:typeof v==="number"?"monospace":"inherit" }}>{v}{u}</div></div>))}
          </div>
          {ev?.notes&&<div style={{ marginBottom:"0.5rem", padding:"0.5rem 0.7rem", background:"#0f172a", borderRadius:"6px" }}><div style={{ fontSize:"0.6rem", color:"#475569", marginBottom:"0.2rem" }}>🌙 Notiz Abend</div><div style={{ fontSize:"0.75rem", color:"#94a3b8", fontStyle:"italic" }}>{ev.notes}</div></div>}
          {mo?.notes&&<div style={{ marginBottom:"0.7rem", padding:"0.5rem 0.7rem", background:"#0f172a", borderRadius:"6px" }}><div style={{ fontSize:"0.6rem", color:"#475569", marginBottom:"0.2rem" }}>🌅 Notiz Morgen</div><div style={{ fontSize:"0.75rem", color:"#94a3b8", fontStyle:"italic" }}>{mo.notes}</div></div>}
          <div style={{ display:"flex", gap:"0.5rem" }}>
            <button onClick={()=>onEdit(entry)} style={{ flex:1, padding:"0.45rem", borderRadius:"8px", border:"1px solid #334155", background:"none", color:"#818cf8", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem", fontWeight:600 }}>✏ Bearbeiten</button>
            <button onClick={()=>onDelete(entry.id)} style={{ padding:"0.45rem 0.9rem", borderRadius:"8px", border:"1px solid #334155", background:"none", color:"#475569", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem" }}>Löschen</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditModal({ entry, onSave, onClose, allTriggers, onAddCustomTrigger }) {
  const [tab,  setTab]  = useState(entry.evening?"evening":"morning");
  const [eve,  setEve]  = useState({...DEFAULT_EVENING,  ...(entry.evening||{})});
  const [morn, setMorn] = useState({...DEFAULT_MORNING,  ...(entry.morning||{})});
  return (
    <div style={{ position:"fixed", inset:0, background:"#020617f0", zIndex:50, overflowY:"auto" }}>
      <div style={{ maxWidth:"480px", margin:"0 auto", padding:"1rem 1rem 5rem" }}>
        <div style={{ background:"#0f172a", borderRadius:"14px", border:"1px solid #1e293b" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"1rem 1.2rem 0.8rem", borderBottom:"1px solid #1e293b" }}>
            <div><div style={{ fontSize:"0.65rem", color:"#4f46e5", letterSpacing:"0.12em", textTransform:"uppercase" }}>Eintrag bearbeiten</div><div style={{ fontSize:"0.95rem", fontWeight:600, color:"#e2e8f0" }}>{entry.date}</div></div>
            <button onClick={onClose} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", fontSize:"1.5rem", lineHeight:1 }}>×</button>
          </div>
          <div style={{ display:"flex", gap:"0.5rem", padding:"0.8rem 1.2rem 0" }}>
            {[["evening","🌙 Abend"],["morning","🌅 Morgen"]].map(([v,l])=>(<button key={v} onClick={()=>setTab(v)} style={{ flex:1, padding:"0.48rem", borderRadius:"8px", cursor:"pointer", fontFamily:"inherit", fontSize:"0.82rem", fontWeight:600, border:`1px solid ${tab===v?"#818cf8":"#1e293b"}`, background:tab===v?"#1e1b4b":"#0f172a", color:tab===v?"#818cf8":"#475569" }}>{l}</button>))}
          </div>
          <div style={{ padding:"0.8rem 1.2rem 0" }}>
            {tab==="evening"&&<>
              <SliderField label="Fatigue" value={eve.fatigue} onChange={v=>setEve(s=>({...s,fatigue:v}))} hint="0 = keine · 10 = maximal"/>
              <SliderField label="Schmerz" value={eve.pain} onChange={v=>setEve(s=>({...s,pain:v}))}/>
              <SliderField label="Brainfog" value={eve.brainfog} onChange={v=>setEve(s=>({...s,brainfog:v}))}/>
              <SliderField label="Schlafqualität letzte Nacht" value={eve.unrefreshing_sleep_prev} onChange={v=>setEve(s=>({...s,unrefreshing_sleep_prev:v}))} hint="0 = erholsam · 10 = unerholsam"/>
              <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.4rem" }}>Aktivitätsniveau</label><div style={{ display:"flex", gap:"0.35rem" }}>{ACTIVITY_LABELS.map((l,i)=><button key={i} onClick={()=>setEve(s=>({...s,activity_today:i}))} style={{ flex:1, padding:"0.38rem 0.15rem", borderRadius:"6px", border:"none", cursor:"pointer", fontSize:"0.58rem", fontFamily:"inherit", background:eve.activity_today===i?"#4f46e5":"#1e293b", color:eve.activity_today===i?"#fff":"#475569" }}>{l}</button>)}</div></div>
              <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.35rem" }}>PEM heute?</label><div style={{ display:"flex", gap:"0.5rem" }}>{[["Ja",true],["Nein",false]].map(([l,v])=><button key={l} onClick={()=>setEve(s=>({...s,pem_today:v}))} style={{ padding:"0.38rem 1.1rem", borderRadius:"6px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"0.82rem", background:eve.pem_today===v?(v?"#7f1d1d":"#14532d"):"#1e293b", color:eve.pem_today===v?"#fff":"#475569" }}>{l}</button>)}</div></div>
              <TriggerChips selected={eve.triggers||[]} onChange={triggers=>setEve(s=>({...s,triggers}))} allTriggers={allTriggers} onAddCustom={onAddCustomTrigger}/>
              <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.35rem" }}>Notiz</label><textarea value={eve.notes} onChange={e=>setEve(s=>({...s,notes:e.target.value}))} style={{ width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", color:"#e2e8f0", padding:"0.55rem 0.75rem", fontSize:"0.85rem", fontFamily:"inherit", minHeight:"58px" }}/></div>
            </>}
            {tab==="morning"&&<>
              <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.45rem" }}>Garmin HFV-Status</label><div style={{ display:"flex", gap:"0.45rem" }}>{HRV_OPTIONS.map(v=><button key={v} onClick={()=>setMorn(s=>({...s,hrv_status:v}))} style={{ flex:1, padding:"0.48rem 0.2rem", borderRadius:"8px", cursor:"pointer", fontFamily:"inherit", fontSize:"0.68rem", fontWeight:600, border:`1px solid ${morn.hrv_status===v?HRV_COLORS[v]:"#334155"}`, background:morn.hrv_status===v?`${HRV_COLORS[v]}22`:"#1e293b", color:morn.hrv_status===v?HRV_COLORS[v]:"#475569" }}>{HRV_LABELS[v]}</button>)}</div></div>
              <NumberField label="rMSSD" value={morn.rmssd_garmin} onChange={v=>setMorn(s=>({...s,rmssd_garmin:v}))} unit="ms" placeholder="z.B. 28"/>
              <NumberField label="Morgenpuls (liegend)" value={morn.morning_hr} onChange={v=>setMorn(s=>({...s,morning_hr:v}))} unit="bpm" placeholder="z.B. 58"/>
              <NumberField label="Atemfrequenz" value={morn.breath_rate} onChange={v=>setMorn(s=>({...s,breath_rate:v}))} unit="/min" placeholder="z.B. 16"/>
              <SliderField label="Symptomstärke beim Aufwachen" value={morn.symptom_on_waking} onChange={v=>setMorn(s=>({...s,symptom_on_waking:v}))} hint="0 = keine · 10 = schwer"/>
              <div style={{ marginBottom:"1.2rem", padding:"0.85rem 1rem", background:"#1e293b", borderRadius:"10px", border:"1px solid #334155" }}><div style={{ fontSize:"0.7rem", color:"#818cf8", fontWeight:600, marginBottom:"0.25rem" }}>War gestern ein PEM-Tag?</div><div style={{ fontSize:"0.68rem", color:"#64748b", marginBottom:"0.55rem" }}>Kalibriert deine persönliche Risikoschwelle.</div><div style={{ display:"flex", gap:"0.45rem" }}>{[["Ja — PEM",true],["Nein",false],["Unsicher",null]].map(([l,v])=><button key={l} onClick={()=>setMorn(s=>({...s,pem_confirmed:v}))} style={{ flex:1, padding:"0.38rem 0.25rem", borderRadius:"6px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"0.68rem", fontWeight:600, background:morn.pem_confirmed===v?(v===true?"#7f1d1d":v===false?"#14532d":"#334155"):"#0f172a", color:morn.pem_confirmed===v?"#fff":"#475569" }}>{l}</button>)}</div></div>
              <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.35rem" }}>Notiz</label><textarea value={morn.notes} onChange={e=>setMorn(s=>({...s,notes:e.target.value}))} style={{ width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", color:"#e2e8f0", padding:"0.55rem 0.75rem", fontSize:"0.85rem", fontFamily:"inherit", minHeight:"58px" }}/></div>
            </>}
          </div>
          <div style={{ display:"flex", gap:"0.5rem", padding:"0 1.2rem 1.2rem" }}>
            <button onClick={onClose} style={{ padding:"0.65rem 1rem", borderRadius:"8px", border:"1px solid #334155", background:"none", color:"#64748b", cursor:"pointer", fontFamily:"inherit" }}>Abbrechen</button>
            <button onClick={()=>{onSave({...entry,evening:{...eve},morning:{...morn}});onClose();}} style={{ flex:1, padding:"0.65rem", borderRadius:"8px", border:"none", background:"#4f46e5", color:"#fff", cursor:"pointer", fontFamily:"inherit", fontWeight:700, fontSize:"0.9rem" }}>Speichern</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function OnboardingModal({ onComplete }) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState({ baselineRmssdMin:"", baselineRmssdMax:"", eveningTime:"20:00", morningTime:"07:30", showStreak:true });
  const steps = [
    { title:"Willkommen 👋", sub:"Dieses Tool hilft dir, PEM-Episoden vorherzusagen und persönliche Auslöser zu erkennen.", content:null },
    { title:"Garmin rMSSD Baseline", sub:"Dein normaler rMSSD-Bereich. Garmin App → HFV → 30-Tage-Übersicht.",
      content:<div><div style={{ display:"flex", gap:"0.8rem", alignItems:"flex-end" }}>{[["Min","baselineRmssdMin","z.B. 20"],["Max","baselineRmssdMax","z.B. 40"]].map(([l,k,ph])=><div key={k}><label style={{ fontSize:"0.7rem", color:"#64748b", display:"block", marginBottom:"0.3rem" }}>{l}</label><input type="number" value={data[k]} placeholder={ph} onChange={e=>setData(d=>({...d,[k]:e.target.value}))} style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:"6px", color:"#e2e8f0", padding:"0.5rem 0.7rem", width:"90px", fontFamily:"monospace", fontSize:"1rem" }}/></div>)}<span style={{ color:"#475569", fontSize:"0.8rem", paddingBottom:"0.5rem" }}>ms</span></div><div style={{ fontSize:"0.67rem", color:"#334155", marginTop:"0.6rem" }}>Unbekannt? Leer lassen, später in Einstellungen ergänzen.</div></div>},
    { title:"Erinnerungszeiten", sub:"Wann soll die App erinnern?",
      content:<div style={{ display:"flex", flexDirection:"column", gap:"1rem" }}>{[["🌙 Abend","eveningTime"],["🌅 Morgen","morningTime"]].map(([l,k])=><div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}><label style={{ fontSize:"0.82rem", color:"#94a3b8" }}>{l}</label><input type="time" value={data[k]} onChange={e=>setData(d=>({...d,[k]:e.target.value}))} style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:"6px", color:"#e2e8f0", padding:"0.4rem 0.7rem", fontFamily:"monospace", fontSize:"0.95rem", colorScheme:"dark" }}/></div>)}</div>},
    { title:"Fast fertig ✓", sub:"Streak-Anzeige aktivieren?",
      content:<div style={{ display:"flex", gap:"0.7rem" }}>{[["Ja",true],["Nein",false]].map(([l,v])=><button key={l} onClick={()=>setData(d=>({...d,showStreak:v}))} style={{ flex:1, padding:"0.65rem", borderRadius:"8px", cursor:"pointer", fontFamily:"inherit", fontSize:"0.85rem", fontWeight:600, border:`1px solid ${data.showStreak===v?"#818cf8":"#334155"}`, background:data.showStreak===v?"#1e1b4b":"#1e293b", color:data.showStreak===v?"#818cf8":"#475569" }}>{l}</button>)}</div>},
  ];
  const cur = steps[step];
  return (
    <div style={{ position:"fixed", inset:0, background:"#020617ee", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:"1rem" }}>
      <div style={{ background:"#0f172a", borderRadius:"16px", padding:"1.7rem 1.4rem", maxWidth:"340px", width:"100%", border:"1px solid #1e293b" }}>
        <div style={{ display:"flex", gap:"0.3rem", marginBottom:"1.3rem" }}>{steps.map((_,i)=><div key={i} style={{ flex:1, height:"3px", borderRadius:"2px", background:i<=step?"#818cf8":"#1e293b", transition:"background 0.3s" }}/>)}</div>
        <div style={{ fontSize:"1.1rem", fontWeight:700, color:"#e2e8f0", marginBottom:"0.45rem" }}>{cur.title}</div>
        <div style={{ fontSize:"0.78rem", color:"#64748b", marginBottom:"1.2rem", lineHeight:1.5 }}>{cur.sub}</div>
        {cur.content&&<div style={{ marginBottom:"1.3rem" }}>{cur.content}</div>}
        <div style={{ display:"flex", gap:"0.5rem" }}>
          {step>0&&<button onClick={()=>setStep(s=>s-1)} style={{ padding:"0.6rem 1rem", borderRadius:"8px", border:"1px solid #334155", background:"none", color:"#64748b", cursor:"pointer", fontFamily:"inherit" }}>Zurück</button>}
          <button onClick={()=>step===steps.length-1?onComplete(data):setStep(s=>s+1)} style={{ flex:1, padding:"0.65rem", borderRadius:"8px", border:"none", background:"#4f46e5", color:"#fff", cursor:"pointer", fontFamily:"inherit", fontWeight:700, fontSize:"0.9rem" }}>{step===steps.length-1?"Loslegen →":"Weiter"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function SettingsTab({ settings:s, onUpdate, entries, onLoadTestData, allTriggers, onDeleteAll }) {
  const [notifStatus,    setNotifStatus]    = useState(null);
  const [newTrigger,     setNewTrigger]     = useState("");
  const [confirmDelete,  setConfirmDelete]  = useState(false);

  const requestNotif = async () => {
    if (!("Notification" in window)) { setNotifStatus("unsupported"); return; }
    const p = await Notification.requestPermission();
    setNotifStatus(p);
    if (p==="granted") onUpdate({notificationsEnabled:true});
  };
  const addTrigger    = () => { const v=newTrigger.trim(); if(v&&!allTriggers.includes(v)){onUpdate({customTriggers:[...(s.customTriggers||[]),v]});setNewTrigger("");} };
  const removeTrigger = t => onUpdate({customTriggers:(s.customTriggers||[]).filter(x=>x!==t)});

  const sec  = { background:"#0f172a", borderRadius:"12px", padding:"1rem 1.2rem", border:"1px solid #1e293b", marginBottom:"0.8rem" };
  const sLbl = { fontSize:"0.68rem", color:"#818cf8", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"0.8rem" };

  const NumRow = ({label, hint, skey, min, max, unit}) => (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.7rem" }}>
      <div><div style={{ fontSize:"0.82rem", color:"#94a3b8" }}>{label}</div>{hint&&<div style={{ fontSize:"0.62rem", color:"#334155", marginTop:"0.1rem" }}>{hint}</div>}</div>
      <div style={{ display:"flex", alignItems:"center", gap:"0.4rem" }}>
        <input type="number" min={min} max={max} value={s[skey]} onChange={e=>onUpdate({[skey]:Number(e.target.value)})} style={{ width:"58px", background:"#1e293b", border:"1px solid #334155", borderRadius:"6px", color:"#e2e8f0", padding:"0.35rem 0.5rem", fontFamily:"monospace", fontSize:"0.9rem", textAlign:"center" }}/>
        {unit&&<span style={{ fontSize:"0.72rem", color:"#475569" }}>{unit}</span>}
      </div>
    </div>
  );

  return (
    <div>
      <div style={sec}>
        <div style={sLbl}>Garmin rMSSD Baseline</div>
        <div style={{ display:"flex", gap:"0.8rem", alignItems:"flex-end" }}>
          {[["Min","baselineRmssdMin"],["Max","baselineRmssdMax"]].map(([l,k])=>(<div key={k}><label style={{ fontSize:"0.68rem", color:"#64748b", display:"block", marginBottom:"0.3rem" }}>{l}</label><input type="number" value={s[k]} placeholder="—" onChange={e=>onUpdate({[k]:e.target.value})} style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:"6px", color:"#e2e8f0", padding:"0.4rem 0.6rem", width:"80px", fontFamily:"monospace", fontSize:"0.9rem" }}/></div>))}
          <span style={{ color:"#475569", fontSize:"0.78rem", paddingBottom:"0.4rem" }}>ms</span>
        </div>
        <div style={{ fontSize:"0.65rem", color:"#334155", marginTop:"0.5rem" }}>Garmin App → HFV → 30-Tage-Übersicht</div>
      </div>

      <div style={sec}>
        <div style={sLbl}>Algorithmus-Parameter</div>
        <NumRow label="Zeitverzögerungs-Fenster" hint="Vortage im Risiko-Score + Lag für Trigger-Analyse" skey="rollingDays" min={0} max={7} unit="Tage"/>
        <NumRow label="Kalibrierungsfenster" hint="Bei Zustandsveränderung verkleinern" skey="calibrationDays" min={14} max={365} unit="Tage"/>
      </div>

      <div style={sec}>
        <div style={sLbl}>Eigene Trigger-Kategorien</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:"0.35rem", marginBottom:"0.6rem" }}>
          {(s.customTriggers||[]).map(t=>(<div key={t} style={{ display:"flex", alignItems:"center", gap:"0.3rem", padding:"0.25rem 0.5rem 0.25rem 0.65rem", borderRadius:"20px", background:"#1e1b4b", border:"1px solid #4f46e5" }}><span style={{ fontSize:"0.68rem", color:"#818cf8" }}>{t}</span><button onClick={()=>removeTrigger(t)} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", fontSize:"0.85rem", lineHeight:1, padding:0 }}>×</button></div>))}
          {!(s.customTriggers||[]).length&&<div style={{ fontSize:"0.72rem", color:"#334155" }}>Noch keine eigenen Trigger</div>}
        </div>
        <div style={{ display:"flex", gap:"0.4rem" }}>
          <input value={newTrigger} onChange={e=>setNewTrigger(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addTrigger()} placeholder="Neuer Trigger…" style={{ flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:"6px", color:"#e2e8f0", padding:"0.38rem 0.6rem", fontSize:"0.78rem", fontFamily:"inherit" }}/>
          <button onClick={addTrigger} style={{ padding:"0.38rem 0.8rem", borderRadius:"6px", border:"none", background:"#1e1b4b", color:"#818cf8", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem" }}>+ Hinzufügen</button>
        </div>
        <div style={{ fontSize:"0.65rem", color:"#334155", marginTop:"0.5rem" }}>Eigene Trigger fließen automatisch in die Lag-Analyse ein.</div>
      </div>

      <div style={sec}>
        <div style={sLbl}>Erinnerungszeiten</div>
        {[["🌙 Abend","eveningTime"],["🌅 Morgen","morningTime"]].map(([l,k])=>(<div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.7rem" }}><span style={{ fontSize:"0.82rem", color:"#94a3b8" }}>{l}</span><input type="time" value={s[k]} onChange={e=>onUpdate({[k]:e.target.value})} style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:"6px", color:"#e2e8f0", padding:"0.33rem 0.6rem", fontFamily:"monospace", fontSize:"0.88rem", colorScheme:"dark" }}/></div>))}
        <button onClick={requestNotif} style={{ width:"100%", padding:"0.5rem", borderRadius:"8px", border:`1px solid ${s.notificationsEnabled?"#4ade80":"#334155"}`, background:s.notificationsEnabled?"#14532d22":"#1e293b", color:s.notificationsEnabled?"#4ade80":"#64748b", cursor:"pointer", fontFamily:"inherit", fontSize:"0.8rem", fontWeight:600 }}>
          {s.notificationsEnabled?"✓ Benachrichtigungen aktiv":"Benachrichtigungen aktivieren"}
        </button>
        {notifStatus==="denied"&&<div style={{ fontSize:"0.65rem", color:"#f87171", marginTop:"0.4rem" }}>Blockiert — Chrome-Einstellungen → Benachrichtigungen erlauben.</div>}
      </div>

      <div style={sec}>
        <div style={sLbl}>Anzeige</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:"0.82rem", color:"#94a3b8" }}>Streak & Compliance anzeigen</span>
          <button onClick={()=>onUpdate({showStreak:!s.showStreak})} style={{ width:"42px", height:"23px", borderRadius:"12px", border:"none", cursor:"pointer", background:s.showStreak?"#4f46e5":"#334155", position:"relative", transition:"background 0.2s" }}><div style={{ position:"absolute", top:"2.5px", left:s.showStreak?"21px":"2.5px", width:"18px", height:"18px", borderRadius:"50%", background:"#fff", transition:"left 0.2s" }}/></button>
        </div>
      </div>

      <div style={sec}>
        <div style={sLbl}>Daten</div>
        <div style={{ fontSize:"0.78rem", color:"#475569", marginBottom:"0.8rem" }}>{entries.length} Einträge · {entries.filter(e=>e.evening&&e.morning).length} vollständig</div>
        <div style={{ display:"flex", flexDirection:"column", gap:"0.5rem" }}>
          <button onClick={onLoadTestData} style={{ padding:"0.5rem", borderRadius:"8px", border:"1px solid #334155", background:"#1e293b", color:"#64748b", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem" }}>Testdaten laden (14 Tage)</button>
          <button onClick={()=>onUpdate({setupDone:false})} style={{ padding:"0.5rem", borderRadius:"8px", border:"1px solid #334155", background:"none", color:"#475569", cursor:"pointer", fontFamily:"inherit", fontSize:"0.75rem" }}>Einrichtungsassistent erneut starten</button>
          {!confirmDelete
            ? <button onClick={()=>setConfirmDelete(true)} style={{ padding:"0.5rem", borderRadius:"8px", border:"1px solid #7f1d1d", background:"none", color:"#f87171", cursor:"pointer", fontFamily:"inherit", fontSize:"0.75rem" }}>Alle Daten löschen …</button>
            : <div style={{ background:"#7f1d1d22", borderRadius:"8px", padding:"0.7rem", border:"1px solid #7f1d1d" }}>
                <div style={{ fontSize:"0.75rem", color:"#fca5a5", marginBottom:"0.5rem" }}>Alle {entries.length} Einträge unwiderruflich löschen?</div>
                <div style={{ display:"flex", gap:"0.5rem" }}>
                  <button onClick={()=>setConfirmDelete(false)} style={{ flex:1, padding:"0.4rem", borderRadius:"6px", border:"1px solid #334155", background:"none", color:"#94a3b8", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem" }}>Abbrechen</button>
                  <button onClick={()=>{onDeleteAll();setConfirmDelete(false);}} style={{ flex:1, padding:"0.4rem", borderRadius:"6px", border:"none", background:"#7f1d1d", color:"#fff", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem", fontWeight:600 }}>Ja, löschen</button>
                </div>
              </div>
          }
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function PEMTracker() {
  const [entries,        setEntries]        = useState([]);
  const [settings,       setSettings]       = useState({...DEFAULT_SETTINGS});
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [editEntry,      setEditEntry]      = useState(null);
  const [tab,            setTab]            = useState("log");
  const [subTab,         setSubTab]         = useState("evening");
  const [showCSV,        setShowCSV]        = useState(false);
  const [evening,        setEvening]        = useState({...DEFAULT_EVENING});
  const [morning,        setMorning]        = useState({...DEFAULT_MORNING});
  const [savedToday,     setSavedToday]     = useState({evening:false,morning:false});

  const today       = mkDateStr(new Date());
  const allTriggers = [...BUILTIN_TRIGGERS, ...(settings.customTriggers||[])];

  useEffect(()=>{
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setEntries(JSON.parse(raw));
      const rs = localStorage.getItem(SETTINGS_KEY);
      if (rs) { const s=JSON.parse(rs); setSettings({...DEFAULT_SETTINGS,...s}); if(!s.setupDone) setShowOnboarding(true); }
      else setShowOnboarding(true);
    } catch { setShowOnboarding(true); }
  },[]);

  const persist        = u => { setEntries(u); try{localStorage.setItem(STORAGE_KEY,JSON.stringify(u));}catch{} };
  const updateSettings = p => { const n={...settings,...p}; setSettings(n); try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(n));}catch{} };
  const completeOnboarding = d => { updateSettings({...d,setupDone:true}); setShowOnboarding(false); };
  const deleteAll      = () => { persist([]); setSavedToday({evening:false,morning:false}); setEvening({...DEFAULT_EVENING}); setMorning({...DEFAULT_MORNING}); };

  const save = key => {
    const updated=[...entries];
    const idx=updated.findIndex(e=>e.date===today);
    const data=key==="evening"?{...evening}:{...morning};
    if(idx>=0) updated[idx][key]=data;
    else { const e={id:Date.now(),date:today}; e[key]=data; updated.unshift(e); }
    persist(updated);
    setSavedToday(s=>({...s,[key]:true}));
  };

  const deleteEntry     = id => persist(entries.filter(e=>e.id!==id));
  const saveEditedEntry = u  => persist(entries.map(e=>e.id===u.id?u:e));
  const loadTestData    = () => { persist(generateTestData()); setTab("history"); };
  const addCustomTrigger = t => updateSettings({customTriggers:[...(settings.customTriggers||[]),t]});

  const todayEntry = entries.find(e=>e.date===today);
  const cal        = computeCalibration(entries,settings);
  const streak     = computeStreak(entries);
  const trendData  = getTrend14Days(entries,settings);
  const riskScore  = computeDayRisk(entries,today,settings,
    todayEntry?.evening||(savedToday.evening?evening:null),
    todayEntry?.morning||(savedToday.morning?morning:null));

  const panel = { background:"#0f172a", borderRadius:"14px", padding:"1.3rem 1.4rem", border:"1px solid #1e293b", marginBottom:"1rem" };
  const TABS  = [{key:"log",icon:"📝",label:"Eingabe"},{key:"history",icon:"📋",label:"Verlauf"},{key:"analysis",icon:"📊",label:"Analyse"},{key:"settings",icon:"⚙️",label:"Einstellungen"}];

  return (
    <div style={{ minHeight:"100vh", background:"#020617", color:"#e2e8f0", fontFamily:"'Segoe UI', sans-serif", paddingBottom:"5rem", maxWidth:"480px", margin:"0 auto" }}>
      <style>{`input[type=range]{height:4px;border-radius:2px;cursor:pointer} *{box-sizing:border-box} textarea{resize:vertical}`}</style>

      {showOnboarding&&<OnboardingModal onComplete={completeOnboarding}/>}
      {editEntry&&<EditModal entry={editEntry} onSave={saveEditedEntry} onClose={()=>setEditEntry(null)} allTriggers={allTriggers} onAddCustomTrigger={addCustomTrigger}/>}

      <div style={{ padding:"1.4rem 1rem 0.7rem", position:"sticky", top:0, background:"#020617ee", backdropFilter:"blur(8px)", zIndex:10, borderBottom:"1px solid #0f172a" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ fontSize:"0.62rem", color:"#4f46e5", letterSpacing:"0.15em", textTransform:"uppercase", marginBottom:"0.15rem" }}>PEM-Prädiktor</div>
            <h1 style={{ margin:0, fontSize:"1.2rem", fontWeight:700, color:"#e2e8f0" }}>Tagesprotokoll</h1>
            <div style={{ color:"#334155", fontSize:"0.7rem", marginTop:"0.1rem" }}>{today}</div>
          </div>
          {riskScore!==null&&<RiskBadge score={riskScore} threshold={cal?.threshold}/>}
        </div>
      </div>

      <div style={{ padding:"0.9rem 1rem" }}>
        {tab==="log"&&(<>
          <div style={{ display:"flex", gap:"0.5rem", marginBottom:"1rem" }}>
            {[["evening","🌙 Abend"],["morning","🌅 Morgen"]].map(([v,l])=>(<button key={v} onClick={()=>setSubTab(v)} style={{ flex:1, padding:"0.5rem", borderRadius:"8px", cursor:"pointer", fontFamily:"inherit", fontSize:"0.82rem", fontWeight:600, position:"relative", border:`1px solid ${subTab===v?"#818cf8":"#1e293b"}`, background:subTab===v?"#1e1b4b":"#0f172a", color:subTab===v?"#818cf8":"#475569" }}>{l}{savedToday[v]&&<span style={{ position:"absolute", top:"4px", right:"6px", width:"6px", height:"6px", borderRadius:"50%", background:"#4ade80" }}/>}</button>))}
          </div>

          {subTab==="evening"&&(<div style={panel}>
            <div style={{ fontSize:"0.67rem", color:"#4f46e5", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"1.1rem" }}>Abend-Eingabe · {settings.eveningTime} Uhr</div>
            <SliderField label="Fatigue" value={evening.fatigue} onChange={v=>setEvening(s=>({...s,fatigue:v}))} hint="0 = keine · 10 = maximal"/>
            <SliderField label="Schmerz" value={evening.pain} onChange={v=>setEvening(s=>({...s,pain:v}))}/>
            <SliderField label="Brainfog" value={evening.brainfog} onChange={v=>setEvening(s=>({...s,brainfog:v}))}/>
            <SliderField label="Schlafqualität letzte Nacht" value={evening.unrefreshing_sleep_prev} onChange={v=>setEvening(s=>({...s,unrefreshing_sleep_prev:v}))} hint="0 = erholsam · 10 = unerholsam"/>
            <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.4rem" }}>Aktivitätsniveau heute</label><div style={{ display:"flex", gap:"0.35rem" }}>{ACTIVITY_LABELS.map((l,i)=><button key={i} onClick={()=>setEvening(s=>({...s,activity_today:i}))} style={{ flex:1, padding:"0.38rem 0.15rem", borderRadius:"6px", border:"none", cursor:"pointer", fontSize:"0.58rem", fontFamily:"inherit", lineHeight:1.3, background:evening.activity_today===i?"#4f46e5":"#1e293b", color:evening.activity_today===i?"#fff":"#475569" }}>{l}</button>)}</div></div>
            <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.35rem" }}>PEM heute?</label><div style={{ display:"flex", gap:"0.5rem" }}>{[["Ja",true],["Nein",false]].map(([l,v])=><button key={l} onClick={()=>setEvening(s=>({...s,pem_today:v}))} style={{ padding:"0.38rem 1.1rem", borderRadius:"6px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"0.82rem", background:evening.pem_today===v?(v?"#7f1d1d":"#14532d"):"#1e293b", color:evening.pem_today===v?"#fff":"#475569" }}>{l}</button>)}</div></div>
            <TriggerChips selected={evening.triggers} onChange={triggers=>setEvening(s=>({...s,triggers}))} allTriggers={allTriggers} onAddCustom={addCustomTrigger}/>
            <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.35rem" }}>Notiz</label><textarea value={evening.notes} onChange={e=>setEvening(s=>({...s,notes:e.target.value}))} placeholder="z.B. Besuch, emotionaler Stress, Wetter…" style={{ width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", color:"#e2e8f0", padding:"0.55rem 0.75rem", fontSize:"0.85rem", fontFamily:"inherit", minHeight:"58px" }}/></div>
            <button onClick={()=>save("evening")} style={{ width:"100%", padding:"0.72rem", borderRadius:"10px", border:"none", cursor:"pointer", background:"#4f46e5", color:"#fff", fontFamily:"inherit", fontWeight:700, fontSize:"0.9rem" }}>Abend speichern</button>
            {savedToday.evening&&<div style={{ textAlign:"center", color:"#4ade80", fontSize:"0.72rem", marginTop:"0.55rem" }}>✓ Gespeichert</div>}
          </div>)}

          {subTab==="morning"&&(<div style={panel}>
            <div style={{ fontSize:"0.67rem", color:"#818cf8", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"1.1rem" }}>Morgen-Eingabe · liegend, vor dem Aufstehen</div>
            <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.45rem" }}>Garmin HFV-Status</label><div style={{ display:"flex", gap:"0.45rem" }}>{HRV_OPTIONS.map(v=><button key={v} onClick={()=>setMorning(s=>({...s,hrv_status:v}))} style={{ flex:1, padding:"0.48rem 0.2rem", borderRadius:"8px", cursor:"pointer", fontFamily:"inherit", fontSize:"0.68rem", fontWeight:600, border:`1px solid ${morning.hrv_status===v?HRV_COLORS[v]:"#334155"}`, background:morning.hrv_status===v?`${HRV_COLORS[v]}22`:"#1e293b", color:morning.hrv_status===v?HRV_COLORS[v]:"#475569" }}>{HRV_LABELS[v]}</button>)}</div></div>
            <NumberField label="rMSSD (Garmin)" value={morning.rmssd_garmin} onChange={v=>setMorning(s=>({...s,rmssd_garmin:v}))} unit="ms" placeholder="z.B. 28"/>
            <NumberField label="Morgenpuls (liegend)" value={morning.morning_hr} onChange={v=>setMorning(s=>({...s,morning_hr:v}))} unit="bpm" placeholder="z.B. 58"/>
            <NumberField label="Atemfrequenz" value={morning.breath_rate} onChange={v=>setMorning(s=>({...s,breath_rate:v}))} unit="/min" placeholder="z.B. 16"/>
            <SliderField label="Symptomstärke beim Aufwachen" value={morning.symptom_on_waking} onChange={v=>setMorning(s=>({...s,symptom_on_waking:v}))} hint="0 = keine · 10 = schwer"/>
            <div style={{ marginBottom:"1.2rem", padding:"0.85rem 1rem", background:"#1e293b", borderRadius:"10px", border:"1px solid #334155" }}>
              <div style={{ fontSize:"0.7rem", color:"#818cf8", fontWeight:600, marginBottom:"0.25rem" }}>War gestern ein PEM-Tag?</div>
              <div style={{ fontSize:"0.68rem", color:"#64748b", marginBottom:"0.55rem" }}>Deine Antwort kalibriert die persönliche Risikoschwelle.</div>
              <div style={{ display:"flex", gap:"0.45rem" }}>{[["Ja — PEM",true],["Nein",false],["Unsicher",null]].map(([l,v])=><button key={l} onClick={()=>setMorning(s=>({...s,pem_confirmed:v}))} style={{ flex:1, padding:"0.38rem 0.25rem", borderRadius:"6px", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"0.68rem", fontWeight:600, background:morning.pem_confirmed===v?(v===true?"#7f1d1d":v===false?"#14532d":"#334155"):"#0f172a", color:morning.pem_confirmed===v?"#fff":"#475569" }}>{l}</button>)}</div>
            </div>
            <div style={{ marginBottom:"1.2rem" }}><label style={{ fontSize:"0.78rem", color:"#94a3b8", letterSpacing:"0.08em", textTransform:"uppercase", display:"block", marginBottom:"0.35rem" }}>Notiz</label><textarea value={morning.notes} onChange={e=>setMorning(s=>({...s,notes:e.target.value}))} placeholder="z.B. RLS-Nacht, früh aufgewacht…" style={{ width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", color:"#e2e8f0", padding:"0.55rem 0.75rem", fontSize:"0.85rem", fontFamily:"inherit", minHeight:"58px" }}/></div>
            <button onClick={()=>save("morning")} style={{ width:"100%", padding:"0.72rem", borderRadius:"10px", border:"none", cursor:"pointer", background:"#6d28d9", color:"#fff", fontFamily:"inherit", fontWeight:700, fontSize:"0.9rem" }}>Morgen speichern</button>
            {savedToday.morning&&<div style={{ textAlign:"center", color:"#4ade80", fontSize:"0.72rem", marginTop:"0.55rem" }}>✓ Gespeichert</div>}
            <div style={{ background:"#0f172a", borderRadius:"10px", padding:"0.85rem 1rem", border:"1px solid #1e293b", marginTop:"1rem" }}>
              <div style={{ fontSize:"0.62rem", color:"#334155", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"0.55rem" }}>Wo in Garmin ablesen</div>
              {[["rMSSD","Garmin App → Herzfrequenzvariabilität"],["HFV-Status","Garmin App → Gesundheit → HFV-Status"],["Morgenpuls","Garmin Connect → Schlaf → Ruheherzfrequenz"],["Atemfrequenz","Garmin Connect → Schlaf → Atemfrequenz"]].map(([k,v])=>(<div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"0.22rem 0", borderBottom:"1px solid #0f172a" }}><span style={{ fontSize:"0.7rem", color:"#818cf8", fontWeight:600 }}>{k}</span><span style={{ fontSize:"0.65rem", color:"#334155" }}>{v}</span></div>))}
            </div>
          </div>)}
        </>)}

        {tab==="history"&&(<div>
          {settings.showStreak&&<StreakBanner streak={streak}/>}
          {entries.length>0&&(<div style={{ marginBottom:"1rem" }}>
            <button onClick={()=>setShowCSV(s=>!s)} style={{ width:"100%", padding:"0.6rem", borderRadius:"10px", border:"1px solid #334155", cursor:"pointer", fontFamily:"inherit", fontWeight:600, fontSize:"0.82rem", background:"#0f172a", color:"#94a3b8", display:"flex", alignItems:"center", justifyContent:"center", gap:"0.5rem" }}>
              ⬇ CSV-Export ({entries.length} Einträge) {showCSV?"▲":"▼"}
            </button>
            {showCSV&&(<div style={{ marginTop:"0.7rem", background:"#0f172a", borderRadius:"10px", border:"1px solid #334155", padding:"0.9rem" }}>
              <div style={{ fontSize:"0.7rem", color:"#64748b", marginBottom:"0.5rem" }}>Alles markieren → kopieren → als .csv speichern</div>
              <textarea readOnly value={buildCSV(entries)} onClick={e=>e.target.select()} style={{ width:"100%", height:"110px", background:"#1e293b", border:"1px solid #334155", borderRadius:"8px", color:"#64748b", padding:"0.5rem", fontSize:"0.62rem", fontFamily:"monospace" }}/>
            </div>)}
          </div>)}
          {entries.length===0
            ?<div style={{ textAlign:"center", color:"#334155", padding:"3rem 1rem" }}><div style={{ fontSize:"2rem", marginBottom:"0.5rem" }}>📋</div>Noch keine Einträge<br/><button onClick={loadTestData} style={{ marginTop:"1rem", padding:"0.5rem 1rem", borderRadius:"8px", border:"1px solid #334155", background:"#1e293b", color:"#64748b", cursor:"pointer", fontFamily:"inherit", fontSize:"0.78rem" }}>Testdaten laden</button></div>
            :entries.map(e=><EntryCard key={e.id} entry={e} onDelete={deleteEntry} onEdit={setEditEntry} entries={entries} settings={settings}/>)
          }
        </div>)}

        {tab==="analysis"&&(<div>
          <div style={{ background:"#0f172a", borderRadius:"12px", padding:"1rem 1.1rem", border:"1px solid #1e293b", marginBottom:"1rem" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:"0.7rem" }}>
              <div style={{ fontSize:"0.68rem", color:"#818cf8", letterSpacing:"0.1em", textTransform:"uppercase" }}>14-Tage-Trend</div>
              <div style={{ display:"flex", gap:"0.7rem" }}>
                <span style={{ fontSize:"0.6rem", color:"#64748b", display:"flex", alignItems:"center", gap:"0.2rem" }}><span style={{ display:"inline-block", width:"7px", height:"7px", borderRadius:"50%", background:"#f87171" }}/>PEM</span>
                {cal?.threshold&&<span style={{ fontSize:"0.6rem", color:"#6366f1" }}>– – Schwelle ({cal.threshold})</span>}
              </div>
            </div>
            <TrendChart data={trendData} threshold={cal?.threshold}/>
          </div>
          <CalibrationPanel entries={entries} settings={settings}/>
          <AnalysisPanel entries={entries} allTriggers={allTriggers} settings={settings}/>
        </div>)}

        {tab==="settings"&&<SettingsTab settings={settings} onUpdate={updateSettings} entries={entries} onLoadTestData={loadTestData} allTriggers={allTriggers} onDeleteAll={deleteAll}/>}
      </div>

      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:"480px", background:"#0f172a", borderTop:"1px solid #1e293b", display:"flex", padding:"0.45rem 0 0.7rem", zIndex:20 }}>
        {TABS.map(t=>(<button key={t.key} onClick={()=>setTab(t.key)} style={{ flex:1, background:"none", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:"0.15rem", padding:"0.25rem 0", color:tab===t.key?"#818cf8":"#334155" }}><span style={{ fontSize:"1.15rem" }}>{t.icon}</span><span style={{ fontSize:"0.58rem", fontFamily:"inherit", fontWeight:tab===t.key?600:400 }}>{t.label}</span></button>))}
      </div>
    </div>
  );
}
