'use strict';

// Boots app.js in memory mode (no database, no Discord, no Riot) with a fake signed-in
// session and calls the routes that every page load depends on. Catches crashes such as
// a ReferenceError in a route before they reach production. Run: npm run test:smoke
process.env.SESSION_SECRET = 'smoke-session-secret';
process.env.LINK_SECRET = 'smoke-link-secret';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.BASE_URL = 'http://localhost';
process.env.DISCORD_CLIENT_ID = '1';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.BASE_PATH;

const assert = require('node:assert/strict');
const http = require('node:http');
const signature = require('cookie-signature');
const storage = require('../src/storage');
const app = require('../app');

async function main() {
  const sid = 'smoke-session-id';
  await storage.sessionSet(sid, { cookie: { originalMaxAge: 60000, expires: null, httpOnly: true, path: '/' }, discordId: '123456789012345678', discordName: 'smoke', discordAvatar: null }, 60000);
  const cookie = `valshops.sid=${encodeURIComponent(`s:${signature.sign(sid, process.env.SESSION_SECRET)}`)}`;

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function get(path, withCookie) {
    const res = await fetch(base + path, { headers: withCookie ? { cookie } : {} });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  }

  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`ok   ${name}`);
    } catch (e) {
      results.push(`FAIL ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };

  await check('GET /health', async () => {
    const r = await get('/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
  await check('GET /api/me signed out', async () => {
    const r = await get('/api/me');
    assert.equal(r.status, 200);
    assert.equal(r.json.authorized, false);
  });
  await check('GET /api/me signed in', async () => {
    const r = await get('/api/me', true);
    assert.equal(r.status, 200);
    assert.equal(r.json.authorized, true);
    assert.equal(r.json.username, 'smoke');
  });
  await check('GET /api/accounts', async () => {
    const r = await get('/api/accounts', true);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.json.ok, true);
  });
  await check('GET /api/prefs', async () => {
    const r = await get('/api/prefs', true);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.json.ok, true);
  });
  await check('cron rejects a missing secret', async () => {
    const r = await get('/api/cron/bundles?secret=smoke-link-secret');
    assert.equal(r.status, 403);
  });
  await check('removed grid routes are gone', async () => {
    assert.equal((await get('/api/skin-grid?id=1')).status, 404);
    assert.equal((await get('/api/bundle-grid?b=1')).status, 404);
  });

  console.log(results.join('\n'));
  server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
