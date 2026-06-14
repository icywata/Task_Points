const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT       = process.env.PORT || 3000;
const HTML_FILE  = path.join(__dirname, 'index.html');
const PASSWORD   = process.env.APP_PASSWORD || 'interesting';
const RESEND_KEY = process.env.RESEND_API_KEY || '';

console.log('Server v8 starting — photo proof support');

// ── R2 / S3 storage ────────────────────────────────────────────
const R2_ENDPOINT   = process.env.R2_ENDPOINT || '';
const R2_BUCKET     = process.env.R2_BUCKET_NAME || 'kinkpoints-proofs';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';

let s3Client = null;
let s3Presigner = null;

function initR2() {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
    console.log('R2 not configured — photo proof disabled');
    return;
  }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
    });
    s3Presigner = getSignedUrl;
    console.log('R2 storage ready');
  } catch(e) {
    console.error('R2 init failed:', e.message);
  }
}

async function uploadToR2(key, buffer, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType
  }));
}

async function getSignedViewUrl(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  return await s3Presigner(s3Client, new GetObjectCommand({
    Bucket: R2_BUCKET, Key: key
  }), { expiresIn: 900 }); // 15 minutes
}

async function deleteFromR2(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

// ── Password hashing ───────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'kinkpoints_salt').digest('hex');
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function uid() {
  return crypto.randomBytes(4).toString('hex');
}

// ── Email via Resend ───────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY || !to) { console.log('Email skipped — no key or recipient'); return; }
  return new Promise((resolve) => {
    const body = JSON.stringify({ from:'KinkPoints <contact@kinkpoints.app>', to, subject, html });
    const opts = {
      hostname:'api.resend.com', path:'/emails', method:'POST',
      headers:{ 'Authorization':`Bearer ${RESEND_KEY}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) console.log(`Email sent to ${to}: ${subject}`);
        else console.error('Email failed:', res.statusCode, data);
        resolve();
      });
    });
    req.on('error', e => { console.error('Email error:', e.message); resolve(); });
    req.write(body); req.end();
  });
}

// ── Database ───────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
let db = null;

async function initDb() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL — using data.json'); return; }
  try {
    const { Client } = require('pg');
    db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    // Main app data table (existing)
    await db.query(`CREATE TABLE IF NOT EXISTS appdata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Sessions table
    await db.query(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
    console.log('Connected to Postgres');
  } catch(e) { console.error('Postgres failed:', e.message); db = null; }
}

async function readData() {
  if (db) {
    const res = await db.query(`SELECT value FROM appdata WHERE key='main'`);
    return res.rows.length ? JSON.parse(res.rows[0].value) : {};
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

async function writeData(obj) {
  const json = JSON.stringify(obj);
  if (db) {
    await db.query(`INSERT INTO appdata (key,value) VALUES ('main',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [json]);
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  }
}

// ── Session management ─────────────────────────────────────────
async function createSession(userId) {
  const token = generateToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  if (db) {
    await db.query(`INSERT INTO sessions (token,user_id,expires_at) VALUES ($1,$2,$3)`, [token, userId, expires]);
  } else {
    // fallback: store in data.json
    const state = await readData();
    if (!state._sessions) state._sessions = {};
    state._sessions[token] = { userId, expires: expires.toISOString() };
    await writeData(state);
  }
  return token;
}

async function getSession(token) {
  if (!token) return null;
  if (db) {
    const res = await db.query(`SELECT user_id FROM sessions WHERE token=$1 AND expires_at > NOW()`, [token]);
    return res.rows.length ? res.rows[0].user_id : null;
  } else {
    const state = await readData();
    const sess = state._sessions && state._sessions[token];
    if (!sess) return null;
    if (new Date(sess.expires) < new Date()) return null;
    return sess.userId;
  }
}

async function deleteSession(token) {
  if (db) {
    await db.query(`DELETE FROM sessions WHERE token=$1`, [token]);
  } else {
    const state = await readData();
    if (state._sessions) delete state._sessions[token];
    await writeData(state);
  }
}

// ── Cookie helpers ─────────────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function setCookieHeader(token) {
  return `session=${token}; HttpOnly; Path=/; Max-Age=${30*24*60*60}; SameSite=Lax; Secure`;
}

// ── Auth middleware ────────────────────────────────────────────
async function requireAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  return await getSession(token);
}

// ── Request body parser ────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Daily reminders ────────────────────────────────────────────
function scheduleDailyReminders() {
  function msUntil8am() {
    const now = new Date(), next = new Date(now);
    next.setHours(8,0,0,0);
    if (next <= now) next.setDate(next.getDate()+1);
    return next - now;
  }
  async function runReminders() {
    console.log('Running daily expiry reminders…');
    try {
      const state = await readData();
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      for (const [profileKey, profileData] of Object.entries(state)) {
        if (!profileData || !profileData.assigned || profileKey.startsWith('_')) continue;
        const email = profileData.notificationEmail;
        if (!email) continue;
        const expiring = profileData.assigned.filter(t => !t.completedOn && t.expiresOn === todayKey);
        if (!expiring.length) continue;
        const firstName = profileData.firstName || profileData.nickname || profileKey;
        const taskList = expiring.map(t =>
          `<li style="margin-bottom:8px"><strong>${t.name}</strong>${t.desc?` — ${t.desc}`:''} <span style="color:#e8a84a">(${t.pts} pts)</span></li>`
        ).join('');
        await sendEmail(email, `⏰ ${expiring.length} task${expiring.length>1?'s':''} expiring today`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#d4537e;margin-bottom:1rem">Tasks expiring today, ${firstName}!</h2>
            <p style="color:#b8829e;margin-bottom:1rem">These assigned tasks expire at the end of today:</p>
            <ul style="padding-left:1.25rem;color:#f0dce8">${taskList}</ul>
          </div>`
        );
      }
    } catch(e) { console.error('Reminder error:', e.message); }
    setTimeout(runReminders, 24*60*60*1000);
  }
  setTimeout(runReminders, msUntil8am());
  console.log(`Daily reminders scheduled — first run in ${Math.round(msUntil8am()/60000)} minutes`);
}

// ── Bootstrap admin HTML ───────────────────────────────────────
const BOOTSTRAP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
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
  input,select{width:100%;background:#111;border:1px solid #2a2a2a;border-radius:8px;color:#e0e0e0;font-family:inherit;font-size:14px;padding:9px 12px;outline:none;transition:border-color .15s}
  input:focus,select:focus{border-color:#d4537e}
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
  <div class="warning">⚠️ One-time use only. Do not use again after bootstrapping.</div>
  <div class="admin-field">
    <h2>Admin Key</h2>
    <div class="field"><label>Secret Key</label><input type="password" id="adminKey" placeholder="Enter admin key"/></div>
  </div>
  <div class="card">
    <h2>💙 Daddy Profile</h2>
    <div class="row">
      <div class="field"><label>First Name</label><input type="text" id="dadFirstName" placeholder="First name"/></div>
      <div class="field"><label>Last Name</label><input type="text" id="dadLastName" placeholder="Last name"/></div>
    </div>
    <div class="field"><label>Nickname</label><input type="text" id="dadNickname" value="Daddy"/></div>
    <div class="field"><label>Role</label>
      <select id="dadRole">
        <option>Daddy</option><option>Dominant</option><option>Domme</option><option>Master</option>
        <option>Mistress</option><option>Mommy</option><option>Owner</option><option>Caregiver</option>
        <option>Rigger</option><option>Sadist</option><option>Switch</option><option>Submissive</option>
        <option>Sub</option><option>Slave</option><option>Little</option><option>Babygirl</option>
        <option>Babyboy</option><option>Pet</option><option>Rope Bunny</option><option>Masochist</option>
        <option>Vanilla</option><option>Curious/Exploring</option>
      </select>
    </div>
    <div class="field"><label>Email</label><input type="email" id="dadEmail" placeholder="daddy@email.com"/></div>
    <div class="field"><label>Password</label><input type="password" id="dadPassword" placeholder="Choose a password"/></div>
  </div>
  <div class="card">
    <h2>🩷 Good Girl Profile</h2>
    <div class="row">
      <div class="field"><label>First Name</label><input type="text" id="ggFirstName" placeholder="First name"/></div>
      <div class="field"><label>Last Name</label><input type="text" id="ggLastName" placeholder="Last name"/></div>
    </div>
    <div class="field"><label>Nickname</label><input type="text" id="ggNickname" value="Good Girl"/></div>
    <div class="field"><label>Role</label>
      <select id="ggRole">
        <option>Submissive</option><option>Sub</option><option>Slave</option><option>Little</option>
        <option>Babygirl</option><option>Babyboy</option><option>Pet</option><option>Rope Bunny</option>
        <option>Masochist</option><option>Switch</option><option>Dominant</option><option>Domme</option>
        <option>Daddy</option><option>Mommy</option><option>Master</option><option>Mistress</option>
        <option>Owner</option><option>Caregiver</option><option>Rigger</option><option>Sadist</option>
        <option>Vanilla</option><option>Curious/Exploring</option>
      </select>
    </div>
    <div class="field"><label>Email</label><input type="email" id="ggEmail" placeholder="goodgirl@email.com"/></div>
    <div class="field"><label>Password</label><input type="password" id="ggPassword" placeholder="Choose a password"/></div>
  </div>
  <button class="btn" onclick="bootstrap()">Create Users & Migrate Data</button>
  <div class="result" id="result"></div>
</div>
<script>
async function bootstrap() {
  const adminKey=document.getElementById('adminKey').value.trim();
  const dadFirst=document.getElementById('dadFirstName').value.trim();
  const dadLast=document.getElementById('dadLastName').value.trim();
  const dadNick=document.getElementById('dadNickname').value.trim();
  const dadRole=document.getElementById('dadRole').value;
  const dadEmail=document.getElementById('dadEmail').value.trim();
  const dadPass=document.getElementById('dadPassword').value;
  const ggFirst=document.getElementById('ggFirstName').value.trim();
  const ggLast=document.getElementById('ggLastName').value.trim();
  const ggNick=document.getElementById('ggNickname').value.trim();
  const ggRole=document.getElementById('ggRole').value;
  const ggEmail=document.getElementById('ggEmail').value.trim();
  const ggPass=document.getElementById('ggPassword').value;
  if(!adminKey||!dadEmail||!dadPass||!ggEmail||!ggPass){showResult('Please fill in all required fields',false);return;}
  const res=await fetch('/api/admin/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminKey,
      daddy:{firstName:dadFirst,lastName:dadLast,nickname:dadNick,role:dadRole,email:dadEmail,password:dadPass},
      goodgirl:{firstName:ggFirst,lastName:ggLast,nickname:ggNick,role:ggRole,email:ggEmail,password:ggPass}
    })
  });
  const data=await res.json();
  showResult(res.ok?'✓ '+data.message:'Error: '+data.error,res.ok);
}
function showResult(msg,ok){const el=document.getElementById('result');el.textContent=msg;el.className='result '+(ok?'ok':'err');el.style.display='block';}
</script>
</body>
</html>`;

// ── Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Serve main app ──────────────────────────────────────────
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── Bootstrap admin ─────────────────────────────────────────
  if (req.method === 'GET' && url === '/admin/bootstrap') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(BOOTSTRAP_HTML);
    return;
  }

  if (req.method === 'POST' && url === '/api/admin/bootstrap') {
    try {
      const { adminKey, daddy, goodgirl } = await parseBody(req);
      if (adminKey !== 'Daemoni') { json(res, { error: 'Invalid admin key' }, 401); return; }
      const state = await readData();
      if (!state.gg) state.gg = {};
      state.gg.firstName         = goodgirl.firstName;
      state.gg.lastName          = goodgirl.lastName;
      state.gg.nickname          = goodgirl.nickname || 'Good Girl';
      state.gg.role              = goodgirl.role || 'Submissive';
      state.gg.notificationEmail = goodgirl.email;
      state.gg.passwordHash      = hashPassword(goodgirl.password);
      state.gg.bootstrapped      = true;
      if (!state.dad) state.dad = {};
      state.dad.firstName         = daddy.firstName;
      state.dad.lastName          = daddy.lastName;
      state.dad.nickname          = daddy.nickname || 'Daddy';
      state.dad.role              = daddy.role || 'Dominant';
      state.dad.notificationEmail = daddy.email;
      state.dad.passwordHash      = hashPassword(daddy.password);
      state.dad.bootstrapped      = true;
      state.partnership = { userA: 'dad', userB: 'gg', status: 'active', since: new Date().toISOString() };
      await writeData(state);
      json(res, { ok: true, message: 'Users bootstrapped and partnered successfully' });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Login ───────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/login') {
    try {
      const { email, password } = await parseBody(req);
      const state = await readData();
      console.log(`Login attempt: ${email}`);
      // Only check known user profile keys, skip metadata keys
      const USER_KEYS = ['gg', 'dad'];
      let userId = null;
      for (const key of USER_KEYS) {
        const profile = state[key];
        if (profile && profile.notificationEmail &&
            profile.notificationEmail.toLowerCase() === email.toLowerCase()) {
          const attemptHash = hashPassword(password);
          const storedHash = profile.passwordHash;
          console.log(`Found profile ${key}, hash match: ${attemptHash === storedHash}`);
          console.log(`Stored hash exists: ${!!storedHash}`);
          if (attemptHash === storedHash) {
            userId = key;
            break;
          }
        }
      }
      if (!userId) { 
        console.log(`Login failed for: ${email}`);
        json(res, { error: 'Invalid email or password' }, 401); return; 
      }
      console.log(`Login success: ${userId}`);
      const token = await createSession(userId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': setCookieHeader(token)
      });
      res.end(JSON.stringify({ ok: true, userId }));
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Logout ──────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/logout') {
    const cookies = parseCookies(req);
    if (cookies.session) await deleteSession(cookies.session);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Get current user ────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/me') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Not authenticated' }, 401); return; }
    const state = await readData();
    const profile = state[userId] || {};
    // Find partner
    let partnerId = null;
    if (state.partnership) {
      if (state.partnership.userA === userId) partnerId = state.partnership.userB;
      if (state.partnership.userB === userId) partnerId = state.partnership.userA;
    }
    const partnerProfile = partnerId ? (state[partnerId] || {}) : null;
    json(res, {
      userId,
      firstName:   profile.firstName,
      lastName:    profile.lastName,
      nickname:    profile.nickname,
      role:        profile.role,
      icon:        profile.icon,
      email:       profile.notificationEmail,
      partnerId,
      partnerNickname: partnerProfile?.nickname,
      partnerRole:     partnerProfile?.role,
      partnerIcon:     partnerProfile?.icon,
      partnerEmail:    partnerProfile?.notificationEmail
    });
    return;
  }

  // ── Get app data (auth required) ────────────────────────────
  if (url === '/api/data') {
    const userId = await requireAuth(req);
    // Fall back to old password auth for compatibility during transition
    const legacyAuth = (req.headers['x-app-password'] || '') === PASSWORD;
    if (!userId && !legacyAuth) { json(res, { error: 'Unauthorized' }, 401); return; }

    if (req.method === 'GET') {
      try { json(res, await readData()); } catch(e) { json(res, { error: e.message }, 500); }
      return;
    }
    if (req.method === 'POST') {
      try { await writeData(await parseBody(req)); json(res, { ok: true }); }
      catch(e) { json(res, { error: e.message }, 500); }
      return;
    }
  }

  // ── Save profile ────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/profile') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const body = await parseBody(req);
      const { firstName, lastName, nickname, role, email, icon, theme } = body;
      const state = await readData();
      if (!state[userId]) state[userId] = {};
      if (firstName !== undefined) state[userId].firstName = firstName;
      if (lastName  !== undefined) state[userId].lastName  = lastName;
      if (nickname  !== undefined) state[userId].nickname  = nickname;
      if (role      !== undefined) state[userId].role      = role;
      if (email     !== undefined) state[userId].notificationEmail = email;
      if (icon      !== undefined) state[userId].icon      = icon;
      if (theme     !== undefined) state[userId].theme     = theme;
      await writeData(state);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Assigned task notification ───────────────────────────────
  if (req.method === 'POST' && url === '/api/notify/assigned') {
    const userId = await requireAuth(req);
    const legacyAuth = (req.headers['x-app-password'] || '') === PASSWORD;
    if (!userId && !legacyAuth) { json(res, { error: 'Unauthorized' }, 401); return; }
    console.log('Notify endpoint hit');
    try {
      const { to, taskName, taskDesc, pts, expiresOn, profileName } = await parseBody(req);
      console.log(`Sending notification to ${to} for task: ${taskName}`);
      const expDate = new Date(expiresOn+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
      await sendEmail(to, `📋 New task assigned: ${taskName}`,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
          <h2 style="color:#d4537e;margin-bottom:1rem">New task assigned, ${profileName}!</h2>
          <div style="background:#2a1c27;border-radius:10px;padding:1rem 1.25rem;border-left:3px solid #c47c1a;margin-bottom:1rem">
            <div style="font-size:16px;font-weight:600;margin-bottom:4px">${taskName}</div>
            ${taskDesc?`<div style="color:#b8829e;font-size:14px;margin-bottom:8px">${taskDesc}</div>`:''}
            <div style="display:flex;gap:12px;font-size:13px">
              <span style="background:#4d2840;color:#f4c0d1;padding:2px 10px;border-radius:20px;font-weight:600">${pts} pts</span>
              <span style="color:#e8a84a">Due ${expDate}</span>
            </div>
          </div>
          <p style="color:#7a5068;font-size:13px">Log in to complete this task before it expires.</p>
        </div>`
      );
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Proof thumbnail (redirects to signed URL) ──────────────
  if (req.method === 'GET' && url.startsWith('/api/proof/thumb')) {
    const userId = await requireAuth(req);
    if (!userId) { res.writeHead(401); res.end(); return; }
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const key = params.get('key');
    if (!key || !s3Client) { res.writeHead(404); res.end(); return; }
    try {
      const signedUrl = await getSignedViewUrl(key);
      res.writeHead(302, { 'Location': signedUrl });
      res.end();
    } catch(e) { res.writeHead(500); res.end(); }
    return;
  }

  // ── Proof rejection notification ───────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/reject') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { taskId, uploaderProfile } = await parseBody(req);
      const state = await readData();
      const uploaderData = state[uploaderProfile] || {};
      const to = uploaderData.notificationEmail;
      const firstName = uploaderData.firstName || uploaderData.nickname || 'there';
      const reviewerData = state[userId] || {};
      const reviewerName = reviewerData.nickname || reviewerData.firstName || 'Your partner';
      if (to) {
        await sendEmail(to, `📷 Photo proof rejected`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#e06060;margin-bottom:1rem">Photo proof rejected</h2>
            <p style="color:#b8829e;margin-bottom:1rem">Hi ${firstName}, ${reviewerName} has rejected your photo proof for a task.</p>
            <p style="color:#7a5068;font-size:13px">Please upload a new photo to complete the task.</p>
          </div>`
        );
      }
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Photo proof upload ─────────────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/upload') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    if (!s3Client) { 
      console.error('Upload attempted but R2 not configured');
      json(res, { error: 'Photo storage not configured on server' }, 503); return; 
    }
    console.log('Upload request from:', userId);

    // Read multipart body — simple raw buffer approach
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const contentType = req.headers['content-type'] || 'image/jpeg';
        const taskId      = req.headers['x-task-id'] || uid();
        const taskType    = req.headers['x-task-type'] || 'daily';
        const viewerIds   = (req.headers['x-viewer-ids'] || '').split(',').filter(Boolean);
        const buffer      = Buffer.concat(chunks);

        // Max 10MB
        if (buffer.length > 10 * 1024 * 1024) {
          json(res, { error: 'Photo too large (max 10MB)' }, 413); return;
        }

        const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
        const key = `proofs/${userId}/${taskId}/${uid()}.${ext}`;

        await uploadToR2(key, buffer, contentType);

        // Store proof record in app data
        const state = await readData();
        if (!state._proofs) state._proofs = {};
        state._proofs[key] = {
          key, uploadedBy: userId, taskId, taskType,
          viewerIds, uploadedAt: Date.now(),
          viewed: {}, saved: {}
        };
        await writeData(state);

        json(res, { ok: true, key });
      } catch(e) {
        console.error('Upload error full:', e);
        json(res, { error: e.message || 'Upload failed' }, 500);
      }
    });
    return;
  }

  // ── Get signed view URL ────────────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/view') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    if (!s3Client) { json(res, { error: 'Photo storage not configured' }, 503); return; }
    try {
      const { key } = await parseBody(req);
      if (!key) { json(res, { error: 'No key provided' }, 400); return; }
      const signedUrl = await getSignedViewUrl(key);
      json(res, { ok: true, url: signedUrl });
    } catch(e) {
      console.error('View error:', e.message);
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Save or delete proof ───────────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/decide') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { key, action } = await parseBody(req); // action: 'save' | 'delete'
      const state = await readData();
      const proof = state._proofs && state._proofs[key];
      if (!proof) { json(res, { error: 'Proof not found' }, 404); return; }
      if (action === 'save') {
        state._proofs[key].saved[userId] = true;
        await writeData(state);
        json(res, { ok: true });
      } else {
        // Check if anyone else saved it
        const othersSaved = Object.entries(state._proofs[key].saved || {})
          .some(([uid, val]) => uid !== userId && val);
        if (!othersSaved) {
          // Safe to delete from R2
          await deleteFromR2(key);
          delete state._proofs[key];
        } else {
          // Others saved it — just remove this user's save flag
          state._proofs[key].saved[userId] = false;
        }
        await writeData(state);
        json(res, { ok: true });
      }
    } catch(e) {
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Get pending proofs for current user ────────────────────
  if (req.method === 'GET' && url === '/api/proof/pending') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const state = await readData();
      const proofs = state._proofs || {};
      const pending = Object.values(proofs).filter(p =>
        p.viewerIds.includes(userId) && !p.viewed[userId]
      );
      json(res, { proofs: pending });
    } catch(e) {
      json(res, { error: e.message }, 500);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Photo cleanup job — runs daily, deletes unviewed proofs older than 7 days ──
function scheduleProofCleanup() {
  async function runCleanup() {
    console.log('Running photo proof cleanup…');
    try {
      const state = await readData();
      if (!state._proofs) return;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let changed = false;
      for (const [key, proof] of Object.entries(state._proofs)) {
        const allViewersSaved = proof.viewerIds.every(vid => proof.saved && proof.saved[vid]);
        const isOld = proof.uploadedAt < cutoff;
        const noViewers = !proof.viewerIds.length;
        if ((isOld && !allViewersSaved) || noViewers) {
          try { await deleteFromR2(key); } catch(e) { console.error('R2 delete error:', e.message); }
          delete state._proofs[key];
          changed = true;
          console.log(`Cleaned up proof: ${key}`);
        }
      }
      if (changed) await writeData(state);
    } catch(e) {
      console.error('Proof cleanup error:', e.message);
    }
    setTimeout(runCleanup, 24 * 60 * 60 * 1000);
  }
  setTimeout(runCleanup, 60 * 60 * 1000); // first run in 1 hour
  console.log('Photo proof cleanup scheduled');
}

// ── Boot ───────────────────────────────────────────────────────
initR2();
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Task Points server running on port ${PORT}`);
    scheduleDailyReminders();
    if (s3Client) scheduleProofCleanup();
  });
});
