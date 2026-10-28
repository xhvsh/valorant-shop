'use strict';

// Best-effort log poster for the private logs channel. Never throws; all
// failures fall back to console output only.

// Both are optional. Without LOG_CHANNEL_ID nothing is posted to Discord.
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '';
const ADMIN_ID = process.env.ADMIN_DISCORD_ID || '';

function adminMention() {
  return ADMIN_ID ? `<@${ADMIN_ID}>` : "the admin";
}

function userMention(discordId) {
  return `<@${discordId}>`;
}

// Cache of discordId -> display name so repeated logs don't re-hit the API.
const nameCache = new Map();

async function resolveName(discordId) {
  const id = String(discordId);
  if (nameCache.has(id)) return nameCache.get(id);
  const token = process.env.DISCORD_BOT_TOKEN || '';
  if (!token) return null;
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${id}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    const name = u.username || null;
    if (name) nameCache.set(id, name);
    return name;
  } catch {
    return null;
  }
}

// Replace every <@id> / <@!id> mention with the user's unique username so
// the log reads "xhvsh did X" instead of "@xhvsh did X" (no mention pill, no
// ping). When keepAdmin is true (failure alerts only) the admin mention is left
// intact so it still pings.
async function renderNames(text, keepAdmin) {
  const ids = [...new Set([...String(text).matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];
  let out = String(text);
  for (const id of ids) {
    if (keepAdmin && ADMIN_ID && id === ADMIN_ID) continue;
    const name = await resolveName(id);
    if (!name) continue;
    out = out.split(`<@${id}>`).join(name).split(`<@!${id}>`).join(name);
  }
  return out;
}

async function sendLog(content, opts = {}) {
  const token = process.env.DISCORD_BOT_TOKEN || '';
  if (!token || !LOG_CHANNEL_ID) {
    console.warn('[log] no bot token or log channel, skipping discord log');
    return false;
  }
  const ping = !!opts.ping;
  try {
    const text = await renderNames(String(content).slice(0, 1900), ping);
    const res = await fetch(`https://discord.com/api/v10/channels/${LOG_CHANNEL_ID}/messages`, {
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      // Failure alerts keep the admin mention and may ping them; normal lines
      // have every mention turned into plain text, so nothing can ping.
      body: JSON.stringify({
        content: text,
        allowed_mentions: ping && ADMIN_ID ? { users: [ADMIN_ID] } : { parse: [] },
      }),
    });
    if (!res.ok) {
      console.warn('[log] discord log failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[log] discord log error:', (e && e.message) || e);
    return false;
  }
}

module.exports = { sendLog, adminMention, userMention, resolveName, renderNames, LOG_CHANNEL_ID };
