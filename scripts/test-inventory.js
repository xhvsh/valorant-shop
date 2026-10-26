'use strict';

// Test: render a VALORANT-collection-style inventory image for an account and
// post it to the #testing channel. Run: node scripts/test-inventory.js [label]
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* env injected elsewhere */
}

const fs = require('node:fs');
const storage = require('../src/storage');
const shop = require('../src/shop');
const items = require('../src/items');
const grid = require('../src/grid');

const LABEL = process.argv[2] || '';
const CHANNEL_ID = process.env.TEST_CHANNEL_ID || '';

(async () => {
  const accounts = await storage.listAccounts();
  const rec = accounts.find((a) => (a.name || a.label || '') === LABEL);
  if (!rec) throw new Error('account not found: ' + LABEL);

  await items.load();
  const res = await shop.accountDetails(rec.discord_id, rec.puuid);
  if (res.status !== 'ok') throw new Error('details status: ' + res.status + ' ' + (res.error || ''));
  const d = res.details;

  const png = await grid.renderInventoryImage(d);
  if (!png) throw new Error('render produced nothing');
  fs.writeFileSync('inventory-test.png', png);
  console.log(`rendered ${png.length} bytes -> inventory-test.png`);

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error('no DISCORD_BOT_TOKEN');
  const fd = new FormData();
  const payload = {
    embeds: [
      {
        title: 'Inventory render test',
        description: `COLLECTION: ${d.name} · ${d.skins.count} skins · ${d.cards.length} cards · ${d.sprays.length} sprays · ${d.buddies.length} buddies`,
        color: 0xff4655,
        image: { url: 'attachment://inventory.png' },
      },
    ],
    attachments: [{ id: 0, filename: 'inventory.png', description: 'Inventory' }],
  };
  fd.append('payload_json', JSON.stringify(payload));
  fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'inventory.png');
  const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}` },
    body: fd,
  });
  if (!r.ok) {
    console.error('post failed:', r.status, await r.text().catch(() => ''));
    process.exit(1);
  }
  console.log('posted to channel', CHANNEL_ID);
})().catch((e) => {
  console.error('test failed:', e);
  process.exit(1);
});
