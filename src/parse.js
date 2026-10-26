'use strict';

const { CURRENCY, resolve } = require('./items');

function rewardItem(offer) {
  if (!offer) return null;
  const reward = offer.Rewards && offer.Rewards[0];
  return (reward && reward.ItemID) || offer.OfferID || null;
}

function priceOf(cost, currencyId) {
  if (!cost) return null;
  if (cost[currencyId] !== undefined) return cost[currencyId];
  const values = Object.values(cost);
  return values.length ? values[0] : null;
}

function bundleDurationMs(b) {
  const s = Number(b.DurationRemainingInSeconds);
  if (Number.isFinite(s) && s > 0) return s * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

function bundleEntry(b, now) {
  if (!b) return null;
  const vp = CURRENCY.vp;
  const totalOf = (obj) => (obj ? (obj[vp] !== undefined ? obj[vp] : Object.values(obj)[0]) : null);
  let before = totalOf(b.TotalBaseCost);
  if (before == null && Array.isArray(b.Items)) {
    before = b.Items.reduce((s, i) => s + (i.BasePrice || 0) * (i.Amount || 1), 0) || null;
  }
  let after = totalOf(b.TotalDiscountedCost);
  if (after == null && Array.isArray(b.Items) && b.Items.some((i) => i.DiscountedPrice != null)) {
    after = b.Items.reduce(
      (s, i) => s + ((i.DiscountedPrice != null ? i.DiscountedPrice : i.BasePrice) || 0) * (i.Amount || 1),
      0
    );
  }
  const percent = before != null && after != null && after < before ? Math.round((1 - after / before) * 100) : 0;
  const res = b.DataAssetID ? resolve(b.DataAssetID) : null;
  const isBundle = res && res.type === 'bundle';
  const items = (Array.isArray(b.Items) ? b.Items : [])
    .map((it) => {
      const id = (it.Item && it.Item.ItemID) || null;
      const base = it.BasePrice != null ? it.BasePrice : null;
      const disc = it.DiscountedPrice != null ? it.DiscountedPrice : base;
      const off = base != null && disc != null && disc < base ? Math.round((1 - disc / base) * 100) : 0;
      return { id, base, disc, percent: off };
    })
    .filter((it) => it.id);
  return {
    id: b.ID || null,
    name: (isBundle && res.name) || 'Featured Bundle',
    art: (isBundle && res.icon) || null,
    before,
    after,
    percent,
    items,
    leavesAt: now + bundleDurationMs(b),
  };
}

function dedupeBundles(list) {
  const seen = new Set();
  return (list || []).filter((b) => b && (b.id ? (!seen.has(b.id) && seen.add(b.id)) : true));
}

function buildStoreResponse(storefront, wallet, now = Date.now()) {
  const skins = storefront && storefront.SkinsPanelLayout;
  const dailyItems = ((skins && skins.SingleItemStoreOffers) || []).map((offer) => ({
    ...resolve(rewardItem(offer)),
    price: priceOf(offer.Cost, CURRENCY.vp),
    currency: 'vp',
  }));

  const bonus = storefront && storefront.BonusStore;
  const nightMarket = bonus
    ? {
        expiresAt: bonus.BonusStoreRemainingDurationInSeconds
          ? now + bonus.BonusStoreRemainingDurationInSeconds * 1000
          : null,
        items: ((bonus.BonusStoreOffers) || []).map((offer) => ({
          ...resolve(rewardItem(offer.Offer)),
          price: priceOf(offer.DiscountCosts, CURRENCY.vp),
          basePrice: priceOf(offer.Offer && offer.Offer.Cost, CURRENCY.vp),
          discount: typeof offer.DiscountPercent === 'number' ? offer.DiscountPercent : null,
          currency: 'vp',
        })),
      }
    : null;

  const accessory = storefront && storefront.AccessoryStore;
  const kingdomShop = accessory
    ? {
        expiresAt: accessory.AccessoryStoreRemainingDurationInSeconds
          ? now + accessory.AccessoryStoreRemainingDurationInSeconds * 1000
          : null,
        items: ((accessory.AccessoryStoreOffers) || []).map((offer) => {
          const cost = (offer.Offer && offer.Offer.Cost) || {};
          return {
            ...resolve(rewardItem(offer.Offer)),
            price: cost[CURRENCY.kc] !== undefined ? cost[CURRENCY.kc] : priceOf(cost, null),
            currency: 'kc',
          };
        }),
      }
    : null;

  const balances = (wallet && wallet.Balances) || {};
  const fb = storefront && storefront.FeaturedBundle;
  const bundles = fb
    ? dedupeBundles([fb.Bundle, ...(fb.Bundles || [])].map((b) => bundleEntry(b, now))).filter(
        (b) => b.leavesAt > now
      )
    : [];
  return {
    wallet: {
      vp: balances[CURRENCY.vp] ?? null,
      kc: balances[CURRENCY.kc] ?? null,
      rp: balances[CURRENCY.rp] ?? null,
    },
    daily: {
      expiresAt: skins && skins.SingleItemOffersRemainingDurationInSeconds
        ? now + skins.SingleItemOffersRemainingDurationInSeconds * 1000
        : null,
      items: dailyItems,
    },
    nightMarket,
    kingdomShop,
    bundles,
  };
}

module.exports = { buildStoreResponse, dedupeBundles };
