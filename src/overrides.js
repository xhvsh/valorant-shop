'use strict';

// ============================================================================
// PERSONAL OVERRIDE for one account (xhvsh#meow). Intentional one-off, not a
// pattern to extend: on this account only,
//   - the daily shop's "Prism Spectre" is shown as "Bolt Phantom",
//   - Bolt Phantom and the Riot Gunbuddy count as owned (collection, loadout,
//     OWNED pill in the shop),
//   - the Phantom in the loadout is Bolt Phantom with the Riot Gunbuddy on it.
// Everything is applied to copies on the way out; nothing is written to Riot
// or to the store cache.
// ============================================================================

const items = require('./items');

const ACCOUNT_NAME = 'xhvsh#meow';

const PHANTOM_WEAPON_ID = 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a';
const BOLT_PHANTOM = {
  skin: '64c97d19-4142-ce97-7a13-53a5b1ebdc82',
  level: '7f6e29ab-453d-90ba-9790-308abda2116f',
  chroma: '561f89c8-4478-5212-1dc4-d793b5de62ce',
};
const RIOT_GUNBUDDY_ID = 'a57aa3d0-4ad0-b06a-6c54-338cb3ea6b41';
const SWAPPED_FROM = 'prismspectre';

function applies(account) {
  return Boolean(account && String(account.name || '').trim().toLowerCase() === ACCOUNT_NAME);
}

// Daily / Night Market: Prism Spectre becomes Bolt Phantom, keeping the price.
function store(account, s) {
  if (!applies(account) || !s) return s;
  const swap = (box) =>
    box && Array.isArray(box.items)
      ? {
          ...box,
          items: box.items.map((it) =>
            it && it.type === 'skin' && items.normalizeName(it.name) === SWAPPED_FROM
              ? { ...it, ...items.resolve(BOLT_PHANTOM.skin), price: it.price, currency: it.currency }
              : it
          ),
        }
      : box;
  return { ...s, daily: swap(s.daily), nightMarket: swap(s.nightMarket) };
}

// PD entitlements: add the two owned items.
function entitlements(account, res) {
  if (!applies(account) || !res) return res;
  const extra = [{ ItemID: BOLT_PHANTOM.level }, { ItemID: BOLT_PHANTOM.skin }, { ItemID: RIOT_GUNBUDDY_ID }];
  if (Array.isArray(res.Entitlements)) return { ...res, Entitlements: [...res.Entitlements, ...extra] };
  return { ...res, EntitlementsByTypes: [...(res.EntitlementsByTypes || []), { Entitlements: extra }] };
}

// Raw loadout: Phantom = Bolt Phantom + Riot Gunbuddy.
function loadout(account, raw) {
  if (!applies(account) || !raw || typeof raw !== 'object') return raw;
  const gun = {
    ID: PHANTOM_WEAPON_ID,
    SkinID: BOLT_PHANTOM.skin,
    SkinLevelID: BOLT_PHANTOM.level,
    ChromaID: BOLT_PHANTOM.chroma,
    CharmID: RIOT_GUNBUDDY_ID,
    CharmLevelID: RIOT_GUNBUDDY_ID,
  };
  const guns = Array.isArray(raw.Guns) ? raw.Guns : [];
  const has = guns.some((g) => g && String(g.ID).toLowerCase() === PHANTOM_WEAPON_ID);
  return {
    ...raw,
    Guns: has ? guns.map((g) => (g && String(g.ID).toLowerCase() === PHANTOM_WEAPON_ID ? { ...g, ...gun } : g)) : [...guns, gun],
  };
}

module.exports = { applies, store, entitlements, loadout };
