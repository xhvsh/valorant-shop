(() => {
  "use strict";

  /* ==========================================================================
     Basics
     ========================================================================== */

  const CURRENCY_ICON = {
    vp: "https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/displayicon.png",
    kc: "https://media.valorant-api.com/currencies/85ca954a-41f2-ce94-9b45-8ca3dd39a00d/displayicon.png",
    rp: "https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png",
  };

  const $ = (id) => document.getElementById(id);

  // The app can be mounted under a subpath (xhv.sh/valorant-shop). The server
  // injects a <base href> tag when that is the case; every absolute API path
  // goes through path() so requests stay inside the mount.
  const BASE_PATH = (() => {
    try {
      const b = document.querySelector("base");
      const href = b && new URL(b.href, location.href).pathname.replace(/\/+$/, "");
      return href && href !== "/" ? href : "";
    } catch {
      return "";
    }
  })();
  const path = (p) => `${BASE_PATH}${p}`;

  const SVG_NS = "http://www.w3.org/2000/svg";
  function iconEl(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", cls ? `i ${cls}` : "i");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }

  // Tiny element builder: h("div", { class: "x", onclick }, child, "text").
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "style") node.setAttribute("style", v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  // Every dynamic image is lazy and async-decoded so big grids scroll smoothly.
  function makeImg(src, alt, onFail) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.alt = alt || "";
    if (onFail) img.onerror = () => onFail(img);
    if (src) img.src = src;
    return img;
  }

  function fallbackText(name, n = 2) {
    return h("span", { class: "fallback", text: String(name || "?").slice(0, n).toUpperCase() });
  }

  function imgOrFallback(src, name, n) {
    if (!src) return fallbackText(name, n);
    return makeImg(src, name, (img) => img.replaceWith(fallbackText(name, n)));
  }

  function fmt(n) {
    return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "-";
  }

  function fmtCountdown(ms) {
    if (ms <= 0) return "00:00:00";
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const hh = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (v) => String(v).padStart(2, "0");
    if (d > 0) return `${d}d ${pad(hh)}h ${pad(m)}m`;
    return `${pad(hh)}:${pad(m)}:${pad(s)}`;
  }

  function titleName(name) {
    const stripped = String(name || "").replace(/\s+title$/i, "").trim();
    return stripped || String(name || "Title");
  }

  function acctName(a) {
    return (a && (a.label || a.name)) || (a && a.puuid ? a.puuid.slice(0, 8) : "Account");
  }

  // "Name#TAG" -> name node + muted tag node.
  function nameNodes(full) {
    const s = String(full || "");
    const at = s.lastIndexOf("#");
    if (at <= 0) return [document.createTextNode(s)];
    return [document.createTextNode(s.slice(0, at)), h("span", { class: "tag", text: s.slice(at) })];
  }

  function initials(full) {
    const s = String(full || "?").replace(/#.*$/, "").trim();
    return (s.slice(0, 2) || "?").toUpperCase();
  }

  // Rarity colours (Riot content tiers) for card accents.
  const TIER_COLORS = {
    select: "#5a9fe2",
    deluxe: "#009587",
    premium: "#d1548d",
    exclusive: "#f5955b",
    ultra: "#fad663",
  };
  function tierColor(tier) {
    const key = String(tier || "").toLowerCase().replace(/\s*edition/gi, "").trim();
    return TIER_COLORS[key] || null;
  }
  function hexTint(hex, alpha) {
    const n = parseInt(String(hex || "#8b929c").replace("#", "").slice(0, 6), 16) || 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  function rankColor(rank) {
    const m = /^#?([0-9a-fA-F]{6})/.exec(String((rank && rank.color) || ""));
    if (!m || m[1].toLowerCase() === "ffffff") return null;
    return `#${m[1]}`;
  }

  // Close a modal when its backdrop is clicked, but only if the press both
  // started and ended on the backdrop (text selection drags stay open).
  function onBackdrop(overlay, close) {
    let down = false;
    overlay.addEventListener("pointerdown", (e) => { down = e.target === overlay; });
    overlay.addEventListener("click", (e) => { if (down && e.target === overlay) close(); });
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label || "Copied"} to clipboard.`, "ok");
    } catch {
      toast("Could not copy. Select it and copy manually.", "error");
    }
  }

  /* ---------- toasts ---------- */

  function toast(message, kind) {
    if (!message) return;
    const box = $("toasts");
    const icon = kind === "ok" ? "check" : kind === "error" ? "alert" : "bell";
    const node = h("div", { class: `toast ${kind || ""}`, role: kind === "error" ? "alert" : "status" }, iconEl(icon), h("span", { text: message }));
    box.appendChild(node);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => {
      node.classList.add("is-leaving");
      setTimeout(() => node.remove(), 220);
    }, kind === "error" ? 5200 : 2800);
  }

  /* ---------- API ---------- */

  // Never let a request hang forever: a stalled fetch on a flaky connection
  // would otherwise leave a spinner up indefinitely.
  const API_TIMEOUT_MS = 20000;

  async function api(url, options) {
    const opts = { ...(options || {}) };
    if (opts.json !== undefined) {
      opts.headers = { ...(opts.headers || {}), "Content-Type": "application/json" };
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    let timedOut = false;
    let timer = null;
    if (!opts.signal && typeof AbortController !== "undefined") {
      const controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, opts.timeoutMs || API_TIMEOUT_MS);
    }
    let res;
    try {
      res = await fetch(path(url), opts);
    } catch (e) {
      const err = new Error(timedOut ? "The request timed out. Check your connection and try again." : "Network error. Check your connection and try again.");
      err.status = 0;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      if (res.status === 401 && S.me) showLanding();
      throw err;
    }
    return data;
  }

  /* ---------- confirm dialog ---------- */

  let confirmResolve = null;
  function confirmDialog({ title, message, okLabel = "Confirm", danger = false }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $("confirmTitle").textContent = title;
      $("confirmMessage").textContent = message;
      const ok = $("confirmOk");
      ok.textContent = okLabel;
      ok.classList.toggle("btn-danger", danger);
      $("confirmOverlay").hidden = false;
      ok.focus();
    });
  }
  function closeConfirm(result) {
    $("confirmOverlay").hidden = true;
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }

  /* ==========================================================================
     State
     ========================================================================== */

  const S = {
    me: null,
    accounts: [], // own + shared, each shared one has shared: true
    order: [], // display order (puuids)
    prefs: { nm: false, bundle: false },
    store: Object.create(null),
    storePending: Object.create(null),
    storeError: Object.create(null),
    details: Object.create(null),
    detailsPending: Object.create(null),
    detailsError: Object.create(null),
    wishlist: { daily: [], accessory: [] },
    wlLoaded: false,
    bundles: null,
    bundlesPending: null,
    bundlesError: null,
    install: { userInstall: null, guildInstall: null },
    stats: null,
    route: { name: "home" },
    dragging: false,
  };

  function ordered() {
    const idx = new Map(S.order.map((p, i) => [p, i]));
    return [...S.accounts].sort((a, b) => {
      const ai = idx.has(a.puuid) ? idx.get(a.puuid) : 1e9;
      const bi = idx.has(b.puuid) ? idx.get(b.puuid) : 1e9;
      return ai - bi;
    });
  }
  function findAcct(puuid) {
    return S.accounts.find((a) => a.puuid === puuid) || null;
  }
  function ownAccounts() {
    return S.accounts.filter((a) => !a.shared);
  }

  function storeHasNm(store) {
    return Boolean(store && store.nightMarket && store.nightMarket.items && store.nightMarket.items.length);
  }
  // Night Market availability is global: any loaded store tells us.
  function nightMarketState() {
    let known = false;
    for (const a of S.accounts) {
      const s = S.store[a.puuid];
      if (!s) continue;
      known = true;
      if (storeHasNm(s)) return { open: true, expiresAt: s.nightMarket.expiresAt || null };
    }
    return { open: false, known };
  }

  function walletOf(a) {
    const s = S.store[a.puuid];
    return (s && s.wallet) || a.wallet || null;
  }

  /* ==========================================================================
     Data loading
     ========================================================================== */

  async function fetchAccounts() {
    const data = await api("/api/accounts");
    const own = (data.accounts || []).map((a) => ({
      ...a,
      shared: false,
      alerts: {
        shop: Boolean(a.alerts && a.alerts.shop),
        accessory: Boolean(a.alerts && a.alerts.accessory),
        wishlist_shop: Boolean(a.alerts && a.alerts.wishlist_shop),
        wishlist_accessory: Boolean(a.alerts && a.alerts.wishlist_accessory),
      },
    }));
    const shared = (data.shared || []).map((s) => ({ ...s, shared: true }));
    S.accounts = [...own, ...shared];
    const known = new Set(S.accounts.map((a) => a.puuid));
    const order = Array.isArray(data.order) ? data.order.filter((p) => known.has(p)) : [];
    for (const a of S.accounts) if (!order.includes(a.puuid)) order.push(a.puuid);
    S.order = order;
    S.prefs = { nm: data.nm === true, bundle: data.bundle === true };
    return data;
  }

  function ensureStore(puuid, force) {
    const a = findAcct(puuid);
    if (!a || !a.linked) return Promise.resolve(null);
    if (force) {
      delete S.store[puuid];
      delete S.storePending[puuid];
    }
    if (S.store[puuid]) return Promise.resolve(S.store[puuid]);
    if (S.storePending[puuid]) return S.storePending[puuid];
    delete S.storeError[puuid];
    const p = api(`/api/shop?puuid=${encodeURIComponent(puuid)}`, { timeoutMs: 35000 })
      .then((data) => {
        S.store[puuid] = data.store || null;
        return S.store[puuid];
      })
      .catch((err) => {
        S.storeError[puuid] = err.message || "Could not load this shop.";
        throw err;
      })
      .finally(() => {
        if (S.storePending[puuid] === p) delete S.storePending[puuid];
        onStore(puuid);
      });
    S.storePending[puuid] = p;
    return p;
  }

  function fetchDetails(puuid, force) {
    const a = findAcct(puuid);
    if (!a || !a.linked) return Promise.resolve(null);
    if (force) delete S.details[puuid];
    if (S.details[puuid]) return Promise.resolve(S.details[puuid]);
    if (S.detailsPending[puuid]) return S.detailsPending[puuid];
    delete S.detailsError[puuid];
    const p = api(`/api/accounts/${encodeURIComponent(puuid)}/details`, { timeoutMs: 35000 })
      .then((res) => {
        S.details[puuid] = res && res.status === "relink" ? { relink: true } : (res && res.details) || {};
        return S.details[puuid];
      })
      .catch((err) => {
        S.detailsError[puuid] = err.message || "Could not load account details.";
        throw err;
      })
      .finally(() => {
        if (S.detailsPending[puuid] === p) delete S.detailsPending[puuid];
        onDetails(puuid);
      });
    S.detailsPending[puuid] = p;
    return p;
  }

  // Warm stores and details for every linked account, a couple at a time, so
  // the overview fills in without tripping the per-user details rate limit.
  function warmAll() {
    const linked = ordered().filter((a) => a.linked);
    for (const a of linked) ensureStore(a.puuid).catch(() => {});
    const targets = linked.slice(0, 20);
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const a = targets[i++];
        await fetchDetails(a.puuid).catch(() => {});
      }
    };
    Promise.all([worker(), worker()]).catch(() => {});
  }

  /* ---------- prefs (partial saves, serialized) ---------- */

  let prefsChain = Promise.resolve();
  function patchPrefs(partial) {
    const run = () =>
      api("/api/prefs", { method: "PATCH", json: partial }).catch(async (err) => {
        toast(err.message || "Could not save your settings.", "error");
        await fetchAccounts().catch(() => {});
        renderAll();
        throw err;
      });
    prefsChain = prefsChain.then(run, run);
    return prefsChain;
  }

  /* ==========================================================================
     Live updates when data arrives
     ========================================================================== */

  function onStore(puuid) {
    if (S.dragging) return;
    updateSidebarItem(puuid);
    const r = S.route;
    if (r.name === "home") {
      replaceCard(puuid);
      renderSummary();
    } else if (r.name === "account" && r.puuid === puuid) {
      renderAccountHead();
      renderTabs();
      if (["daily", "acc", "nm"].includes(r.tab)) renderPanel();
    }
    scheduleAutoRefresh();
  }

  function onDetails(puuid) {
    if (S.dragging) return;
    updateSidebarItem(puuid);
    const r = S.route;
    if (r.name === "home") replaceCard(puuid);
    else if (r.name === "account" && r.puuid === puuid) {
      renderAccountHead();
      if (r.tab === "collection") renderPanel();
    }
  }

  /* ==========================================================================
     Router
     ========================================================================== */

  const ACCOUNT_TABS = ["daily", "acc", "nm", "collection", "alerts", "sharing"];

  // Routes are real paths (/a/<puuid>/<tab>, /wishlist, ...) under BASE_PATH and
  // use the History API. The server returns index.html for each of them.
  const PAGE_ROUTES = ["wishlist", "bundles", "settings"];

  function routeParts(pathname) {
    let p = pathname;
    if (BASE_PATH) {
      if (p !== BASE_PATH && !p.startsWith(`${BASE_PATH}/`)) return null;
      p = p.slice(BASE_PATH.length);
    }
    const parts = p.split("/").filter(Boolean);
    try {
      return parts.map(decodeURIComponent);
    } catch {
      return null;
    }
  }

  function parseRoute() {
    const parts = routeParts(location.pathname) || [];
    if (parts[0] === "a" && parts[1]) {
      return { name: "account", puuid: parts[1], tab: ACCOUNT_TABS.includes(parts[2]) ? parts[2] : "daily" };
    }
    if (parts.length === 1 && PAGE_ROUTES.includes(parts[0])) return { name: parts[0] };
    return { name: "home" };
  }

  function isRouteUrl(u) {
    if (u.origin !== location.origin) return false;
    const parts = routeParts(u.pathname);
    if (!parts) return false;
    if (!parts.length) return true;
    if (parts[0] === "a") return Boolean(parts[1]) && parts.length <= 3;
    return parts.length === 1 && PAGE_ROUTES.includes(parts[0]);
  }

  function go(url, replace) {
    const t = new URL(url, location.href);
    if (t.pathname === location.pathname && t.search === location.search) render();
    else {
      history[replace ? "replaceState" : "pushState"]({}, "", `${t.pathname}${t.search}`);
      render();
    }
  }

  function acctHref(puuid, tab) {
    return path(`/a/${encodeURIComponent(puuid)}${tab && tab !== "daily" ? `/${tab}` : ""}`);
  }

  // Old links look like /valorant-shop/#/a/<puuid>. Rewrite them to real paths.
  function adoptLegacyHash() {
    const m = location.hash.match(/^#\/(.*)$/);
    if (!m) return false;
    history.replaceState({}, "", path(`/${m[1]}`));
    return true;
  }

  // Internal links are plain anchors; handle them without a page load.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    if ((a.getAttribute("href") || "").startsWith("#")) return;
    let u;
    try {
      u = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (!isRouteUrl(u)) return;
    e.preventDefault();
    go(u.href);
  });

  let lastRouteKey = "";
  function render() {
    const r = parseRoute();
    S.route = r;
    closeMenu();
    closeSidebar();
    const key = `${r.name}|${r.puuid || ""}`;
    const view = $("view");
    if (key !== lastRouteKey) {
      view.style.animation = "none";
      void view.offsetWidth;
      view.style.animation = "";
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    lastRouteKey = key;
    view.innerHTML = "";
    if (r.name === "account") {
      const a = findAcct(r.puuid);
      if (!a) {
        go(path("/"), true);
        return;
      }
      renderAccountView(a);
    } else if (r.name === "wishlist") renderWishlistView();
    else if (r.name === "bundles") renderBundlesView();
    else if (r.name === "settings") renderSettingsView();
    else renderHome();
    updateNav();
  }

  function renderAll() {
    renderSidebar();
    render();
  }

  // Static page names are styled as uppercase labels; account names (Riot IDs
  // are case sensitive) are shown exactly as written.
  function setTitle(text, isName) {
    const el = $("topbarTitle");
    el.textContent = text;
    el.classList.toggle("is-label", !isName);
    document.title = text && text !== "Overview" ? `${text} - valorant shop` : "valorant shop";
  }

  function updateNav() {
    const r = S.route;
    const nav = r.name === "account" ? "" : r.name;
    document.querySelectorAll("[data-nav]").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.nav === nav);
      if (el.dataset.nav === nav) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    document.querySelectorAll(".sb-acct").forEach((el) => {
      el.classList.toggle("is-active", r.name === "account" && el.dataset.puuid === r.puuid);
    });
    const count = S.wishlist.daily.length + S.wishlist.accessory.length;
    const badge = $("navWishCount");
    badge.hidden = !count;
    badge.textContent = String(count);
    const bundles = $("navBundleCount");
    const nb = (S.bundles || []).length;
    bundles.hidden = !nb;
    bundles.textContent = String(nb);
  }

  /* ==========================================================================
     Sidebar
     ========================================================================== */

  function emblemEl(a, size) {
    const d = S.details[a.puuid];
    const rank = d && d.rank;
    const box = h("span", { class: `emblem ${size || ""}` });
    // Unranked accounts get Riot's unranked emblem (tier 0 icon) too.
    if (rank && rank.icon) {
      box.appendChild(makeImg(rank.icon, rank.tierName || "", (img) => img.replaceWith(document.createTextNode(initials(acctName(a))))));
      box.title = Number(rank.tier) >= 3 ? rank.tierName || "" : "Unranked";
    } else if (S.detailsPending[a.puuid] && !d) {
      box.classList.add("sk");
    } else {
      box.textContent = initials(acctName(a));
    }
    return box;
  }

  function sidebarSub(a) {
    if (!a.linked) return a.shared ? "Owner must re-link" : "Needs re-linking";
    const d = S.details[a.puuid];
    const rank = d && d.rank;
    const parts = [];
    if (rank && rank.tierName && Number(rank.tier) >= 3) parts.push(titleCase(rank.tierName));
    else if (rank) parts.push("Unranked");
    const w = walletOf(a);
    if (w && typeof w.vp === "number") parts.push(`${fmt(w.vp)} VP`);
    if (a.shared) parts.push("shared");
    return parts.join(" · ") || (a.shard || "").toUpperCase();
  }

  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function sidebarItem(a) {
    const li = h("li", { class: "sb-acct", dataset: { puuid: a.puuid }, role: "link", tabindex: "0", title: acctName(a) });
    const grip = h("span", { class: "grip", title: "Drag to reorder", "aria-hidden": "true" }, iconEl("grip"));
    grip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    li.appendChild(grip);
    li.appendChild(emblemEl(a));
    li.appendChild(
      h("span", { class: "sb-acct-text" },
        h("span", { class: "sb-acct-name" }, nameNodes(acctName(a))),
        h("span", { class: "sb-acct-sub", text: sidebarSub(a) }))
    );
    if (a.is_default) li.appendChild(iconEl("crown", "mark"));
    else if (a.shared) li.appendChild(iconEl("share", "mark shared"));
    if (S.route.name === "account" && S.route.puuid === a.puuid) li.classList.add("is-active");
    const open = () => go(acctHref(a.puuid));
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        moveAccount(a.puuid, e.key === "ArrowUp" ? -1 : 1, true);
      }
    });
    return li;
  }

  function renderSidebar() {
    if (S.dragging) return;
    const list = $("sbAccounts");
    list.innerHTML = "";
    const accts = ordered();
    if (!accts.length) {
      list.appendChild(h("li", { class: "sb-empty", text: "No accounts yet." }));
    }
    for (const a of accts) list.appendChild(sidebarItem(a));
    $("sbHint").hidden = accts.length < 2;
  }

  function updateSidebarItem(puuid) {
    const a = findAcct(puuid);
    const old = document.querySelector(`.sb-acct[data-puuid="${CSS.escape(puuid)}"]`);
    if (!a || !old) return;
    old.replaceWith(sidebarItem(a));
  }

  function openSidebar() {
    $("sidebar").classList.add("is-open");
    $("scrim").hidden = false;
  }
  function closeSidebar() {
    $("sidebar").classList.remove("is-open");
    $("scrim").hidden = true;
  }

  /* ---------- drag to reorder (pointer events: mouse, pen and touch) ---------- */

  function makeSortable(listEl, itemSelector, onMove) {
    listEl.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest(".grip");
      if (!grip || !listEl.contains(grip)) return;
      const item = grip.closest(itemSelector);
      if (!item) return;
      e.preventDefault();
      const items = [...listEl.querySelectorAll(itemSelector)];
      if (items.length < 2) return;
      const from = items.indexOf(item);
      const rects = items.map((it) => it.getBoundingClientRect());
      const step = rects[1].top - rects[0].top || rects[0].height;
      const startY = e.clientY;
      let to = from;
      let moved = false;
      S.dragging = true;
      item.classList.add("is-dragging");
      try { grip.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      for (const it of items) if (it !== item) it.style.transition = "transform .16s ease";

      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 3) moved = true;
        const min = rects[0].top - rects[from].top;
        const max = rects[items.length - 1].top - rects[from].top;
        const clamped = Math.max(min - 8, Math.min(max + 8, dy));
        item.style.transform = `translateY(${clamped}px)`;
        const center = rects[from].top + rects[from].height / 2 + clamped;
        to = 0;
        items.forEach((it, i) => {
          if (i !== from && rects[i].top + rects[i].height / 2 < center) to += 1;
        });
        items.forEach((it, i) => {
          if (i === from) return;
          let shift = 0;
          if (from < to && i > from && i <= to) shift = -step;
          if (from > to && i < from && i >= to) shift = step;
          it.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      };
      const end = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", end);
        grip.removeEventListener("pointercancel", end);
        for (const it of items) {
          it.style.transform = "";
          it.style.transition = "";
        }
        item.classList.remove("is-dragging");
        S.dragging = false;
        if (moved && to !== from) onMove(from, to);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
    });
  }

  function reorderByIndex(from, to) {
    const list = ordered().map((a) => a.puuid);
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    S.order = list;
    saveOrder();
  }

  function moveAccount(puuid, dir, keepFocus) {
    const list = ordered().map((a) => a.puuid);
    const i = list.indexOf(puuid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    S.order = list;
    saveOrder();
    if (keepFocus) {
      const node = document.querySelector(`.sb-acct[data-puuid="${CSS.escape(puuid)}"]`);
      if (node) node.focus();
    }
  }

  function saveOrder() {
    renderSidebar();
    if (S.route.name === "home" || S.route.name === "settings") render();
    patchPrefs({ order: S.order }).catch(() => {});
  }

  /* ==========================================================================
     Floating menus
     ========================================================================== */

  let menuEl = null;
  let menuAnchor = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    if (menuAnchor) menuAnchor.setAttribute("aria-expanded", "false");
    menuEl = null;
    menuAnchor = null;
  }
  function openMenu(anchor, entries) {
    if (menuAnchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    const menu = h("div", { class: "menu", role: "menu" });
    for (const e of entries) {
      if (e === "sep") {
        menu.appendChild(h("div", { class: "menu-sep" }));
        continue;
      }
      const btn = h("button", { class: `menu-item${e.danger ? " danger" : ""}`, type: "button", role: "menuitem", disabled: e.disabled },
        iconEl(e.icon),
        h("span", { class: "menu-text" }, h("b", { text: e.label }), e.sub ? h("small", { text: e.sub }) : null));
      btn.addEventListener("click", () => {
        closeMenu();
        e.onClick();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    if (window.innerWidth < 720) {
      // Phones: a bottom sheet, always fully on screen.
      menu.classList.add("sheet");
    } else {
      const r = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const mw = menu.offsetWidth;
      const mh = Math.min(menu.offsetHeight, vh - 24);
      // Right-align to the anchor when it sits in the right half of the screen.
      let left = r.left + r.width / 2 > vw / 2 ? r.right - mw : r.left;
      left = Math.max(12, Math.min(left, vw - mw - 12));
      let top = r.bottom + 6;
      if (top + mh > vh - 12) top = r.top - mh - 6 >= 12 ? r.top - mh - 6 : Math.max(12, vh - mh - 12);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.style.maxHeight = `${vh - 24}px`;
      menu.style.overflowY = "auto";
    }
    anchor.setAttribute("aria-expanded", "true");
    menuEl = menu;
    menuAnchor = anchor;
    const first = menu.querySelector(".menu-item:not(:disabled)");
    if (first) first.focus({ preventScroll: true });
  }

  function addMenuEntries() {
    return [
      { icon: "plus", label: "Add your Riot account", sub: "Sign in with Riot", onClick: openAddOwn },
      { icon: "share", label: "Import shared account", sub: "Enter a share code", onClick: openImport },
    ];
  }

  /* ==========================================================================
     Overview
     ========================================================================== */

  function renderHome() {
    setTitle("Overview");
    const view = $("view");
    const accts = ordered();
    view.appendChild(
      h("div", { class: "page-head" },
        h("div", null,
          h("h1", { text: "Overview" }),
          h("p", { text: accts.length ? "Every linked account at a glance. Pick one to see its shops, collection and alerts." : "Add a Riot account to see its shops and turn on DM alerts." })),
        h("div", { class: "page-actions" },
          h("button", { class: "btn", type: "button", "aria-haspopup": "menu", onclick: (e) => openMenu(e.currentTarget, addMenuEntries()) }, iconEl("plus"), "Add account")))
    );

    if (!accts.length) {
      view.appendChild(
        h("div", { class: "empty-state" },
          iconEl("user"),
          h("h3", { text: "No accounts yet" }),
          h("p", { text: "Sign in with your Riot account, or import one a friend shared with you. Everything stays read-only." }),
          h("div", { class: "page-actions" },
            h("button", { class: "btn", type: "button", onclick: openAddOwn }, iconEl("plus"), "Add Riot account"),
            h("button", { class: "btn btn-ghost", type: "button", onclick: openImport }, iconEl("share"), "Import shared")))
      );
      maybePromo(view);
      return;
    }

    view.appendChild(h("div", { class: "summary", id: "summary" }));
    renderSummary();
    maybePromo(view);

    const grid = h("div", { class: "acct-grid" });
    for (const a of accts) grid.appendChild(accountCardEl(a));
    grid.appendChild(
      h("button", { class: "acct-card-add", type: "button", "aria-haspopup": "menu", onclick: (e) => openMenu(e.currentTarget, addMenuEntries()) },
        iconEl("plus"), h("span", { text: "Add another account" }))
    );
    view.appendChild(grid);
  }

  function renderSummary() {
    const box = $("summary");
    if (!box) return;
    box.innerHTML = "";
    const accts = ordered();
    const now = Date.now();
    let nextDaily = 0;
    for (const a of accts) {
      const s = S.store[a.puuid];
      const at = s && s.daily && s.daily.expiresAt;
      if (at && at > now && (!nextDaily || at < nextDaily)) nextDaily = at;
    }
    const nm = nightMarketState();
    const wlCount = S.wishlist.daily.length + S.wishlist.accessory.length;
    const hits = wishlistHits();
    const item = (icon, label, value, extra) =>
      h("div", { class: `summary-item ${extra || ""}` }, iconEl(icon), h("div", { class: "summary-text" }, h("span", { class: "summary-label", text: label }), value));

    box.appendChild(item("user", "Accounts", h("span", { class: "summary-value", text: `${ownAccounts().length} own${accts.length > ownAccounts().length ? ` · ${accts.length - ownAccounts().length} shared` : ""}` })));
    box.appendChild(item("clock", "Daily reset", nextDaily ? countdownEl(nextDaily, "summary-value") : h("span", { class: "summary-value faint", text: "-" })));
    box.appendChild(
      item("moon", "Night Market",
        nm.open
          ? (nm.expiresAt ? countdownEl(nm.expiresAt, "summary-value", "Open · ") : h("span", { class: "summary-value", text: "Open" }))
          : h("span", { class: "summary-value faint", text: nm.known ? "Closed" : "-" }),
        nm.open ? "is-night" : "")
    );
    box.appendChild(item("star", "Wishlist", h("span", { class: "summary-value", text: hits ? `${hits} in shops now` : `${wlCount} ${wlCount === 1 ? "item" : "items"}` })));
  }

  // How many wishlisted items are in any loaded daily or accessory shop now.
  function wishlistHits() {
    let n = 0;
    const seen = new Set();
    for (const a of S.accounts) {
      const s = S.store[a.puuid];
      if (!s) continue;
      for (const it of [...((s.daily && s.daily.items) || []), ...((s.kingdomShop && s.kingdomShop.items) || [])]) {
        if (isWishlisted(it) && !seen.has(`${a.puuid}:${it.id}`)) {
          seen.add(`${a.puuid}:${it.id}`);
          n += 1;
        }
      }
    }
    return n;
  }

  const PROMO_HIDE_KEY = "vs.addApp.hidden";
  function promoHidden() {
    try { return localStorage.getItem(PROMO_HIDE_KEY) === "1"; } catch { return false; }
  }
  function maybePromo(view) {
    if (promoHidden()) return;
    const promo = h("div", { class: "promo" },
      iconEl("terminal"),
      h("div", { class: "promo-text" },
        h("b", { text: "Get valorant shop on Discord" }),
        h("span", { text: "Run /shop, /rank and /share anywhere, and receive your alerts as DMs." })),
      h("div", { class: "promo-actions" },
        h("button", { class: "btn sm", type: "button", onclick: () => openInstall("user") }, "Add App"),
        h("button", { class: "btn btn-ghost sm", type: "button", onclick: () => openInstall("guild") }, "Add to server"),
        h("button", {
          class: "icon-btn sm", type: "button", "aria-label": "Dismiss", title: "Dismiss",
          onclick: () => {
            try { localStorage.setItem(PROMO_HIDE_KEY, "1"); } catch { /* storage blocked */ }
            promo.remove();
          },
        }, iconEl("x"))));
    view.appendChild(promo);
  }

  // Live countdown; the global ticker rewrites every [data-until] each second.
  function countdownEl(at, cls, prefix, suffix) {
    return h("span", {
      class: cls || "",
      dataset: { until: String(at), prefix: prefix || "", suffix: suffix || "" },
      text: `${prefix || ""}${fmtCountdown(at - Date.now())}${suffix || ""}`,
    });
  }

  function coinEl(code, value) {
    const na = value === null || value === undefined;
    return h("span", { class: `coin${na ? " na" : ""}`, title: code.toUpperCase() }, makeImg(CURRENCY_ICON[code], code.toUpperCase()), na ? "-" : fmt(value));
  }

  function walletEl(a) {
    const w = walletOf(a);
    if (!w && a.linked && S.storePending[a.puuid]) {
      return h("div", { class: "wallet" }, h("span", { class: "sk", style: "width:74px;height:28px" }), h("span", { class: "sk", style: "width:66px;height:28px" }), h("span", { class: "sk", style: "width:70px;height:28px" }));
    }
    const ww = w || {};
    return h("div", { class: "wallet" }, coinEl("vp", ww.vp), coinEl("rp", ww.rp), coinEl("kc", ww.kc));
  }

  function rankBlock(a, compact) {
    const d = S.details[a.puuid];
    if (!a.linked) return null;
    if (!d && S.detailsPending[a.puuid]) {
      return h("div", { class: "acct-card-rank" }, h("div", { class: "sk sk-line w60" }), h("div", { class: "sk", style: "height:4px" }));
    }
    if (!d || d.relink || !d.rank) {
      return compact ? null : h("div", { class: "acct-card-rank" }, h("span", { class: "rank-name faint", text: d && d.relink ? "Needs re-link" : "Rank unavailable" }));
    }
    const rank = d.rank;
    const ranked = Number(rank.tier) >= 3;
    const top = Number(rank.tier) >= 24;
    const rr = Math.max(0, Math.round(Number(rank.rr) || 0));
    const color = rankColor(rank) || "#8b929c";
    const level = d.level && d.level.level ? `Lv ${fmt(d.level.level)}` : "";
    const line = h("div", { class: "rank-line" },
      h("span", { class: "rank-name", text: ranked ? rank.tierName : "Unranked" }),
      h("span", { class: "rank-rr", text: [ranked ? `${fmt(rr)} RR` : "", level].filter(Boolean).join(" · ") }));
    const bar = h("div", { class: "rr-bar", style: `--tier:${color}` }, h("span", { style: `width:${ranked ? (top ? 100 : Math.min(100, rr)) : 0}%` }));
    return h("div", { class: "acct-card-rank" }, line, bar);
  }

  function accountCardEl(a) {
    const card = h("a", { class: `acct-card${a.is_default ? " is-main" : ""}`, href: acctHref(a.puuid), dataset: { card: a.puuid } });
    const chips = h("div", { class: "acct-card-chips" });
    if (a.shard) chips.appendChild(h("span", { class: "chip", text: a.shard.toUpperCase() }));
    if (a.is_default) chips.appendChild(h("span", { class: "chip main" }, iconEl("crown"), "Main"));
    if (a.shared) chips.appendChild(h("span", { class: "chip shared" }, iconEl("share"), a.sharedBy && a.sharedBy.name ? `From ${a.sharedBy.name}` : "Shared"));
    const store = S.store[a.puuid];
    if (storeHasNm(store)) chips.appendChild(h("span", { class: "chip night" }, iconEl("moon"), "Night Market"));

    card.appendChild(
      h("div", { class: "acct-card-top" },
        emblemEl(a, "md"),
        h("div", { class: "acct-card-id" }, h("div", { class: "acct-card-name" }, nameNodes(acctName(a))), chips))
    );

    if (!a.linked) {
      card.appendChild(
        h("div", { class: "warn-line" }, iconEl("alert"),
          h("span", { text: a.shared ? "The owner needs to re-link this account before its shops can load." : "This account's Riot session expired. Open it to re-link." }))
      );
      return card;
    }

    const rb = rankBlock(a, true);
    if (rb) card.appendChild(rb);

    const shop = h("div", { class: "acct-card-shop" });
    const items = (store && store.daily && store.daily.items) || [];
    if (store) {
      for (const it of items.slice(0, 4)) {
        const color = tierColor(it.tier);
        shop.appendChild(h("div", { class: "mini-item", title: it.name || "", style: color ? `--tier:${color}` : null }, it.icon ? makeImg(it.icon, it.name) : fallbackText(it.name)));
      }
    } else if (S.storeError[a.puuid]) {
      shop.style.gridTemplateColumns = "1fr";
      shop.appendChild(h("div", { class: "faint", style: "font-size:12.5px", text: "Shop unavailable right now." }));
    } else {
      for (let i = 0; i < 4; i++) shop.appendChild(h("div", { class: "mini-item sk" }));
    }
    card.appendChild(shop);

    card.appendChild(h("div", { class: "acct-card-foot" }, walletEl(a)));
    return card;
  }

  function replaceCard(puuid) {
    const a = findAcct(puuid);
    const old = document.querySelector(`[data-card="${CSS.escape(puuid)}"]`);
    if (a && old) old.replaceWith(accountCardEl(a));
  }

  /* ==========================================================================
     Account page
     ========================================================================== */

  function renderAccountView(a) {
    setTitle(acctName(a), true);
    const view = $("view");
    view.appendChild(h("a", { class: "back-link", href: path("/") }, iconEl("chevron-left"), "Overview"));
    view.appendChild(h("div", { id: "acctHead" }));
    view.appendChild(h("nav", { class: "tabs", id: "acctTabs", role: "tablist", "aria-label": "Account sections" }));
    view.appendChild(h("section", { id: "acctPanel", class: "acct-panel" }));
    renderAccountHead();
    renderTabs();
    renderPanel();
    if (a.linked) {
      ensureStore(a.puuid).catch(() => {});
      fetchDetails(a.puuid).catch(() => {});
    }
  }

  function currentAcct() {
    return S.route.name === "account" ? findAcct(S.route.puuid) : null;
  }

  function renderAccountHead() {
    const box = $("acctHead");
    const a = currentAcct();
    if (!box || !a) return;
    box.innerHTML = "";

    const chips = h("div", { class: "hero-chips" });
    if (a.shard) chips.appendChild(h("span", { class: "chip", text: a.shard.toUpperCase() }));
    if (a.is_default) chips.appendChild(h("span", { class: "chip main" }, iconEl("crown"), "Main account"));
    if (a.shared) chips.appendChild(h("span", { class: "chip shared" }, iconEl("share"), a.sharedBy && a.sharedBy.name ? `Shared by ${a.sharedBy.name}` : "Shared with you"));
    const d = S.details[a.puuid];
    if (d && d.level && d.level.level) chips.appendChild(h("span", { class: "chip", text: `Level ${fmt(d.level.level)}` }));
    chips.appendChild(
      h("button", { class: "puuid-btn", type: "button", title: "Copy account ID (PUUID)", onclick: () => copyText(a.puuid, "Account ID copied") },
        iconEl("copy"), h("span", { text: a.puuid }))
    );

    const actions = h("div", { class: "hero-actions" });
    if (!a.shared && !a.is_default) {
      actions.appendChild(h("button", { class: "btn btn-quiet", type: "button", onclick: () => setMain(a) }, iconEl("crown"), "Set as main"));
    }
    if (a.linked) {
      actions.appendChild(h("button", { class: "btn btn-quiet", type: "button", title: "Reload shop and details", onclick: (e) => refreshAccount(a, e.currentTarget) }, iconEl("refresh"), "Refresh"));
    }
    actions.appendChild(
      h("button", { class: "btn btn-quiet btn-square", type: "button", title: "More actions", "aria-label": "More actions", "aria-haspopup": "menu", onclick: (e) => openMenu(e.currentTarget, accountMenu(a)) }, iconEl("more"))
    );

    box.appendChild(
      h("div", { class: "hero" },
        emblemEl(a, "lg"),
        h("div", { class: "hero-id" }, h("h1", { class: "hero-name" }, nameNodes(acctName(a))), chips),
        actions)
    );

    if (!a.linked) {
      box.appendChild(
        h("div", { class: "notice" }, iconEl("alert"),
          h("div", { class: "notice-text" },
            h("b", { text: a.shared ? "The owner needs to re-link this account" : "This account needs to be re-linked" }),
            h("span", { text: a.shared ? "Its Riot session expired. Ask the owner to add it again on their dashboard." : "Its Riot session expired. Sign in with Riot again to reconnect it; your alerts and settings stay." })),
          a.shared ? null : h("button", { class: "btn sm", type: "button", onclick: openAddOwn }, "Re-link"))
      );
      return;
    }
    if (d && d.relink) {
      box.appendChild(h("div", { class: "notice" }, iconEl("alert"), h("div", { class: "notice-text" }, h("b", { text: "Riot asked to sign in again" }), h("span", { text: "Some details could not load. Re-link the account if shops stop updating." }))));
    }
    box.appendChild(statsEl(a));
  }

  function statsEl(a) {
    const d = S.details[a.puuid];
    const loading = !d && S.detailsPending[a.puuid];
    const stats = h("div", { class: "stats" });
    const stat = (label, ...content) => h("div", { class: "stat" }, h("div", { class: "stat-label", text: label }), ...content);
    const skLine = () => h("div", { class: "stat-value" }, h("span", { class: "sk sk-line w60" }));

    // Rank
    if (loading) stats.appendChild(stat("Rank", skLine()));
    else if (d && d.rank) {
      const rank = d.rank;
      const ranked = Number(rank.tier) >= 3;
      const top = Number(rank.tier) >= 24;
      const rr = Math.max(0, Math.round(Number(rank.rr) || 0));
      const color = rankColor(rank) || "#8b929c";
      const sub = !ranked ? "No placement this act" : top ? `${fmt(rr)} RR${rank.leaderboard ? ` · #${fmt(rank.leaderboard)}` : ""}` : `${fmt(rr)} / 100 RR`;
      stats.appendChild(
        stat("Rank",
          h("div", { class: "stat-value" },
            rank.icon ? h("span", { class: "emblem md", style: "background:transparent" }, makeImg(rank.icon, "")) : null,
            h("div", { style: "min-width:0" }, h("div", { class: "stat-big", text: ranked ? rank.tierName : "Unranked" }), h("div", { class: "stat-sub", text: sub }))),
          ranked ? h("div", { class: "rr-bar", style: `--tier:${color}` }, h("span", { style: `width:${top ? 100 : Math.min(100, rr)}%` })) : null)
      );
    } else stats.appendChild(stat("Rank", h("div", { class: "stat-value faint", text: "Unavailable" })));

    // Peak
    if (loading) stats.appendChild(stat("Peak rank", skLine()));
    else {
      const rank = d && d.rank;
      const hasPeak = rank && Number(rank.peakTier) >= 3 && rank.peakName;
      stats.appendChild(
        stat("Peak rank",
          h("div", { class: "stat-value" },
            hasPeak && rank.peakIcon ? h("span", { class: "emblem md", style: "background:transparent" }, makeImg(rank.peakIcon, "")) : null,
            h("div", { class: "stat-big", text: hasPeak ? rank.peakName : "-" })))
      );
    }

    // Collection
    if (loading) stats.appendChild(stat("Collection", skLine()));
    else {
      const skins = d && d.skins ? d.skins.count || 0 : null;
      const acc = d ? ["buddies", "sprays", "cards", "flexes"].reduce((n, k) => n + (Array.isArray(d[k]) ? d[k].length : 0), 0) : null;
      stats.appendChild(
        stat("Collection",
          h("div", { class: "stat-value" },
            h("div", null, h("div", { class: "stat-big", text: skins === null ? "-" : `${fmt(skins)} skins` }), acc ? h("div", { class: "stat-sub", text: `${fmt(acc)} accessories` }) : null)))
      );
    }

    // Wallet
    stats.appendChild(stat("Wallet", walletEl(a)));
    return stats;
  }

  function accountMenu(a) {
    const list = ordered();
    const i = list.findIndex((x) => x.puuid === a.puuid);
    const entries = [];
    if (!a.shared) {
      if (a.linked) entries.push({ icon: "share", label: "Share this account", sub: "Create or manage a share code", onClick: () => go(acctHref(a.puuid, "sharing")) });
      entries.push({ icon: "bell", label: "DM alerts", sub: "Daily shop, accessories, wishlist", onClick: () => go(acctHref(a.puuid, "alerts")) });
      if (!a.linked) entries.push({ icon: "link", label: "Re-link account", sub: "Sign in with Riot again", onClick: openAddOwn });
    }
    entries.push({ icon: "chevron-up", label: "Move up", disabled: i <= 0, onClick: () => moveAccount(a.puuid, -1) });
    entries.push({ icon: "chevron-down", label: "Move down", disabled: i < 0 || i >= list.length - 1, onClick: () => moveAccount(a.puuid, 1) });
    entries.push({ icon: "copy", label: "Copy account ID", onClick: () => copyText(a.puuid, "Account ID copied") });
    entries.push("sep");
    entries.push({
      icon: "trash",
      label: a.shared ? "Remove from my list" : "Remove account",
      sub: a.shared ? "You can import it again with the code" : "Stops its alerts and sharing",
      danger: true,
      onClick: () => (a.shared ? removeShared(a) : removeAccount(a)),
    });
    return entries;
  }

  function tabDefs(a) {
    const store = S.store[a.puuid];
    const nmOpen = storeHasNm(store);
    const tabs = [
      { id: "daily", label: "Daily shop", icon: "bag" },
      { id: "acc", label: "Accessories", icon: "sparkle" },
      { id: "nm", label: "Night Market", icon: "moon", night: true, dot: nmOpen, disabled: store && !nmOpen },
      { id: "collection", label: "Collection", icon: "box" },
    ];
    if (!a.shared) {
      tabs.push({ id: "alerts", label: "Alerts", icon: "bell" });
      tabs.push({ id: "sharing", label: "Sharing", icon: "share" });
    }
    return tabs;
  }

  function renderTabs() {
    const nav = $("acctTabs");
    const a = currentAcct();
    if (!nav || !a) return;
    const scroll = nav.scrollLeft;
    nav.innerHTML = "";
    for (const t of tabDefs(a)) {
      const on = S.route.tab === t.id;
      const link = h("a", {
        class: `tab${on ? " is-active" : ""}${t.night ? " is-night" : ""}${t.disabled ? " is-disabled" : ""}`,
        href: acctHref(a.puuid, t.id),
        role: "tab",
        "aria-selected": on ? "true" : "false",
      }, iconEl(t.icon), t.label, t.dot ? h("span", { class: "dot", title: "Night Market is open" }) : null);
      nav.appendChild(link);
    }
    nav.scrollLeft = scroll;
    const active = nav.querySelector(".tab.is-active");
    if (active && (active.offsetLeft < nav.scrollLeft || active.offsetLeft + active.offsetWidth > nav.scrollLeft + nav.clientWidth)) {
      nav.scrollLeft = active.offsetLeft - 16;
    }
  }

  function renderPanel() {
    const box = $("acctPanel");
    const a = currentAcct();
    if (!box || !a) return;
    const tab = S.route.tab;
    box.innerHTML = "";
    if (!a.linked && ["daily", "acc", "nm", "collection"].includes(tab)) {
      box.appendChild(h("div", { class: "empty-state" }, iconEl("link"), h("h3", { text: "Not connected" }), h("p", { text: "Re-link this account to load its shops and collection." })));
      return;
    }
    if (tab === "daily" || tab === "acc" || tab === "nm") renderShopPanel(box, a, tab);
    else if (tab === "collection") renderCollectionPanel(box, a);
    else if (tab === "alerts") renderAlertsPanel(box, a);
    else if (tab === "sharing") renderSharingPanel(box, a);
  }

  /* ---------- shop panels ---------- */

  function skeletonCards(n, cls) {
    const grid = h("div", { class: `grid ${cls || ""}` });
    for (let i = 0; i < n; i++) {
      grid.appendChild(h("div", { class: "card grid-sk" }, h("div", { class: "card-media sk", style: "border-radius:0" }), h("div", { class: "card-body" }, h("div", { class: "sk sk-line w80" }), h("div", { class: "sk sk-line w40" }))));
    }
    return grid;
  }

  function renderShopPanel(box, a, view) {
    const store = S.store[a.puuid];
    const titles = { daily: "Daily shop", acc: "Accessory shop", nm: "Night Market" };
    const head = h("div", { class: "panel-head" }, h("h2", { text: titles[view] }));
    const tools = h("div", { class: "panel-tools" });
    head.appendChild(tools);
    box.appendChild(head);

    if (!store) {
      if (S.storeError[a.puuid] && !S.storePending[a.puuid]) {
        box.appendChild(
          h("div", { class: "empty-state" }, iconEl("alert"), h("h3", { text: "Could not load this shop" }), h("p", { text: S.storeError[a.puuid] }),
            h("button", { class: "btn btn-ghost", type: "button", onclick: () => { ensureStore(a.puuid, true).catch(() => {}); renderPanel(); } }, iconEl("refresh"), "Try again"))
        );
        return;
      }
      tools.appendChild(h("span", { class: "sk sk-line", style: "width:120px" }));
      box.appendChild(skeletonCards(view === "nm" ? 6 : 4, "daily"));
      return;
    }

    let items = [];
    let expiresAt = null;
    let empty = "";
    if (view === "daily") {
      items = (store.daily && store.daily.items) || [];
      expiresAt = store.daily && store.daily.expiresAt;
      empty = "No daily offers right now.";
    } else if (view === "acc") {
      items = (store.kingdomShop && store.kingdomShop.items) || [];
      expiresAt = store.kingdomShop && store.kingdomShop.expiresAt;
      empty = "The accessory shop is empty for this account right now.";
    } else {
      items = (store.nightMarket && store.nightMarket.items) || [];
      expiresAt = store.nightMarket && store.nightMarket.expiresAt;
      empty = "Riot's Night Market is closed right now. It usually opens for a couple of weeks once per act.";
    }

    if (expiresAt) {
      tools.appendChild(h("span", { class: "reset", title: view === "nm" ? "Night Market closes in" : "Resets in" }, iconEl("clock"), countdownEl(expiresAt, "", view === "nm" ? "Ends in " : "Resets in ")));
    }
    if (view === "nm" && items.length) {
      const revealed = nmRevealedSet(a.puuid);
      if (items.some((it) => !revealed.has(String(it.id || "")))) {
        tools.appendChild(h("button", { class: "btn btn-quiet sm", type: "button", onclick: () => document.querySelectorAll(".nm-card.nm-covered").forEach((c) => c.click()) }, iconEl("eye"), "Reveal all"));
      }
    }

    if (!items.length) {
      box.appendChild(h("div", { class: "empty-state" }, iconEl(view === "nm" ? "moon" : "bag"), h("h3", { text: view === "nm" ? "No Night Market" : "Nothing here" }), h("p", { text: empty })));
      return;
    }

    if (view === "nm") {
      const grid = h("div", { class: "nm-grid" });
      const revealed = nmRevealedSet(a.puuid);
      for (const item of items) grid.appendChild(nmCard(item, a.puuid, revealed.has(String(item.id || ""))));
      box.appendChild(grid);
    } else {
      const grid = h("div", { class: "grid daily" });
      for (const item of items) grid.appendChild(card(item, { wishlist: true, showType: view === "acc", banner: view === "acc" }));
      box.appendChild(grid);
      prefetchPreviews(items);
    }
    syncStars();
  }

  const TYPE_LABEL = { skin: "Weapon skin", buddy: "Gun buddy", spray: "Spray", card: "Player card", title: "Title", flex: "Flex" };

  function card(item, opts = {}) {
    const color = tierColor(item.tier);
    const el = h("article", { class: "card", style: color ? `--tier:${color}` : null });
    const media = h("div", { class: "card-media" });
    if (item.type === "title") media.appendChild(h("div", { class: "title-text", text: titleName(item.name) }));
    else {
      // Accessory shop shows player cards as the wide banner (spanning two
      // columns); everywhere else, including the wishlist, keeps the square art.
      const banner = Boolean(opts.banner && item.type === "card" && item.art && item.art.wide);
      if (banner) el.classList.add("is-banner");
      media.appendChild(imgOrFallback(banner ? item.art.wide : (item.type === "card" && item.art && item.art.small) || item.icon, item.name));
    }
    if (opts.discount) media.appendChild(h("span", { class: "badge", text: `-${opts.discount}%` }));
    if (item.owned) markOwned(el, media);
    if (opts.wishlist) {
      const star = makeStar(item);
      if (star) media.appendChild(star);
    }
    el.appendChild(media);

    const body = h("div", { class: "card-body" }, h("h3", { text: item.name || "Unknown", title: item.name || "" }));
    const meta = h("div", { class: "card-meta" });
    meta.appendChild(priceEl(item, opts.oldPrice));
    if (opts.showType && TYPE_LABEL[item.type]) meta.appendChild(h("span", { class: "card-type", text: TYPE_LABEL[item.type] }));
    else if (item.tier) meta.appendChild(h("span", { class: "card-type", style: color ? `color:${color}` : null, text: item.tier }));
    body.appendChild(meta);
    el.appendChild(body);
    if (canPreview(item)) previewTrigger(el, item);
    return el;
  }

  // "Owned" tag for items the account already has (the server flags them).
  function markOwned(el, media, animate) {
    el.classList.add("is-owned");
    media.appendChild(h("span", { class: `owned-tag${animate ? " nm-pop" : ""}`, title: "Already on this account" }, iconEl("check"), "Owned"));
  }

  function priceEl(item, oldPrice) {
    const price = h("span", { class: "price" });
    if (oldPrice && oldPrice !== item.price) price.appendChild(h("span", { class: "old", text: fmt(oldPrice) }));
    if (item.price === null || item.price === undefined) {
      price.appendChild(h("span", { text: "-" }));
      return price;
    }
    const currency = item.currency || "vp";
    price.appendChild(makeImg(CURRENCY_ICON[currency] || CURRENCY_ICON.vp, currency.toUpperCase()));
    price.appendChild(h("span", { text: fmt(item.price) }));
    return price;
  }

  /* ---------- Night Market (mystery reveal) ---------- */

  // Revealed offers stay uncovered for the rest of the browsing session per
  // account, so background refreshes never re-wrap a skin already opened.
  const nmRevealed = new Map();
  function nmRevealedSet(puuid) {
    let set = nmRevealed.get(puuid);
    if (!set) {
      set = new Set();
      nmRevealed.set(puuid, set);
    }
    return set;
  }

  function nmCard(item, puuid, wasRevealed) {
    const color = tierColor(item.tier) || "#8b929c";
    const el = h("article", { class: "card nm-card nm-covered", style: `--tier:${color}` });
    el.style.setProperty("--nm-soft", hexTint(color, 0.2));
    el.style.setProperty("--nm-ground", hexTint(color, 0.3));
    el.style.setProperty("--nm-glow", hexTint(color, 0.55));
    el.style.setProperty("--nm-line", hexTint(color, 0.42));
    el.style.setProperty("--nm-solid", color);

    const media = h("div", { class: "card-media nm-media" });
    el.appendChild(media);
    // The image source is only set at reveal time so the skin cannot be spoiled
    // from the network tab or the DOM.
    const img = makeImg(null, "");
    let fallbackSpan = null;
    const src = item.icon || "";
    if (src) {
      img.onerror = () => {
        fallbackSpan = fallbackText(item.name);
        img.replaceWith(fallbackSpan);
      };
      media.appendChild(img);
    }
    const cover = h("div", { class: "nm-cover" }, h("div", { class: "nm-badge" }, h("div", { class: "nm-mark" })));
    el.appendChild(cover);
    const body = h("div", { class: "card-body nm-body" });
    el.appendChild(body);

    let revealed = false;
    const revealKey = String(item.id || "");
    function fillRevealed(animate) {
      if (src) {
        img.classList.toggle("nm-pop", animate);
        img.loading = "eager";
        img.src = src;
        img.alt = item.name || "Skin";
      } else if (!fallbackSpan) {
        fallbackSpan = fallbackText(item.name);
        if (animate) fallbackSpan.classList.add("nm-pop");
        media.appendChild(fallbackSpan);
      }
      const h3 = h("h3", { class: animate ? "nm-pop" : null, text: item.name || "Unknown", title: item.name || "" });
      body.appendChild(h3);
      const base = item.basePrice != null ? item.basePrice : item.oldPrice;
      const row = h("div", { class: `card-meta${animate ? " nm-pop" : ""}` }, priceEl(item, base));
      body.appendChild(row);
      if (item.discount) media.appendChild(h("span", { class: `badge${animate ? " nm-pop" : ""}`, text: `-${item.discount}%` }));
      if (item.owned) markOwned(el, media, animate);
      const star = makeStar(item);
      if (star) {
        if (animate) star.classList.add("nm-pop");
        media.appendChild(star);
        syncStars();
      }
      if (canPreview(item)) {
        el.classList.add("is-previewable");
        el.title = `Preview ${item.name || "offer"}`;
      }
    }
    function reveal() {
      if (revealed) return;
      revealed = true;
      nmRevealedSet(puuid).add(revealKey);
      el.classList.remove("nm-covered");
      el.classList.add("nm-revealing");
      el.removeAttribute("aria-label");
      fillRevealed(true);
      setTimeout(() => {
        el.classList.remove("nm-revealing");
        el.classList.add("nm-revealed");
        el.removeAttribute("role");
        cover.remove();
        const pending = document.querySelectorAll(".nm-card.nm-covered").length;
        if (!pending) {
          const btn = [...document.querySelectorAll(".panel-tools .btn")].find((b) => b.textContent.includes("Reveal all"));
          if (btn) btn.remove();
        }
      }, 680);
    }
    function activate(e) {
      if (e.target.closest(".star-btn")) return;
      if (!revealed) reveal();
      else if (canPreview(item)) openPreview(item);
    }
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      activate(e);
    });
    if (wasRevealed) {
      el.classList.remove("nm-covered");
      el.classList.add("nm-revealed");
      revealed = true;
      fillRevealed(false);
      cover.remove();
    } else {
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", "Reveal Night Market offer");
    }
    return el;
  }

  /* ---------- collection ---------- */

  const collectionState = new Map(); // puuid -> { section, weapon, kind, q }

  function renderCollectionPanel(box, a) {
    const d = S.details[a.puuid];
    box.appendChild(h("div", { class: "panel-head" }, h("h2", { text: "Collection" })));
    if (!d) {
      if (S.detailsError[a.puuid] && !S.detailsPending[a.puuid]) {
        box.appendChild(h("div", { class: "empty-state" }, iconEl("alert"), h("h3", { text: "Could not load the collection" }), h("p", { text: S.detailsError[a.puuid] }),
          h("button", { class: "btn btn-ghost", type: "button", onclick: () => { fetchDetails(a.puuid, true).catch(() => {}); renderPanel(); } }, iconEl("refresh"), "Try again")));
        return;
      }
      const sk = h("div", { class: "tiles" });
      for (let i = 0; i < 12; i++) sk.appendChild(h("div", { class: "tile" }, h("div", { class: "tile-media sk", style: "border-radius:0" }), h("div", { class: "tile-name" }, h("div", { class: "sk sk-line w80" }))));
      box.appendChild(sk);
      return;
    }
    if (d.relink) {
      box.appendChild(h("div", { class: "empty-state" }, iconEl("link"), h("h3", { text: "Needs re-linking" }), h("p", { text: "Riot asked to sign in again before the collection can load." })));
      return;
    }

    const st = collectionState.get(a.puuid) || { section: "skins", weapon: "all", kind: "all", q: "" };
    collectionState.set(a.puuid, st);
    const skins = (d.skins && d.skins.items) || [];
    const lists = {
      skins: skins,
      buddies: d.buddies || [],
      sprays: d.sprays || [],
      cards: d.cards || [],
      flexes: d.flexes || [],
    };
    const labels = { skins: "Skins", buddies: "Gun buddies", sprays: "Sprays", cards: "Player cards", flexes: "Flexes" };
    const counts = { ...Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])), skins: (d.skins && d.skins.count) || skins.length };

    const seg = h("div", { class: "seg", role: "tablist" });
    for (const key of Object.keys(lists)) {
      seg.appendChild(
        h("button", {
          type: "button", role: "tab", class: st.section === key ? "is-active" : null, "aria-selected": st.section === key ? "true" : "false",
          onclick: () => {
            st.section = key;
            st.q = "";
            st.segScroll = seg.scrollLeft;
            renderPanel();
          },
        }, labels[key], h("span", { class: "n", text: fmt(counts[key]) }))
      );
    }
    box.appendChild(seg);
    // Re-rendering rebuilds the tab strip; keep its horizontal scroll so the
    // tapped tab does not jump away on phones.
    if (st.segScroll) seg.scrollLeft = st.segScroll;


    const search = h("input", { type: "search", class: "input", placeholder: `Search ${labels[st.section].toLowerCase()}...`, "aria-label": `Search ${labels[st.section]}`, autocomplete: "off", spellcheck: "false" });
    search.value = st.q;
    const countEl = h("span", { class: "coll-count" });
    box.appendChild(h("div", { class: "coll-tools" }, h("label", { class: "search" }, iconEl("search"), search), countEl));

    const list = lists[st.section];
    let filterBox = null;
    if (st.section === "skins" && list.length) {
      filterBox = h("div");
      const KIND_LABELS = { standard: "Standard", agent: "Agent", limited: "Limited", battlepass: "Battle pass" };
      const ownedKinds = ["standard", "agent", "limited", "battlepass"].filter((key) => list.some((s) => s.kind === key));
      const WEAPON_ORDER = ["Classic", "Shorty", "Frenzy", "Ghost", "Sheriff", "Bandit", "Stinger", "Spectre", "Bucky", "Judge", "Bulldog", "Guardian", "Phantom", "Vandal", "Warden", "Marshal", "Operator", "Outlaw", "Ares", "Odin", "Melee"];
      const owned = new Set(list.map((s) => s.weapon).filter(Boolean));
      const weapons = WEAPON_ORDER.filter((w) => owned.has(w));
      for (const w of [...owned].sort()) if (!WEAPON_ORDER.includes(w)) weapons.push(w);
      const pills = (values, current, set, labelFor) => {
        const row = h("div", { class: "filters", role: "group" });
        for (const v of ["all", ...values]) {
          row.appendChild(h("button", {
            type: "button", class: `pill${current === v ? " is-active" : ""}`, dataset: { v },
            onclick: () => {
              set(v);
              row.querySelectorAll(".pill").forEach((p) => p.classList.toggle("is-active", p.dataset.v === v));
              apply();
            },
          }, v === "all" ? "All" : labelFor(v)));
        }
        return row;
      };
      const kindRow = ownedKinds.length > 1 ? pills(ownedKinds, st.kind, (v) => { st.kind = v; }, (v) => KIND_LABELS[v]) : null;
      const weaponRow = weapons.length ? pills(weapons, st.weapon, (v) => { st.weapon = v; }, (v) => v) : null;
      if (kindRow) filterBox.appendChild(kindRow);
      if (weaponRow) filterBox.appendChild(weaponRow);
      box.appendChild(filterBox);
    } else {
      box.appendChild(h("div", { style: "height:14px" }));
    }

    if (!list.length) {
      box.appendChild(h("div", { class: "empty-state" }, iconEl("box"), h("h3", { text: `No ${labels[st.section].toLowerCase()}` }), h("p", { text: "Nothing of this type is owned on this account yet." })));
      countEl.textContent = "";
      return;
    }

    const square = st.section !== "skins" && st.section !== "flexes";
    const tiles = h("div", { class: `tiles${square ? " square" : st.section === "flexes" ? " wide" : ""}` });
    const nodes = [];
    for (const it of list) {
      // Sprays use the animated GIF when Riot has one (icon), else the still.
      const src = st.section === "cards" ? (it.art && it.art.small) || it.icon : it.icon || it.staticIcon;
      const tile = h("div", { class: "tile", title: it.name || "" }, h("div", { class: "tile-media" }, imgOrFallback(src, it.name)), h("div", { class: "tile-name", text: it.name || "Unknown" }));
      if (st.section === "skins" && it.id) previewTrigger(tile, { ...it, type: "skin" });
      if (st.section === "cards" && it.art) previewTrigger(tile, { ...it, type: "card" });
      tiles.appendChild(tile);
      nodes.push({ tile, key: String(it.name || "").toLowerCase(), weapon: it.weapon || null, kind: it.kind || null });
    }
    box.appendChild(tiles);
    const none = h("div", { class: "inline-msg", text: "Nothing matches your filters.", hidden: true });
    box.appendChild(none);

    function apply() {
      const q = st.q.trim().toLowerCase();
      let shown = 0;
      for (const n of nodes) {
        const ok = (!q || n.key.includes(q)) && (st.section !== "skins" || ((st.weapon === "all" || n.weapon === st.weapon) && (st.kind === "all" || n.kind === st.kind)));
        n.tile.hidden = !ok;
        if (ok) shown += 1;
      }
      none.hidden = shown > 0;
      countEl.textContent = shown === nodes.length ? `${fmt(nodes.length)} owned` : `${fmt(shown)} of ${fmt(nodes.length)}`;
    }
    search.addEventListener("input", () => {
      st.q = search.value;
      apply();
    });
    apply();
  }

  /* ---------- alerts ---------- */

  function switchEl(on, label, onChange) {
    const sw = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label });
    sw.addEventListener("click", () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", next ? "true" : "false");
      onChange(next, sw);
    });
    return sw;
  }

  function renderAlertsPanel(box, a) {
    box.appendChild(h("div", { class: "panel-head" }, h("h2", { text: "DM alerts" })));
    box.appendChild(h("p", { class: "muted", style: "margin:-6px 0 16px", text: `Get a Discord DM from the valorant shop app about ${acctName(a)}. All alerts start off.` }));
    const rows = h("div", { class: "rows" });
    const defs = [
      ["shop", "bag", "Daily shop", "A DM with this account's daily shop every day when it resets."],
      ["wishlist_shop", "star", "Wishlist in daily shop", "Only when an item from your wishlist shows up in the daily shop."],
      ["accessory", "sparkle", "Accessory shop", "A DM when the weekly accessory shop refreshes."],
      ["wishlist_accessory", "star", "Wishlist in accessory shop", "Only when a wishlisted accessory shows up."],
    ];
    for (const [kind, icon, title, desc] of defs) {
      rows.appendChild(
        h("div", { class: "row" }, iconEl(icon), h("div", { class: "row-text" }, h("b", { text: title }), h("span", { text: desc })),
          switchEl(Boolean(a.alerts && a.alerts[kind]), title, (on) => {
            a.alerts = { ...(a.alerts || {}), [kind]: on };
            patchPrefs({ accounts: { [a.puuid]: { [kind]: on } } }).then(() => toast(`${title} alerts ${on ? "on" : "off"}.`, "ok"), () => {});
          }))
      );
    }
    box.appendChild(rows);
    box.appendChild(
      h("div", { class: "tip", style: "margin-top:14px" }, iconEl("bell"),
        h("span", null, "Night Market and new bundle alerts are global, find them in ", h("a", { href: path("/settings"), text: "Settings" }), ". DMs need the Discord app: ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); openInstall("user"); } , text: "add it here" }), "."))
    );
    if (!S.wlLoaded || S.wishlist.daily.length + S.wishlist.accessory.length === 0) {
      box.appendChild(h("div", { class: "tip", style: "margin-top:8px" }, iconEl("star"), h("span", null, "Wishlist alerts need items on your ", h("a", { href: path("/wishlist"), text: "wishlist" }), ".")));
    }
  }

  /* ---------- sharing ---------- */

  const SHARE_ROTATE_COOLDOWN_MS = 60000;
  let shareCooldownTimer = null;

  async function renderSharingPanel(box, a) {
    if (shareCooldownTimer) { clearInterval(shareCooldownTimer); shareCooldownTimer = null; }
    box.appendChild(h("div", { class: "panel-head" }, h("h2", { text: "Sharing" })));
    const body = h("div", { class: "share-box" }, h("div", { class: "sk", style: "height:72px" }), h("div", { class: "sk sk-line w60" }));
    box.appendChild(body);
    if (!a.linked) {
      body.innerHTML = "";
      body.appendChild(h("p", { class: "muted", text: "Re-link this account before sharing it." }));
      return;
    }
    let share = null;
    try {
      const data = await api("/api/shares");
      share = (data.shares || []).find((s) => s.puuid === a.puuid) || null;
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(h("p", { class: "form-error", text: err.message }));
      return;
    }
    if (S.route.name !== "account" || S.route.puuid !== a.puuid || S.route.tab !== "sharing") return;
    body.innerHTML = "";

    if (!share) {
      const create = h("button", { class: "btn", type: "button" }, iconEl("share"), "Create share code");
      create.addEventListener("click", async () => {
        create.classList.add("is-busy");
        try {
          await api("/api/shares", { method: "POST", json: { puuid: a.puuid } });
          toast("Share code created.", "ok");
          renderPanel();
        } catch (err) {
          toast(err.message, "error");
          create.classList.remove("is-busy");
        }
      });
      body.appendChild(
        h("section", { class: "share-card share-intro" },
          h("p", { class: "muted", style: "margin:0", text: "Create a code and send it to anyone you want to share this account's shops with. They get read-only access and never see your Riot login. You can revoke it any time." }),
          h("div", null, create))
      );
      body.appendChild(discordShareTip());
      return;
    }

    const refresh = h("button", { class: "btn btn-quiet", type: "button" }, iconEl("refresh"), "New code");
    refresh.addEventListener("click", async () => {
      refresh.classList.add("is-busy");
      try {
        await api(`/api/shares/${encodeURIComponent(a.puuid)}/rotate`, { method: "POST" });
        toast("New code issued. People who already imported it keep access.", "ok");
      } catch (err) {
        if (err.status !== 429) toast(err.message, "error");
      }
      renderPanel();
    });
    const stop = h("button", { class: "btn btn-danger", type: "button" }, iconEl("x"), "Stop sharing");
    stop.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: "Stop sharing", message: `Stop sharing ${acctName(a)}? Everyone you shared it with loses access and the code stops working.`, okLabel: "Stop sharing", danger: true });
      if (!ok) return;
      stop.classList.add("is-busy");
      try {
        await api(`/api/shares/${encodeURIComponent(share.code)}`, { method: "DELETE" });
        toast("Sharing stopped.", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
      renderPanel();
    });

    const codeCard = h("section", { class: "share-card" },
      h("div", { class: "section-title", style: "margin:0", text: "Share code" }),
      h("div", { class: "share-code" },
        h("span", { class: "share-code-text", text: share.code }),
        h("button", { class: "btn btn-quiet sm", type: "button", onclick: () => copyText(share.code, "Share code copied") }, iconEl("copy"), "Copy")),
      h("div", { class: "page-actions" }, refresh, stop),
      h("p", { class: "faint share-note", text: "A new code keeps everyone who already imported it. Stopping sharing removes the code and everyone you shared it with." })
    );

    const people = share.recipients || [];
    const peopleCard = h("section", { class: "share-card" },
      h("div", { class: "section-title", style: "margin:0" }, h("span", { text: "People with access" }), h("span", { class: "count", text: String(people.length) })));
    if (!people.length) peopleCard.appendChild(h("p", { class: "muted", style: "margin:0", text: "Nobody has imported this code yet." }));
    else {
      const list = h("div", { class: "share-people" });
      for (const r of people) {
        const rm = h("button", { class: "icon-btn sm danger", type: "button", title: "Remove access", "aria-label": `Remove ${r.name || r.id}` }, iconEl("x"));
        rm.addEventListener("click", async () => {
          const ok = await confirmDialog({ title: "Remove access", message: `Remove ${r.name || r.id}? They lose access to this account.`, okLabel: "Remove", danger: true });
          if (!ok) return;
          try {
            await api(`/api/shares/${encodeURIComponent(share.code)}/recipients/${encodeURIComponent(r.id)}`, { method: "DELETE" });
            toast("Access removed.", "ok");
          } catch (err) {
            toast(err.message, "error");
          }
          renderPanel();
        });
        list.appendChild(h("div", { class: "share-person" }, iconEl("user"), h("span", { text: r.name || r.id }), rm));
      }
      peopleCard.appendChild(list);
    }

    body.appendChild(h("div", { class: "share-cols" }, codeCard, peopleCard));
    body.appendChild(discordShareTip());
    applyRotateCooldown(refresh, share.rotated_at);
  }

  // Three command cards. Commands never wrap; the short description under each
  // one does, and the grid drops to one column on narrow screens.
  function discordShareTip() {
    const cmds = [
      ["/share code", "Shows this code"],
      ["/share import", "Adds a friend's account"],
      ["/share stop", "Revokes it"],
    ];
    return h("section", { class: "share-discord" },
      h("div", { class: "section-title", style: "margin:0" }, h("span", { class: "share-discord-head" }, iconEl("terminal"), "On Discord")),
      h("ul", null, cmds.map(([c, d]) => h("li", null, h("code", { text: c }), h("span", { text: d }))))
    );
  }

  function applyRotateCooldown(btn, rotatedAt) {
    if (shareCooldownTimer) { clearInterval(shareCooldownTimer); shareCooldownTimer = null; }
    const label = btn.lastChild;
    const tick = () => {
      const ms = SHARE_ROTATE_COOLDOWN_MS - (Date.now() - (rotatedAt || 0));
      if (ms <= 0 || !btn.isConnected) {
        if (shareCooldownTimer) { clearInterval(shareCooldownTimer); shareCooldownTimer = null; }
        btn.disabled = false;
        label.textContent = "New code";
        return;
      }
      btn.disabled = true;
      label.textContent = `New code in ${Math.ceil(ms / 1000)}s`;
    };
    tick();
    if (SHARE_ROTATE_COOLDOWN_MS - (Date.now() - (rotatedAt || 0)) > 0) shareCooldownTimer = setInterval(tick, 500);
  }

  /* ---------- account actions ---------- */

  async function setMain(a) {
    const ok = await confirmDialog({
      title: "Set main account",
      message: `Make ${acctName(a)} your main account? Discord commands use it when you do not pick an account.`,
      okLabel: "Set as main",
    });
    if (!ok) return;
    const before = S.accounts.map((x) => [x, x.is_default]);
    for (const x of S.accounts) if (!x.shared) x.is_default = x.puuid === a.puuid;
    renderSidebar();
    render();
    try {
      await api("/api/accounts/default", { method: "POST", json: { puuid: a.puuid } });
      toast(`${acctName(a)} is now your main account.`, "ok");
    } catch (err) {
      for (const [x, v] of before) x.is_default = v;
      renderAll();
      toast(err.message || "Could not set the main account.", "error");
    }
  }

  async function refreshAccount(a, btn) {
    btn.classList.add("is-busy");
    await Promise.allSettled([ensureStore(a.puuid, true), fetchDetails(a.puuid, true)]);
    btn.classList.remove("is-busy");
    if (S.storeError[a.puuid]) toast(S.storeError[a.puuid], "error");
    else toast("Account refreshed.", "ok");
  }

  async function removeAccount(a) {
    const ok = await confirmDialog({ title: "Remove account", message: `Remove ${acctName(a)}? Its alerts stop and any share code for it is revoked.`, okLabel: "Remove", danger: true });
    if (!ok) return;
    try {
      await api(`/api/accounts/${encodeURIComponent(a.puuid)}`, { method: "DELETE" });
      forget(a.puuid);
      await fetchAccounts().catch(() => {});
      toast(`${acctName(a)} removed.`, "ok");
      renderSidebar();
      go(path("/"));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function removeShared(a) {
    const ok = await confirmDialog({ title: "Remove shared account", message: `Remove ${acctName(a)} from your list? You can import it again later if you still have the code.`, okLabel: "Remove", danger: true });
    if (!ok) return;
    try {
      await api(`/api/shares/imported/${encodeURIComponent(a.puuid)}`, { method: "DELETE" });
      forget(a.puuid);
      S.accounts = S.accounts.filter((x) => x.puuid !== a.puuid);
      S.order = S.order.filter((p) => p !== a.puuid);
      toast(`${acctName(a)} removed from your list.`, "ok");
      renderSidebar();
      go(path("/"));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function forget(puuid) {
    delete S.store[puuid];
    delete S.details[puuid];
    delete S.storeError[puuid];
    delete S.detailsError[puuid];
  }

  /* ==========================================================================
     Add / import accounts
     ========================================================================== */

  let addFlowId = null;

  async function prepareAddLink() {
    const openBtn = $("addOpenBtn");
    addFlowId = null;
    openBtn.setAttribute("aria-disabled", "true");
    openBtn.removeAttribute("href");
    openBtn.textContent = "Preparing sign-in...";
    $("addError").hidden = true;
    try {
      const data = await api("/api/accounts/add/start", { method: "POST" });
      addFlowId = data.flowId;
      openBtn.href = data.url;
      openBtn.removeAttribute("aria-disabled");
      openBtn.textContent = "Open Riot sign-in";
    } catch (err) {
      openBtn.removeAttribute("aria-disabled");
      openBtn.textContent = "Try again";
      openBtn.href = "#";
      $("addError").textContent = err.message;
      $("addError").hidden = false;
    }
  }

  function openAddOwn() {
    closeMenu();
    closeSidebar();
    $("addUrlInput").value = "";
    $("addError").hidden = true;
    $("addOverlay").hidden = false;
    prepareAddLink();
  }
  function closeAdd() {
    $("addOverlay").hidden = true;
    addFlowId = null;
  }

  async function completeAdd() {
    const btn = $("addCompleteBtn");
    const errorBox = $("addError");
    errorBox.hidden = true;
    const url = $("addUrlInput").value.trim();
    if (!url) {
      errorBox.textContent = "Paste the full address from the Riot tab first.";
      errorBox.hidden = false;
      return;
    }
    btn.classList.add("is-busy");
    try {
      const prev = new Set(S.accounts.map((a) => a.puuid));
      const data = await api("/api/accounts/add/complete", { method: "POST", json: { flowId: addFlowId, url }, timeoutMs: 45000 });
      closeAdd();
      await fetchAccounts();
      const fresh = S.accounts.find((a) => !prev.has(a.puuid));
      // A re-link of an existing account refreshes its data in place.
      for (const a of S.accounts) if (prev.has(a.puuid) && a.linked) forget(a.puuid);
      renderSidebar();
      warmAll();
      if (fresh) {
        toast(`${acctName(fresh)} added.`, "ok");
        go(acctHref(fresh.puuid));
      } else {
        toast("Account reconnected.", "ok");
        render();
      }
      if (data && data.hasRefreshToken === false) toast("Linked, but without a long-lived session. You may need to re-add it later.", "error");
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      btn.classList.remove("is-busy");
    }
  }

  function openImport() {
    closeMenu();
    closeSidebar();
    $("shareCodeInput").value = "";
    $("importError").hidden = true;
    $("importOverlay").hidden = false;
    $("shareCodeInput").focus();
  }
  function closeImport() {
    $("importOverlay").hidden = true;
  }

  async function importShared() {
    const btn = $("importBtn");
    const errorBox = $("importError");
    const code = $("shareCodeInput").value.trim();
    errorBox.hidden = true;
    if (!code) {
      errorBox.textContent = "Enter a share code.";
      errorBox.hidden = false;
      return;
    }
    btn.classList.add("is-busy");
    try {
      const data = await api("/api/shares/import", { method: "POST", json: { code } });
      closeImport();
      await fetchAccounts();
      renderSidebar();
      warmAll();
      const puuid = data.account && data.account.puuid;
      toast(`${(data.account && data.account.name) || "Shared account"} added to your list.`, "ok");
      if (puuid && findAcct(puuid)) go(acctHref(puuid));
      else render();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      btn.classList.remove("is-busy");
    }
  }

  /* ==========================================================================
     Wishlist
     ========================================================================== */

  let wlKind = "daily";
  let wlSearchTimer = null;
  let wlIndex = null;
  let wlIndexPromise = null;
  let wlIndexFailed = false;
  let wlRenderedKey = "";
  let wlRows = [];
  const wlOps = new Map();
  let wlFlushTimer = null;
  let wlFlushActive = false;

  function kindOfType(type) {
    if (type === "skin") return "daily";
    if (type === "buddy" || type === "spray" || type === "card" || type === "title") return "accessory";
    return null;
  }

  function wlKey(item) {
    return String((item && item.name) || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function isWishlisted(item) {
    if (!item) return false;
    const id = String(item.id || "");
    const key = wlKey(item);
    return [...S.wishlist.daily, ...S.wishlist.accessory].some((x) => String(x.id) === id || (key && wlKey(x) === key));
  }

  function setStarIcon(btn, on) {
    btn.replaceChildren(iconEl("star"));
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function makeStar(item) {
    if (!kindOfType(item.type)) return null;
    const on = isWishlisted(item);
    const btn = h("button", { class: "star-btn", type: "button", title: on ? "Remove from wishlist" : "Add to wishlist", "aria-label": on ? "Remove from wishlist" : "Add to wishlist", dataset: { itemId: String(item.id || ""), itemName: String(item.name || "") } });
    setStarIcon(btn, on);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isWishlisted(item)) removeWishlist(item);
      else addWishlist(item);
    });
    return btn;
  }

  function syncStars() {
    document.querySelectorAll(".star-btn").forEach((btn) => {
      const on = isWishlisted({ id: btn.dataset.itemId, name: btn.dataset.itemName });
      btn.title = on ? "Remove from wishlist" : "Add to wishlist";
      btn.setAttribute("aria-label", btn.title);
      setStarIcon(btn, on);
    });
  }

  function setWishlisted(item, want) {
    const kind = kindOfType(item.type);
    if (!kind) return;
    const id = String(item.id || "");
    const key = wlKey(item);
    const match = (x) => String(x.id) === id || (key && wlKey(x) === key);
    S.wishlist.daily = S.wishlist.daily.filter((x) => !match(x));
    S.wishlist.accessory = S.wishlist.accessory.filter((x) => !match(x));
    if (want) {
      S.wishlist[kind].unshift({ id: item.id, name: item.name, type: item.type, icon: item.icon || null, art: item.art || null, addedAt: Date.now() });
    }
    renderWishlistUI();
  }

  // All wishlist changes are coalesced into one debounced batch request. Only
  // the latest op per item matters and the batch is idempotent, so bursts of
  // clicks (or a refresh mid-flight) never lose the last change.
  function queueWlOp(item, op) {
    const id = String((item && item.id) || "");
    if (!id || !kindOfType(item.type)) return;
    wlOps.set(id, op);
    queueWlFlush();
  }
  function queueWlFlush() {
    if (wlFlushTimer) clearTimeout(wlFlushTimer);
    wlFlushTimer = setTimeout(() => {
      wlFlushTimer = null;
      flushWlOps();
    }, 250);
  }

  function reconcileWishlist(data) {
    const server = { daily: data.daily || [], accessory: data.accessory || [] };
    const ids = (w) => new Set([...w.daily, ...w.accessory].map((x) => String(x.id)));
    const a = ids(S.wishlist);
    const b = ids(server);
    if (a.size === b.size && [...a].every((x) => b.has(x))) return;
    S.wishlist = server;
    S.wlLoaded = true;
    renderWishlistUI();
  }

  async function flushWlOps() {
    if (wlFlushActive || !wlOps.size) return;
    wlFlushActive = true;
    const sent = new Map(wlOps);
    try {
      const data = await api("/api/wishlist/batch", { method: "POST", json: { ops: [...sent].map(([id, op]) => ({ id, op })) }, keepalive: true });
      for (const [id, op] of sent) if (wlOps.get(id) === op) wlOps.delete(id);
      if (!wlOps.size && data && data.daily) reconcileWishlist(data);
    } catch (err) {
      await loadWishlist().catch(() => {});
      toast(err.message || "Could not update your wishlist.", "error");
    } finally {
      wlFlushActive = false;
      if (wlOps.size) queueWlFlush();
    }
  }

  // Fire-and-forget flush for unload/background (sendBeacon or keepalive).
  function flushWlOpsNow() {
    if (wlFlushTimer) {
      clearTimeout(wlFlushTimer);
      wlFlushTimer = null;
    }
    if (!wlOps.size) return;
    const body = JSON.stringify({ ops: [...wlOps].map(([id, op]) => ({ id, op })) });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(path("/api/wishlist/batch"), new Blob([body], { type: "application/json" }))) return;
    } catch {
      /* fall through */
    }
    try {
      fetch(path("/api/wishlist/batch"), { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
    } catch {
      /* nothing more to do during unload */
    }
  }

  function addWishlist(item) {
    if (isWishlisted(item)) return;
    setWishlisted(item, true);
    queueWlOp(item, "add");
    toast(`${item.name || "Item"} added to your wishlist.`, "ok");
  }
  function removeWishlist(item) {
    if (!isWishlisted(item)) return;
    setWishlisted(item, false);
    queueWlOp(item, "remove");
  }

  async function loadWishlist() {
    const data = await api("/api/wishlist");
    S.wishlist = { daily: data.daily || [], accessory: data.accessory || [] };
    S.wlLoaded = true;
    renderWishlistUI();
  }

  function renderWishlistUI() {
    renderWishlistGrid();
    syncStars();
    refreshSearchRows();
    updateNav();
    renderSummary();
    const seg = document.querySelector("#wlSeg");
    if (seg) {
      seg.querySelectorAll("button").forEach((b) => {
        const n = b.querySelector(".n");
        if (n) n.textContent = String(S.wishlist[b.dataset.kind].length);
      });
    }
  }

  function refreshSearchRows() {
    document.querySelectorAll(".wl-result[data-item-id]").forEach((row) => {
      const on = isWishlisted({ id: row.dataset.itemId, name: row.dataset.itemName });
      row.classList.toggle("is-added", on);
      const tag = row.querySelector(".wl-result-tag");
      if (tag) tag.textContent = on ? "Added" : "Add";
    });
  }

  function renderWishlistView() {
    setTitle("Wishlist");
    const view = $("view");
    view.appendChild(
      h("div", { class: "page-head" },
        h("div", null, h("h1", { text: "Wishlist" }), h("p", { text: "Star items you want. Turn on wishlist alerts per account and get a DM the day one shows up in that account's shop." })))
    );
    const seg = h("div", { class: "seg", id: "wlSeg", role: "tablist" });
    for (const [kind, label] of [["daily", "Weapon skins"], ["accessory", "Accessories"]]) {
      seg.appendChild(h("button", {
        type: "button", role: "tab", class: wlKind === kind ? "is-active" : null, dataset: { kind },
        onclick: () => { wlKind = kind; closeWlResults(); render(); },
      }, label, h("span", { class: "n", text: String(S.wishlist[kind].length) })));
    }
    const input = h("input", { type: "search", id: "wlSearchInput", class: "input", placeholder: wlKind === "daily" ? "Search skins to add..." : "Search buddies, sprays, cards, titles...", autocomplete: "off", spellcheck: "false", "aria-label": "Search items" });
    const search = h("div", { class: "wl-search" }, h("label", { class: "search" }, iconEl("search"), input), h("div", { class: "wl-results", id: "wlResults", hidden: true }));
    view.appendChild(h("div", { class: "wl-bar" }, seg, search));
    view.appendChild(h("div", { class: "wl-grid", id: "wlGrid" }));
    view.appendChild(h("div", { id: "wlEmpty", hidden: true }));
    view.appendChild(
      h("div", { class: "tip wl-hint" }, iconEl("bell"),
        h("span", null, "Wishlist alerts are per account. Open an account's ", h("b", { text: "Alerts" }), " tab and turn on the wishlist switches."))
    );

    input.addEventListener("input", () => {
      if (wlSearchTimer) clearTimeout(wlSearchTimer);
      wlSearchTimer = setTimeout(runWlSearch, 90);
    });
    input.addEventListener("focus", () => {
      if (input.value.trim() && $("wlResults").hidden) runWlSearch();
      ensureWlIndex().catch(() => {});
    });
    renderWishlistGrid();
    ensureWlIndex().catch(() => {});
  }

  function renderWishlistGrid() {
    const grid = $("wlGrid");
    if (!grid) return;
    grid.innerHTML = "";
    const items = S.wishlist[wlKind] || [];
    for (const item of items) grid.appendChild(wishlistCard(item));
    const empty = $("wlEmpty");
    empty.innerHTML = "";
    if (!items.length) {
      empty.appendChild(
        h("div", { class: "empty-state" }, iconEl("star"), h("h3", { text: S.wlLoaded ? "Nothing here yet" : "Loading..." }),
          h("p", { text: "Search above to add items, or tap the star on anything in a shop." }))
      );
    }
    empty.hidden = items.length > 0;
  }

  function wishlistCard(item) {
    const thumb = h("div", { class: "wl-thumb" });
    const src = (item.type === "card" && item.art && item.art.small) || item.icon;
    if (src) thumb.appendChild(imgOrFallback(src, item.name));
    else if (item.type === "title") thumb.appendChild(h("span", { class: "title-text", text: titleName(item.name) }));
    else thumb.appendChild(fallbackText(item.name));
    const rm = h("button", { class: "wl-remove", type: "button", title: "Remove from wishlist", "aria-label": `Remove ${item.name || "item"} from wishlist` }, iconEl("x"));
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      removeWishlist(item);
    });
    const el = h("article", { class: "wl-card" }, thumb, rm, h("div", { class: "wl-card-name", text: item.name || "Unknown", title: item.name || "" }));
    if (canPreview(item)) previewTrigger(el, item);
    return el;
  }

  function closeWlResults() {
    const box = $("wlResults");
    if (box) {
      box.hidden = true;
      box.innerHTML = "";
    }
    wlRenderedKey = "";
    wlRows = [];
  }

  function ensureWlIndex() {
    if (wlIndex) return Promise.resolve(wlIndex);
    if (wlIndexPromise) return wlIndexPromise;
    wlIndexPromise = api("/api/items/index", { timeoutMs: 30000 })
      .then((data) => {
        wlIndex = (data.items || []).map((x) => ({ id: x.i, name: x.n, type: x.t, icon: x.c, art: x.a ? { small: x.a.s, wide: x.a.w, large: x.a.l } : null }));
        wlIndexFailed = false;
        return wlIndex;
      })
      .catch((err) => {
        wlIndexPromise = null;
        wlIndexFailed = true;
        throw err;
      });
    return wlIndexPromise;
  }

  function filterWlIndex(q) {
    const nq = q.toLowerCase();
    const out = [];
    for (const item of wlIndex) {
      if ((item.type === "skin" ? "daily" : "accessory") !== wlKind) continue;
      if (nq && !String(item.name || "").toLowerCase().includes(nq)) continue;
      out.push(item);
    }
    if (nq) {
      out.sort((a, b) => {
        const an = String(a.name || "").toLowerCase();
        const bn = String(b.name || "").toLowerCase();
        return (an.startsWith(nq) ? 0 : 1) - (bn.startsWith(nq) ? 0 : 1) || an.localeCompare(bn);
      });
    }
    return out;
  }

  const WL_RENDER_CAP = 300;

  function wlResultRow(item) {
    const added = isWishlisted(item);
    const row = h("button", { type: "button", class: added ? "wl-result is-added" : "wl-result", dataset: { itemId: String(item.id || ""), itemName: String(item.name || "") } });
    const src = (item.type === "card" && item.art && item.art.small) || item.icon;
    row.appendChild(src ? makeImg(src, "") : h("span", { class: "wl-result-thumb" }, iconEl("star")));
    row.appendChild(h("span", { class: "wl-result-name", text: item.name || "Unknown" }));
    row.appendChild(h("span", { class: "wl-result-tag", text: added ? "Added" : "Add" }));
    row.addEventListener("click", () => {
      if (isWishlisted(item)) removeWishlist(item);
      else addWishlist(item);
    });
    return row;
  }

  function renderWlResults(items) {
    const box = $("wlResults");
    if (!box) return;
    box.innerHTML = "";
    wlRows = [];
    if (!items.length) {
      box.appendChild(h("div", { class: "wl-result empty-row", text: "No matching items." }));
      box.hidden = false;
      return;
    }
    const shown = items.length > WL_RENDER_CAP ? items.slice(0, WL_RENDER_CAP) : items;
    const frag = document.createDocumentFragment();
    for (const item of shown) {
      const row = wlResultRow(item);
      wlRows.push(row);
      frag.appendChild(row);
    }
    box.appendChild(frag);
    if (items.length > WL_RENDER_CAP) box.appendChild(h("div", { class: "wl-result wl-more", text: `Showing ${WL_RENDER_CAP} of ${items.length}, keep typing to narrow.` }));
    box.hidden = false;
  }

  async function runWlSearch() {
    const input = $("wlSearchInput");
    if (!input) return;
    const q = input.value.trim();
    if (!q) {
      closeWlResults();
      return;
    }
    const key = `${wlKind}|${q}`;
    if (key === wlRenderedKey) return;
    if (!wlIndex && !wlIndexFailed) {
      const box = $("wlResults");
      box.innerHTML = "";
      box.appendChild(h("div", { class: "wl-result empty-row", text: "Loading items..." }));
      box.hidden = false;
      try {
        await ensureWlIndex();
      } catch {
        /* fall back to server search */
      }
    }
    if (!$("wlSearchInput") || $("wlSearchInput").value.trim() !== q) return;
    if (!wlIndex) {
      try {
        const data = await api(`/api/items/search?q=${encodeURIComponent(q)}&kind=${wlKind}`);
        if ($("wlSearchInput") && $("wlSearchInput").value.trim() === q) renderWlResults(data.results || []);
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    renderWlResults(filterWlIndex(q));
    wlRenderedKey = key;
  }

  function moveWlActive(dir) {
    if (!wlRows.length) return;
    let idx = wlRows.findIndex((r) => r.classList.contains("is-active"));
    idx = idx < 0 ? (dir > 0 ? 0 : wlRows.length - 1) : idx + dir;
    idx = Math.max(0, Math.min(wlRows.length - 1, idx));
    wlRows.forEach((r, i) => r.classList.toggle("is-active", i === idx));
    wlRows[idx].scrollIntoView({ block: "nearest" });
  }

  /* ==========================================================================
     Item preview
     ========================================================================== */

  const PREVIEW_TYPES = new Set(["skin", "card"]);
  const previewCache = new Map();

  function canPreview(item) {
    return Boolean(item && PREVIEW_TYPES.has(item.type) && item.id);
  }

  function previewTrigger(el, item) {
    el.classList.add("is-previewable");
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    if (!el.title) el.title = `Preview ${item.name || "item"}`;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".star-btn") || e.target.closest(".wl-remove")) return;
      openPreview(item);
    });
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPreview(item);
      }
    });
  }

  async function previewData(item) {
    const id = String(item.id);
    if (previewCache.has(id)) return previewCache.get(id);
    if (item.type === "card" && item.art && (item.art.small || item.art.wide || item.art.large)) {
      previewCache.set(id, { art: item.art });
      return previewCache.get(id);
    }
    const data = await api(`/api/item?id=${encodeURIComponent(item.id)}`);
    previewCache.set(id, data.item || {});
    return previewCache.get(id);
  }

  // Warm previews for what the user is looking at (shops, bundles), a few at a
  // time. Not run for the wishlist or collection: those can hold hundreds.
  function prefetchPreviews(items) {
    const seen = new Set();
    const targets = [];
    for (const it of items || []) {
      if (!canPreview(it)) continue;
      const id = String(it.id);
      if (seen.has(id) || previewCache.has(id)) continue;
      seen.add(id);
      targets.push(it);
    }
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const it = targets[i++];
        await previewData(it).catch(() => {});
      }
    };
    Promise.all([worker(), worker(), worker()]).catch(() => {});
  }

  async function openPreview(item) {
    if (!canPreview(item)) return;
    $("previewTitle").textContent = item.name || "Item";
    const body = $("previewBody");
    body.innerHTML = "";
    body.appendChild(h("div", { class: "preview-stage sk" }));
    $("previewOverlay").hidden = false;
    let data;
    try {
      data = await previewData(item);
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(h("p", { class: "preview-empty", text: err.message || "Could not load this preview." }));
      return;
    }
    if ($("previewOverlay").hidden) return;
    if (item.type === "card") renderCardPreview(data);
    else renderSkinPreview(item, data);
  }

  function renderSkinPreview(item, data) {
    const body = $("previewBody");
    body.innerHTML = "";
    const chromas = (data.chromas || []).filter((c) => c && c.render);
    const stageImg = makeImg((chromas[0] && chromas[0].render) || data.render || item.icon || "", item.name || "Item", (img) => img.replaceWith(fallbackText(item.name)));
    stageImg.loading = "eager";
    body.appendChild(h("div", { class: "preview-stage" }, stageImg));
    if (chromas.length > 1) {
      const row = h("div", { class: "preview-swatches" });
      const buttons = [];
      chromas.forEach((c, i) => {
        const b = h("button", { type: "button", class: `preview-swatch${i === 0 ? " is-active" : ""}`, title: c.name || "Chroma", "aria-label": c.name || "Chroma" }, makeImg(c.swatch || c.render, ""));
        b.addEventListener("click", () => {
          stageImg.src = c.render;
          buttons.forEach((x) => x.classList.remove("is-active"));
          b.classList.add("is-active");
        });
        buttons.push(b);
        row.appendChild(b);
      });
      body.appendChild(h("div", null, h("h3", { class: "preview-heading", text: `Chromas (${chromas.length})` }), row));
    }
  }

  function renderCardPreview(data) {
    const body = $("previewBody");
    body.innerHTML = "";
    const art = (data && data.art) || {};
    if (!art.large && !art.small && !art.wide) {
      body.appendChild(h("p", { class: "preview-empty", text: "No artwork available for this card." }));
      return;
    }
    const frame = (label, src, cls) => h("div", { class: `preview-frame${cls ? ` ${cls}` : ""}` }, h("span", { text: label }), makeImg(src, label));
    // Tall art on the left is sized to the right column's height (banner +
    // icon row), so the three images sit flush with little empty space.
    const left = h("div", { class: "preview-col" });
    const tall = art.large ? frame("In game", art.large, "is-tall") : null;
    if (tall) left.appendChild(tall);
    const right = h("div", { class: "preview-col" });
    if (art.wide) right.appendChild(frame("Banner", art.wide));
    if (art.small) right.appendChild(frame("Icon", art.small, "is-small"));
    body.appendChild(h("div", { class: "preview-displays" }, left, right));
    if (tall && typeof ResizeObserver !== "undefined") {
      const img = tall.querySelector("img");
      const label = tall.querySelector("span");
      const fit = () => {
        if (window.innerWidth < 720) {
          img.style.height = "";
          return;
        }
        const chrome = 24 + 8 + label.offsetHeight + 2;
        img.style.height = `${Math.max(160, right.offsetHeight - chrome)}px`;
      };
      new ResizeObserver(fit).observe(right);
      fit();
    }
  }

  function closePreview() {
    $("previewOverlay").hidden = true;
    $("previewBody").innerHTML = "";
  }

  /* ==========================================================================
     Bundles
     ========================================================================== */

  function loadBundles(force) {
    if (!force && S.bundles) return Promise.resolve(S.bundles);
    if (!force && S.bundlesPending) return S.bundlesPending;
    S.bundlesError = null;
    S.bundlesPending = api("/api/bundles", { timeoutMs: 30000 })
      .then((data) => {
        S.bundles = data.bundles || [];
        return S.bundles;
      })
      .catch((err) => {
        S.bundlesError = err.message || "Could not load bundles.";
        throw err;
      })
      .finally(() => {
        S.bundlesPending = null;
        if (S.route.name === "bundles") render();
        else updateNav();
        scheduleAutoRefresh();
      });
    return S.bundlesPending;
  }

  function renderBundlesView() {
    setTitle("Bundles");
    const view = $("view");
    view.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Featured bundles" }), h("p", { text: "What is in the store right now and how long it stays. The same for every account." }))));
    if (!S.bundles) {
      if (S.bundlesError && !S.bundlesPending) {
        view.appendChild(h("div", { class: "empty-state" }, iconEl("alert"), h("h3", { text: "Could not load bundles" }), h("p", { text: S.bundlesError }),
          h("button", { class: "btn btn-ghost", type: "button", onclick: () => loadBundles(true).catch(() => {}) }, iconEl("refresh"), "Try again")));
        return;
      }
      const list = h("div", { class: "bundle-list" });
      for (let i = 0; i < 2; i++) list.appendChild(h("div", { class: "bundle-card" }, h("div", { class: "bundle-banner sk", style: "border-radius:0" }), h("div", { class: "bundle-items" }, ...Array.from({ length: 4 }, () => h("div", { class: "sk", style: "height:110px" })))));
      view.appendChild(list);
      loadBundles().catch(() => {});
      return;
    }
    if (!S.bundles.length) {
      view.appendChild(h("div", { class: "empty-state" }, iconEl("layers"), h("h3", { text: "No featured bundles" }), h("p", { text: "Nothing is in rotation right now." })));
      return;
    }
    const list = h("div", { class: "bundle-list" });
    for (const b of S.bundles) list.appendChild(bundleCard(b));
    view.appendChild(list);
    prefetchPreviews(S.bundles.flatMap((b) => b.items || []));
  }

  function bundleItemEl(it) {
    const thumb = h("div", { class: "bundle-item-thumb" });
    const src = (it.type === "card" && it.art && it.art.small) || it.icon;
    if (src) thumb.appendChild(imgOrFallback(src, it.name));
    else thumb.appendChild(fallbackText(it.type === "title" ? titleName(it.name) : it.name, 3));
    const el = h("div", { class: "bundle-item" }, thumb, h("div", { class: "bundle-item-name", text: it.type === "title" ? titleName(it.name) : it.name || "Unknown", title: it.name || "" }));
    // Item prices are shown at their base value only: the bundle discount is a
    // whole-bundle deal, so per-item strike-throughs would mislead.
    const priceVal = it.base != null ? it.base : it.disc;
    if (priceVal != null) el.appendChild(h("div", { class: "bundle-item-price" }, makeImg(CURRENCY_ICON.vp, "VP"), fmt(priceVal)));
    if (canPreview(it)) previewTrigger(el, it);
    return el;
  }

  function bundleCard(b) {
    const banner = h("div", { class: "bundle-banner" });
    if (b.art) banner.appendChild(h("img", { class: "bundle-banner-img", src: b.art, alt: "", loading: "lazy" }));
    const rawName = b.name || "Featured Bundle";
    const meta = h("div", { class: "bundle-meta" });
    if (b.after != null || b.before != null) {
      const price = h("span", { class: "bundle-price" }, makeImg(CURRENCY_ICON.vp, "VP"));
      if (b.after != null && b.before != null && b.after < b.before) price.appendChild(h("span", { class: "old", text: fmt(b.before) }));
      price.appendChild(h("span", { text: fmt(b.after != null ? b.after : b.before) }));
      meta.appendChild(price);
    }
    if (b.percent) meta.appendChild(h("span", { class: "bundle-off", text: `-${b.percent}%` }));
    if (b.leavesAt) meta.appendChild(h("span", { class: "bundle-countdown" }, iconEl("clock"), countdownEl(b.leavesAt, "", "", " left")));
    banner.appendChild(h("div", { class: "bundle-info" }, h("h3", { class: "bundle-title", text: /bundle$/i.test(rawName) ? rawName : `${rawName} Bundle` }), meta));
    const card = h("article", { class: "bundle-card" }, banner);
    if (b.items && b.items.length) {
      const items = h("div", { class: "bundle-items" });
      for (const it of b.items) items.appendChild(bundleItemEl(it));
      card.appendChild(items);
    }
    return card;
  }

  /* ==========================================================================
     Settings
     ========================================================================== */

  function renderSettingsView() {
    setTitle("Settings");
    const view = $("view");
    view.appendChild(h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Settings" }), h("p", { text: "Global alerts, account order and the Discord app." }))));
    const grid = h("div", { class: "settings-grid" });
    const left = h("div");
    const right = h("div");
    grid.appendChild(left);
    grid.appendChild(right);
    view.appendChild(grid);

    // Global alerts
    left.appendChild(h("div", { class: "section-title", text: "Global alerts" }));
    left.appendChild(
      h("div", { class: "rows" },
        h("div", { class: "row" }, iconEl("moon"), h("div", { class: "row-text" }, h("b", { text: "Night Market opens" }), h("span", { text: "One DM when the Night Market starts, for your main account." })),
          switchEl(S.prefs.nm, "Night Market alerts", (on) => { S.prefs.nm = on; patchPrefs({ nm: on }).then(() => toast(`Night Market alerts ${on ? "on" : "off"}.`, "ok"), () => {}); })),
        h("div", { class: "row" }, iconEl("layers"), h("div", { class: "row-text" }, h("b", { text: "New bundles" }), h("span", { text: "A DM the moment a new bundle hits the store." })),
          switchEl(S.prefs.bundle, "New bundle alerts", (on) => { S.prefs.bundle = on; patchPrefs({ bundle: on }).then(() => toast(`New bundle alerts ${on ? "on" : "off"}.`, "ok"), () => {}); })))
    );
    left.appendChild(h("p", { class: "faint", style: "font-size:12.5px;margin:8px 2px 0", text: "Shop and wishlist alerts are per account, in each account's Alerts tab." }));

    // Account order
    const accts = ordered();
    left.appendChild(h("div", { class: "section-title", style: "margin-top:26px" }, h("span", { text: "Account order" }), h("span", { class: "count", text: String(accts.length) })));
    if (!accts.length) left.appendChild(h("p", { class: "muted", text: "No accounts yet." }));
    else {
      const rows = h("div", { class: "rows", id: "orderRows" });
      accts.forEach((a, i) => {
        rows.appendChild(
          h("div", { class: "row order-row", dataset: { puuid: a.puuid } },
            h("span", { class: "grip", title: "Drag to reorder", "aria-hidden": "true" }, iconEl("grip")),
            emblemEl(a),
            h("div", { class: "row-text" }, h("b", null, nameNodes(acctName(a))), h("span", { text: a.shared ? "Shared with you" : a.is_default ? "Main account" : (a.shard || "").toUpperCase() })),
            h("div", { class: "order-btns" },
              h("button", { class: "icon-btn sm", type: "button", "aria-label": `Move ${acctName(a)} up`, disabled: i === 0, onclick: () => moveAccount(a.puuid, -1) }, iconEl("chevron-up")),
              h("button", { class: "icon-btn sm", type: "button", "aria-label": `Move ${acctName(a)} down`, disabled: i === accts.length - 1, onclick: () => moveAccount(a.puuid, 1) }, iconEl("chevron-down"))))
        );
      });
      left.appendChild(rows);
      makeSortable(rows, ".order-row", reorderByIndex);
      left.appendChild(h("p", { class: "faint", style: "font-size:12.5px;margin:8px 2px 0", text: "This order is used in the sidebar, the overview and the account picker of Discord commands." }));
    }

    // Discord
    right.appendChild(h("div", { class: "section-title", text: "Discord app" }));
    right.appendChild(
      h("div", { class: "rows" },
        h("div", { class: "row" }, iconEl("terminal"), h("div", { class: "row-text" }, h("b", { text: "Add valorant shop to Discord" }), h("span", { text: "Needed for slash commands and DMs." })),
          h("div", { class: "page-actions" },
            h("button", { class: "btn sm", type: "button", onclick: () => openInstall("user") }, "Add App"),
            h("button", { class: "btn btn-ghost sm", type: "button", onclick: () => openInstall("guild") }, "Server"))))
    );
    const cmds = [
      ["/shop", "Daily shop of an account"],
      ["/accessories", "Weekly accessory shop"],
      ["/nightmarket", "Night Market offers"],
      ["/bundle", "Featured bundles"],
      ["/rank", "Rank card with peak and level"],
      ["/collection", "Owned skins and accessories"],
      ["/share code", "Show or create a share code"],
      ["/share import", "Add an account shared with you"],
      ["/share stop", "Stop sharing an account"],
      ["/main", "Change your main account"],
      ["/link", "Open this dashboard"],
    ];
    right.appendChild(h("div", { class: "rows", style: "margin-top:8px" }, h("ul", { class: "cmd-list" }, cmds.map(([c, d]) => h("li", null, h("code", { text: c }), h("span", { text: d }))))));

    // Your data + about
    right.appendChild(h("div", { class: "section-title", style: "margin-top:26px", text: "Your data" }));
    right.appendChild(
      h("div", { class: "rows" },
        h("div", { class: "row" }, iconEl("trash"), h("div", { class: "row-text" }, h("b", { text: "Delete all my data" }), h("span", { text: "Removes your accounts, alerts, wishlist and shares. Cannot be undone." })),
          h("button", { class: "btn btn-danger sm", type: "button", onclick: openWipe }, "Delete")))
    );
    const about = h("div", { class: "rows", style: "margin-top:8px" });
    const statsRow = h("div", { class: "about-stats" });
    if (S.stats) {
      statsRow.appendChild(h("div", null, h("b", { text: fmt(S.stats.users) }), h("span", { text: "Website users" })));
      statsRow.appendChild(h("div", null, h("b", { text: fmt(S.stats.accounts) }), h("span", { text: "Riot accounts" })));
    }
    statsRow.appendChild(h("div", null, h("b", { class: "mono", text: loadedVersion() ? `v${loadedVersion()}` : "-" }), h("span", { text: "Version" })));
    about.appendChild(statsRow);
    right.appendChild(about);
  }

  function avatarEl() {
    const box = h("span", { class: "avatar" });
    const me = S.me || {};
    if (me.avatar && me.discordId) box.appendChild(h("img", { src: `https://cdn.discordapp.com/avatars/${me.discordId}/${me.avatar}.png?size=64`, alt: "" }));
    else box.textContent = (me.username || "?").slice(0, 1).toUpperCase();
    return box;
  }

  function openInstall(kind) {
    const url = kind === "guild" ? S.install.guildInstall : S.install.userInstall;
    if (url) window.open(url, "_blank", "noopener");
    else toast("Install links are still loading. Try again in a moment.");
  }

  function openWipe() {
    $("wipeInput").value = "";
    $("wipeBtn").disabled = true;
    $("wipeError").hidden = true;
    $("wipeOverlay").hidden = false;
    $("wipeInput").focus();
  }
  function closeWipe() {
    $("wipeOverlay").hidden = true;
  }
  async function doWipe() {
    const btn = $("wipeBtn");
    const errorBox = $("wipeError");
    if ($("wipeInput").value.trim() !== "DELETE") return;
    errorBox.hidden = true;
    btn.classList.add("is-busy");
    btn.disabled = true;
    try {
      await api("/api/me/delete", { method: "POST", json: { confirm: "DELETE" } });
      history.replaceState({}, "", path("/"));
      location.reload();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      btn.classList.remove("is-busy");
      btn.disabled = false;
    }
  }

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => null);
    history.replaceState({}, "", path("/"));
    location.reload();
  }

  /* ==========================================================================
     Ticker + auto refresh
     ========================================================================== */

  let tickerTimer = null;
  let expiredKick = 0;
  function startTicker() {
    if (tickerTimer) return;
    tickerTimer = setInterval(() => {
      const now = Date.now();
      let expired = false;
      document.querySelectorAll("[data-until]").forEach((el) => {
        const at = Number(el.dataset.until);
        if (!at) return;
        const left = at - now;
        if (left <= 0) {
          el.textContent = "Refreshing...";
          expired = true;
        } else {
          el.textContent = `${el.dataset.prefix || ""}${fmtCountdown(left)}${el.dataset.suffix || ""}`;
        }
      });
      if (expired && now - expiredKick > 20000) {
        expiredKick = now;
        setTimeout(runAutoRefresh, 4000);
      }
    }, 1000);
  }

  // The server caches each store until its rotation instant, so polling is
  // cheap before a reset and only hits Riot once it actually happened. We
  // refresh just after the next known rotation and keep showing old data until
  // fresh data arrives.
  let autoTimer = null;
  let refreshing = false;
  let lastRefreshAt = 0;

  function storeSig(store) {
    if (!store) return "";
    const part = (b) => (b && b.items ? `${b.expiresAt || 0}:${b.items.map((i) => i.id + (i.owned ? "*" : "")).join(",")}` : "");
    const w = store.wallet || {};
    return [part(store.daily), part(store.kingdomShop), part(store.nightMarket), `${w.vp}|${w.rp}|${w.kc}`].join("~");
  }

  function nextExpiry() {
    const now = Date.now();
    let min = 0;
    const consider = (at) => {
      if (at && at > now && (min === 0 || at < min)) min = at;
    };
    for (const a of S.accounts) {
      const s = S.store[a.puuid];
      if (!s) continue;
      consider(s.daily && s.daily.expiresAt);
      consider(s.kingdomShop && s.kingdomShop.expiresAt);
      consider(s.nightMarket && s.nightMarket.expiresAt);
    }
    for (const b of S.bundles || []) consider(b.leavesAt);
    return min;
  }

  function scheduleAutoRefresh() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    const at = nextExpiry();
    let delay;
    if (at) delay = Math.min(Math.max(8000, at - Date.now() + 5000), 30 * 60 * 1000);
    else if (S.accounts.some((a) => a.linked && !S.store[a.puuid])) delay = 20000;
    else if (S.accounts.some((a) => a.linked)) delay = 5 * 60 * 1000;
    else return;
    autoTimer = setTimeout(runAutoRefresh, delay);
  }

  async function runAutoRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const targets = S.accounts.filter((a) => a.linked);
      await Promise.allSettled(
        targets.map((a) =>
          api(`/api/shop?puuid=${encodeURIComponent(a.puuid)}`, { timeoutMs: 35000 }).then((d) => {
            const changed = storeSig(S.store[a.puuid]) !== storeSig(d.store);
            S.store[a.puuid] = d.store || null;
            delete S.storeError[a.puuid];
            if (changed) onStore(a.puuid);
          })
        )
      );
      if (S.bundles) {
        const before = JSON.stringify((S.bundles || []).map((b) => [b.id, b.leavesAt]));
        const data = await api("/api/bundles").catch(() => null);
        if (data) {
          S.bundles = data.bundles || [];
          if (before !== JSON.stringify(S.bundles.map((b) => [b.id, b.leavesAt])) && S.route.name === "bundles") render();
        }
      }
    } finally {
      refreshing = false;
      lastRefreshAt = Date.now();
      scheduleAutoRefresh();
    }
  }

  /* ==========================================================================
     Version heartbeat
     ========================================================================== */

  const VERSION_HEARTBEAT_MS = 60000;

  function loadedVersion() {
    const el = document.querySelector('script[src*="dashboard.js"]');
    const found = el && el.getAttribute("src").match(/[?&]v=(\d+)/);
    return found ? found[1] : "";
  }

  function unsetUpdateBust() {
    const url = new URL(location.href);
    if (!url.searchParams.has("_u")) return;
    url.searchParams.delete("_u");
    const query = url.searchParams.toString();
    history.replaceState({}, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
  }

  async function checkForUpdate() {
    try {
      const data = await api("/api/version");
      const live = data && data.version ? String(data.version) : "";
      const current = loadedVersion();
      if (!/^\d+$/.test(live) || !/^\d+$/.test(current)) return;
      if (Number(live) > Number(current)) {
        $("updateVer").textContent = `v${live}`;
        $("updatePill").hidden = false;
      } else if (live === current) $("updatePill").hidden = true;
    } catch {
      /* offline: next heartbeat retries */
    }
  }

  function startVersionWatch() {
    const current = loadedVersion();
    $("footVer").textContent = current ? `v${current}` : "";
    $("updateBtn").addEventListener("click", () => {
      const url = new URL(location.href);
      url.searchParams.set("_u", String(Date.now()));
      location.replace(`${url.pathname}?${url.searchParams.toString()}${url.hash}`);
    });
    checkForUpdate();
    setInterval(checkForUpdate, VERSION_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    window.addEventListener("online", checkForUpdate);
  }

  /* ==========================================================================
     Boot
     ========================================================================== */

  function showLanding() {
    $("splash").hidden = true;
    $("app").hidden = true;
    $("landing").hidden = false;
  }

  function renderMe() {
    const me = S.me || {};
    const box = $("meAvatar");
    box.replaceWith(Object.assign(avatarEl(), { id: "meAvatar" }));
    $("meName").textContent = me.username || "Signed in";
  }

  async function loadInstallLinks() {
    try {
      const data = await api("/api/install");
      S.install = data;
      if (data.userInstall) $("installLink").href = data.userInstall;
      if (data.guildInstall) $("guildInstallLink").href = data.guildInstall;
    } catch {
      /* install buttons stay inert */
    }
  }

  function wireStatic() {
    $("menuBtn").addEventListener("click", openSidebar);
    $("sidebarClose").addEventListener("click", closeSidebar);
    $("scrim").addEventListener("click", closeSidebar);
    $("sbAddBtn").addEventListener("click", (e) => openMenu(e.currentTarget, addMenuEntries()));
    $("signOutBtn").addEventListener("click", signOut);
    $("installBtn").addEventListener("click", () => openInstall("user"));

    $("addCancelBtn").addEventListener("click", closeAdd);
    $("addCancelX").addEventListener("click", closeAdd);
    $("addCompleteBtn").addEventListener("click", completeAdd);
    $("addUrlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") completeAdd(); });
    $("addOpenBtn").addEventListener("click", (e) => {
      const btn = $("addOpenBtn");
      if (btn.getAttribute("aria-disabled") === "true") e.preventDefault();
      else if (btn.textContent === "Try again") {
        e.preventDefault();
        prepareAddLink();
      }
    });
    onBackdrop($("addOverlay"), closeAdd);

    $("importBtn").addEventListener("click", importShared);
    $("importCancelBtn").addEventListener("click", closeImport);
    $("importCancelX").addEventListener("click", closeImport);
    $("shareCodeInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        importShared();
      }
    });
    onBackdrop($("importOverlay"), closeImport);

    $("confirmOk").addEventListener("click", () => closeConfirm(true));
    $("confirmCancel").addEventListener("click", () => closeConfirm(false));
    onBackdrop($("confirmOverlay"), () => closeConfirm(false));

    $("wipeInput").addEventListener("input", () => { $("wipeBtn").disabled = $("wipeInput").value.trim() !== "DELETE"; });
    $("wipeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doWipe(); });
    $("wipeBtn").addEventListener("click", doWipe);
    $("wipeCancelBtn").addEventListener("click", closeWipe);
    $("wipeCancelX").addEventListener("click", closeWipe);
    onBackdrop($("wipeOverlay"), closeWipe);

    $("previewClose").addEventListener("click", closePreview);
    onBackdrop($("previewOverlay"), closePreview);

    makeSortable($("sbAccounts"), ".sb-acct", reorderByIndex);

    document.addEventListener("pointerdown", (e) => {
      if (menuEl && !menuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu();
      const box = $("wlResults");
      if (box && !box.hidden && !e.target.closest(".wl-search")) closeWlResults();
    });
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, { passive: true });

    document.addEventListener("keydown", (e) => {
      const box = $("wlResults");
      if (box && !box.hidden) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveWlActive(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (e.key === "Enter" && document.activeElement === $("wlSearchInput")) {
          const active = document.querySelector(".wl-result.is-active");
          if (active) {
            e.preventDefault();
            active.click();
            return;
          }
        }
      }
      if (e.key !== "Escape") return;
      if (menuEl) closeMenu();
      else if (!$("confirmOverlay").hidden) closeConfirm(false);
      else if (!$("wipeOverlay").hidden) closeWipe();
      else if (!$("previewOverlay").hidden) closePreview();
      else if (!$("importOverlay").hidden) closeImport();
      else if (!$("addOverlay").hidden) closeAdd();
      else if (box && !box.hidden) closeWlResults();
      else if ($("sidebar").classList.contains("is-open")) closeSidebar();
    });

    // Lock page scroll while a modal is open. scrollbar-gutter keeps the
    // layout from shifting when the scrollbar comes and goes.
    const lock = () => {
      const locked = Boolean(document.querySelector(".overlay:not([hidden])")) || $("sidebar").classList.contains("is-open");
      document.documentElement.style.overflow = locked ? "hidden" : "";
    };
    const observer = new MutationObserver(lock);
    document.querySelectorAll(".overlay").forEach((o) => observer.observe(o, { attributes: true, attributeFilter: ["hidden"] }));
    observer.observe($("sidebar"), { attributes: true, attributeFilter: ["class"] });

    window.addEventListener("popstate", render);
    window.addEventListener("hashchange", () => { if (adoptLegacyHash()) render(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushWlOpsNow();
      else if (Date.now() - lastRefreshAt > 60000 && S.me) runAutoRefresh();
    });
    window.addEventListener("pagehide", flushWlOpsNow);
  }

  async function init() {
    wireStatic();
    loadInstallLinks();
    api("/api/stats").then((d) => { if (d && d.ok) S.stats = d; }).catch(() => {});

    let me = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        me = await api("/api/me");
        break;
      } catch (e) {
        me = null;
        if (attempt === 0) {
          $("splashText").textContent = "Reconnecting...";
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    }
    if (!me || !me.authorized) {
      showLanding();
      return;
    }
    S.me = me;
    renderMe();
    $("splashText").textContent = "Loading accounts...";

    const wishlistReady = loadWishlist().catch((err) => toast(err.message, "error"));
    try {
      await fetchAccounts();
    } catch (err) {
      if (err.status === 401) {
        showLanding();
        return;
      }
      toast(err.message || "Could not load your accounts.", "error");
    }

    // Show the app as soon as the account list is in. Shops, ranks and bundles
    // stream in behind skeletons, so a slow Riot call never holds first paint.
    $("splash").hidden = true;
    $("app").hidden = false;
    $("installBtn").hidden = false;
    renderSidebar();
    render();
    startTicker();
    warmAll();
    wishlistReady.then(() => updateNav());
    loadBundles().catch(() => {});
    scheduleAutoRefresh();
  }

  adoptLegacyHash();
  unsetUpdateBust();
  startVersionWatch();
  init().catch((err) => {
    // Never leave the splash up forever: fall back to the sign-in screen.
    console.error(err);
    showLanding();
  });
})();
