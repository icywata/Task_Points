# Task Points Tracker — Setup Guide

## What's in this folder

| File | Purpose |
|------|---------|
| `server.js` | Node.js server — serves the app and stores data in `data.json` |
| `index.html` | The app itself |
| `package.json` | Tells Railway/Render how to start the server |
| `data.json` | Where all task data is saved (auto-created if missing) |

---

## Deploy to Railway (free, ~2 minutes)

Railway gives you a public URL that anyone anywhere can open.

### 1. Push to GitHub
Put this folder in a GitHub repo. If you've never done this:
1. Go to https://github.com/new and create a repo (e.g. `task-points`)
2. In your terminal, inside this folder:
   ```
   git init
   git add .
   git commit -m "initial"
   git remote add origin https://github.com/YOUR_USERNAME/task-points.git
   git push -u origin main
   ```

### 2. Deploy on Railway
1. Go to https://railway.app and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Pick your `task-points` repo
4. Railway detects `package.json` and deploys automatically
5. Click **Settings → Networking → Generate Domain**
6. You get a URL like `https://task-points-production.up.railway.app`

Share that URL with whoever needs access. That's it.

---

## Important note about data storage

Data is saved in `data.json` on the server's disk. Railway's free tier
has **ephemeral storage** — if the server restarts, `data.json` resets.

To make data truly permanent on Railway, add a **Volume**:
1. In your Railway project, click **New → Volume**
2. Mount it at `/app/data`
3. Change `DATA_FILE` in `server.js` to:
   ```js
   const DATA_FILE = '/app/data/data.json';
   ```
4. Redeploy

Or use **Render.com** instead — it has a free persistent disk option
built in with no extra steps.

---

## Running locally (optional)

If you want to run it on your own machine:
```
node server.js
```
Then open http://localhost:3000 in your browser.
