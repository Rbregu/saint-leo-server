// server.js — Saint Leo Security Awareness Study (Supabase Edition)
// Run:  node server.js
// Requires: npm install express cors @supabase/supabase-js

const express   = require("express");
const cors      = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ── Supabase client ───────────────────────────────────────────────────────────
// ⚠️ In production, move these to environment variables (see bottom of file)
const SUPABASE_URL  = process.env.SUPABASE_URL  || "https://fxdhgcbbdapuzeymoxro.supabase.co";
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4ZGhnY2JiZGFwdXpleW1veHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MjIwMDAsImV4cCI6MjA4ODk5ODAwMH0.namqHjEMcwlOOsy6U5-t3G9xNxYmPSTgPyOlC5lpfyA";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── POST /track ───────────────────────────────────────────────────────────────
app.post("/track", async (req, res) => {
  const { stage, email, roles, userAgent, timestamp } = req.body;
  if (!stage) return res.status(400).json({ error: "stage is required" });

  const { error } = await supabase.from("events").insert({
    stage,
    email:      email     || null,
    roles:      roles     || null,
    user_agent: userAgent || null,
    ip:         req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    timestamp:  timestamp || new Date().toISOString(),
  });

  if (error) {
    console.error("[TRACK ERROR]", error.message);
    return res.status(500).json({ error: error.message });
  }

  console.log(`[TRACK] stage="${stage}"${email ? ` email="${email}"` : ""}${roles ? ` roles=${JSON.stringify(roles)}` : ""}`);
  res.json({ ok: true });
});

// ── POST /survey ──────────────────────────────────────────────────────────────
app.post("/survey", async (req, res) => {
  const { answers, email, roles, timestamp } = req.body;

  // insert into surveys table
  const { error: surveyError } = await supabase.from("surveys").insert({
    email:     email || null,
    roles:     roles || null,
    q1:        answers?.q1 || null,
    q2:        answers?.q2 || null,
    q3:        answers?.q3 || null,
    q4:        answers?.q4 || null,
    timestamp: timestamp || new Date().toISOString(),
  });

  if (surveyError) {
    console.error("[SURVEY ERROR]", surveyError.message);
    return res.status(500).json({ error: surveyError.message });
  }

  // also log a survey_answered event for funnel tracking
  await supabase.from("events").insert({
    stage:     "survey_answered",
    email:     email || null,
    roles:     roles || null,
    user_agent: null,
    ip:        req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    timestamp: timestamp || new Date().toISOString(),
  });

  console.log(`[SURVEY] from ${email || "anonymous"}`);
  res.json({ ok: true });
});

