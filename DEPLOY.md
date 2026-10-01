# Deploying

The app is a Node.js server. It does **not** work when copied into `public_html` as plain files (that gives a 403):
it must run as a Node.js app.

Requirements: Node **22.13 or newer** (22 LTS or 24 recommended).

## Hostinger (hPanel Node.js app — Business / Cloud plans)

1. Push this repository to GitHub (`.env`, `data/` and `node_modules/` are git-ignored).
2. If you previously deployed it into `public_html` through Git, remove that deployment first
   (hPanel → Advanced → Git → delete the repository, then empty `public_html`).
3. hPanel → **Websites → Add website → Node.js Apps** → **Import Git repository** → pick this repo.
4. Build settings:
   | Setting | Value |
   |---|---|
   | Node version | **22.x** or **24.x** |
   | Install command | `npm install` |
   | Build command | `npm run build` (does nothing; no build needed) |
   | Start command / entry file | `npm start` / `server.js` |
5. **Environment variables** (same screen):
   | Name | Value |
   |---|---|
   | `WII_PASSWORD` | a long password, 10+ characters (**required**) |
   | `WII_USER` | your login name (default `admin`) |
   | `WII_DATA_DIR` | `/home/<your-hostinger-user>/wii-data` (keeps reports safe across redeploys) |
   | `WII_CONCURRENCY` | `1` |
6. Deploy, then open the domain. The browser asks for the user name and password.

Do not set `PORT`: the host provides it. `HOST` defaults to `0.0.0.0` when a password is set.

### Screenshots, Core Web Vitals and PDF export

These need a Chromium browser. Shared hosting usually cannot run one. Without it, audits still complete;
the report says Core Web Vitals could not be measured and PDF export returns an error (the HTML report works).
If your plan allows it, run once over SSH inside the app folder:

```bash
npm run browser:install
```

For full browser features use a VPS (below).

## VPS (Hostinger VPS, any Ubuntu server)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone <your-repo-url> website-audit && cd website-audit
npm install --omit=dev
npx playwright install --with-deps chromium
cp .env.example .env && nano .env        # set WII_PASSWORD, WII_DATA_DIR
sudo npm install -g pm2
pm2 start npm --name website-audit -- start && pm2 save && pm2 startup
```

Then put Nginx in front (with HTTPS via Certbot) and proxy to `http://127.0.0.1:4173`.
Set `HOST=127.0.0.1` in `.env` so the app is reachable only through Nginx.

## Updating

Push to GitHub and redeploy (Hostinger) or `git pull && npm install --omit=dev && pm2 restart website-audit` (VPS).
Reports survive as long as `WII_DATA_DIR` points outside the app folder.
