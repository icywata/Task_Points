const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');
const PASSWORD  = process.env.APP_PASSWORD || 'interesting';

// ── Database setup ─────────────────────────────────────────────
// Uses Postgres if DATABASE_URL is set (Railway), otherwise falls
// back to a local data.json file so local dev still works.

let db = null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL found — using local data.json');
    return;
  }
  try {
    const { Client } = require('pg');
    db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query(`
      CREATE TABLE IF NOT EXISTS appdata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    console.log('Connected to Postgres');
  } catch (e) {
    console.error('Postgres connection failed:', e.message);
    db = null;
  }
}

const DATA_FILE = path.join(__dirname, 'data.json');

function readDataFile() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
function writeDataFile(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
}

async function readData() {
  if (db) {
    const res = await db.query(`SELECT value FROM appdata WHERE key = 'main'`);
    if (res.rows.length === 0) return {};
    return JSON.parse(res.rows[0].value);
  }
  return readDataFile();
}

async function writeData(obj) {
  if (db) {
    const json = JSON.stringify(obj);
    await db.query(`
      INSERT INTO appdata (key, value) VALUES ('main', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [json]);
  } else {
    writeDataFile(obj);
  }
}

// ── Auth ───────────────────────────────────────────────────────
function checkAuth(req) {
  return (req.headers['x-app-password'] || '') === PASSWORD;
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

  // Auth check endpoint
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

  // Data endpoints — require password
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
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
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
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

// ── Boot ───────────────────────────────────────────────────────
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Task Points server running on port ${PORT}`);
  });
});
