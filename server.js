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

// ── Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
