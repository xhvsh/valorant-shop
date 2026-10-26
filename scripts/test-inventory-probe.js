'use strict';

// Probe: what does the personalization loadout endpoint return for a live
// account? Prints the raw JSON (truncated) plus the details-level summary.
// Run: DETAIL_DEBUG=1 node scripts/test-inventory-probe.js [label]
//   or set env explicitly. Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
//   ENCRYPTION_KEY from .env.
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* env injected elsewhere */
}
process.env.DETAIL_DEBUG = '1';

const storage = require('../src/storage');
const shop = require('../src/shop');
const items = require('../src/items');

const LABEL = process.argv[2] || '';

(async () => {
  const accounts = await storage.listAccounts();
  const rec = accounts.find((a) => (a.name || a.label || '') === LABEL);
  if (!rec) {
    console.error('account not found:', LABEL);
    process.exit(1);
  }
  await items.load().catch((e) => console.warn('catalog load failed:', e.message));
  const res = await shop.accountDetails(rec.discord_id, rec.puuid);
  if (res.status !== 'ok') {
    console.error('details status:', res.status, res.error || '');
    process.exit(1);
  }
  const d = res.details;
  const summary = {
    name: d.name,
    level: d.level,
    skins: d.skins.count,
    cards: d.cards.length,
    sprays: d.sprays.length,
    buddies: d.buddies.length,
    equipped: d.equipped,
  };
  console.log('---- details summary ----');
  console.log(JSON.stringify(summary, null, 1));
  console.log('---- card sample ----');
  console.log(JSON.stringify((d.cards[0] || null), null, 1));
  console.log('---- spray sample ----');
  console.log(JSON.stringify((d.sprays[0] || null), null, 1));
  console.log('---- buddy sample ----');
  console.log(JSON.stringify((d.buddies[0] || null), null, 1));
  console.log('---- skin sample ----');
  console.log(JSON.stringify((d.skins.items[0] || null), null, 1));
  console.log('---- kinds ----');
  console.log(JSON.stringify(d.skins.kinds));
})().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
