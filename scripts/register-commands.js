'use strict';

// Registers the bot's slash commands with Discord. Run once per app/guild set.
//   node scripts/register-commands.js
const fs = require('node:fs');
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

const guildId = process.argv[2] || process.env.DISCORD_GUILD_ID || '';

(async () => {
  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  // Bulk overwrite: one request replaces the full command set (avoids per-command rate limits).
  const body = COMMANDS.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    options: cmd.options || [],
    contexts: [0, 1, 2],
    integration_types: [0, 1],
    dm_permission: true,
  }));

  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) {
    console.error('Failed to register commands:', JSON.stringify(json));
    process.exitCode = 1;
  } else {
    console.log(`Registered ${json.length} command(s)${guildId ? ` for guild ${guildId}` : ' (global)'}: ${json.map((c) => '/' + c.name).join(', ')}`);
  }

  // Global commands show up in every server. A leftover guild-scoped copy of the
  // same command shows up beside them, so every command appears twice in that
  // server. After a global registration, clear any guild-scoped commands.
  if (!guildId && r.ok) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${token}` };
    const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers });
    const guilds = guildsRes.ok ? await guildsRes.json() : [];
    for (const g of guilds) {
      const gUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${g.id}/commands`;
      const existing = await fetch(gUrl, { headers }).then((x) => (x.ok ? x.json() : []));
      if (!existing.length) continue;
      const cleared = await fetch(gUrl, { method: 'PUT', headers, body: '[]' });
      console.log(`Cleared ${existing.length} guild-scoped command(s) in ${g.name} (${g.id}): ${cleared.ok ? 'ok' : cleared.status}`);
    }
  } else if (guildId) {
    console.warn('Guild-scoped registration duplicates global commands in that server. Use it only if the global set is not registered.');
  }
})();