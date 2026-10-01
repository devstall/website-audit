// Production entry point. Hosting panels (Hostinger, cPanel, Render, ...) can start this file directly
// with `node server.js` or through `npm start`; it needs no build step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Optional .env file next to this one (hosting panel variables take precedence).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(envFile, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.warn(`[startup] Node ${process.versions.node} detected. Use Node 22.13+ (or 24) so reports are stored in SQLite.`);
}

// No top-level await: some hosts (Hostinger, cPanel/Passenger, LiteSpeed) load this file with require().
import('tsx/esm/api')
  .then(({ register }) => {
    register();
    return import('./src/server.ts');
  })
  .then(({ startServer }) => startServer())
  .catch((err) => {
    console.error('[startup] The app could not start:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}
