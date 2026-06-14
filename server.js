const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT       = process.env.PORT || 3000;
const HTML_FILE  = path.join(__dirname, 'index.html');
const RESEND_KEY = process.env.RESEND_API_KEY || '';

console.log('Server v11 starting — connect codes + cleanup');

// ── Password hashing ───────────────────────────────────────────
function hashPassword(p) {
  return crypto.createHash('sha256').update(p + 'kinkpoints_salt').digest('hex');
}
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function uid() { return crypto.randomBytes(4).toString('hex'); }

// ── R2 storage ─────────────────────────────────────────────────
const R2_ENDPOINT   = process.env.R2_ENDPOINT || '';
const R2_BUCKET     = process.env.R2_BUCKET_NAME || 'kinkpoints-proofs';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
let s3Client = null, s3Presigner = null;

function initR2() {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY || !R2_SECRET_KEY) { console.log('R2 not configured'); return; }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    s3Client = new S3Client({ region:'auto', endpoint:R2_ENDPOINT, credentials:{ accessKeyId:R2_ACCESS_KEY, secretAccessKey:R2_SECRET_KEY } });
    s3Presigner = getSignedUrl;
    console.log('R2 storage ready');
  } catch(e) { console.error('R2 init failed:', e.message); }
}

async function uploadToR2(key, buffer, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({ Bucket:R2_BUCKET, Key:key, Body:buffer, ContentType:contentType }));
}
async function getSignedViewUrl(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  return await s3Presigner(s3Client, new GetObjectCommand({ Bucket:R2_BUCKET, Key:key }), { expiresIn:900 });
}
async function deleteFromR2(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new DeleteObjectCommand({ Bucket:R2_BUCKET, Key:key }));
}

// ── Email ──────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY || !to) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({ from:'KinkPoints <contact@kinkpoints.app>', to, subject, html });
    const opts = { hostname:'api.resend.com', path:'/emails', method:'POST', headers:{ 'Authorization':`Bearer ${RESEND_KEY}`, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) } };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) console.log(`Email sent to ${to}`);
        else console.error('Email failed:', res.statusCode, data);
        resolve();
      });
    });
    req.on('error', e => { console.error('Email error:', e.message); resolve(); });
    req.write(body); req.end();
  });
}

// ── Database ───────────────────────────────────────────────────
let db = null;

async function initDb() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL'); return; }
  try {
    const { Client } = require('pg');
    db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await createSchema();
    console.log('Connected to Postgres');
  } catch(e) { console.error('Postgres failed:', e.message); db = null; }
}

async function createSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT UNIQUE,
      first_name TEXT,
      last_name TEXT,
      nickname TEXT,
      role TEXT,
      icon TEXT DEFAULT 'heart',
      theme TEXT DEFAULT 'rose',
      notification_email TEXT,
      email_verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Add columns that may not exist yet on older installs
  const alterCols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT 'heart'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'rose'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS connect_code TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS used_invite_code TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_invite_token TEXT`,
    `ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS visible_to TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS visible_to TEXT`,
  ];
  for (const sql of alterCols) {
    try { await db.query(sql); } catch(e) {}
  }
  try {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_connect_code_unique ON users(connect_code) WHERE connect_code IS NOT NULL`);
  } catch(e) {}

  // Generate connect codes for users that don't have one
  await db.query(`
    UPDATE users SET connect_code = LPAD(FLOOR(RANDOM() * 90000 + 10000)::TEXT, 5, '0')
    WHERE connect_code IS NULL
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      user_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      label TEXT,
      capacity INTEGER NOT NULL DEFAULT 200,
      used INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS partner_invites (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS partner_requests (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(from_user_id, to_user_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS partnerships (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL REFERENCES users(id),
      user_b_id TEXT NOT NULL REFERENCES users(id),
      status TEXT DEFAULT 'active',
      requested_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_a_id, user_b_id)
    );
    CREATE TABLE IF NOT EXISTS partnership_permissions (
      id TEXT PRIMARY KEY,
      partnership_id TEXT NOT NULL REFERENCES partnerships(id),
      granting_user_id TEXT NOT NULL REFERENCES users(id),
      grantee_user_id TEXT NOT NULL REFERENCES users(id),
      allow_tasks BOOLEAN DEFAULT FALSE,
      allow_shop BOOLEAN DEFAULT FALSE,
      UNIQUE(granting_user_id, grantee_user_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_by TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      points INTEGER NOT NULL,
      require_proof BOOLEAN DEFAULT FALSE,
      proof_reviewer_id TEXT REFERENCES users(id),
      visible_to TEXT REFERENCES users(id),
      assigned_on DATE,
      expires_on DATE,
      start_date DATE,
      deleted_from DATE,
      month_key TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS task_completions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      completed_by TEXT NOT NULL REFERENCES users(id),
      completed_on DATE NOT NULL,
      proof_key TEXT,
      proof_status TEXT,
      proof_reviewer_id TEXT REFERENCES users(id),
      proof_reviewed_at TIMESTAMPTZ,
      proof_saved BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(task_id, completed_by, completed_on)
    );
    CREATE TABLE IF NOT EXISTS monthly_completions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      completed_by TEXT NOT NULL REFERENCES users(id),
      completed_on DATE,
      month_key TEXT NOT NULL,
      UNIQUE(task_id, completed_by, month_key)
    );
    CREATE TABLE IF NOT EXISTS shop_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT,
      cost INTEGER NOT NULL,
      visible_to TEXT REFERENCES users(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      shop_item_id TEXT REFERENCES shop_items(id),
      shop_item_name TEXT NOT NULL,
      shop_item_desc TEXT,
      cost INTEGER NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      redeemed_by TEXT NOT NULL REFERENCES users(id),
      redeemed_at TIMESTAMPTZ DEFAULT NOW(),
      fulfilled BOOLEAN DEFAULT FALSE,
      fulfilled_at TIMESTAMPTZ,
      fulfilled_by TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS proof_photos (
      id TEXT PRIMARY KEY,
      r2_key TEXT NOT NULL UNIQUE,
      task_id TEXT REFERENCES tasks(id),
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      viewer_ids TEXT[],
      status TEXT DEFAULT 'pending',
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      saved_by TEXT[]
    );
    CREATE TABLE IF NOT EXISTS appdata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ── Session management ─────────────────────────────────────────
async function createSession(userId) {
  const token = generateToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.query(`INSERT INTO sessions (token,user_id,expires_at) VALUES ($1,$2,$3)`, [token, userId, expires]);
  return token;
}
async function getSession(token) {
  if (!token || !db) return null;
  const res = await db.query(`SELECT user_id FROM sessions WHERE token=$1 AND expires_at > NOW()`, [token]);
  return res.rows.length ? res.rows[0].user_id : null;
}
async function deleteSession(token) {
  if (db) await db.query(`DELETE FROM sessions WHERE token=$1`, [token]);
}

// ── Cookie helpers ─────────────────────────────────────────────
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k,...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}
function setCookieHeader(token) {
  return `session=${token}; HttpOnly; Path=/; Max-Age=${30*24*60*60}; SameSite=Lax; Secure`;
}

async function requireAuth(req) {
  const token = parseCookies(req).session;
  return await getSession(token);
}

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

// ── User helpers ───────────────────────────────────────────────
async function generateUniqueConnectCode() {
  let code, exists = true;
  while (exists) {
    code = Math.floor(10000 + Math.random() * 90000).toString();
    const r = await db.query(`SELECT id FROM users WHERE connect_code=$1`, [code]);
    exists = r.rows.length > 0;
  }
  return code;
}

async function getUserById(id) {
  const r = await db.query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function getUserByEmail(email) {
  const r = await db.query('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  return r.rows[0] || null;
}
async function getPartnership(userId) {
  const r = await db.query(`SELECT * FROM partnerships WHERE (user_a_id=$1 OR user_b_id=$1) AND status='active'`, [userId]);
  if (!r.rows.length) return null;
  const p = r.rows[0];
  const partnerId = p.user_a_id === userId ? p.user_b_id : p.user_a_id;
  return { partnershipId: p.id, partnerId };
}
async function getPermissions(grantingUserId, granteeUserId) {
  const r = await db.query(`SELECT * FROM partnership_permissions WHERE granting_user_id=$1 AND grantee_user_id=$2`, [grantingUserId, granteeUserId]);
  return r.rows[0] || { allow_tasks: false, allow_shop: false };
}

// ── Points calculation ─────────────────────────────────────────
async function getTotalEarned(userId) {
  // Daily/assigned/repeat completions
  const r1 = await db.query(`
    SELECT COALESCE(SUM(t.points),0) as total
    FROM task_completions tc
    JOIN tasks t ON tc.task_id = t.id
    WHERE tc.completed_by = $1
    AND (tc.proof_status IS NULL OR tc.proof_status = 'approved')
  `, [userId]);
  // Monthly completions
  const r2 = await db.query(`
    SELECT COALESCE(SUM(t.points),0) as total
    FROM monthly_completions mc
    JOIN tasks t ON mc.task_id = t.id
    WHERE mc.completed_by = $1 AND mc.completed_on IS NOT NULL
  `, [userId]);
  return parseInt(r1.rows[0].total) + parseInt(r2.rows[0].total);
}
async function getTotalSpent(userId) {
  const r = await db.query(`SELECT COALESCE(SUM(cost),0) as total FROM inventory WHERE redeemed_by=$1`, [userId]);
  return parseInt(r.rows[0].total);
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
      if (!db) return;
      const today = new Date().toISOString().slice(0,10);
      const r = await db.query(`
        SELECT t.*, u.notification_email, u.first_name, u.nickname
        FROM tasks t
        JOIN users u ON t.owner_id = u.id
        WHERE t.type = 'assigned' AND t.expires_on = $1 AND t.active = TRUE
        AND NOT EXISTS (SELECT 1 FROM task_completions tc WHERE tc.task_id = t.id AND tc.completed_by = t.owner_id)
      `, [today]);
      const byUser = {};
      r.rows.forEach(t => {
        if (!t.notification_email) return;
        if (!byUser[t.owner_id]) byUser[t.owner_id] = { email: t.notification_email, name: t.first_name || t.nickname || 'there', tasks: [] };
        byUser[t.owner_id].tasks.push(t);
      });
      for (const { email, name, tasks } of Object.values(byUser)) {
        const taskList = tasks.map(t => `<li style="margin-bottom:8px"><strong>${t.name}</strong> <span style="color:#e8a84a">(${t.points} pts)</span></li>`).join('');
        await sendEmail(email, `⏰ ${tasks.length} task${tasks.length>1?'s':''} expiring today`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#d4537e;margin-bottom:1rem">Tasks expiring today, ${name}!</h2>
            <ul style="padding-left:1.25rem;color:#f0dce8">${taskList}</ul>
          </div>`);
      }
    } catch(e) { console.error('Reminder error:', e.message); }
    setTimeout(runReminders, 24*60*60*1000);
  }
  setTimeout(runReminders, msUntil8am());
  console.log(`Daily reminders scheduled — first run in ${Math.round(msUntil8am()/60000)} minutes`);
}

