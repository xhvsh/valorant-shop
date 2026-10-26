'use strict';

// Audits the bot's registered slash commands and exits 1 when something is off:
//   node scripts/check-commands.js
// Checks that the global set matches COMMANDS, and that no server has its own
// copy of a command (which makes it show up twice in that server). Fix with
//   node scripts/register-commands.js
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* env injected elsewhere */
}

const { COMMANDS } = require('../src/discord/commands');

const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID;
if (!token || !appId) {
  console.error('Missing DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}` };

async function get(url) {
  const r = await fetch(`${API}${url}`, { headers });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

(async () => {
  const problems = [];
  const expected = new Set(COMMANDS.map((c) => c.name));
  const global = await get(`/applications/${appId}/commands`);
  const globalNames = global.map((c) => c.name);

  for (const name of globalNames) {
    if (globalNames.filter((n) => n === name).length > 1) problems.push(`global: /${name} is registered more than once`);
    if (!expected.has(name)) problems.push(`global: /${name} is registered but no longer defined in COMMANDS`);
  }
  for (const name of expected) if (!globalNames.includes(name)) problems.push(`global: /${name} is defined but not registered`);

  const guilds = await get('/users/@me/guilds');
  for (const g of guilds) {
    const own = await get(`/applications/${appId}/guilds/${g.id}/commands`);
    if (own.length) {
      problems.push(`guild ${g.name} (${g.id}): ${own.length} server-only command(s) duplicate the global ones: ${own.map((c) => `/${c.name}`).join(', ')}`);
    }
  }

  console.log(`Global: ${globalNames.map((n) => `/${n}`).join(' ')} | servers checked: ${guilds.length}`);
  if (!problems.length) {
    console.log('OK: no duplicate or missing commands.');
    return;
  }
  for (const p of problems) console.error(`PROBLEM: ${p}`);
  console.error('Run: node scripts/register-commands.js');
  process.exitCode = 1;
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
