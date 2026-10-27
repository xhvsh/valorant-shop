'use strict';

const { dedupeBundles } = require('../parse');
const { renderBundleMedia } = require('../grid');
const { buildNotice, EPHEMERAL } = require('./embeds');

function accountOption() {
  return {
    type: 3,
    name: 'account',
    description: 'Which linked account to show (default: your main account)',
    autocomplete: true,
  };
}

// Same picker, limited to the user's own accounts (sharing, main account).
function ownAccountOption(description, required = false) {
  return { type: 3, name: 'account', description, autocomplete: true, required };
}

const COMMANDS = [
  { name: 'shop', description: 'Show your current VALORANT shop', options: [accountOption()] },
  { name: 'accessories', description: 'Show the current accessory shop (kingdom credits)', options: [accountOption()] },
  { name: 'bundle', description: 'Show the currently featured bundles (no account needed)' },
  { name: 'nightmarket', description: 'Show your current Night Market (when available)', options: [accountOption()] },
  { name: 'rank', description: 'Show your current competitive rank', options: [accountOption()] },
  { name: 'collection', description: 'Show how many skins you own (standard, limited, battle pass)', options: [accountOption()] },
  {
    name: 'share',
    description: 'Share an account with friends, or add one someone shared with you',
    options: [
      { type: 1, name: 'code', description: 'Show (or create) the share code for one of your accounts', options: [ownAccountOption('Which of your accounts (default: your main account)')] },
      {
        type: 1,
        name: 'import',
        description: 'Add an account someone shared with you',
        options: [{ type: 3, name: 'code', description: 'The 8-character share code', required: true, min_length: 8, max_length: 12 }],
      },
      { type: 1, name: 'stop', description: 'Stop sharing one of your accounts (removes it for everyone)', options: [ownAccountOption('Which of your accounts (default: your main account)')] },
    ],
  },
  { name: 'main', description: 'Choose the account commands use when you do not pick one', options: [ownAccountOption('Your new main account', true)] },
  { name: 'link', description: 'Manage linked accounts and alerts on the website' },
];

// Commands whose account picker only lists the user's own accounts.
const OWN_ACCOUNT_COMMANDS = new Set(['share', 'main']);

// /bundle always pulls data from this account (a linked Discord user ID, set
// with BUNDLE_SOURCE_ID) so anyone can use the command.
const BUNDLE_SOURCE_ID = process.env.BUNDLE_SOURCE_ID || '';

// Immediate private reply in the same boxed style as every other command. An
// optional link button is added as an action row inside the box.
function ephemeralMessage(content, button) {
  const data = buildNotice(content);
  if (button) {
    data.components[0].components.push({
      type: 1,
      components: [{ type: 2, style: 5, label: button.label, url: button.url }],
    });
  }
  data.flags |= EPHEMERAL;
  return { type: 4, data };
}

function deferPublic() {
  return { type: 5, data: {} };
}

// Deferred reply only the caller sees; the follow-up edits it in place.
function deferPrivate() {
  return { type: 5, data: { flags: EPHEMERAL } };
}

function accountLabel(acct) {
  const base = acct.label || acct.name || (acct.puuid || '').slice(0, 8);
  return acct.is_default ? `${base} (main)` : base;
}

// Account picker choices, in the order the user arranged them on the dashboard
// (main first when nothing is saved). `ownOnly` drops shared accounts.
async function accountChoices(ctx, discordId, query, opts = {}) {
  const q = String(query || '').toLowerCase();
  const [owned, imported, prefs] = await Promise.all([
    ctx.storage.listAccountsByUser(discordId).catch(() => []),
    opts.ownOnly ? Promise.resolve({}) : ctx.storage.getImportedShares(discordId).catch(() => ({})),
    ctx.storage.getPrefs(discordId).catch(() => ({ order: [] })),
  ]);
  const ownedIds = new Set(owned.map((a) => String(a.puuid)));
  const combined = [...owned].sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)));
  for (const [puuid, item] of Object.entries(imported)) {
    if (ownedIds.has(String(puuid))) continue;
    const nm = (item && item.name) || String(puuid).slice(0, 8);
    combined.push({ puuid, name: nm, label: `${nm} (shared)`, shared: true });
  }
  const order = Array.isArray(prefs.order) ? prefs.order.map(String) : [];
  if (order.length) {
    const rank = (a) => {
      const i = order.indexOf(String(a.puuid));
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    combined.sort((a, b) => rank(a) - rank(b));
  }
  return combined
    .filter(
      (a) =>
        !q ||
        String(a.label || a.name || '').toLowerCase().includes(q) ||
        String(a.puuid || '').toLowerCase().startsWith(q)
    )
    .slice(0, 25)
    .map((a) => ({ name: String(accountLabel(a)).slice(0, 100), value: String(a.puuid) }));
}

