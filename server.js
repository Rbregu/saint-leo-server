// server.js — Saint Leo Security Awareness Study (In-Memory / Test Mode)
// Run:  node server.js
// Requires: npm install express cors

const express = require("express");
const cors    = require("cors");

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ── In-memory store ───────────────────────────────────────────────────────────
const store = {
  events:  [],   // all raw tracking events
  surveys: [],   // survey answers with multiple-choice responses
};

// ── Stats builder ─────────────────────────────────────────────────────────────
function buildStats() {
  const scans    = store.events.filter(e => e.stage === "page_loaded").length;
  const emails   = store.events.filter(e => e.stage === "email_submitted").length;
  const pwds     = store.events.filter(e => e.stage === "password_clicked").length;
  const surveyed = store.events.filter(e => e.stage === "survey_answered").length;

  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "0%");

  const emailList = store.events
    .filter(e => e.stage === "email_submitted" && e.email)
    .map(e => ({ email: e.email, timestamp: e.timestamp, userAgent: e.userAgent, ip: e.ip }));

  return {
    summary: {
      totalScans:         scans,
      emailsSubmitted:    emails,
      passwordsAttempted: pwds,
      surveyResponses:    surveyed,
    },
    conversionRates: {
      scanToEmail:      pct(emails, scans),
      emailToPassword:  pct(pwds,   emails),
      overallRisk:      pct(pwds,   scans),
    },
    emails:    emailList,
    surveys:   store.surveys,
    rawEvents: store.events,
  };
}

// ── POST /track ───────────────────────────────────────────────────────────────
app.post("/track", (req, res) => {
  const { stage, email, userAgent, timestamp } = req.body;
  if (!stage) return res.status(400).json({ error: "stage is required" });

  const event = {
    id:        store.events.length + 1,
    stage,
    email:     email     || null,
    userAgent: userAgent || null,
    ip:        req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    timestamp: timestamp || new Date().toISOString(),
  };

  store.events.push(event);
  console.log(`[TRACK] #${event.id} stage="${stage}"${email ? ` email="${email}"` : ""}`);
  res.json({ ok: true, id: event.id });
});

// ── POST /survey ──────────────────────────────────────────────────────────────
app.post("/survey", (req, res) => {
  const { answers, email, timestamp } = req.body;
  const entry = {
    id:        store.surveys.length + 1,
    answers,                              // { q1: "...", q2: "...", q3: "..." }
    email:     email || null,
    timestamp: timestamp || new Date().toISOString(),
  };
  store.surveys.push(entry);

  // also log a "survey_answered" tracking event so the count shows in stats
  store.events.push({
    id:        store.events.length + 1,
    stage:     "survey_answered",
    email:     email || null,
    userAgent: null,
    ip:        req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    timestamp: entry.timestamp,
  });

  console.log(`[SURVEY] #${entry.id} from ${email || "anonymous"}`);
  res.json({ ok: true });
});

// ── GET /results — JSON (polled by the dashboard every 4s) ────────────────────
app.get("/results", (req, res) => {
  res.json(buildStats());
});

// ── GET /results/pretty — quick human-readable HTML view ─────────────────────
app.get("/results/pretty", (req, res) => {
  const { summary: s, conversionRates: r, emails, surveys } = buildStats();
  res.send(`<!DOCTYPE html><html><head><title>Results</title>
  <style>
    body{font-family:system-ui;background:#07100a;color:#d8f3dc;max-width:800px;margin:40px auto;padding:0 20px}
    h1{color:#52b788}h2{color:#95d5b2;margin-top:32px}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #1e3d28;font-size:13px}
    th{color:#6b9e7e;font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:#0d1f12}
    .big{font-size:32px;font-weight:900;color:#52b788}.label{font-size:11px;color:#6b9e7e}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}
    .box{background:#0d1f12;border:1px solid #1e3d28;border-radius:10px;padding:16px;text-align:center}
    a{color:#95d5b2}
  </style></head><body>
  <h1>🔐 Saint Leo — Security Awareness Study</h1>
  <div class="grid">
    <div class="box"><div class="big">${s.totalScans}</div><div class="label">Scans</div></div>
    <div class="box"><div class="big">${s.emailsSubmitted}</div><div class="label">Emails</div></div>
    <div class="box"><div class="big">${s.passwordsAttempted}</div><div class="label">Pwd Clicks</div></div>
    <div class="box"><div class="big">${s.surveyResponses}</div><div class="label">Surveys</div></div>
  </div>
  <h2>Conversion Rates</h2>
  <table>
    <tr><th>Funnel Step</th><th>Rate</th></tr>
    <tr><td>Scan → Email</td><td>${r.scanToEmail}</td></tr>
    <tr><td>Email → Password</td><td>${r.emailToPassword}</td></tr>
    <tr><td>Overall Risk</td><td>${r.overallRisk}</td></tr>
  </table>
  <h2>Emails (${emails.length})</h2>
  <table>
    <tr><th>#</th><th>Email</th><th>Time</th></tr>
    ${emails.map((e,i)=>`<tr><td>${i+1}</td><td>${e.email}</td><td>${e.timestamp}</td></tr>`).join("")}
  </table>
  <h2>Survey Responses (${surveys.length})</h2>
  <table>
    <tr><th>#</th><th>Q1 — Trust</th><th>Q2 — Red Flags</th><th>Q3 — QR Frequency</th></tr>
    ${surveys.map((s,i)=>`<tr>
      <td>${i+1}</td>
      <td>${s.answers?.q1||"—"}</td>
      <td>${s.answers?.q2||"—"}</td>
      <td>${s.answers?.q3||"—"}</td>
    </tr>`).join("")}
  </table>
  <p style="margin-top:32px;font-size:12px;color:#1e3d28">
    JSON: <a href="/results">/results</a> · 
    <a href="javascript:location.reload()">Refresh</a>
  </p>
  </body></html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   Saint Leo — Security Awareness Server          ║
  ║   http://localhost:${PORT}                          ║
  ║                                                  ║
  ║   POST /track           log funnel event         ║
  ║   POST /survey          save survey answers      ║
  ║   GET  /results         JSON  (dashboard polls)  ║
  ║   GET  /results/pretty  HTML  quick view         ║
  ╚══════════════════════════════════════════════════╝
  `);
});
