'use strict';

// One-off probe #2: more personalization endpoints.
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* env injected elsewhere */
}

const storage = require('../src/storage');
const shop = require('../src/shop');
const riot = require('../src/riot');

const LABEL = process.argv[2] || '';

(async () => {
  const accounts = await storage.listAccounts();
  const rec = accounts.find((a) => (a.name || a.label || '') === LABEL);
  if (!rec) throw new Error('account not found: ' + LABEL);

  const auth = storage.decrypt(rec.auth_encrypted);
  const fresh = await shop.renewTokens(auth, { discordId: rec.discord_id });
  auth.access_token = fresh.access_token;
  auth.id_token = fresh.id_token || auth.id_token;
  auth.expires_at = fresh.expires_at;
  auth.refresh_token = fresh.refresh_token || auth.refresh_token;
  await storage.saveAccount(rec.discord_id, rec.puuid, { auth_encrypted: storage.encrypt(auth) });

  const entitlement = await riot.entitlements(fresh.access_token);
  const shard = rec.shard || 'na';
  const puuid = rec.puuid;
  const B = `https://pd.${shard}.a.pvp.net`;
  const clientVersion = await riot.clientVersion();
  const H = (extra = {}) => ({
    Authorization: `Bearer ${fresh.access_token}`,
    'X-Riot-Entitlements-JWT': entitlement || '',
    'X-Riot-ClientPlatform': riot.CLIENT_PLATFORM,
    'X-Riot-ClientVersion': clientVersion,
    Accept: 'application/json',
    ...extra,
  });

  const cases = [
    ['GET', `${B}/personalization/v3/players/${puuid}`],
    ['GET', `${B}/personalization/v2/players/${puuid}`, 'POST'],
    ['GET', `${B}/personalization/v2/identity/${puuid}`],
    ['GET', `${B}/personalization/v2/players/${puuid}/sprays`],
    ['GET', `${B}/personalization/v2/players/${puuid}/identity`],
    ['GET', `${B}/core_identity/v1/players/${puuid}`],
    ['GET', `${B}/collectibles/v1/players/${puuid}`],
  ];
  for (const [, url, method] of cases) {
    try {
      const res = await fetch(url, { method: method || 'GET', headers: H() });
      const text = await res.text();
      console.log(`${res.status}  ${method || 'GET'}  ${url}`);
      if (res.status >= 200 && res.status < 300) console.log('     ' + text.slice(0, 1200));
    } catch (e) {
      console.log(`ERR ${(e.message || '').slice(0, 100)}  ${url}`);
    }
  }
})().catch((e) => {
  console.error('probe failed:', e.message || e);
  process.exit(1);
});