// ── Proof cleanup ──────────────────────────────────────────────
function scheduleProofCleanup() {
  async function runCleanup() {
    if (!db || !s3Client) return;
    try {
      const cutoff = new Date(Date.now() - 7*24*60*60*1000).toISOString();
      const r = await db.query(`SELECT * FROM proof_photos WHERE status='pending' AND uploaded_at < $1`, [cutoff]);
      for (const p of r.rows) {
        try { await deleteFromR2(p.r2_key); } catch(e) {}
        await db.query(`DELETE FROM proof_photos WHERE id=$1`, [p.id]);
      }
    } catch(e) { console.error('Proof cleanup error:', e.message); }
    setTimeout(runCleanup, 24*60*60*1000);
  }
  setTimeout(runCleanup, 60*60*1000);
}

// ── Migration from old JSON blob ───────────────────────────────
async function migrateFromJson(state, dadUser, ggUser, partnershipId) {
  const migrate = async (profile, user) => {
    const p = state[profile];
    if (!p) return;

    // Tasks - daily
    for (const [dateKey, day] of Object.entries(p.days || {})) {
      for (const t of (day.tasks || [])) {
        const taskId = t.id || uid();
        await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,require_proof,active) VALUES ($1,$2,$3,'daily',$4,$5,$6,$7,TRUE) ON CONFLICT DO NOTHING`,
          [taskId, user.id, user.id, t.name, t.desc||null, t.pts, t.requireProof||false]);
        if (t.done) {
          await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [uid(), taskId, user.id, dateKey]);
        }
      }
    }

    // Tasks - monthly
    for (const [monthKey, tasks] of Object.entries(p.monthly || {})) {
      for (const t of tasks) {
        const taskId = t.id || uid();
        await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,month_key,active) VALUES ($1,$2,$3,'monthly',$4,$5,$6,$7,TRUE) ON CONFLICT DO NOTHING`,
          [taskId, user.id, user.id, t.name, t.desc||null, t.pts, monthKey]);
        const done = (p.monthlyDone||{})[monthKey]?.[t.id];
        if (done) {
          await db.query(`INSERT INTO monthly_completions (id,task_id,completed_by,completed_on,month_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [uid(), taskId, user.id, done, monthKey]);
        }
      }
    }

    // Tasks - repeating
    for (const t of (p.repeating || [])) {
      const taskId = t.id || uid();
      const deletedFrom = (p.repeatingDeleted||{})[t.id] || null;
      await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,start_date,deleted_from,active) VALUES ($1,$2,$3,'repeat',$4,$5,$6,$7,$8,TRUE) ON CONFLICT DO NOTHING`,
        [taskId, user.id, user.id, t.name, t.desc||null, t.pts, t.startDate, deletedFrom]);
      for (const [dateKey, done] of Object.entries(p.repeatingDone || {})) {
        if (done[t.id]) {
          await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [uid(), taskId, user.id, dateKey]);
        }
      }
    }

    // Tasks - assigned
    for (const t of (p.assigned || [])) {
      const taskId = t.id || uid();
      await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,assigned_on,expires_on,require_proof,active) VALUES ($1,$2,$3,'assigned',$4,$5,$6,$7,$8,$9,TRUE) ON CONFLICT DO NOTHING`,
        [taskId, user.id, user.id, t.name, t.desc||null, t.pts, t.assignedOn, t.expiresOn, t.requireProof||false]);
      if (t.completedOn) {
        await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [uid(), taskId, user.id, t.completedOn]);
      }
    }

    // Shop items
    for (const item of (p.shop || [])) {
      await db.query(`INSERT INTO shop_items (id,owner_id,name,description,cost,active) VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT DO NOTHING`,
        [item.id||uid(), user.id, item.name, item.desc||null, item.cost]);
    }

    // Inventory
    for (const inv of (p.inventory || [])) {
      // Check if referenced shop item exists to avoid FK violation
      let shopItemId = null;
      if (inv.rewardId) {
        const check = await db.query(`SELECT id FROM shop_items WHERE id=$1`, [inv.rewardId]);
        if (check.rows.length) shopItemId = inv.rewardId;
      }
      await db.query(`INSERT INTO inventory (id,shop_item_id,shop_item_name,shop_item_desc,cost,owner_id,redeemed_by,redeemed_at,fulfilled,fulfilled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [inv.id||uid(), shopItemId, inv.name, inv.desc||null, inv.cost,
         inv.fromUserId === 'dad' ? dadUser.id : ggUser.id,
         user.id, new Date(inv.redeemedAt||Date.now()),
         inv.fulfilled||false, inv.fulfilledAt ? new Date(inv.fulfilledAt) : null]);
    }

    // User permissions
    if (p.permissions) {
      for (const [targetProfile, perms] of Object.entries(p.permissions)) {
        const granteeUser = targetProfile === 'dad' ? dadUser : ggUser;
        await db.query(`INSERT INTO partnership_permissions (id,partnership_id,granting_user_id,grantee_user_id,allow_tasks,allow_shop)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (granting_user_id,grantee_user_id) DO UPDATE SET allow_tasks=$5,allow_shop=$6`,
          [uid(), partnershipId, user.id, granteeUser.id, perms.tasks||false, perms.shop||false]);
      }
    }
  };

  await migrate('dad', dadUser);
  await migrate('gg', ggUser);
  console.log('Migration complete');
}