async function bundlePayload(ctx, opts = {}) {
  try {
    const t0 = Date.now();
    let result = await ctx.shop.getShop(BUNDLE_SOURCE_ID, undefined, { owned: false });
    console.log(`[bundle] getShop -> ${result.status} ${Date.now() - t0}ms`);
    if (result.status === 'ok' && (!result.store.bundles || !result.store.bundles.length)) {
      const t1 = Date.now();
      result = await ctx.shop.getShop(BUNDLE_SOURCE_ID, undefined, { force: true, owned: false });
      console.log(`[bundle] getShop force -> ${result.status} ${Date.now() - t1}ms`);
    }
    let bundles = result.status === 'ok' ? result.store.bundles || [] : [];
    if (!bundles.length) {
      const acct = await ctx.storage.getAccount(BUNDLE_SOURCE_ID);
      const stale = acct && acct.store_cache && acct.store_cache.bundles;
      bundles = stale || [];
    }
    if (bundles.length) {
      ctx.shop.rememberBundles(bundles).catch(() => {});
    } else {
      // Source account unavailable: use any account's cached bundles, then the
      // last good global snapshot, so /bundle never goes dark on a relink.
      bundles = await ctx.shop.anyCachedBundles().catch(() => []);
    }
    bundles = dedupeBundles(bundles);
    const wantId = opts.bundleId != null ? String(opts.bundleId) : '';
    const selected = bundles.find((b) => b && String(b.id) === wantId) || bundles[0];
    console.log(`[bundle] serving ${bundles.length} bundle(s) selected=${selected && selected.id}`);
    if (selected) {
      const files = [];
      let imageRefs;
      if (selected.items && selected.items.length) {
        const media = await renderBundleMedia(selected.items);
        if (media) {
          files.push(media);
          imageRefs = { [selected.id]: `attachment://${media.name}` };
        }
      }
      const message = ctx.embeds.buildBundleMessage(bundles, {
        selectedId: selected.id,
        appUrl: ctx.linkBaseUrl,
        discordId: BUNDLE_SOURCE_ID,
        imageRefs,
        accentColor: await ctx.embeds.bundleAccentColor(selected.art),
      });
      return { ...message, files };
    }
    return buildNotice('Bundle data is unavailable right now. Try again in a few minutes.');
  } catch (e) {
    console.error(`[bundle] payload error: ${(e && e.stack) || e}`);
    return buildNotice(`Could not load bundles (${e.message}). Try again in a few minutes.`);
  }
}

// ctx: { storage, shop, embeds, linkBaseUrl, fireFollowUp({interactionId, token, discordId, name}) }
async function handleInteraction(body, ctx) {
  const name = body.data && body.data.name;
  const user = (body.member && body.member.user) || body.user || {};
  const discordId = user.id;
  if (!discordId) return ephemeralMessage('Could not determine your Discord account.');

  switch (name) {
    case 'shop':
    case 'accessories':
    case 'nightmarket':
    case 'rank':
    case 'collection':
      return deferPublic();
    case 'bundle':
      return deferPublic();
    case 'share':
    case 'main':
      return deferPrivate();
    case 'link': {
      return ephemeralMessage(
        '## valorant shop\nManage linked accounts and daily alerts on the dashboard.\n-# Sign in with Discord there to add accounts.',
        { label: 'Open dashboard', url: ctx.linkBaseUrl }
      );
    }
    default:
      return ephemeralMessage('Unknown command.');
  }
}

module.exports = { COMMANDS, OWN_ACCOUNT_COMMANDS, handleInteraction, bundlePayload, BUNDLE_SOURCE_ID, accountChoices, accountLabel };