// ── GET /results ──────────────────────────────────────────────────────────────
app.get("/results", async (req, res) => {
  try {
    const [eventsRes, surveysRes] = await Promise.all([
      supabase.from("events").select("*").order("timestamp", { ascending: true }),
      supabase.from("surveys").select("*").order("timestamp", { ascending: true }),
    ]);

    if (eventsRes.error)  throw new Error(eventsRes.error.message);
    if (surveysRes.error) throw new Error(surveysRes.error.message);

    const events  = eventsRes.data  || [];
    const surveys = surveysRes.data || [];

    // ── compute summary ───────────────────────────────────────────────────────
    const scans     = events.filter(e => e.stage === "page_loaded").length;
    const emails    = events.filter(e => e.stage === "email_submitted").length;
    const pwds      = events.filter(e => e.stage === "password_clicked").length;
    const surveyed  = events.filter(e => e.stage === "survey_answered").length;
    const downloads = events.filter(e => e.stage === "file_downloaded").length;

    const emailEvents = events.filter(e => e.stage === "email_submitted");
    const students    = emailEvents.filter(e => e.roles?.student).length;
    const staff       = emailEvents.filter(e => e.roles?.staff).length;
    const faculty     = emailEvents.filter(e => e.roles?.faculty).length;

    const pct = (a, b) => b ? `${((a / b) * 100).toFixed(1)}%` : "0%";

    // build email list with accurate per-user cross-referencing
    // file_downloaded fires BEFORE email is entered so ev.email is null — match by IP instead
    // password_clicked fires AFTER email entry — match by email first, fallback to IP
    const emailList = emailEvents.map(e => {
      const userIp    = e.ip;
      const userEmail = e.email;

      const downloaded = events.some(ev =>
        ev.stage === "file_downloaded" &&
        ev.ip && userIp && ev.ip === userIp
      );

      const pwdClicked = events.some(ev =>
        ev.stage === "password_clicked" &&
        (
          (ev.email && userEmail && ev.email === userEmail) ||
          (!ev.email && ev.ip && userIp && ev.ip === userIp)
        )
      );

      return {
        email:           userEmail,
        roles:           e.roles || {},
        downloadedFile:  downloaded,
        passwordClicked: pwdClicked,
        timestamp:       e.timestamp,
        userAgent:       e.user_agent,
        ip:              userIp,
      };
    });

    res.json({
      summary: {
        totalScans:         scans,
        emailsSubmitted:    emails,
        passwordsAttempted: pwds,
        surveyResponses:    surveyed,
        fileDownloads:      downloads,
        students,
        staff,
        faculty,
      },
      conversionRates: {
        scanToEmail:     pct(emails,    scans),
        scanToDownload:  pct(downloads, scans),
        emailToPassword: pct(pwds,      emails),
        overallRisk:     pct(pwds,      scans),
      },
      emails:    emailList,
      surveys,
      rawEvents: events,
    });

  } catch (err) {
    console.error("[RESULTS ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /results/pretty ───────────────────────────────────────────────────────
app.get("/results/pretty", async (req, res) => {
  try {
    const r = await fetch(`http://localhost:${PORT}/results`);
    const { summary: s, conversionRates: rates, emails, surveys } = await r.json();

    res.send(`<!DOCTYPE html><html><head><title>Results</title>
    <style>
      body{font-family:system-ui;background:#07100a;color:#d8f3dc;max-width:900px;margin:40px auto;padding:0 20px}
      h1{color:#52b788}h2{color:#95d5b2;margin-top:32px}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #1e3d28;font-size:13px}
      th{color:#6b9e7e;font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:#0d1f12}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}
      .box{background:#0d1f12;border:1px solid #1e3d28;border-radius:10px;padding:16px;text-align:center}
      .big{font-size:32px;font-weight:900;color:#52b788}.label{font-size:11px;color:#6b9e7e}
      .tag{display:inline-block;border-radius:4px;padding:2px 7px;font-size:11px;margin-right:3px}
      a{color:#95d5b2}
    </style></head><body>
    <h1>🔐 Saint Leo — Security Awareness Study</h1>
    <div class="grid">
      <div class="box"><div class="big">${s.totalScans}</div><div class="label">Scans</div></div>
      <div class="box"><div class="big">${s.emailsSubmitted}</div><div class="label">Emails</div></div>
      <div class="box"><div class="big">${s.fileDownloads}</div><div class="label">Downloads</div></div>
      <div class="box"><div class="big">${s.passwordsAttempted}</div><div class="label">Pwd Clicks</div></div>
    </div>
    <h2>Role Breakdown</h2>
    <table>
      <tr><th>Role</th><th>Count</th></tr>
      <tr><td>🎓 Students</td><td>${s.students}</td></tr>
      <tr><td>💼 Staff</td><td>${s.staff}</td></tr>
    </table>
    <h2>Conversion Rates</h2>
    <table>
      <tr><th>Funnel Step</th><th>Rate</th></tr>
      <tr><td>Scan → Email</td><td>${rates.scanToEmail}</td></tr>
      <tr><td>Scan → Download</td><td>${rates.scanToDownload}</td></tr>
      <tr><td>Email → Password</td><td>${rates.emailToPassword}</td></tr>
      <tr><td>Overall Risk</td><td>${rates.overallRisk}</td></tr>
    </table>
    <h2>Emails (${emails.length})</h2>
    <table>
      <tr><th>#</th><th>Email</th><th>Role</th><th>Downloaded</th><th>Time</th></tr>
      ${emails.map((e, i) => `<tr>
        <td>${i+1}</td><td>${e.email}</td>
        <td>
          ${e.roles?.student ? '<span class="tag" style="background:#2d6a4f;color:#fff">Student</span>' : ""}
          ${e.roles?.staff   ? '<span class="tag" style="background:#e8a000;color:#000">Staff</span>'   : ""}
        </td>
        <td>${e.downloadedFile ? "✓ Yes" : "—"}</td>
        <td>${new Date(e.timestamp).toLocaleString()}</td>
      </tr>`).join("")}
    </table>
    <h2>Survey Responses (${surveys.length})</h2>
    <table>
      <tr><th>#</th><th>Q1 — Trust</th><th>Q2 — Red Flags</th><th>Q3 — QR Frequency</th></tr>
      ${surveys.map((s, i) => `<tr>
        <td>${i+1}</td><td>${s.q1||"—"}</td><td>${s.q2||"—"}</td><td>${s.q3||"—"}</td>
      </tr>`).join("")}
    </table>
    <p style="margin-top:32px;font-size:12px;color:#1e3d28">
      JSON: <a href="/results">/results</a> · <a href="javascript:location.reload()">Refresh</a>
    </p>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`<p style="color:red">Error: ${err.message}</p>`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   Saint Leo — Security Awareness Server          ║
  ║   http://localhost:${PORT}  (Supabase edition)      ║
  ║                                                  ║
  ║   POST /track           log funnel event         ║
  ║   POST /survey          save survey answers      ║
  ║   GET  /results         JSON  (dashboard polls)  ║
  ║   GET  /results/pretty  HTML  quick view         ║
  ╚══════════════════════════════════════════════════╝
  `);
});

// ── HOW TO SET ENVIRONMENT VARIABLES ON RENDER ────────────────────────────────
// Instead of hardcoding credentials, go to:
// Render Dashboard → saint-leo-server → Environment → Add the following:
//
//   SUPABASE_URL = https://fxdhgcbbdapuzeymoxro.supabase.co
//   SUPABASE_KEY = your-anon-key
//
// Then update the two lines at the top of this file to ONLY use process.env:
//   const SUPABASE_URL = process.env.SUPABASE_URL;
//   const SUPABASE_KEY = process.env.SUPABASE_KEY;