// ── Bootstrap HTML ─────────────────────────────────────────────
const BOOTSTRAP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Bootstrap Admin v2</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;padding:2rem 1rem;display:flex;align-items:flex-start;justify-content:center}
  .wrap{width:100%;max-width:560px}
  h1{font-size:20px;font-weight:700;color:#fff;margin-bottom:4px}
  .subtitle{font-size:13px;color:#666;margin-bottom:2rem}
  .warning{background:#2d1a1a;border:1px solid #5a2020;border-radius:10px;padding:12px 16px;font-size:13px;color:#e06060;margin-bottom:1.5rem}
  .info{background:#1a1a2d;border:1px solid #202050;border-radius:10px;padding:12px 16px;font-size:13px;color:#a0a0e0;margin-bottom:1.5rem}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:1.5rem;margin-bottom:1rem}
  .card h2{font-size:14px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#888;margin-bottom:1rem}
  .field{margin-bottom:12px}
  label{display:block;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:#666;margin-bottom:5px}
  input,select{width:100%;background:#111;border:1px solid #2a2a2a;border-radius:8px;color:#e0e0e0;font-family:inherit;font-size:14px;padding:9px 12px;outline:none}
  input:focus,select:focus{border-color:#d4537e}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .admin-field{background:#1a1a2a;border:1px solid #2a2a4a;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
  .admin-field h2{font-size:14px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#4a6aaa;margin-bottom:1rem}
  .btn{width:100%;height:44px;background:#d4537e;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:1.5rem}
  .btn:hover{background:#993556}
  .result{margin-top:1rem;padding:12px 16px;border-radius:10px;font-size:14px;display:none;white-space:pre-wrap}
  .result.ok{background:#1a2d1a;border:1px solid #2a5a2a;color:#6abf6a}
  .result.err{background:#2d1a1a;border:1px solid #5a2020;color:#e06060}
</style>
</head>
<body>
<div class="wrap">
  <h1>🔐 Bootstrap Admin v2</h1>
  <p class="subtitle">Migrate to proper multi-tenant schema</p>
  <div class="warning">⚠️ Run once only. This migrates all existing data to the new schema.</div>
  <div class="info">ℹ️ All your existing tasks, points, shop items, and inventory will be preserved. You will need to log in again after migration.</div>
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
    <div class="field"><label>Username</label><input type="text" id="dadUsername" value="mcduffro" placeholder="username"/></div>
    <div class="field"><label>Nickname</label><input type="text" id="dadNickname" value="Daddy"/></div>
    <div class="field"><label>Role</label>
      <select id="dadRole">
        <option>Daddy</option><option>Dominant</option><option>Domme</option><option>Master</option>
        <option>Mistress</option><option>Mommy</option><option>Owner</option><option>Switch</option>
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
    <div class="field"><label>Username</label><input type="text" id="ggUsername" value="lilyroh99" placeholder="username"/></div>
    <div class="field"><label>Nickname</label><input type="text" id="ggNickname" value="Good Girl"/></div>
    <div class="field"><label>Role</label>
      <select id="ggRole">
        <option>Submissive</option><option>Sub</option><option>Babygirl</option><option>Little</option>
        <option>Slave</option><option>Pet</option><option>Switch</option>
      </select>
    </div>
    <div class="field"><label>Email</label><input type="email" id="ggEmail" placeholder="goodgirl@email.com"/></div>
    <div class="field"><label>Password</label><input type="password" id="ggPassword" placeholder="Choose a password"/></div>
  </div>
  <button class="btn" onclick="migrate()">Migrate & Create Users</button>
  <div class="result" id="result"></div>
</div>
<script>
async function migrate() {
  const adminKey=document.getElementById('adminKey').value.trim();
  const dad={ firstName:document.getElementById('dadFirstName').value.trim(), lastName:document.getElementById('dadLastName').value.trim(), username:document.getElementById('dadUsername').value.trim().toLowerCase(), nickname:document.getElementById('dadNickname').value.trim(), role:document.getElementById('dadRole').value, email:document.getElementById('dadEmail').value.trim(), password:document.getElementById('dadPassword').value };
  const gg={ firstName:document.getElementById('ggFirstName').value.trim(), lastName:document.getElementById('ggLastName').value.trim(), username:document.getElementById('ggUsername').value.trim().toLowerCase(), nickname:document.getElementById('ggNickname').value.trim(), role:document.getElementById('ggRole').value, email:document.getElementById('ggEmail').value.trim(), password:document.getElementById('ggPassword').value };
  if(!adminKey||!dad.email||!dad.password||!gg.email||!gg.password){showResult('Please fill in all required fields',false);return;}
  const btn=document.querySelector('.btn');
  btn.textContent='Migrating…';btn.disabled=true;
  const res=await fetch('/api/admin/migrate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminKey,dad,gg})});
  const data=await res.json();
  showResult(res.ok?'✓ '+data.message:'Error: '+data.error,res.ok);
  btn.textContent='Migrate & Create Users';btn.disabled=false;
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

  // ── Test endpoint ──────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/test') {
    json(res, { ok:true, version:'v10', time:new Date().toISOString() }); return;
  }

  // ── Serve HTML ─────────────────────────────────────────────
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── Bootstrap admin page ───────────────────────────────────
  if (req.method === 'GET' && url === '/admin/bootstrap') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(BOOTSTRAP_HTML);
    return;
  }

  // ── Migration endpoint ─────────────────────────────────────
  if (req.method === 'POST' && url === '/api/admin/migrate') {
    try {
      const { adminKey, dad, gg } = await parseBody(req);
      if (adminKey !== 'Daemoni') { json(res, { error: 'Invalid admin key' }, 401); return; }

      // Read existing JSON blob
      let state = {};
      try {
        const r = await db.query(`SELECT value FROM appdata WHERE key='main'`);
        if (r.rows.length) state = JSON.parse(r.rows[0].value);
      } catch(e) { console.log('No existing appdata, starting fresh'); }

      // Create or update dad user
      const dadId = 'dad';
      const ggId  = 'gg';
      await db.query(`INSERT INTO users (id,email,password_hash,username,first_name,last_name,nickname,role,notification_email,icon,theme)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET email=$2,password_hash=$3,username=COALESCE(users.username,$4),first_name=$5,last_name=$6,nickname=$7,role=$8,notification_email=$9`,
        [dadId, dad.email, hashPassword(dad.password), 'mcduffro', dad.firstName, dad.lastName, dad.nickname||'Daddy', dad.role||'Dominant',
         dad.email, state.dad?.icon||'star', state.dad?.theme||'midnight']);

      await db.query(`INSERT INTO users (id,email,password_hash,username,first_name,last_name,nickname,role,notification_email,icon,theme)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET email=$2,password_hash=$3,username=COALESCE(users.username,$4),first_name=$5,last_name=$6,nickname=$7,role=$8,notification_email=$9`,
        [ggId, gg.email, hashPassword(gg.password), 'lilyroh99', gg.firstName, gg.lastName, gg.nickname||'Good Girl', gg.role||'Submissive',
         gg.email, state.gg?.icon||'heart', state.gg?.theme||'rose']);

      // Partnership
      const partnershipId = 'dad-gg-partnership';
      await db.query(`INSERT INTO partnerships (id,user_a_id,user_b_id,status,requested_by)
        VALUES ($1,$2,$3,'active',$4) ON CONFLICT DO NOTHING`,
        [partnershipId, dadId, ggId, dadId]);

      // Migrate all data
      const dadUser = { id: dadId };
      const ggUser  = { id: ggId };
      await migrateFromJson(state, dadUser, ggUser, partnershipId);

      // Clear old sessions so everyone logs in fresh
      await db.query(`DELETE FROM sessions`);
      // Mark bootstrapped users as verified and bypass invite requirement
      await db.query(`UPDATE users SET email_verified=TRUE, used_invite_code='bootstrap' WHERE id IN ($1,$2)`, [dadId, ggId]);
      // Scope any existing dad shop items to gg (existing items were created for her)
      await db.query(`UPDATE shop_items SET visible_to=$1 WHERE owner_id=$2 AND visible_to IS NULL`, [ggId, dadId]);

      json(res, { ok: true, message: 'Migration complete! All data preserved. Please log in again.' });
    } catch(e) {
      console.error('Migration error:', e);
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Forgot password ────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/forgot-password') {
    try {
      const { email } = await parseBody(req);
      const user = await getUserByEmail(email);
      // Always respond OK to prevent email enumeration
      if (user) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 30 * 60 * 1000);
        await db.query(`DELETE FROM email_verifications WHERE LOWER(email)=LOWER($1)`, [email]);
        await db.query(`INSERT INTO email_verifications (id,email,code,user_id,expires_at) VALUES ($1,$2,$3,$4,$5)`,
          [uid(), email.toLowerCase(), code, user.id, expires]);
        await sendEmail(email, `Your KinkPoints password reset code: ${code}`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#d4537e;margin-bottom:1rem">Password reset</h2>
            <p style="color:#b8829e;margin-bottom:1.5rem">Use this code to reset your password:</p>
            <div style="background:#2a1c27;border-radius:12px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
              <div style="font-size:36px;font-weight:700;color:#d4537e;letter-spacing:10px">${code}</div>
            </div>
            <p style="color:#7a5068;font-size:13px">This code expires in 30 minutes. If you didn't request a reset, ignore this email.</p>
          </div>`);
      }
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Reset password ─────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/reset-password') {
    try {
      const { email, code, password } = await parseBody(req);
      if (password.length < 8) { json(res, { error: 'Password must be at least 8 characters' }, 400); return; }
      const r = await db.query(`SELECT * FROM email_verifications WHERE LOWER(email)=LOWER($1) AND code=$2 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`, [email, code]);
      if (!r.rows.length) { json(res, { error: 'Invalid or expired code' }, 400); return; }
      const verification = r.rows[0];
      await db.query(`UPDATE users SET password_hash=$1, email_verified=TRUE WHERE id=$2`, [hashPassword(password), verification.user_id]);
      await db.query(`DELETE FROM email_verifications WHERE LOWER(email)=LOWER($1)`, [email]);
      // Invalidate all existing sessions for security
      await db.query(`DELETE FROM sessions WHERE user_id=$1`, [verification.user_id]);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Check invite code ──────────────────────────────────────
  if (req.method === 'POST' && url === '/api/invite/check') {
    try {
      const { code } = await parseBody(req);
      if (!code) { json(res, { valid: false, error: 'No code provided' }); return; }
      // Check batch invite code
      const r = await db.query(`SELECT * FROM invite_codes WHERE LOWER(code)=LOWER($1) AND active=TRUE`, [code.trim()]);
      if (!r.rows.length) { json(res, { valid: false, error: 'Invalid invite code' }); return; }
      const inv = r.rows[0];
      if (inv.used >= inv.capacity) { json(res, { valid: false, error: 'Sorry, all invites have been used. Check back later!' }); return; }
      json(res, { valid: true, type: 'batch', label: inv.label, remaining: inv.capacity - inv.used });
    } catch(e) { json(res, { valid: false, error: e.message }); }
    return;
  }

  // ── Check partner invite token ─────────────────────────────
  if (req.method === 'GET' && url.startsWith('/api/invite/partner?')) {
    try {
      const token = new URL('http://x'+url).searchParams.get('token');
      if (!token) { json(res, { valid: false }); return; }
      const r = await db.query(`SELECT pi.*, u.nickname, u.username FROM partner_invites pi JOIN users u ON u.id=pi.from_user_id WHERE pi.token=$1 AND pi.used=FALSE`, [token]);
      if (!r.rows.length) { json(res, { valid: false, error: 'Invite link is invalid or already used' }); return; }
      json(res, { valid: true, fromUsername: r.rows[0].username, fromNickname: r.rows[0].nickname, toEmail: r.rows[0].to_email, token });
    } catch(e) { json(res, { valid: false, error: e.message }); }
    return;
  }

  // ── Send partner invite email ──────────────────────────────
  if (req.method === 'POST' && url === '/api/invite/partner') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { email } = await parseBody(req);
      if (!email) { json(res, { error: 'Email required' }, 400); return; }
      // Check user hasn't already sent a partner invite
      const existing = await db.query(`SELECT id FROM partner_invites WHERE from_user_id=$1 AND used=FALSE`, [userId]);
      if (existing.rows.length) {
        // Resend existing invite
        await db.query(`DELETE FROM partner_invites WHERE from_user_id=$1 AND used=FALSE`, [userId]);
      }
      const user = await getUserById(userId);
      const token = crypto.randomBytes(24).toString('hex');
      await db.query(`INSERT INTO partner_invites (id,from_user_id,to_email,token) VALUES ($1,$2,$3,$4)`,
        [uid(), userId, email.toLowerCase(), token]);
      const inviteUrl = `${process.env.APP_URL || 'https://kinkpoints.app'}/signup?invite=${token}`;
      const senderName = user.nickname || user.username || 'Someone';
      await sendEmail(email, `${senderName} invited you to KinkPoints`,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
          <h2 style="color:#d4537e;margin-bottom:1rem">You've been invited 💝</h2>
          <p style="color:#b8829e;margin-bottom:1rem"><strong style="color:#f0dce8">${senderName}</strong> has invited you to join them on KinkPoints — a private app for tracking tasks, earning points, and staying connected.</p>
          <div style="text-align:center;margin:1.5rem 0">
            <a href="${inviteUrl}" style="background:#d4537e;color:#fff;padding:12px 28px;border-radius:30px;text-decoration:none;font-weight:700;font-size:15px">Accept invite & sign up</a>
          </div>
          <p style="color:#7a5068;font-size:12px;text-align:center">This invite is just for you. Once you sign up you'll be connected automatically.</p>
        </div>`);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Admin: create invite code ──────────────────────────────
  if (req.method === 'POST' && url === '/api/admin/invite-code') {
    try {
      const { key, code, label, capacity } = await parseBody(req);
      if (key !== 'Daemoni') { json(res, { error: 'Unauthorized' }, 401); return; }
      await db.query(`INSERT INTO invite_codes (id,code,label,capacity) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET label=$3,capacity=$4,active=TRUE`,
        [uid(), code.toUpperCase(), label||code, capacity||200]);
      json(res, { ok: true, code: code.toUpperCase(), capacity: capacity||200 });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Admin: list invite codes ───────────────────────────────
  if (req.method === 'GET' && url === '/api/admin/invite-codes') {
    try {
      const authHeader = req.headers['x-admin-key'];
      if (authHeader !== 'Daemoni') { json(res, { error: 'Unauthorized' }, 401); return; }
      const r = await db.query(`SELECT * FROM invite_codes ORDER BY created_at DESC`);
      json(res, r.rows);
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Signup ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/signup') {
    try {
      const { firstName, username, email, password, role, inviteCode, partnerToken } = await parseBody(req);
      // Validate
      if (!firstName || !username || !email || !password || !role) { json(res, { error: 'All fields required' }, 400); return; }
      if (password.length < 8) { json(res, { error: 'Password must be at least 8 characters' }, 400); return; }
      if (!/^[a-z0-9_]+$/.test(username)) { json(res, { error: 'Username can only contain letters, numbers and underscores' }, 400); return; }

      // Validate invite — must have either a batch code or a partner token
      let inviteCodeId = null;
      let partnerInviteId = null;
      if (partnerToken) {
        const pi = await db.query(`SELECT * FROM partner_invites WHERE token=$1 AND used=FALSE`, [partnerToken]);
        if (!pi.rows.length) { json(res, { error: 'Invite link is invalid or already used' }, 403); return; }
        partnerInviteId = pi.rows[0].id;
      } else if (inviteCode) {
        const ic = await db.query(`SELECT * FROM invite_codes WHERE LOWER(code)=LOWER($1) AND active=TRUE`, [inviteCode.trim()]);
        if (!ic.rows.length) { json(res, { error: 'Invalid invite code' }, 403); return; }
        if (ic.rows[0].used >= ic.rows[0].capacity) { json(res, { error: 'Sorry, all invites have been used. Check back later!' }, 403); return; }
        inviteCodeId = ic.rows[0].id;
      } else {
        json(res, { error: 'An invite code or partner invite is required to sign up' }, 403); return;
      }
      // Check email unique
      const existingEmail = await db.query(`SELECT id FROM users WHERE LOWER(email)=LOWER($1)`, [email]);
      if (existingEmail.rows.length) { json(res, { error: 'An account with that email already exists' }, 409); return; }
      // Check username unique
      const existingUser = await db.query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`, [username]);
      if (existingUser.rows.length) { json(res, { error: 'That username is already taken' }, 409); return; }
      // Generate connect code
      const connectCode = await generateUniqueConnectCode();
      // Create user (unverified)
      const userId = uid() + uid(); // longer ID for real users
      await db.query(`INSERT INTO users (id,email,password_hash,username,first_name,nickname,role,notification_email,connect_code,email_verified)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)`,
        [userId, email.toLowerCase(), hashPassword(password), username, firstName, username, role, email.toLowerCase(), connectCode]);
      // Mark invite used
      if (inviteCodeId) {
        await db.query(`UPDATE invite_codes SET used=used+1 WHERE id=$1`, [inviteCodeId]);
      }
      if (partnerInviteId) {
        await db.query(`UPDATE partner_invites SET used=TRUE WHERE id=$1`, [partnerInviteId]);
        // Auto-send partner request from inviter to new user
        const invRow = await db.query(`SELECT from_user_id FROM partner_invites WHERE id=$1`, [partnerInviteId]);
        if (invRow.rows.length) {
          await db.query(`INSERT INTO partner_requests (id,from_user_id,to_user_id,status) VALUES ($1,$2,$3,'pending') ON CONFLICT DO NOTHING`,
            [uid(), invRow.rows[0].from_user_id, userId]);
        }
      }
      // Generate verification code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
      await db.query(`INSERT INTO email_verifications (id,email,code,user_id,expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [uid(), email.toLowerCase(), code, userId, expires]);
      // Send verification email
      await sendEmail(email, `Your KinkPoints verification code: ${code}`,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
          <h2 style="color:#d4537e;margin-bottom:1rem">Welcome to KinkPoints, ${firstName}!</h2>
          <p style="color:#b8829e;margin-bottom:1.5rem">Enter this code to verify your email address:</p>
          <div style="background:#2a1c27;border-radius:12px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
            <div style="font-size:36px;font-weight:700;color:#d4537e;letter-spacing:10px">${code}</div>
          </div>
          <p style="color:#7a5068;font-size:13px">This code expires in 30 minutes. If you didn't create a KinkPoints account, ignore this email.</p>
        </div>`);
      json(res, { ok: true });
    } catch(e) { console.error('Signup error:', e); json(res, { error: e.message }, 500); }
    return;
  }

  // ── Verify email ───────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/verify-email') {
    try {
      const { email, code } = await parseBody(req);
      const r = await db.query(`SELECT * FROM email_verifications WHERE LOWER(email)=LOWER($1) AND code=$2 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`, [email, code]);
      if (!r.rows.length) { json(res, { error: 'Invalid or expired code' }, 400); return; }
      const verification = r.rows[0];
      // Mark user verified
      await db.query(`UPDATE users SET email_verified=TRUE WHERE id=$1`, [verification.user_id]);
      // Clean up codes
      await db.query(`DELETE FROM email_verifications WHERE email=LOWER($1)`, [email]);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Resend verification ────────────────────────────────────
  if (req.method === 'POST' && url === '/api/resend-verification') {
    try {
      const { email } = await parseBody(req);
      const user = await getUserByEmail(email);
      if (!user) { json(res, { error: 'Email not found' }, 404); return; }
      if (user.email_verified) { json(res, { error: 'Email already verified' }, 400); return; }
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 30 * 60 * 1000);
      await db.query(`DELETE FROM email_verifications WHERE email=LOWER($1)`, [email]);
      await db.query(`INSERT INTO email_verifications (id,email,code,user_id,expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [uid(), email.toLowerCase(), code, user.id, expires]);
      await sendEmail(email, `Your new KinkPoints verification code: ${code}`,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
          <h2 style="color:#d4537e;margin-bottom:1rem">New verification code</h2>
          <div style="background:#2a1c27;border-radius:12px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
            <div style="font-size:36px;font-weight:700;color:#d4537e;letter-spacing:10px">${code}</div>
          </div>
          <p style="color:#7a5068;font-size:13px">Expires in 30 minutes.</p>
        </div>`);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Login ──────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/login') {
    try {
      const { email, password } = await parseBody(req);
      console.log(`Login attempt: ${email}`);
      const user = await getUserByEmail(email);
      if (!user) { console.log('User not found'); json(res, { error: 'Invalid email or password' }, 401); return; }
      if (user.password_hash !== hashPassword(password)) { console.log('Wrong password'); json(res, { error: 'Invalid email or password' }, 401); return; }
      if (!user.email_verified) { json(res, { error: 'Please verify your email before signing in', unverified: true }, 403); return; }
      const token = await createSession(user.id);
      console.log(`Login success: ${user.id}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': setCookieHeader(token) });
      res.end(JSON.stringify({ ok: true, userId: user.id }));
    } catch(e) { console.error('Login error:', e.message); json(res, { error: e.message }, 500); }
    return;
  }

  // ── Logout ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/logout') {
    const cookies = parseCookies(req);
    if (cookies.session) await deleteSession(cookies.session);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0; Secure' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Get current user ───────────────────────────────────────
  // ── Per-partnership balances ───────────────────────────────
  if (req.method === 'GET' && url === '/api/balances') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const partnerships = await db.query(`
        SELECT p.id, p.created_at,
          CASE WHEN p.user_a_id=$1 THEN p.user_b_id ELSE p.user_a_id END as partner_id
        FROM partnerships p
        WHERE (p.user_a_id=$1 OR p.user_b_id=$1) AND p.status='active'
      `, [userId]);

      const balances = {};
      for (const pship of partnerships.rows) {
        const partnerId = pship.partner_id;

        // Points earned on tasks visible to this partner or everyone
        // No date cutoff for existing partnerships — "fresh start" is enforced
        // naturally because new tasks default to visible_to = specific partner
        const earned = await db.query(`
          SELECT COALESCE(SUM(t.points), 0) as total
          FROM task_completions tc
          JOIN tasks t ON t.id = tc.task_id
          WHERE tc.completed_by = $1
            AND (t.visible_to = $2 OR t.visible_to IS NULL)
        `, [userId, partnerId]);

        // Points spent on items from this partner's shop
        const spent = await db.query(`
          SELECT COALESCE(SUM(i.cost), 0) as total
          FROM inventory i
          WHERE i.redeemed_by = $1 AND i.owner_id = $2
        `, [userId, partnerId]);

        balances[partnerId] = {
          earned: parseInt(earned.rows[0].total),
          spent: parseInt(spent.rows[0].total),
          balance: parseInt(earned.rows[0].total) - parseInt(spent.rows[0].total),
          partnershipStart
        };
      }
      json(res, balances);
    } catch(e) { console.error('Balances error:', e); json(res, { error: e.message }, 500); }
    return;
  }

  if (req.method === 'GET' && url === '/api/me') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Not authenticated' }, 401); return; }
    try {
      const user = await getUserById(userId);
      if (!user) { json(res, { error: 'User not found' }, 404); return; }
      const partnership = await getPartnership(userId);
      let partnerData = null;
      if (partnership) partnerData = await getUserById(partnership.partnerId);
      // Get pending incoming requests
      const reqsResult = await db.query(`
        SELECT pr.*, u.username, u.nickname, u.icon FROM partner_requests pr
        JOIN users u ON u.id = pr.from_user_id
        WHERE pr.to_user_id=$1 AND pr.status='pending'
      `, [userId]);

      json(res, {
        userId: user.id,
        username: user.username,
        connectCode: user.connect_code,
        firstName: user.first_name,
        lastName: user.last_name,
        nickname: user.nickname,
        role: user.role,
        icon: user.icon,
        theme: user.theme,
        email: user.notification_email,
        partnerId: partnership?.partnerId || null,
        partnershipId: partnership?.partnershipId || null,
        partnerUsername: partnerData?.username || null,
        partnerNickname: partnerData?.nickname || null,
        partnerFirstName: partnerData?.first_name || null,
        partnerLastName: partnerData?.last_name || null,
        partnerRole: partnerData?.role || null,
        partnerIcon: partnerData?.icon || null,
        partnerTheme: partnerData?.theme || null,
        partnerEmail: partnerData?.notification_email || null,
        pendingRequests: reqsResult.rows.map(r => ({
          id: r.id,
          fromUserId: r.from_user_id,
          username: r.username,
          nickname: r.nickname,
          icon: r.icon,
          createdAt: r.created_at
        }))
      });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Save profile ───────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/profile') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { firstName, lastName, nickname, role, email, icon, theme, username } = await parseBody(req);
      // Check username uniqueness if changing
      if (username) {
        const existing = await db.query(`SELECT id FROM users WHERE username=$1 AND id!=$2`, [username, userId]);
        if (existing.rows.length) { json(res, { error: 'Username already taken' }, 409); return; }
      }
      await db.query(`UPDATE users SET first_name=$1,last_name=$2,nickname=$3,role=$4,notification_email=$5,icon=$6,theme=$7,username=COALESCE($8,username) WHERE id=$9`,
        [firstName, lastName, nickname, role, email, icon, theme, username||null, userId]);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Get app data ───────────────────────────────────────────
  // Returns data structured the same way the frontend expects
  if (req.method === 'GET' && url === '/api/data') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const partnership = await getPartnership(userId);
      const partnerIds = partnership ? [userId, partnership.partnerId] : [userId];
      const result = {};

      for (const uid of partnerIds) {
        const p = {};
        const isOwner = uid === userId;
        // Params: [uid] for owner, [uid, userId] for partner view
        const visParams = isOwner ? [uid] : [uid, userId];

        // Build days structure from task_completions
        p.days = {};
        const dailyTasks = await db.query(`
          SELECT t.*, tc.completed_on, tc.proof_key, tc.proof_status, tc.proof_saved
          FROM tasks t
          LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.completed_by = t.owner_id
          WHERE t.owner_id=$1 AND t.type='daily' AND t.active=TRUE
          ${isOwner ? '' : 'AND (t.visible_to IS NULL OR t.visible_to=$2)'}
        `, visParams);
        dailyTasks.rows.forEach(t => {
          const dateKey = t.completed_on ? t.completed_on.toISOString().slice(0,10) : null;
          const key = dateKey || t.created_at.toISOString().slice(0,10);
          if (!p.days[key]) p.days[key] = { tasks:[] };
          p.days[key].tasks.push({
            id: t.id, name: t.name, desc: t.description, pts: t.points,
            createdBy: t.created_by, visibleTo: t.visible_to,
            done: !!t.completed_on, requireProof: t.require_proof,
            proof: t.proof_key ? { key: t.proof_key, state: t.proof_status||'pending', savedBy: t.proof_saved ? {[uid]:true} : {} } : null
          });
        });

        // Monthly tasks
        p.monthly = {}; p.monthlyDone = {};
        const monthlyTasks = await db.query(`SELECT t.*, mc.completed_on, mc.month_key as done_month FROM tasks t LEFT JOIN monthly_completions mc ON mc.task_id=t.id AND mc.completed_by=$1 WHERE t.owner_id=$1 AND t.type='monthly' AND t.active=TRUE ${isOwner ? '' : 'AND (t.visible_to IS NULL OR t.visible_to=$2)'}`, visParams);
        monthlyTasks.rows.forEach(t => {
          const mk = t.month_key;
          if (!p.monthly[mk]) p.monthly[mk] = [];
          if (!p.monthly[mk].find(x => x.id === t.id)) {
            p.monthly[mk].push({ id:t.id, name:t.name, desc:t.description, pts:t.points, visibleTo:t.visible_to, createdBy:t.created_by });
          }
          if (t.completed_on) {
            if (!p.monthlyDone[mk]) p.monthlyDone[mk] = {};
            p.monthlyDone[mk][t.id] = t.completed_on.toISOString().slice(0,10);
          }
        });

        // Repeating tasks
        p.repeating = []; p.repeatingDone = {}; p.repeatingDeleted = {};
        const repeatingTasks = await db.query(`SELECT t.*, tc.completed_on FROM tasks t LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.completed_by=$1 WHERE t.owner_id=$1 AND t.type='repeat' AND t.active=TRUE ${isOwner ? '' : 'AND (t.visible_to IS NULL OR t.visible_to=$2)'}`, visParams);
        const seen = new Set();
        repeatingTasks.rows.forEach(t => {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            p.repeating.push({ id:t.id, name:t.name, desc:t.description, pts:t.points, startDate:t.start_date?.toISOString().slice(0,10), requireProof:t.require_proof, visibleTo:t.visible_to, createdBy:t.created_by });
            if (t.deleted_from) p.repeatingDeleted[t.id] = t.deleted_from.toISOString().slice(0,10);
          }
          if (t.completed_on) {
            const dk = t.completed_on.toISOString().slice(0,10);
            if (!p.repeatingDone[dk]) p.repeatingDone[dk] = {};
            p.repeatingDone[dk][t.id] = true;
          }
        });

        // Assigned tasks
        p.assigned = [];
        const assignedTasks = await db.query(`SELECT t.*, tc.completed_on, tc.proof_key, tc.proof_status FROM tasks t LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.completed_by=$1 WHERE t.owner_id=$1 AND t.type='assigned' AND t.active=TRUE ${isOwner ? '' : 'AND (t.visible_to IS NULL OR t.visible_to=$2)'}`, visParams);
        const seenA = new Set();
        assignedTasks.rows.forEach(t => {
          if (!seenA.has(t.id)) {
            seenA.add(t.id);
            p.assigned.push({
              id:t.id, name:t.name, desc:t.description, pts:t.points,
              createdBy:t.created_by, visibleTo:t.visible_to,
              assignedOn:t.assigned_on?.toISOString().slice(0,10),
              expiresOn:t.expires_on?.toISOString().slice(0,10),
              completedOn:t.completed_on?.toISOString().slice(0,10)||null,
              requireProof:t.require_proof,
              proof:t.proof_key ? { key:t.proof_key, state:t.proof_status||'pending', viewerIds:[] } : null
            });
          }
        });

        // Shop items
        // Owner sees ALL their items (for management)
        // Partner sees only items scoped to them or to everyone (null)
        p.shop = [];
        const shopQuery = uid === userId
          ? `SELECT * FROM shop_items WHERE owner_id=$1 AND active=TRUE ORDER BY created_at`
          : `SELECT * FROM shop_items WHERE owner_id=$1 AND active=TRUE AND (visible_to IS NULL OR visible_to=$2) ORDER BY created_at`;
        const shopParams = uid === userId ? [uid] : [uid, userId];
        const shopItems = await db.query(shopQuery, shopParams);
        p.shop = shopItems.rows.map(i => ({ id:i.id, name:i.name, desc:i.description, cost:i.cost, visibleTo:i.visible_to }));

        // Inventory — items this user redeemed
        p.inventory = [];
        const inv = await db.query(`SELECT * FROM inventory WHERE redeemed_by=$1 ORDER BY redeemed_at`, [uid]);
        p.inventory = inv.rows.map(i => ({
          id:i.id, rewardId:i.shop_item_id, name:i.shop_item_name, desc:i.shop_item_desc,
          cost:i.cost, fromUserId:i.owner_id, redeemedAt:i.redeemed_at?.getTime(),
          fulfilled:i.fulfilled, fulfilledAt:i.fulfilled_at?.getTime()||null
        }));

        // Permissions
        p.permissions = {};
        const permsResult = await db.query(`SELECT * FROM partnership_permissions WHERE granting_user_id=$1`, [uid]);
        permsResult.rows.forEach(pr => {
          p.permissions[pr.grantee_user_id] = { tasks:pr.allow_tasks, shop:pr.allow_shop };
        });

        result[uid] = p;
      }

      // Add partnership info
      if (partnership) {
        result.partnership = { userA:'dad', userB:'gg', status:'active' };
      }

      // Add partner's balance with current user (for displaying on partner's profile)
      if (partnership) {
        const partnerId = partnership.partnerId;

        const theirEarned = await db.query(`
          SELECT COALESCE(SUM(t.points), 0) as total
          FROM task_completions tc
          JOIN tasks t ON t.id = tc.task_id
          WHERE tc.completed_by = $1
            AND (t.visible_to = $2 OR t.visible_to IS NULL)
        `, [partnerId, userId]);

        const theirSpent = await db.query(`
          SELECT COALESCE(SUM(i.cost), 0) as total
          FROM inventory i WHERE i.redeemed_by=$1 AND i.owner_id=$2
        `, [partnerId, userId]);

        const te = parseInt(theirEarned.rows[0].total);
        const ts = parseInt(theirSpent.rows[0].total);
        result._partnerBalances = { earned: te, spent: ts, balance: te - ts };
      }

      json(res, result);
    } catch(e) { console.error('Get data error:', e); json(res, { error: e.message }, 500); }
    return;
  }

  // ── Save app data (writes back changes) ────────────────────
  if (req.method === 'POST' && url === '/api/data') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const state = await parseBody(req);
      const partnership = await getPartnership(userId);
      const myData = state[userId];
      if (!myData) { json(res, { ok: true }); return; }

      // Also process partner's data if present (e.g. tasks assigned to partner)
      const partnerData = partnership ? state[partnership.partnerId] : null;

      // Helper to save assigned tasks for a given profile
      const saveAssigned = async (assigned, ownerIdVal, createdByVal) => {
        for (const t of (assigned || [])) {
          await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,assigned_on,expires_on,require_proof,active)
            VALUES ($1,$2,$3,'assigned',$4,$5,$6,$7,$8,$9,TRUE) ON CONFLICT (id) DO NOTHING`,
            [t.id, ownerIdVal, createdByVal, t.name, t.desc||null, t.pts, t.assignedOn, t.expiresOn, t.requireProof||false]);
          if (t.completedOn) {
            await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [uid(), t.id, ownerIdVal, t.completedOn]);
          }
          if (t.proof?.key) {
            await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on,proof_key,proof_status)
              VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (task_id,completed_by,completed_on) DO UPDATE SET proof_key=$5,proof_status=$6`,
              [uid(), t.id, ownerIdVal, t.completedOn||t.assignedOn, t.proof.key, t.proof.state||'pending']);
          }
        }
      };

      // Save partner's assigned tasks (tasks we added to their profile)
      if (partnerData && partnerData.assigned) {
        await saveAssigned(partnerData.assigned, partnership.partnerId, userId);
      }

      // Save partner's other task types if we have permission
      if (partnerData && partnership) {
        const perms = await getPermissions(partnership.partnerId, userId);
        if (perms.allow_tasks) {
          // Daily tasks added to partner's profile
          for (const [dateKey, day] of Object.entries(partnerData.days || {})) {
            for (const t of (day.tasks || [])) {
              await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,require_proof,active) VALUES ($1,$2,$3,'daily',$4,$5,$6,$7,TRUE) ON CONFLICT (id) DO NOTHING`,
                [t.id, partnership.partnerId, userId, t.name, t.desc||null, t.pts, t.requireProof||false]);
            }
          }
          // Monthly tasks
          for (const [mk, tasks] of Object.entries(partnerData.monthly || {})) {
            for (const t of tasks) {
              await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,month_key,active) VALUES ($1,$2,$3,'monthly',$4,$5,$6,$7,TRUE) ON CONFLICT (id) DO NOTHING`,
                [t.id, partnership.partnerId, userId, t.name, t.desc||null, t.pts, mk]);
            }
          }
          // Repeating tasks
          for (const t of (partnerData.repeating || [])) {
            const deletedFrom = (partnerData.repeatingDeleted || {})[t.id] || null;
            await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,start_date,deleted_from,active) VALUES ($1,$2,$3,'repeat',$4,$5,$6,$7,$8,TRUE) ON CONFLICT (id) DO UPDATE SET deleted_from=$8`,
              [t.id, partnership.partnerId, userId, t.name, t.desc||null, t.pts, t.startDate, deletedFrom]);
          }
        }
      }

      // Update profile icon/theme if changed
      const user = await getUserById(userId);

      // Process tasks - upsert daily tasks for today
      for (const [dateKey, day] of Object.entries(myData.days || {})) {
        for (const t of (day.tasks || [])) {
          await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,require_proof,visible_to,active) VALUES ($1,$2,$3,'daily',$4,$5,$6,$7,$8,TRUE) ON CONFLICT (id) DO UPDATE SET visible_to=$8 WHERE tasks.active=TRUE`,
            [t.id, userId, userId, t.name, t.desc||null, t.pts, t.requireProof||false, t.visibleTo||null]);
          if (t.done) {
            await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [uid(), t.id, userId, dateKey]);
          } else {
            await db.query(`DELETE FROM task_completions WHERE task_id=$1 AND completed_by=$2 AND completed_on=$3`, [t.id, userId, dateKey]);
          }
          if (t.proof?.key) {
            await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on,proof_key,proof_status)
              VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (task_id,completed_by,completed_on) DO UPDATE SET proof_key=$5,proof_status=$6`,
              [uid(), t.id, userId, dateKey, t.proof.key, t.proof.state||'pending']);
          }
        }
      }

      // Monthly completions
      for (const [mk, tasks] of Object.entries(myData.monthly || {})) {
        for (const t of tasks) {
          await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,month_key,visible_to,active) VALUES ($1,$2,$3,'monthly',$4,$5,$6,$7,$8,TRUE) ON CONFLICT (id) DO UPDATE SET visible_to=$8 WHERE tasks.active=TRUE`,
            [t.id, userId, userId, t.name, t.desc||null, t.pts, mk, t.visibleTo||null]);
        }
      }
      for (const [mk, done] of Object.entries(myData.monthlyDone || {})) {
        for (const [taskId, completedOn] of Object.entries(done)) {
          if (completedOn) {
            await db.query(`INSERT INTO monthly_completions (id,task_id,completed_by,completed_on,month_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (task_id,completed_by,month_key) DO UPDATE SET completed_on=$4`,
              [uid(), taskId, userId, completedOn, mk]);
          } else {
            await db.query(`DELETE FROM monthly_completions WHERE task_id=$1 AND completed_by=$2 AND month_key=$3`, [taskId, userId, mk]);
          }
        }
      }

      // Repeating tasks
      for (const t of (myData.repeating || [])) {
        const deletedFrom = (myData.repeatingDeleted || {})[t.id] || null;
        await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,start_date,deleted_from,visible_to,active) VALUES ($1,$2,$3,'repeat',$4,$5,$6,$7,$8,$9,TRUE) ON CONFLICT (id) DO UPDATE SET deleted_from=$8,visible_to=$9 WHERE tasks.active=TRUE`,
          [t.id, userId, userId, t.name, t.desc||null, t.pts, t.startDate, deletedFrom, t.visibleTo||null]);
      }
      for (const [dateKey, done] of Object.entries(myData.repeatingDone || {})) {
        for (const [taskId, isDone] of Object.entries(done)) {
          if (isDone) {
            await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [uid(), taskId, userId, dateKey]);
          }
        }
      }

      // Assigned tasks
      for (const t of (myData.assigned || [])) {
        await db.query(`INSERT INTO tasks (id,owner_id,created_by,type,name,description,points,assigned_on,expires_on,require_proof,visible_to,active) VALUES ($1,$2,$3,'assigned',$4,$5,$6,$7,$8,$9,$10,TRUE) ON CONFLICT (id) DO UPDATE SET visible_to=$10 WHERE tasks.active=TRUE`,
          [t.id, userId, userId, t.name, t.desc||null, t.pts, t.assignedOn, t.expiresOn, t.requireProof||false, t.visibleTo||null]);
        if (t.completedOn) {
          await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [uid(), t.id, userId, t.completedOn]);
        }
        if (t.proof?.key) {
          await db.query(`INSERT INTO task_completions (id,task_id,completed_by,completed_on,proof_key,proof_status)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (task_id,completed_by,completed_on) DO UPDATE SET proof_key=$5,proof_status=$6`,
            [uid(), t.id, userId, t.completedOn||t.assignedOn, t.proof.key, t.proof.state||'pending']);
        }
      }

      // Shop items
      for (const item of (myData.shop || [])) {
        await db.query(`INSERT INTO shop_items (id,owner_id,name,description,cost,visible_to,active) VALUES ($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT (id) DO UPDATE SET visible_to=$6`,
          [item.id, userId, item.name, item.desc||null, item.cost, item.visibleTo||null]);
      }

      // Inventory
      for (const inv of (myData.inventory || [])) {
        await db.query(`INSERT INTO inventory (id,shop_item_id,shop_item_name,shop_item_desc,cost,owner_id,redeemed_by,redeemed_at,fulfilled,fulfilled_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET fulfilled=$9,fulfilled_at=$10`,
          [inv.id, inv.rewardId||null, inv.name, inv.desc||null, inv.cost,
           inv.fromUserId||userId, userId, new Date(inv.redeemedAt||Date.now()),
           inv.fulfilled||false, inv.fulfilledAt ? new Date(inv.fulfilledAt) : null]);
      }

      // Permissions
      for (const [targetId, perms] of Object.entries(myData.permissions || {})) {
        const partnership2 = await getPartnership(userId);
        if (!partnership2) continue;
        await db.query(`INSERT INTO partnership_permissions (id,partnership_id,granting_user_id,grantee_user_id,allow_tasks,allow_shop)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (granting_user_id,grantee_user_id) DO UPDATE SET allow_tasks=$5,allow_shop=$6`,
          [uid(), partnership2.partnershipId, userId, targetId, perms.tasks||false, perms.shop||false]);
      }

      json(res, { ok: true });
    } catch(e) { console.error('Save data error:', e); json(res, { error: e.message }, 500); }
    return;
  }

  // ── Permissions ────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/permissions') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { granteeId, allowTasks, allowShop } = await parseBody(req);
      const partnership = await getPartnership(userId);
      if (!partnership) { json(res, { error: 'No partnership' }, 400); return; }
      await db.query(`INSERT INTO partnership_permissions (id,partnership_id,granting_user_id,grantee_user_id,allow_tasks,allow_shop)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (granting_user_id,grantee_user_id) DO UPDATE SET allow_tasks=$5,allow_shop=$6`,
        [uid(), partnership.partnershipId, userId, granteeId, allowTasks, allowShop]);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Send partner request by connect code ──────────────────
  if (req.method === 'POST' && url === '/api/partner/request') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { connectCode } = await parseBody(req);
      if (!connectCode) { json(res, { error: 'Connect code required' }, 400); return; }
      // Find target user by code
      const target = await db.query(`SELECT id, username, nickname FROM users WHERE connect_code=$1`, [connectCode.trim()]);
      if (!target.rows.length) { json(res, { error: 'No user found with that code' }, 404); return; }
      const targetUser = target.rows[0];
      if (targetUser.id === userId) { json(res, { error: 'You cannot add yourself' }, 400); return; }
      // Check not already partners
      const existing = await getPartnership(userId);
      if (existing && existing.partnerId === targetUser.id) { json(res, { error: 'Already partners' }, 409); return; }
      // Check not blocked
      const blocked = await db.query(`SELECT status FROM partner_requests WHERE from_user_id=$1 AND to_user_id=$2 AND status='blocked'`, [targetUser.id, userId]);
      if (blocked.rows.length) { json(res, { error: 'Unable to send request' }, 403); return; }
      // Upsert request
      await db.query(`INSERT INTO partner_requests (id,from_user_id,to_user_id,status) VALUES ($1,$2,$3,'pending')
        ON CONFLICT (from_user_id,to_user_id) DO UPDATE SET status='pending',created_at=NOW()`,
        [uid(), userId, targetUser.id]);
      json(res, { ok: true, message: `Request sent to @${targetUser.username || targetUser.nickname}` });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Respond to partner request ─────────────────────────────
  if (req.method === 'POST' && url === '/api/partner/respond') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { requestId, action } = await parseBody(req); // action: accept | decline | block
      const reqResult = await db.query(`SELECT * FROM partner_requests WHERE id=$1 AND to_user_id=$2`, [requestId, userId]);
      if (!reqResult.rows.length) { json(res, { error: 'Request not found' }, 404); return; }
      const partnerReq = reqResult.rows[0];
      if (action === 'accept') {
        // Create partnership
        const partnershipId = `${partnerReq.from_user_id}-${userId}-${uid()}`;
        await db.query(`INSERT INTO partnerships (id,user_a_id,user_b_id,status,requested_by) VALUES ($1,$2,$3,'active',$4)
          ON CONFLICT DO NOTHING`, [partnershipId, partnerReq.from_user_id, userId, partnerReq.from_user_id]);
        await db.query(`UPDATE partner_requests SET status='accepted' WHERE id=$1`, [requestId]);
        // Notify requester by email
        const requester = await getUserById(partnerReq.from_user_id);
        const accepter = await getUserById(userId);
        if (requester?.notification_email) {
          await sendEmail(requester.notification_email, `🎉 ${accepter.nickname || accepter.username} accepted your partner request!`,
            `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
              <h2 style="color:#d4537e;margin-bottom:1rem">Partner request accepted!</h2>
              <p style="color:#b8829e;">@${accepter.username || accepter.nickname} has accepted your partner request on KinkPoints. Log in to get started!</p>
            </div>`);
        }
        json(res, { ok: true, action: 'accepted' });
      } else if (action === 'decline') {
        await db.query(`UPDATE partner_requests SET status='declined' WHERE id=$1`, [requestId]);
        json(res, { ok: true, action: 'declined' });
      } else if (action === 'block') {
        await db.query(`UPDATE partner_requests SET status='blocked' WHERE id=$1`, [requestId]);
        json(res, { ok: true, action: 'blocked' });
      } else {
        json(res, { error: 'Invalid action' }, 400);
      }
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Get my connect code ────────────────────────────────────
  if (req.method === 'GET' && url === '/api/partner/code') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const user = await getUserById(userId);
      json(res, { connectCode: user.connect_code });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Debug task ownership ───────────────────────────────────
  if (req.method === 'GET' && url === '/api/debug/tasks') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const r = await db.query(`SELECT id, name, type, owner_id, created_by, active FROM tasks WHERE owner_id=$1 OR created_by=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
      json(res, { userId, tasks: r.rows });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Update shop item ───────────────────────────────────────
  if (req.method === 'POST' && url === '/api/shop/update') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { id, name, desc, cost, visibleTo } = await parseBody(req);
      await db.query(`UPDATE shop_items SET name=$1, description=$2, cost=$3, visible_to=$4 WHERE id=$5 AND owner_id=$6`,
        [name, desc||null, cost, visibleTo||null, id, userId]);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Update task ────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/task/update') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { taskId, name, desc, pts, visibleTo, updateVisibility } = await parseBody(req);
      console.log(`Task update: ${taskId}, updateVisibility: ${updateVisibility}, userId: ${userId}, visibleTo: ${visibleTo}`);
      if (updateVisibility) {
        const r = await db.query(`UPDATE tasks SET visible_to=$1 WHERE id=$2 AND owner_id=$3`,
          [visibleTo||null, taskId, userId]);
        console.log(`Visibility updated, rows: ${r.rowCount}`);
        if (r.rowCount === 0) {
          // Maybe column doesn't exist yet — try adding it
          try { await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS visible_to TEXT`); } catch(e2) {}
          await db.query(`UPDATE tasks SET visible_to=$1 WHERE id=$2 AND owner_id=$3`,
            [visibleTo||null, taskId, userId]);
        }
      } else {
        const r = await db.query(`UPDATE tasks SET name=$1, description=$2, points=$3 WHERE id=$4 AND created_by=$5`,
          [name, desc||null, pts, taskId, userId]);
        console.log(`Content updated, rows: ${r.rowCount}`);
      }
      json(res, { ok: true });
    } catch(e) {
      console.error('Task update error:', e.message);
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Delete task ────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/task/delete') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { taskId, ownerProfile } = await parseBody(req);
      console.log(`Delete task ${taskId} by user ${userId}, ownerProfile: ${ownerProfile}`);
      // Allow if: user owns task, user created task, or user is deleting from their partner's profile
      const r = await db.query(
        `UPDATE tasks SET active=FALSE WHERE id=$1 AND (owner_id=$2 OR created_by=$2 OR owner_id=$3)`,
        [taskId, userId, ownerProfile || userId]
      );
      console.log(`Rows updated: ${r.rowCount}`);
      json(res, { ok: true });
    } catch(e) { console.error('Delete error:', e); json(res, { error: e.message }, 500); }
    return;
  }

  // ── Delete repeating task from date ───────────────────────
  if (req.method === 'POST' && url === '/api/task/delete-from') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { taskId, fromDate } = await parseBody(req);
      await db.query(`UPDATE tasks SET deleted_from=$1 WHERE id=$2 AND owner_id=$3`, [fromDate, taskId, userId]);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Proof upload ───────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/upload') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    if (!s3Client) { json(res, { error: 'Photo storage not configured' }, 503); return; }
    console.log('Upload request from:', userId);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const contentType = req.headers['content-type'] || 'image/jpeg';
        const taskId = req.headers['x-task-id'] || uid();
        const viewerIds = (req.headers['x-viewer-ids'] || '').split(',').filter(Boolean);
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 10 * 1024 * 1024) { json(res, { error: 'Photo too large (max 10MB)' }, 413); return; }
        const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
        const key = `proofs/${userId}/${taskId}/${uid()}.${ext}`;
        await uploadToR2(key, buffer, contentType);
        await db.query(`INSERT INTO proof_photos (id,r2_key,task_id,uploaded_by,viewer_ids,status) VALUES ($1,$2,$3,$4,$5,'pending')`,
          [uid(), key, taskId, userId, viewerIds]);
        json(res, { ok: true, key });
      } catch(e) { console.error('Upload error:', e); json(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── Proof view ─────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/view') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    if (!s3Client) { json(res, { error: 'Storage not configured' }, 503); return; }
    try {
      const { key } = await parseBody(req);
      if (!key) { json(res, { error: 'No key' }, 400); return; }
      const signedUrl = await getSignedViewUrl(key);
      json(res, { ok: true, url: signedUrl });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Proof thumbnail ────────────────────────────────────────
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

  // ── Proof decide (save/delete) ─────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/decide') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { key, action } = await parseBody(req);
      if (action === 'save') {
        await db.query(`UPDATE proof_photos SET saved_by = array_append(COALESCE(saved_by,'{}'), $1) WHERE r2_key=$2`, [userId, key]);
      } else {
        // Check if others saved it
        const r = await db.query(`SELECT saved_by FROM proof_photos WHERE r2_key=$1`, [key]);
        const savedBy = (r.rows[0]?.saved_by || []).filter(id => id !== userId);
        if (!savedBy.length) {
          try { await deleteFromR2(key); } catch(e) {}
          await db.query(`DELETE FROM proof_photos WHERE r2_key=$1`, [key]);
        } else {
          await db.query(`UPDATE proof_photos SET saved_by=$1 WHERE r2_key=$2`, [savedBy, key]);
        }
      }
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Proof reject notification ──────────────────────────────
  if (req.method === 'POST' && url === '/api/proof/reject') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { taskId, uploaderProfile } = await parseBody(req);
      const uploader = await getUserById(uploaderProfile);
      const reviewer = await getUserById(userId);
      if (uploader?.notification_email) {
        const name = uploader.first_name || uploader.nickname || 'there';
        const reviewerName = reviewer?.nickname || reviewer?.first_name || 'Your partner';
        await sendEmail(uploader.notification_email, `📷 Photo proof rejected`,
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#1a1118;color:#f0dce8;padding:2rem;border-radius:12px">
            <h2 style="color:#e06060;margin-bottom:1rem">Photo proof rejected</h2>
            <p style="color:#b8829e;">Hi ${name}, ${reviewerName} rejected your photo proof. Please upload a new one.</p>
          </div>`);
      }
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── Assigned task notification ─────────────────────────────
  if (req.method === 'POST' && url === '/api/notify/assigned') {
    const userId = await requireAuth(req);
    if (!userId) { json(res, { error: 'Unauthorized' }, 401); return; }
    try {
      const { to, taskName, taskDesc, pts, expiresOn, profileName } = await parseBody(req);
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
        </div>`);
      json(res, { ok: true });
    } catch(e) { json(res, { error: e.message }, 500); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Boot ───────────────────────────────────────────────────────
initR2();
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Task Points server running on port ${PORT}`);
    scheduleDailyReminders();
    if (s3Client) scheduleProofCleanup();
  });
});
