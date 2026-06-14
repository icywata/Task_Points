const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');
const PASSWORD  = process.env.APP_PASSWORD || 'interesting';
const RESEND_KEY = process.env.RESEND_API_KEY || '';

console.log('Server v6 starting — email via Resend');
console.log('RESEND_API_KEY set:', !!RESEND_KEY);

// ── Email via Resend ───────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY || !to) {
    console.log('Email skipped — no API key or recipient');
    return;
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({
      from: 'KinkPoints <contact@kinkpoints.app>',
      to,
      subject,
      html
    });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`Email sent to ${to}: ${subject}`);
        } else {
          console.error('Email failed:', res.statusCode, data);
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.error('Email request error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Database setup ─────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
let db = null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — using local data.json');
    return;
  }
  try {
    const { Client } = require('pg');
    db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query(`CREATE TABLE IF NOT EXISTS appdata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    console.log('Connected to Postgres');
  } catch(e) {
    console.error('Postgres connection failed:', e.message);
    db = null;
  }
}

function readDataFile() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function writeDataFile(obj) { fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2)); }

async function readData() {
  if (db) {
    const res = await db.query(`SELECT value FROM appdata WHERE key = 'main'`);
    return res.rows.length ? JSON.parse(res.rows[0].value) : {};
  }
  return readDataFile();
}

async function writeData(obj) {
  if (db) {
    const json = JSON.stringify(obj);
    await db.query(`INSERT INTO appdata (key,value) VALUES ('main',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [json]);
  } else {
    writeDataFile(obj);
  }
}

// ── Auth ───────────────────────────────────────────────────────
function checkAuth(req) { return (req.headers['x-app-password'] || '') === PASSWORD; }

// ── Daily expiry reminders ─────────────────────────────────────
function scheduleDailyReminders() {
  function msUntil8am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  async function runReminders() {
    console.log('Running daily expiry reminders…');
    try {
      const state = await readData();
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

      for (const [profileKey, profileData] of Object.entries(state)) {
        if (!profileData || !profileData.assigned) continue;
        const email = profileData.notificationEmail;
        if (!email) continue;
        const expiringToday = profileData.assigned.filter(t => !t.completedOn && t.expiresOn === todayKey);
        if (!expiringToday.length) continue;
        const firstName = profileData.firstName || profileData.nickname || (profileKey === 'gg' ? 'Good Girl' : 'Daddy');
        const taskList = expiringToday.map(t =>
          `<li style="margin-bottom:8px"><strong>${t.name}</strong>${t.desc ? ` — ${t.desc}` : ''} <span style="color:#e8a84a">(${t.pts} pts)</span></li>`
        ).join('');
        await sendEmail(email,
          `⏰ ${expiringToday.length} task${expiringToday.length > 1 ? 's' : ''} expiring today`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#d4537e;margin-bottom:1rem">Tasks expiring today, ${firstName}!</h2>
            <p style="color:#b8829e;margin-bottom:1rem">These assigned tasks expire at the end of today:</p>
            <ul style="padding-left:1.25rem;color:#f0dce8">${taskList}</ul>
          </div>`
        );
      }
    } catch(e) {
      console.error('Reminder check failed:', e.message);
    }
    setTimeout(runReminders, 24 * 60 * 60 * 1000);
  }

  setTimeout(runReminders, msUntil8am());
  console.log(`Daily reminders scheduled — first run in ${Math.round(msUntil8am()/60000)} minutes`);
}

// ── Simple password hash (pre-bcrypt, upgrade later) ──────────
const crypto = require('crypto');
function simpleHash(password) {
  return crypto.createHash('sha256').update(password + 'kinkpoints_salt').digest('hex');
}

// ── Bootstrap admin page HTML ──────────────────────────────────
const BOOTSTRAP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Bootstrap Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;padding:2rem 1rem;display:flex;align-items:flex-start;justify-content:center}
  .wrap{width:100%;max-width:560px}
  h1{font-size:20px;font-weight:700;color:#fff;margin-bottom:4px}
  .subtitle{font-size:13px;color:#666;margin-bottom:2rem}
  .warning{background:#2d1a1a;border:1px solid #5a2020;border-radius:10px;padding:12px 16px;font-size:13px;color:#e06060;margin-bottom:1.5rem}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:1.5rem;margin-bottom:1rem}
  .card h2{font-size:14px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#888;margin-bottom:1rem}
  .field{margin-bottom:12px}
  label{display:block;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#666;margin-bottom:5px}
  input{width:100%;background:#111;border:1px solid #2a2a2a;border-radius:8px;color:#e0e0e0;font-family:inherit;font-size:14px;padding:9px 12px;outline:none;transition:border-color .15s}
  input:focus{border-color:#d4537e}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .admin-field{background:#1a1a2a;border:1px solid #2a2a4a;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
  .admin-field h2{font-size:14px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#4a6aaa;margin-bottom:1rem}
  .btn{width:100%;height:44px;background:#d4537e;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:1.5rem;transition:background .15s}
  .btn:hover{background:#993556}
  .result{margin-top:1rem;padding:12px 16px;border-radius:10px;font-size:14px;display:none}
  .result.ok{background:#1a2d1a;border:1px solid #2a5a2a;color:#6abf6a}
  .result.err{background:#2d1a1a;border:1px solid #5a2020;color:#e06060}
</style>
</head>
<body>
<div class="wrap">
  <h1>🔐 Bootstrap Admin</h1>
  <p class="subtitle">One-time setup — create user accounts from existing profile data</p>

  <div class="warning">⚠️ This page is for one-time use only. Once bootstrapped, do not use again.</div>

  <div class="admin-field">
    <h2>Admin Key</h2>
    <div class="field">
      <label>Secret Key</label>
      <input type="password" id="adminKey" placeholder="Enter admin key" />
    </div>
  </div>

  <div class="card">
    <h2>💙 Daddy Profile</h2>
    <div class="row">
      <div class="field"><label>First Name</label><input type="text" id="dadFirstName" placeholder="First name" /></div>
      <div class="field"><label>Last Name</label><input type="text" id="dadLastName" placeholder="Last name" /></div>
    </div>
    <div class="field"><label>Nickname</label><input type="text" id="dadNickname" value="Daddy" /></div>
    <div class="field"><label>Email</label><input type="email" id="dadEmail" placeholder="daddy@email.com" /></div>
    <div class="field"><label>Password</label><input type="password" id="dadPassword" placeholder="Choose a password" /></div>
  </div>

  <div class="card">
    <h2>🩷 Good Girl Profile</h2>
    <div class="row">
      <div class="field"><label>First Name</label><input type="text" id="ggFirstName" placeholder="First name" /></div>
      <div class="field"><label>Last Name</label><input type="text" id="ggLastName" placeholder="Last name" /></div>
    </div>
    <div class="field"><label>Nickname</label><input type="text" id="ggNickname" value="Good Girl" /></div>
    <div class="field"><label>Email</label><input type="email" id="ggEmail" placeholder="goodgirl@email.com" /></div>
    <div class="field"><label>Password</label><input type="password" id="ggPassword" placeholder="Choose a password" /></div>
  </div>

  <button class="btn" onclick="bootstrap()">Create Users & Migrate Data</button>
  <div class="result" id="result"></div>
</div>
<script>
async function bootstrap() {
  const adminKey   = document.getElementById('adminKey').value.trim();
  const dadFirst   = document.getElementById('dadFirstName').value.trim();
  const dadLast    = document.getElementById('dadLastName').value.trim();
  const dadNick    = document.getElementById('dadNickname').value.trim();
  const dadEmail   = document.getElementById('dadEmail').value.trim();
  const dadPass    = document.getElementById('dadPassword').value;
  const ggFirst    = document.getElementById('ggFirstName').value.trim();
  const ggLast     = document.getElementById('ggLastName').value.trim();
  const ggNick     = document.getElementById('ggNickname').value.trim();
  const ggEmail    = document.getElementById('ggEmail').value.trim();
  const ggPass     = document.getElementById('ggPassword').value;

  if (!adminKey||!dadEmail||!dadPass||!ggEmail||!ggPass) {
    showResult('Please fill in all required fields', false); return;
  }

  const res = await fetch('/api/admin/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminKey,
      daddy:   { firstName:dadFirst, lastName:dadLast, nickname:dadNick, email:dadEmail, password:dadPass },
      goodgirl:{ firstName:ggFirst,  lastName:ggLast,  nickname:ggNick,  email:ggEmail,  password:ggPass  }
    })
  });
  const data = await res.json();
  if (res.ok) {
    showResult('✓ ' + data.message, true);
  } else {
    showResult('Error: ' + data.error, false);
  }
}

function showResult(msg, ok) {
  const el = document.getElementById('result');
  el.textContent = msg;
  el.className = 'result ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
}
</script>
</body>
</html>`;

// ── Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Bootstrap admin page ──────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/bootstrap') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(BOOTSTRAP_HTML);
    return;
  }

  if (req.method === 'POST' && url === '/api/admin/bootstrap') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { adminKey, daddy, goodgirl } = JSON.parse(body);

        // Check secret key
        if (adminKey !== 'Daemoni') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid admin key' }));
          return;
        }

        // Load existing data
        const state = await readData();

        // Migrate gg profile
        if (!state.gg) state.gg = {};
        state.gg.firstName         = goodgirl.firstName;
        state.gg.lastName          = goodgirl.lastName;
        state.gg.nickname          = goodgirl.nickname || 'Good Girl';
        state.gg.notificationEmail = goodgirl.email;
        state.gg.passwordHash      = simpleHash(goodgirl.password);
        state.gg.bootstrapped      = true;

        // Migrate dad profile
        if (!state.dad) state.dad = {};
        state.dad.firstName         = daddy.firstName;
        state.dad.lastName          = daddy.lastName;
        state.dad.nickname          = daddy.nickname || 'Daddy';
        state.dad.notificationEmail = daddy.email;
        state.dad.passwordHash      = simpleHash(daddy.password);
        state.dad.bootstrapped      = true;

        // Mark them as partnered
        state.partnership = { userA: 'dad', userB: 'gg', status: 'active', since: new Date().toISOString() };

        await writeData(state);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Users bootstrapped and partnered successfully' }));
      } catch(e) {
        console.error('Bootstrap error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve HTML
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Auth check
  if (req.method === 'POST' && url === '/api/auth') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Wrong password' }));
        }
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // Data endpoints
  if (url === '/api/data') {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'GET') {
      try {
        const data = await readData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          await writeData(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
  }

  // Assigned task notification
  if (req.method === 'POST' && url === '/api/notify/assigned') {
    if (!checkAuth(req)) { res.writeHead(401); res.end(); return; }
    console.log('Notify endpoint hit');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { to, taskName, taskDesc, pts, expiresOn, profileName } = JSON.parse(body);
        console.log(`Sending notification to ${to} for task: ${taskName}`);
        const expDate = new Date(expiresOn + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
        await sendEmail(to,
          `📋 New task assigned: ${taskName}`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#d4537e;margin-bottom:1rem">New task assigned, ${profileName}!</h2>
            <div style="background:#2a1c27;border-radius:10px;padding:1rem 1.25rem;border-left:3px solid #c47c1a;margin-bottom:1rem">
              <div style="font-size:16px;font-weight:600;margin-bottom:4px">${taskName}</div>
              ${taskDesc ? `<div style="color:#b8829e;font-size:14px;margin-bottom:8px">${taskDesc}</div>` : ''}
              <div style="display:flex;gap:12px;font-size:13px">
                <span style="background:#4d2840;color:#f4c0d1;padding:2px 10px;border-radius:20px;font-weight:600">${pts} pts</span>
                <span style="color:#e8a84a">Due ${expDate}</span>
              </div>
            </div>
            <p style="color:#7a5068;font-size:13px">Log in to the tracker to complete this task before it expires.</p>
          </div>`
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('Notify endpoint error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Boot ───────────────────────────────────────────────────────
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Task Points server running on port ${PORT}`);
    scheduleDailyReminders();
  });
});
