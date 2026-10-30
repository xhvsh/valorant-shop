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
  // Riot's content tier icons (valorant-api.com), keyed like TIER_COLORS.
  const TIER_ICON_IDS = {
    select: "12683d76-48d7-84a3-4e09-6985794f0445",
    deluxe: "0cebb8be-46d7-c12a-d306-e9907bfc5a25",
    premium: "60bca009-4182-7998-dee7-b8a2558dc369",
    exclusive: "e046854e-406c-37f4-6607-19a9ba8426fc",
    ultra: "411e4a55-4e59-7757-41f0-86a53f101bb5",
  };
  // The tier as its icon, with the name as tooltip and accessible label. Null for
  // items without a known tier.
  function tierIconEl(tier) {
    const key = String(tier || "").toLowerCase().replace(/\s*edition/gi, "").trim();
    const id = TIER_ICON_IDS[key];
    if (!id) return null;
    const name = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    return h("img", { class: "tier-icon", src: `https://media.valorant-api.com/contenttiers/${id}/displayicon.png`, alt: name, title: name, loading: "lazy", decoding: "async" });
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
  // Confirmation dialog. Optional extras: an icon (danger defaults to an alert), a
  // `subject` node shown in a card under the title (e.g. the account), and
  // `points`, a list of what will happen. Destructive dialogs focus Cancel.
  function confirmDialog({ title, message, okLabel = "Confirm", danger = false, icon, subject, points }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $("confirmTitle").textContent = title;
      $("confirmMessage").textContent = message || "";
      $("confirmMessage").hidden = !message;
      const iconBox = $("confirmIcon");
      const iconName = icon || (danger ? "alert" : null);
      iconBox.hidden = !iconName;
      iconBox.className = `dlg-icon${danger ? " is-danger" : ""}`;
      iconBox.replaceChildren(...(iconName ? [iconEl(iconName)] : []));
      const subjectBox = $("confirmSubject");
      subjectBox.hidden = !subject;
      subjectBox.replaceChildren(...(subject ? [subject] : []));
      const list = $("confirmPoints");
      list.hidden = !(points && points.length);
      list.replaceChildren(...(points || []).map((t) => h("li", { text: t })));
      const ok = $("confirmOk");
      ok.textContent = okLabel;
      ok.classList.toggle("btn-danger", danger);
      showOverlay($("confirmOverlay"));
      (danger ? $("confirmCancel") : ok).focus();
    });
  }
  /* ---------- dialog open / close animation ---------- */

  const CLOSE_MS = 240;
  const isTouchLayout = () => window.matchMedia("(max-width: 719px), (pointer: coarse)").matches;
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isClosing = (el) => el.classList.contains("is-closing");

  function showOverlay(el) {
    clearTimeout(el._closeTimer);
    el._closeTimer = null;
    resetSheet(el);
    el.classList.remove("is-closing");
    el.hidden = false;
  }

  // Plays the close animation, then hides the overlay and runs `done`.
  function hideOverlay(el, done) {
    if (el.hidden || isClosing(el)) return;
    const finish = () => {
      el._closeTimer = null;
      el.hidden = true;
      el.classList.remove("is-closing");
      resetSheet(el);
      if (done) done();
    };
    if (reducedMotion()) return finish();
    el.classList.add("is-closing");
    el._closeTimer = setTimeout(finish, CLOSE_MS);
  }

  function resetSheet(el) {
    const modal = el.querySelector(".modal");
    if (modal) {
      modal.style.transform = "";
      modal.style.transition = "";
      modal.style.removeProperty("--drag");
    }
    el.style.backgroundColor = "";
    el.style.backdropFilter = "";
    el.style.webkitBackdropFilter = "";
  }

  // Phone sheets: pull the sheet down by its top (or anywhere once its content is
  // scrolled to the top). Past a third of its height, or flicked, it slides away;
  // a shorter pull springs back.
  function initSheetDrag(overlay, close) {
    const modal = overlay.querySelector(".modal");
    if (!modal) return;
    let startY = 0;
    let lastY = 0;
    let startT = 0;
    let tracking = false;
    let dragging = false;
    const offset = () => Math.max(0, lastY - startY);

    modal.addEventListener("touchstart", (e) => {
      tracking = e.touches.length === 1 && !isClosing(overlay) && window.matchMedia("(max-width: 719px)").matches && modal.scrollTop <= 0;
      dragging = false;
      startY = lastY = e.touches[0].clientY;
      startT = Date.now();
    }, { passive: true });

    modal.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      lastY = e.touches[0].clientY;
      const dy = lastY - startY;
      if (!dragging) {
        if (dy < -6 || modal.scrollTop > 0) {
          tracking = false;
          return;
        }
        if (dy < 6) return;
        dragging = true;
        modal.style.transition = "none";
      }
      e.preventDefault();
      const dim = Math.max(0, 1 - offset() / Math.max(1, modal.offsetHeight));
      modal.style.transform = `translateY(${offset()}px)`;
      overlay.style.backgroundColor = `rgba(4, 4, 6, ${(0.72 * dim).toFixed(3)})`;
      overlay.style.backdropFilter = overlay.style.webkitBackdropFilter = `blur(${(4 * dim).toFixed(1)}px)`;
    }, { passive: false });

    const end = () => {
      if (!tracking || !dragging) {
        tracking = false;
        return;
      }
      tracking = false;
      dragging = false;
      const dy = offset();
      const speed = dy / Math.max(1, Date.now() - startT);
      if (dy > modal.offsetHeight / 3 || (speed > 0.6 && dy > 40)) {
        modal.style.setProperty("--drag", `${dy}px`);
        close();
      } else {
        modal.style.transition = "transform .28s var(--ease)";
        modal.style.transform = "";
        overlay.style.backgroundColor = "";
        overlay.style.backdropFilter = overlay.style.webkitBackdropFilter = "";
        setTimeout(() => { if (!dragging) modal.style.transition = ""; }, 300);
      }
    };
    modal.addEventListener("touchend", end);
    modal.addEventListener("touchcancel", end);
  }

  /* ---------- dialog focus ---------- */

  // Opening a dialog moves focus into it, Tab and Shift+Tab stay inside the
  // topmost one, and closing it hands focus back to what opened it.
  const dlgStack = [];
  let lastOutsideFocus = null;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const dlgFocusables = (overlay) => [...overlay.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && el.offsetParent !== null);

  function onDialogToggle(overlay) {
    const at = dlgStack.findIndex((d) => d.overlay === overlay);
    if (!overlay.hidden && at === -1) {
      dlgStack.push({ overlay, opener: lastOutsideFocus });
      const modal = overlay.querySelector(".modal");
      if (modal) modal.tabIndex = -1;
      if (!overlay.contains(document.activeElement)) (modal || overlay).focus({ preventScroll: true });
    } else if (overlay.hidden && at !== -1) {
      const [{ opener }] = dlgStack.splice(at, 1);
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    }
  }

  function initDialogFocus() {
    document.addEventListener("focusin", (e) => {
      if (e.target instanceof Element && !e.target.closest(".overlay")) lastOutsideFocus = e.target;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || !dlgStack.length) return;
      const { overlay } = dlgStack[dlgStack.length - 1];
      const items = dlgFocusables(overlay);
      const modal = overlay.querySelector(".modal");
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const now = document.activeElement;
      if (!overlay.contains(now)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (now === first || now === modal)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && now === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function closeConfirm(result) {
    hideOverlay($("confirmOverlay"));
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
    prefs: { nm: false, bundle: false, wishlist_nm: false, nm_names: false },
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
    S.prefs = { nm: data.nm === true, bundle: data.bundle === true, wishlist_nm: data.wishlist_nm === true, nm_names: data.nm_names === true };
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

  const ACCOUNT_TABS = ["daily", "acc", "nm", "collection", "loadout", "mastery", "alerts", "sharing"];

  // Routes are real paths (/a/<puuid>/<tab>, /wishlist, ...) under BASE_PATH and
  // use the History API. The server returns index.html for each of them.
  const PAGE_ROUTES = ["wishlist", "bundles", "battlepass", "settings"];

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
      // A link (or back/forward) to a tab this account does not have opens its daily shop.
      if (!tabAllowed(a, r.tab)) {
        go(acctHref(a.puuid), true);
        return;
      }
      renderAccountView(a);
    } else if (r.name === "wishlist") renderWishlistView();
    else if (r.name === "bundles") renderBundlesView();
    else if (r.name === "battlepass") renderBattlepassView();
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
    requestAnimationFrame(watchHeading);
  }

  // On desktop the page heading and the sticky top bar would both say the same thing:
  // keep the bar's title quiet until the heading has scrolled out of view.
  let headingObs = null;
  function watchHeading() {
    if (headingObs) headingObs.disconnect();
    headingObs = null;
    const bar = $("topbarTitle");
    const heading = document.querySelector("#view h1");
    bar.classList.remove("is-quiet");
    if (!heading || !("IntersectionObserver" in window)) return;
    bar.classList.add("is-quiet");
    headingObs = new IntersectionObserver(([entry]) => bar.classList.toggle("is-quiet", entry.isIntersecting), { rootMargin: "-56px 0px 0px 0px" });
    headingObs.observe(heading);
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
    const accts = $("navAcctCount");
    const na = S.accounts.length;
    accts.hidden = !na;
    accts.textContent = String(na);
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
    // The equipped player card is the avatar. Without it (loadout unavailable, or the
    // art fails to load) the rank emblem or initials show as before.
    const card = d && d.equipped && d.equipped.identityCard;
    const cardArt = card && card.art && card.art.small;
    const fallback = () => {
      box.classList.remove("is-card");
      box.title = "";
      box.textContent = initials(acctName(a));
    };
    if (cardArt) {
      box.classList.add("is-card");
      box.title = card.name || "";
      box.appendChild(makeImg(cardArt, card.name || "", fallback));
    } else if (rank && rank.icon) {
      // Unranked accounts get Riot's unranked emblem (tier 0 icon) too.
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
    // Switching accounts keeps the open tab (Loadout stays Loadout) when the other account
    // has it too; otherwise it opens on the daily shop.
    const open = () => {
      const tab = S.route.name === "account" && tabAllowed(a, S.route.tab) ? S.route.tab : "daily";
      go(acctHref(a.puuid, tab));
    };
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
    // Opens right under the anchor (above it when there is no room below), kept
    // fully on screen, on phones too.
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

  // Overview strip: when each rotation ends, so nothing has to be opened to find out.
  // Shop and accessory resets are the soonest across the loaded accounts.
  function renderSummary() {
    const box = $("summary");
    if (!box) return;
    box.innerHTML = "";
    const now = Date.now();
    let nextDaily = 0;
    let nextAcc = 0;
    const soonest = (cur, at) => (at && at > now && (!cur || at < cur) ? at : cur);
    for (const a of ordered()) {
      const s = S.store[a.puuid];
      nextDaily = soonest(nextDaily, s && s.daily && s.daily.expiresAt);
      nextAcc = soonest(nextAcc, s && s.kingdomShop && s.kingdomShop.expiresAt);
    }
    const nm = nightMarketState();
    const accts = ordered();
    const own = ownAccounts().length;

    const item = (icon, label, value, extra) =>
      h("div", { class: `summary-item ${extra || ""}` }, iconEl(icon), h("div", { class: "summary-text" }, h("span", { class: "summary-label", text: label }), value));
    const dash = (text) => h("span", { class: "summary-value faint", text: text || "-" });

    box.appendChild(
      item("user", "Accounts", h("span", { class: "summary-value", text: `${own} own${accts.length > own ? ` · ${accts.length - own} shared` : ""}` }))
    );
    box.appendChild(item("bag", "Shop resets", nextDaily ? countdownEl(nextDaily, "summary-value") : dash()));
    box.appendChild(item("sparkle", "Accessories reset", nextAcc ? countdownEl(nextAcc, "summary-value") : dash()));
    box.appendChild(
      item("moon", nm.open && nm.expiresAt ? "Night Market ends" : "Night Market",
        nm.open
          ? (nm.expiresAt ? countdownEl(nm.expiresAt, "summary-value") : h("span", { class: "summary-value", text: "Open" }))
          : dash(nm.known ? "Closed" : "-"),
        nm.open ? "is-night" : "")
    );
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
    if (!w && a.linked && !S.storeError[a.puuid]) {
      return h("div", { class: "wallet" }, h("span", { class: "sk", style: "width:74px;height:28px" }), h("span", { class: "sk", style: "width:66px;height:28px" }), h("span", { class: "sk", style: "width:70px;height:28px" }));
    }
    const ww = w || {};
    return h("div", { class: "wallet" }, coinEl("vp", ww.vp), coinEl("rp", ww.rp), coinEl("kc", ww.kc));
  }

  // The rank row always takes the same height (loading, loaded or unavailable), so a
  // card does not grow or shrink when the rank arrives.
  function rankBlock(a, compact) {
    const d = S.details[a.puuid];
    if (!a.linked) return null;
    if (!d && !S.detailsError[a.puuid]) {
      return h("div", { class: "acct-card-rank" }, h("div", { class: "sk sk-line w60" }), h("div", { class: "sk", style: "height:4px" }));
    }
    if (!d || d.relink || !d.rank) {
      return h("div", { class: "acct-card-rank" }, h("span", { class: "rank-name faint", text: d && d.relink ? "Needs re-link" : compact ? "No rank data" : "Rank unavailable" }));
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
    const card = h("a", { class: `acct-card${a.is_default ? " is-main" : ""}${a.shared ? " is-shared" : ""}`, href: acctHref(a.puuid), dataset: { card: a.puuid } });
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
        shop.appendChild(h("div", { class: "mini-item", title: it.price != null ? `${it.name || ""} - ${fmt(it.price)} VP` : it.name || "", style: color ? `--tier:${color}` : null }, it.icon ? makeImg(it.icon, it.name) : fallbackText(it.name)));
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
    // Keep the level chip's spot while the details load, so the header does not reflow.
    else if (!d && a.linked && !S.detailsError[a.puuid]) chips.appendChild(h("span", { class: "chip sk", style: "width:84px", "aria-hidden": "true" }));
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
    const loading = !d && !S.detailsError[a.puuid];
    const stats = h("div", { class: "stats" });
    // label on top, content in the middle, an optional footer pinned to the bottom
    const stat = (label, body, foot) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-body" }, ...body), foot ? h("div", { class: "stat-foot" }, foot) : null);
    const sk = () => [h("span", { class: "sk sk-line w60" })];
    const emblem = (icon) => (icon ? h("span", { class: "emblem md", style: "background:transparent" }, makeImg(icon, "")) : null);

    // Rank
    if (loading) stats.appendChild(stat("Rank", sk(), h("div", { class: "rr-bar sk" })));
    else if (d && d.rank) {
      const rank = d.rank;
      const ranked = Number(rank.tier) >= 3;
      const top = Number(rank.tier) >= 24;
      const rr = Math.max(0, Math.round(Number(rank.rr) || 0));
      const color = rankColor(rank) || "#8b929c";
      const sub = !ranked ? "No placement this act" : top ? `${fmt(rr)} RR${rank.leaderboard ? ` · #${fmt(rank.leaderboard)}` : ""}` : `${fmt(rr)} / 100 RR`;
      stats.appendChild(
        stat("Rank",
          [emblem(rank.icon), h("div", null, h("div", { class: "stat-big", text: ranked ? rank.tierName : "Unranked" }), h("div", { class: "stat-sub", text: sub }))],
          ranked ? h("div", { class: "rr-bar", style: `--tier:${color}` }, h("span", { style: `width:${top ? 100 : Math.min(100, rr)}%` })) : null)
      );
    } else stats.appendChild(stat("Rank", [h("span", { class: "faint", text: "Unavailable" })]));

    // Peak
    if (loading) stats.appendChild(stat("Peak rank", sk()));
    else {
      const rank = d && d.rank;
      const hasPeak = rank && Number(rank.peakTier) >= 3 && rank.peakName;
      stats.appendChild(
        stat("Peak rank", [
          hasPeak ? emblem(rank.peakIcon) : null,
          h("div", null, h("div", { class: "stat-big", text: hasPeak ? rank.peakName : "-" }), h("div", { class: "stat-sub", text: hasPeak ? "Best across all acts" : "No ranked games" })),
        ])
      );
    }

    // Collection
    if (loading) stats.appendChild(stat("Collection", sk()));
    else {
      const skins = d && d.skins ? d.skins.count || 0 : null;
      const acc = d ? ["buddies", "sprays", "cards", "titles", "flexes"].reduce((n, k) => n + (Array.isArray(d[k]) ? d[k].length : 0), 0) : null;
      const num = (v, unit) => h("div", { class: "stat-num" }, h("b", { text: v === null ? "-" : fmt(v) }), h("span", { text: unit }));
      stats.appendChild(stat("Collection", [h("div", { class: "stat-pair" }, num(skins, "Skins"), num(acc, "Accessories"))]));
    }

    // Wallet
    stats.appendChild(stat("Wallet", [walletRowsEl(a)]));
    return stats;
  }

  // Stacked currency rows for the stat box: icon and code on the left, the
  // balance right-aligned so the numbers line up.
  function walletRowsEl(a) {
    const w = walletOf(a);
    if (!w && a.linked && !S.storeError[a.puuid]) {
      return h("div", { class: "wallet-rows" }, ...[0, 1, 2].map(() => h("span", { class: "sk", style: "height:18px" })));
    }
    const ww = w || {};
    const row = (code) => {
      const v = ww[code];
      const na = v === null || v === undefined;
      return h("div", { class: `wallet-row${na ? " na" : ""}`, title: code.toUpperCase() },
        makeImg(CURRENCY_ICON[code], code.toUpperCase()), h("span", { class: "wr-code", text: code.toUpperCase() }), h("span", { class: "wr-val", text: na ? "-" : fmt(v) }));
    };
    return h("div", { class: "wallet-rows" }, row("vp"), row("rp"), row("kc"));
  }

  function accountMenu(a) {
    const list = ordered();
    const i = list.findIndex((x) => x.puuid === a.puuid);
    const entries = [];
    if (!a.shared) {
      if (a.linked) entries.push({ icon: "share", label: "Share this account", sub: "Create or manage a share code", onClick: () => go(acctHref(a.puuid, "sharing")) });
      if (a.linked) entries.push({ icon: "shield", label: "Loadout link", sub: "Beta: let someone change the skins", onClick: () => openLoadShare(a) });
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
      { id: "loadout", label: "Loadout", icon: "shield" },
      { id: "mastery", label: "Agent mastery", icon: "trophy" },
    ];
    if (!a.shared) {
      tabs.push({ id: "alerts", label: "Alerts", icon: "bell" });
      tabs.push({ id: "sharing", label: "Sharing", icon: "share" });
    }
    return tabs;
  }

  // Alerts and Sharing belong to the owner: an account shared with you has neither.
  function tabAllowed(a, tab) {
    return tabDefs(a).some((t) => t.id === tab);
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
      nav.scrollLeft = Math.max(0, active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2);
    }
  }

  function renderPanel() {
    const box = $("acctPanel");
    const a = currentAcct();
    if (!box || !a) return;
    const tab = S.route.tab;
    box.innerHTML = "";
    if (!a.linked && ["daily", "acc", "nm", "collection", "loadout", "mastery"].includes(tab)) {
      box.appendChild(h("div", { class: "empty-state" }, iconEl("link"), h("h3", { text: "Not connected" }), h("p", { text: "Re-link this account to load its shops and collection." })));
      return;
    }
    if (tab === "daily" || tab === "acc" || tab === "nm") renderShopPanel(box, a, tab);
    else if (tab === "collection") renderCollectionPanel(box, a);
    else if (tab === "loadout") renderLoadoutPanel(box, a);
    else if (tab === "mastery") renderMasteryPanel(box, a);
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
      tools.appendChild(h("span", { class: "sk sk-line", style: "width:120px;height:14px" }));
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

  // Placeholder tiles shaped like wishlist pick cards, shown while data loads.
  function wlSkeleton(n) {
    const grid = h("div", { class: "wl-picks", "aria-hidden": "true" });
    for (let i = 0; i < n; i++) {
      grid.appendChild(h("div", { class: "wl-pick" }, h("div", { class: "wl-pick-thumb sk", style: "border-radius:0" }), h("div", { class: "wl-pick-body" }, h("span", { class: "sk sk-line w80" }), h("span", { class: "sk sk-line w40" }))));
    }
    return grid;
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
    else if (item.tier) {
      const icon = tierIconEl(item.tier);
      meta.appendChild(icon ? h("span", { class: "card-tier" }, icon) : h("span", { class: "card-type", style: color ? `color:${color}` : null, text: item.tier }));
    }
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
      // Same stack as the loaded panel (tab strip, search row, filter row), then tiles.
      box.appendChild(h("div", { class: "sk coll-sk-seg" }));
      box.appendChild(h("div", { class: "sk coll-sk-tools" }));
      box.appendChild(h("div", { class: "sk coll-sk-filters" }));
      const sk = h("div", { class: "tiles" });
      for (let i = 0; i < 18; i++) sk.appendChild(h("div", { class: "tile" }, h("div", { class: "tile-media sk", style: "border-radius:0" }), h("div", { class: "tile-name" }, h("div", { class: "sk sk-line w80" }))));
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
      titles: d.titles || [],
      flexes: d.flexes || [],
    };
    const labels = { skins: "Skins", buddies: "Gun buddies", sprays: "Sprays", cards: "Player cards", titles: "Titles", flexes: "Flexes" };
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

    const square = st.section !== "skins" && st.section !== "flexes" && st.section !== "titles";
    const tiles = h("div", { class: `tiles${square ? " square" : st.section === "flexes" ? " wide" : st.section === "titles" ? " titles" : ""}` });
    const nodes = [];
    for (const it of list) {
      // Sprays use the animated GIF when Riot has one (icon), else the still.
      const src = st.section === "cards" ? (it.art && it.art.small) || it.icon : it.icon || it.staticIcon;
      // Titles are text only: the title itself fills the tile, no caption.
      const isTitle = st.section === "titles";
      const media = isTitle ? h("div", { class: "title-text", text: titleName(it.name) }) : imgOrFallback(src, it.name);
      const tile = h("div", { class: "tile", title: it.name || "" }, h("div", { class: "tile-media" }, media), isTitle ? null : h("div", { class: "tile-name", text: it.name || "Unknown" }));
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

  /* ---------- loadout ---------- */

  // puuid -> { data, error, pending }. Fetched when the tab opens, kept for the session.
  const loadouts = Object.create(null);
  // The in-game loadout screen: five columns, weapons grouped as the game groups them.
  const LOADOUT_COLUMNS = [
    [["Sidearms", ["Classic", "Shorty", "Frenzy", "Ghost", "Bandit", "Sheriff"]]],
    [["SMGs", ["Stinger", "Spectre"]], ["Shotguns", ["Bucky", "Judge"]], ["Melee", ["Melee"]]],
    [["Rifles", ["Bulldog", "Guardian", "Warden", "Phantom", "Vandal"]]],
    [["Sniper rifles", ["Marshal", "Outlaw", "Operator"]], ["Machine guns", ["Ares", "Odin"]]],
  ];

  function fetchLoadout(puuid, force) {
    const box = loadouts[puuid] || (loadouts[puuid] = {});
    if (force) {
      box.data = null;
      box.error = null;
    }
    if (box.data || box.pending) return;
    box.error = null;
    box.pending = api(`/api/accounts/${encodeURIComponent(puuid)}/loadout`, { timeoutMs: 35000 })
      .then((res) => {
        if (res && res.status === "relink") box.error = "Riot asked to sign in again. Re-link this account to see its loadout.";
        else box.data = (res && res.loadout) || null;
        if (!box.data && !box.error) box.error = "Riot did not return a loadout for this account.";
      })
      .catch((err) => {
        box.error = err.message || "Could not load the loadout.";
      })
      .finally(() => {
        box.pending = null;
        if (S.route.name === "account" && S.route.puuid === puuid && S.route.tab === "loadout") renderPanel();
      });
  }

  // Every skin image is cropped to the weapon and 512px wide, so by itself a Classic would
  // look as long as an Operator. These are the widths each weapon is drawn at, as a share
  // of its tile's width: sidearms smallest, then SMGs, then the long guns. Long guns stop
  // at 0.8 and sit mid-height, clear of the buddy hanging in the bottom-right corner.
  const LOADOUT_GUN_WIDTH = {
    Classic: 0.44, Shorty: 0.62, Frenzy: 0.44, Ghost: 0.6, Bandit: 0.46, Sheriff: 0.54,
    Stinger: 0.66, Spectre: 0.68, Bucky: 0.8, Judge: 0.76, Melee: 0.6,
    Bulldog: 0.78, Guardian: 0.8, Warden: 0.8, Phantom: 0.8, Vandal: 0.8,
    Marshal: 0.8, Outlaw: 0.8, Operator: 0.8, Ares: 0.8, Odin: 0.8,
  };

  function loadoutGunEl(weapon, g) {
    const skin = (g && g.skin) || {};
    const random = Boolean(g && skin.random);
    const tip = g ? (random ? `${weapon}: random favorite skin` : `${weapon}: ${skin.name || ""}`) : weapon;
    const art = g ? skin.render || skin.icon : null;
    const color = !random && tierColor(skin.tier);
    // The label shows the weapon, and the skin's name on hover.
    const skinName = g && !random && skin.name ? skin.name : "";
    return h("div", { class: `lo-gun${random ? " is-random" : ""}${g ? "" : " is-empty"}${color ? " has-tier" : ""}`, title: tip, style: `--gw:${LOADOUT_GUN_WIDTH[weapon] || 0.7}${color ? `;--tier:${color}` : ""}` },
      h("div", { class: "lo-gun-art" }, art ? imgOrFallback(art, skin.name) : null),
      h("span", { class: `lo-weapon${skinName ? " has-skin" : ""}` }, h("span", { class: "lo-weapon-name", text: weapon }), skinName ? h("span", { class: "lo-skin-name", text: skinName }) : null),
      g && g.buddy ? h("div", { class: "lo-buddy", title: g.buddy.name || "" }, g.buddy.icon ? makeImg(g.buddy.icon, g.buddy.name, (img) => img.remove()) : null) : null);
  }

  // The columns of weapon tiles. Without a loadout (still loading) every tile is a skeleton.
  function loadoutColumnsEl(byWeapon) {
    const screen = h("div", { class: "lo-screen" });
    const known = new Set(LOADOUT_COLUMNS.flatMap((col) => col.flatMap(([, list]) => list)));
    LOADOUT_COLUMNS.forEach((groups, i) => {
      const col = h("div", { class: "lo-col" });
      groups.forEach(([label, weapons]) => {
        col.appendChild(h("h3", { class: "lo-h", text: label }));
        for (const w of weapons) col.appendChild(byWeapon ? loadoutGunEl(w, byWeapon.get(w)) : h("div", { class: "lo-gun sk" }));
      });
      // Anything the game added that is not listed above goes at the end of the rifles.
      if (i === 2 && byWeapon) {
        for (const [w, g] of byWeapon) if (!known.has(w)) col.appendChild(loadoutGunEl(w, g));
      }
      screen.appendChild(col);
    });
    return screen;
  }

  // Expression wheel: four slots, filled clockwise from the top in the order Riot lists
  // them. A slot holds a spray or a flex.
  function loadoutWheelEl(lo) {
    const list = (lo.expressions && lo.expressions.length ? lo.expressions : [...(lo.sprays || []), ...(lo.flexes || [])]).slice(0, 4);
    const positions = ["top", "right", "bottom", "left"];
    const wheel = h("div", { class: "lo-wheel" }, h("span", { class: "lo-wheel-dot" }));
    positions.forEach((pos, i) => {
      const x = list[i] || null;
      wheel.appendChild(h("div", { class: `lo-slot ${pos}`, title: x ? x.name || "" : "" }, x ? imgOrFallback(x.icon || x.staticIcon, x.name) : null));
    });
    return wheel;
  }

  // The owner's side of a loadout link (opened from the account's ... menu): make one
  // (shown once), see whether one is live, revoke it. The link itself is never stored in
  // readable form, so it cannot be shown again.
  const shareUi = Object.create(null);
  let shareTarget = null;

  function openLoadShare(a) {
    closeMenu();
    closeSidebar();
    shareTarget = a;
    const st = shareUi[a.puuid] || (shareUi[a.puuid] = { cosmetics: false });
    st.status = st.status || null;
    renderLoadShare();
    showOverlay($("shareLinkOverlay"));
    // The live state comes from the server; the dialog shows what it knows meanwhile.
    // While it is open it keeps asking whether the link was used or ran out, so a used
    // link disappears here (and can no longer be copied) as soon as it is saved.
    pollLoadShare(a, true);
    clearInterval(shareTimer);
    shareTimer = setInterval(() => pollLoadShare(a, false), 4000);
  }
  let shareTimer = null;
  function pollLoadShare(a, first) {
    const st = shareUi[a.puuid];
    return api(`/api/accounts/${encodeURIComponent(a.puuid)}/loadshare`)
      .then((r) => {
        const was = st.status;
        st.status = r;
        if (!r.active) st.url = null;
        const changed = first || !was || was.active !== r.active || was.used !== r.used;
        if (changed && shareTarget === a) renderLoadShare();
      })
      .catch(() => { if (first && shareTarget === a) renderLoadShare(); });
  }
  function closeLoadShare() {
    clearInterval(shareTimer);
    shareTimer = null;
    hideOverlay($("shareLinkOverlay"), () => { shareTarget = null; });
  }

  function renderLoadShare() {
    const a = shareTarget;
    const body = $("slBody");
    if (!a) return;
    const st = shareUi[a.puuid];
    const enc = encodeURIComponent(a.puuid);
    const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const live = st.url ? { expiresAt: st.expiresAt } : st.status && st.status.active ? st.status : null;

    async function create() {
      st.busy = true;
      renderLoadShare();
      try {
        const r = await api(`/api/accounts/${enc}/loadshare`, { method: "POST", json: { cosmetics: st.cosmetics } });
        st.url = r.url;
        st.expiresAt = r.expiresAt;
        st.status = { active: true, expiresAt: r.expiresAt, cosmetics: r.cosmetics };
      } catch (err) {
        toast(err.message, "error");
      }
      st.busy = false;
      if (shareTarget === a) renderLoadShare();
    }
    async function revoke() {
      st.busy = true;
      renderLoadShare();
      try {
        await api(`/api/accounts/${enc}/loadshare`, { method: "DELETE" });
        st.url = null;
        st.status = { active: false };
        toast("Link revoked.", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
      st.busy = false;
      if (shareTarget === a) renderLoadShare();
    }

    const kids = [
      h("div", { class: "dlg-note is-warn" }, iconEl("alert"),
        h("p", {}, h("b", { text: "Beta feature. " }),
          "This one writes to the account's in-game loadout through an unofficial Riot endpoint, so it is riskier than the read-only parts of this site. Only share it with people you trust.")),
      h("ul", { class: "dlg-points" },
        h("li", {}, "Anyone with the link can change this account's weapon skins and gun buddies. No sign-in needed."),
        h("li", {}, "They can only equip what the account owns, plus Standard and Random Favorite skins."),
        h("li", {}, h("b", { text: "One save only," }), " and the link ends 30 minutes after you make it."),
        h("li", {}, "They will see which skins and buddies this account owns.")),
    ];

    if (!live) {
      kids.push(h("div", { class: "rows sl-opts" }, h("div", { class: "row" },
        iconEl("sparkle"),
        h("div", { class: "row-text" }, h("b", { text: "Cosmetics" }), h("span", { text: "Also let them change the player card, title, sprays and flexes." })),
        switchEl(st.cosmetics, "Allow cosmetics", (on) => { st.cosmetics = on; }))));
      const last = st.status;
      if (last && last.used) {
        kids.push(h("div", { class: "sl-state" }, h("span", { class: "chip ok", text: "Used" }),
          h("span", { text: `The last link was used${last.lastSave ? ` at ${time(last.lastSave.at)}` : ""} and no longer works.` })));
      } else if (last && last.expired) {
        kids.push(h("div", { class: "sl-state" }, h("span", { class: "chip", text: "Expired" }), h("span", { text: "The last link ran out without being used." })));
      }
      kids.push(h("div", { class: "modal-actions" },
        h("button", { class: "btn btn-ghost", type: "button", onclick: closeLoadShare }, "Cancel"),
        h("button", { class: `btn${st.busy ? " is-busy" : ""}`, type: "button", disabled: st.busy, onclick: create }, iconEl("link"), "Create link")));
    } else {
      if (st.url) {
        kids.push(h("label", { class: "wipe-label", for: "slLink", text: "Your link (shown once)" }),
          h("div", { class: "sl-link" },
            h("input", { id: "slLink", class: "input", type: "text", readonly: true, value: st.url, "aria-label": "Share link", onfocus: (e) => e.target.select() }),
            h("button", { class: "btn", type: "button", onclick: () => copyText(st.url, "Link copied") }, iconEl("copy"), "Copy")));
      } else {
        kids.push(h("div", { class: "dlg-note" }, iconEl("info"), h("p", { text: "A link is active. It cannot be shown again; revoke it and make a new one if you lost it." })));
      }
      kids.push(h("p", { class: "sl-meta" },
        h("span", { class: "chip ok", text: "Live" }),
        ` Works once, until ${time(live.expiresAt)}${st.status && st.status.cosmetics ? " · cosmetics allowed" : ""}`),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn btn-danger", type: "button", disabled: st.busy, onclick: revoke }, "Revoke"),
          h("button", { class: "btn btn-ghost", type: "button", onclick: closeLoadShare }, "Done")));
    }
    body.replaceChildren(...kids);
  }

  function renderLoadoutPanel(box, a) {
    const head = h("div", { class: "panel-head" }, h("h2", { text: "Loadout" }));
    box.appendChild(head);
    const st = loadouts[a.puuid] || (loadouts[a.puuid] = {});
    if (!st.data && !st.error && !st.pending) fetchLoadout(a.puuid);
    const lo = st.data;
    if (!lo) {
      if (st.error && !st.pending) {
        box.appendChild(h("div", { class: "empty-state" }, iconEl("alert"), h("h3", { text: "Could not load the loadout" }), h("p", { text: st.error }),
          h("button", { class: "btn btn-ghost", type: "button", onclick: () => { fetchLoadout(a.puuid, true); renderPanel(); } }, iconEl("refresh"), "Try again")));
        return;
      }
      const sk = loadoutColumnsEl(null);
      sk.appendChild(h("div", { class: "lo-col lo-side" },
        h("h3", { class: "lo-h", text: "Player card" }), h("div", { class: "lo-card-wrap" }, h("div", { class: "lo-card sk" })),
        h("h3", { class: "lo-h lo-expr-h", text: "Expressions" }), h("div", { class: "lo-wheel sk" })));
      box.appendChild(h("div", { class: "lo-wrap" }, sk));
      return;
    }

    head.appendChild(h("button", { class: "btn btn-ghost", type: "button", onclick: () => { fetchLoadout(a.puuid, true); renderPanel(); } }, iconEl("refresh"), "Refresh"));

    const byWeapon = new Map();
    for (const g of lo.guns || []) if (g.weapon) byWeapon.set(g.weapon, g);
    const screen = loadoutColumnsEl(byWeapon);

    // Last column: player card and the expressions wheel. As in the game, the player's
    // name and title sit over the card. They are beside the card in a wrapper, not inside it,
    // because the card clips and fades its art and the name row sticks out past its edges.
    // The account level is shown elsewhere.
    const cardArt = lo.card && lo.card.art && (lo.card.art.large || lo.card.art.wide || lo.card.art.small);
    const card = h("div", { class: "lo-card-wrap" },
      h("div", { class: "lo-card", title: lo.card ? lo.card.name || "" : "" },
        cardArt ? imgOrFallback(cardArt, lo.card && lo.card.name) : h("div", { class: "lo-card-none", text: "No card equipped" })),
      h("div", { class: "lo-card-name" }, h("b", { text: String(a.name || acctName(a)).replace(/#.*$/, "") }),
        lo.title ? h("span", {}, h("i", { text: titleName(lo.title.name) })) : null));
    const side = h("div", { class: "lo-col lo-side" },
      h("h3", { class: "lo-h", text: "Player card" }),
      card,
      lo.incognito ? h("span", { class: "chip lo-incognito", text: "Incognito" }) : null,
      h("h3", { class: "lo-h lo-expr-h", text: "Expressions" }),
      loadoutWheelEl(lo));
    screen.appendChild(side);
    box.appendChild(h("div", { class: "lo-wrap" }, screen));
  }

  /* ---------- battle pass ---------- */

  // The act's pass (dates, tiers, rewards) is the same for everyone and loaded once; each
  // account's tier and premium flag come from its own call, two at a time like the details.
  const battlepass = { pass: null, error: null, pending: null };
  const bpProgress = {};

  // The pass changes about once an act, so the browser keeps its own copy until the act ends
  // (a day at most) and the page opens instantly. Progress is kept for ten minutes, as on the
  // server. Storage can be blocked or full: everything here is optional.
  const BP_PASS_KEY = "bp:pass:v1";
  const BP_PASS_KEEP_MS = 24 * 60 * 60 * 1000;
  const BP_PROGRESS_KEEP_MS = 10 * 60 * 1000;

  function bpStored(key, keepMs) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v && v.at && Date.now() - v.at < keepMs ? v : null;
    } catch {
      return null;
    }
  }

  function bpStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), ...value }));
    } catch {
      /* private mode or full: the page just asks the server next time */
    }
  }

  function loadBattlepass(force) {
    if (!force && (battlepass.pass || battlepass.pending)) return battlepass.pending || Promise.resolve(battlepass.pass);
    if (!force) {
      const saved = bpStored(BP_PASS_KEY, BP_PASS_KEEP_MS);
      if (saved && saved.pass && saved.pass.act && Date.parse(saved.pass.act.end) > Date.now() && saved.pass.chapters && saved.pass.chapters.length) {
        battlepass.pass = saved.pass;
        if (S.route.name === "battlepass") render();
        return Promise.resolve(battlepass.pass);
      }
    }
    battlepass.error = null;
    battlepass.pending = api("/api/battlepass", { timeoutMs: 30000 })
      .then((res) => {
        battlepass.pass = (res && res.pass) || null;
        if (!battlepass.pass) battlepass.error = "The battle pass is not available right now.";
        else if (battlepass.pass.chapters && battlepass.pass.chapters.length) bpStore(BP_PASS_KEY, { pass: battlepass.pass });
      })
      .catch((err) => {
        battlepass.error = err.message || "Could not load the battle pass.";
      })
      .finally(() => {
        battlepass.pending = null;
        if (S.route.name === "battlepass") render();
      });
    return battlepass.pending;
  }

  function fetchBpProgress(puuid, force) {
    const box = bpProgress[puuid] || (bpProgress[puuid] = {});
    if (force) {
      box.data = null;
      box.error = null;
    }
    if (box.data || box.pending) return box.pending || Promise.resolve();
    box.error = null;
    if (!force) {
      const saved = bpStored(`bp:progress:v1:${puuid}`, BP_PROGRESS_KEEP_MS);
      if (saved && saved.progress) {
        box.data = saved.progress;
        if (S.route.name === "battlepass") renderBattlepassRows();
        return Promise.resolve();
      }
    }
    box.pending = api(`/api/accounts/${encodeURIComponent(puuid)}/battlepass`, { timeoutMs: 35000 })
      .then((res) => {
        if (res && res.status === "relink") box.error = "Riot asked to sign in again. Re-link this account.";
        else box.data = (res && res.progress) || null;
        if (box.data) bpStore(`bp:progress:v1:${puuid}`, { progress: box.data });
        if (!box.data && !box.error) box.error = "No battle pass data for this account.";
      })
      .catch((err) => {
        box.error = err.message || "Could not load progress.";
      })
      .finally(() => {
        box.pending = null;
        if (S.route.name === "battlepass") renderBattlepassRows();
      });
    return box.pending;
  }

  // One pass shown the way the game shows it: a page of tiers (one chapter) with the
  // premium rewards in a row and the chapter's free rewards after them, and the chapters as
  // a line of diamonds below. The pass is the same for every account: each one is an avatar
  // on that line where it is, and on the tile of the tier it is working on.
  let bpPage = 0;

  const bpTotal = (pass) => pass.chapters.reduce((n, ch) => n + ch.levels.length, 0);
  const bpLinked = () => ordered().filter((a) => a.linked);
  const bpData = (a) => (bpProgress[a.puuid] || {}).data;

  // Where an account sits on the track, in tiers: tier 25 and half way to 26 is 25.5.
  function bpPos(p) {
    if (p.tier >= p.totalTiers) return p.totalTiers;
    return p.tier + (p.nextXp ? Math.min(1, p.towards / p.nextXp) : 0);
  }

  // The tier an account is working on, or 0 once it has finished the pass.
  const bpWorking = (p, total) => (p.tier >= total ? 0 : p.tier + 1);

  // The page that holds the tier an account is working on.
  function bpPageOf(pass, p) {
    const target = Math.min(p.tier + 1, bpTotal(pass));
    const i = pass.chapters.findIndex((ch) => ch.levels.some((l) => l.tier === target));
    return i < 0 ? 0 : i;
  }

  // Where an account is on the chapter line, 0 to 1: the middle of the diamond of the
  // chapter it is working on (the last one once it has finished the pass). Accounts in the
  // same chapter share that spot.
  function bpLineAt(pass, p) {
    const i = p.tier >= bpTotal(pass) ? pass.chapters.length - 1 : bpPageOf(pass, p);
    return (i + 0.5) / pass.chapters.length;
  }

  // The last page is the Epilogue, not a numbered chapter.
  const bpChapterName = (ch, i) => (ch.epilogue ? "Epilogue" : `Chapter ${i + 1}`);

  // Inside the art a title reads as the title itself ("Gearing Up"); the item name under it
  // keeps "Title".
  const bpShownName = (r) => (r.kind === "title" ? titleName(r.name) : r.name);

  const BP_KINDS = { skin: "Skin", buddy: "Gun buddy", spray: "Spray", card: "Player card", title: "Title", currency: "Currency", other: "Flex" };

  // The reward's art: player cards fill the square like in the game, everything else sits
  // inside it. Titles have no art, so their text is the art.
  function bpArtEl(r) {
    const box = h("div", { class: `bp-art${r && r.kind === "card" ? " is-card" : ""}` });
    if (!r) return box;
    const text = () => h("span", { class: "bp-art-text", text: bpShownName(r) });
    if (r.icon) {
      // A shimmer holds the square until the picture is in, then the picture fades up.
      box.classList.add("is-loading");
      const img = makeImg(r.icon, r.name, (bad) => {
        box.classList.remove("is-loading");
        bad.replaceWith(text());
      });
      img.loading = "eager";
      const done = () => box.classList.remove("is-loading");
      img.addEventListener("load", done);
      if (img.complete && img.naturalWidth) done();
      box.appendChild(img);
    } else box.appendChild(text());
    if (r.amount > 1) box.appendChild(h("b", { class: "bp-amount", text: `x${fmt(r.amount)}` }));
    return box;
  }

  function bpTileEl(r, o) {
    const art = bpArtEl(r);
    if (o.here.length) {
      art.appendChild(h("span", { class: "bp-here" }, ...o.here.slice(0, 3).map((a) => emblemEl(a, "xs")),
        o.here.length > 3 ? h("span", { class: "bp-here-more", text: `+${o.here.length - 3}` }) : null));
    }
    const tip = [r ? `${r.name}${r.amount > 1 ? ` x${fmt(r.amount)}` : ""}${r.kind === "title" ? "" : ` (${BP_KINDS[r.kind] || r.kind})`}` : o.label];
    if (o.here.length) tip.push(`Working on it: ${o.here.map(acctName).join(", ")}`);
    const tile = h("div", { class: `bp-tile${o.free ? " is-free" : ""}`, style: `grid-column:${o.col}`, title: tip.join("\n") },
      art,
      h("span", { class: "bp-foot" }, h("b", { text: o.label }), h("span", { text: r ? r.name : "" })));
    // Skins and player cards open the same preview as everywhere else.
    if (r && canPreview(r)) previewTrigger(tile, r);
    return tile;
  }

  function bpViewEl(pass, accts, onPage) {
    const total = bpTotal(pass);
    const ch = pass.chapters[bpPage];
    const first = ch.levels[0].tier;
    const last = ch.levels[ch.levels.length - 1].tier;
    const loaded = accts.filter(bpData);
    const hereOn = (tier) => loaded.filter((a) => bpWorking(bpData(a), total) === tier);

    // As in the game: the premium tiles in a row, then a diamond, then the chapter's free
    // rewards. The grid has room for the most tiles and free rewards any chapter has, so
    // tiles keep their size and place from page to page.
    const cols = Math.max(...pass.chapters.map((c) => c.levels.length));
    const freeCols = Math.max(...pass.chapters.map((c) => c.free.length));
    // Columns are as wide as they would be on the fullest page and the used ones are centred,
    // so a chapter with fewer free rewards (or none) sits in the middle of the box.
    const used = ch.free.length;
    const stage = h("div", { class: "bp-stage-in", style: `--s:${cols + freeCols};grid-template-columns:repeat(${cols}, var(--t))${used ? ` 10px repeat(${used}, var(--t))` : ""}` },
      h("span", { class: "bp-col-label", style: `grid-column:1 / span ${cols}`, text: "Premium" }),
      used ? h("span", { class: "bp-col-label is-free", style: `grid-column:${cols + 2} / span ${used}`, text: "Free" }) : null,
      used ? h("span", { class: "bp-sep", style: `grid-column:${cols + 1}`, "aria-hidden": "true" }) : null);
    ch.levels.forEach((l, i) => stage.appendChild(bpTileEl(l.reward, { label: `Tier ${l.tier}`, col: i + 1, here: hereOn(l.tier) })));
    ch.free.forEach((r, i) => stage.appendChild(bpTileEl(r, { label: "Free", col: cols + 2 + i, here: [], free: true })));

    // The chapters as diamonds on a line, the open one large with its number. Every
    // account is a small avatar above the line where it is; accounts close together share
    // one spot as a row of overlapping avatars (the first few, then +N) with a short stem.
    // Clicking an avatar opens its page.
    const count = pass.chapters.length;
    const marks = loaded.map((a) => ({ a, p: bpData(a), at: bpLineAt(pass, bpData(a)) })).sort((x, y) => x.at - y.at);
    const track = h("div", { class: "bp-track", style: `--cnt:${count}` });
    const groups = [];
    for (const m of marks) {
      const g = groups[groups.length - 1];
      if (g && m.at - g.from < 0.05) g.items.push(m);
      else groups.push({ from: m.at, items: [m] });
    }
    for (const g of groups) {
      const at = g.items.reduce((n, m) => n + m.at, 0) / g.items.length;
      track.appendChild(h("div", { class: "bp-mark-group", style: `left:${(at * 100).toFixed(2)}%` },
        ...g.items.slice(0, 4).map((m) => h("button", { class: "bp-mark", type: "button",
          title: `${acctName(m.a)}: tier ${m.p.tier} of ${m.p.totalTiers}`, "aria-label": `${acctName(m.a)}, tier ${m.p.tier}`, onclick: () => onPage(bpPageOf(pass, m.p)) },
        emblemEl(m.a, "xs"))),
        g.items.length > 4 ? h("span", { class: "bp-mark-more", title: g.items.slice(4).map((m) => acctName(m.a)).join(", "), text: `+${g.items.length - 4}` }) : null));
    }
    pass.chapters.forEach((c, i) => {
      const on = i === bpPage;
      track.appendChild(h("button", {
        class: `bp-dot${on ? " is-on" : ""}${c.epilogue ? " is-epilogue" : ""}`,
        type: "button",
        "aria-label": bpChapterName(c, i),
        "aria-current": on ? "page" : null,
        title: `${bpChapterName(c, i)}: tiers ${c.levels[0].tier} to ${c.levels[c.levels.length - 1].tier}`,
        onclick: () => onPage(i),
      }, h("span", { class: "bp-dot-mark" }, c.epilogue ? iconEl("star") : on ? h("span", { text: String(i + 1) }) : null)));
    });
    // The arrows loop: next from the Epilogue is chapter 1, previous from chapter 1 the Epilogue.
    const arrow = (delta) => h("button", { class: "bp-arrow", type: "button", "aria-label": delta < 0 ? "Previous chapter" : "Next chapter", onclick: () => onPage((bpPage + delta + count) % count) },
      iconEl(delta < 0 ? "chevron-left" : "chevron-right"));

    const head = h("div", { class: "bp-view-title" }, h("b", { text: bpChapterName(ch, bpPage) }), h("span", { text: `Tiers ${first} to ${last}` }));
    return h("section", { class: "bp-view" }, head, h("div", { class: "bp-stage" }, stage), h("div", { class: "bp-nav" }, arrow(-1), track, arrow(1)));
  }

  // One card per account: its tier, the whole pass as a bar with a notch per chapter, and
  // the xp toward the next tier under it. Clicking a card opens the page it is on.
  function bpAcctEl(a, pass, onPage) {
    const box = bpProgress[a.puuid] || {};
    const p = box.data;
    const total = p ? p.totalTiers : bpTotal(pass);
    const waiting = !p && !box.error;
    const sub = !p ? box.error || "" : p.tier >= total ? "Pass complete" : p.nextXp ? `${fmt(p.towards)} / ${fmt(p.nextXp)} XP to tier ${p.tier + 1}` : "Not started";
    return h("button", { class: `bp-acct${box.error ? " is-error" : ""}${waiting ? " is-waiting" : ""}`, type: "button", disabled: !p, onclick: () => onPage(bpPageOf(pass, p)) },
      emblemEl(a, "md"),
      h("span", { class: "bp-acct-name" }, h("b", {}, ...nameNodes(acctName(a))),
        p && p.premium != null ? h("span", { class: `chip${p.premium ? " main" : ""}`, text: p.premium ? "Premium" : "Free" }) : null),
      waiting
        ? h("span", { class: "bp-acct-tier" }, h("span", { class: "sk bp-sk-tier" }))
        : h("span", { class: "bp-acct-tier" }, h("small", { text: "Tier" }), h("span", {}, h("b", { text: p ? String(p.tier) : "-" }), h("i", { text: `/${total}` }))),
      h("span", { class: `bp-acct-bar${p ? "" : " sk"}`, style: `--chs:${pass.chapters.length}` }, h("i", { style: `width:${p ? ((bpPos(p) / total) * 100).toFixed(2) : 0}%` })),
      waiting ? h("span", { class: "bp-acct-sub" }, h("span", { class: "sk sk-line w60" })) : h("span", { class: "bp-acct-sub", text: sub }));
  }

  function renderBattlepassRows() {
    const body = document.querySelector("#view .bp-body");
    const pass = battlepass.pass;
    if (!body || !pass) return;
    const accts = bpLinked();
    // The page stays on the first chapter; progress arriving must not move it. Only the
    // user (arrows, diamonds, account cards) changes the page.
    const scroll = window.scrollY;
    const onPage = (i) => {
      bpPage = Math.max(0, Math.min(pass.chapters.length - 1, i));
      renderBattlepassRows();
    };
    body.replaceChildren(
      h("div", { class: "bp-accts" }, ...accts.map((a) => bpAcctEl(a, pass, onPage))),
      bpViewEl(pass, accts, onPage));
    window.scrollTo({ top: scroll, behavior: "instant" });
  }

  function renderBattlepassView() {
    setTitle("Battle pass");
    const view = $("view");
    const pass = battlepass.pass;
    const head = h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Battle pass" }),
      h("p", { text: pass ? `${pass.act.name}. Click an account to open the chapter it is on.` : "Where each account stands on the current act's battle pass." })));
    view.appendChild(head);
    if (!pass) {
      if (battlepass.error && !battlepass.pending) {
        view.appendChild(h("div", { class: "empty-state" }, iconEl("alert"), h("h3", { text: "Could not load the battle pass" }), h("p", { text: battlepass.error }),
          h("button", { class: "btn btn-ghost", type: "button", onclick: () => loadBattlepass(true) }, iconEl("refresh"), "Try again")));
        return;
      }
      const n = Math.max(1, Math.min(3, bpLinked().length));
      view.appendChild(h("div", { class: "bp-body" },
        h("div", { class: "bp-accts" }, ...Array.from({ length: n }, () => h("div", { class: "bp-acct bp-acct-sk sk" }))),
        h("section", { class: "bp-view" },
          h("div", { class: "bp-view-title" }, h("span", { class: "sk sk-line w40", style: "height:26px" }), h("span", { class: "sk sk-line w20" })),
          h("div", { class: "bp-sk-tiles" }, ...Array.from({ length: 7 }, () => h("div", { class: "sk bp-sk-tile" }))),
          h("div", { class: "bp-sk-nav sk" }))));
      loadBattlepass();
      return;
    }
    const end = Date.parse(pass.act.end);
    view.appendChild(h("div", { class: "bp-ends" }, iconEl("clock"),
      h("span", {}, "Ends in "), countdownEl(end, "bp-count"),
      h("span", { class: "bp-ends-date", text: ` (${new Date(end).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })})` }),
      pass.premiumVP ? h("span", { class: "bp-ends-date", text: `Premium costs ${fmt(pass.premiumVP)} VP.` }) : null));
    if (!pass.chapters.length) {
      view.appendChild(h("div", { class: "empty-state" }, iconEl("info"), h("h3", { text: "Tiers not published yet" }), h("p", { text: "This act's battle pass is not in the catalog yet. Check back soon." })));
      return;
    }
    const linked = bpLinked();
    if (!linked.length) {
      view.appendChild(h("div", { class: "empty-state" }, iconEl("user"), h("h3", { text: "No linked accounts" }), h("p", { text: "Link a Riot account to see its battle pass." })));
      return;
    }
    view.appendChild(h("div", { class: "bp-body" }));
    renderBattlepassRows();
    const todo = linked.filter((a) => !(bpProgress[a.puuid] && (bpProgress[a.puuid].data || bpProgress[a.puuid].pending || bpProgress[a.puuid].error)));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) await fetchBpProgress(todo[i++].puuid).catch(() => {});
    };
    Promise.all([worker(), worker(), worker()]).catch(() => {});
  }

  /* ---------- agent mastery (Bloomline) ---------- */

  // Laid out like the game's Agent Mastery > Act Level page: the agent's portrait and name in
  // its own colour, the act's 30 levels as a segmented track, and the portrait upgrades at
  // levels 1, 4, 7 and 10. Mastery points per act level (the wiki's table; its level 9 total
  // is a typo for 109,900) and the lifetime-level frames come from the game, not the API.
  const MASTERY_STEPS = [2000, 8500, 9300, 10500, 12000, 13800, 15800, 17900, 20100, 22500, 35000, 78000, 205000, 418000];
  const MASTERY_CUM = [0];
  for (let i = 0; i < 30; i++) MASTERY_CUM.push(MASTERY_CUM[i] + (MASTERY_STEPS[i] || 715000));
  const MASTERY_UPGRADES = { 1: "Level indicator", 4: "Level indicator upgrade", 7: "Background upgrade", 10: "Background animation" };
  const MASTERY_FRAMES = [[30, "IV"], [20, "III"], [10, "II"], [0, "I"]];
  const bloom = {};
  let masSel = null;

  const masLevel = (pts) => {
    let l = 0;
    while (l < 30 && pts >= MASTERY_CUM[l + 1]) l++;
    return l;
  };
  const masFrame = (life) => (MASTERY_FRAMES.find(([min]) => life >= min) || [0, "I"])[1];

  // The agent's name takes the most vivid colour of its own background, lightened a little
  // so it reads on the dark page like the game's title.
  function masAccent(colors) {
    let best = null;
    for (const c of colors || []) {
      const n = parseInt(c.slice(1, 7), 16);
      if (!Number.isFinite(n)) continue;
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const score = Math.max(r, g, b) - Math.min(r, g, b) + Math.max(r, g, b) * 0.4;
      if (!best || score > best.score) best = { r, g, b, score };
    }
    if (!best) return "#e9ecf5";
    const mix = (v) => Math.round(v + (255 - v) * 0.6);
    return `rgb(${mix(best.r)}, ${mix(best.g)}, ${mix(best.b)})`;
  }

  function fetchBloom(puuid, force) {
    const box = bloom[puuid] || (bloom[puuid] = {});
    if (force) {
      box.data = null;
      box.error = null;
    }
    if (box.data || box.pending) return box.pending;
    box.error = null;
    box.pending = api(`/api/accounts/${encodeURIComponent(puuid)}/bloomline`, { timeoutMs: 35000 })
      .then((res) => {
        if (res && res.status === "relink") box.error = "Riot asked to sign in again. Re-link this account.";
        else if (res && res.agents) box.data = res;
        else box.error = (res && res.error) || "No agent mastery data for this account.";
      })
      .catch((err) => {
        box.error = err.message || "Could not load agent mastery.";
      })
      .finally(() => {
        box.pending = null;
        if (S.route.name === "account" && S.route.puuid === puuid && S.route.tab === "mastery") renderPanel();
      });
    return box.pending;
  }

  // The agent's square portrait in the game's frame: level I until lifetime level 10, then
  // II, III at 20 and IV at 30.
  function masPortrait(ag, size) {
    const frame = masFrame(ag.lifetime);
    return h("span", { class: `mas-face is-${size || "md"} f-${frame}`, title: `Level ${frame} frame` },
      ag.icon ? makeImg(ag.icon, ag.name) : fallbackText(ag.name));
  }

  function masRosterEl(agents, onPick) {
    return h("div", { class: "mas-roster", role: "listbox", "aria-label": "Agents" }, ...agents.map((ag) =>
      h("button", { class: `mas-pick${ag.id === masSel ? " is-on" : ""}${ag.points ? "" : " is-new"}`, type: "button", role: "option", "aria-selected": ag.id === masSel ? "true" : "false", onclick: () => onPick(ag.id) },
        masPortrait(ag, "sm"),
        h("span", { class: "mas-pick-name", text: ag.name }),
        h("span", { class: "mas-pick-lvl", title: "Act level", text: ag.points ? String(masLevel(ag.points)) : "-" }))));
  }

  function masStageEl(ag, actEnd) {
    const lvl = masLevel(ag.points);
    const accent = masAccent(ag.colors);
    const cols = ag.colors && ag.colors.length ? ag.colors : ["#33406b", "#0e1428"];
    const toward = lvl >= 30 ? 0 : ag.points - MASTERY_CUM[lvl];
    const need = lvl >= 30 ? 0 : MASTERY_CUM[lvl + 1] - MASTERY_CUM[lvl];
    const daysLeft = actEnd ? Math.max(0, Math.ceil((Date.parse(actEnd) - Date.now()) / 86400000)) : null;

    // 30 segments: the bar fills through the levels reached and part of the one being earned.
    const segs = [];
    for (let i = 1; i <= 30; i++) {
      const done = i <= lvl;
      const cur = i === lvl + 1;
      const fill = done ? 100 : cur && need ? Math.min(100, (toward / need) * 100) : 0;
      segs.push(h("span", { class: `mas-seg${done ? " is-done" : ""}${cur ? " is-cur" : ""}`, title: `Act level ${i}: ${fmt(MASTERY_CUM[i])} MP` },
        h("i", { style: `width:${fill.toFixed(1)}%` })));
    }
    const marks = Object.keys(MASTERY_UPGRADES).map(Number).map((n) => {
      const got = lvl >= n;
      return h("div", { class: `mas-mile${got ? " is-got" : ""}`, style: `left:${(((n - 0.5) / 30) * 100).toFixed(3)}%`, title: MASTERY_UPGRADES[n] },
        h("span", { class: "mas-mile-tick" }),
        h("span", { class: "mas-mile-face" }, ag.icon ? makeImg(ag.icon, "") : null, got ? null : iconEl("lock")),
        h("b", { text: `Act level ${n}` }),
        h("small", { text: `${fmt(MASTERY_CUM[n])} MP` }),
        h("small", { class: "mas-mile-up", text: MASTERY_UPGRADES[n] }));
    });

    const label = h("div", { class: "mas-now", style: `left:${((Math.min(lvl + 0.5, 29.5) / 30) * 100).toFixed(3)}%` },
      h("b", { text: ag.points ? `Act level ${lvl}` : "Not played" }),
      h("span", {}, h("em", { text: fmt(ag.points) }), lvl >= 30 ? " MP" : ` / ${fmt(MASTERY_CUM[lvl + 1])}`));

    const next = MASTERY_FRAMES.slice().reverse().find(([min]) => ag.lifetime < min && min > 0);
    return h("section", { class: "mas-stage", style: `--a:${accent};--c1:${cols[0]};--c2:${cols[cols.length > 2 ? 2 : cols.length - 1]}` },
      h("div", { class: "mas-art" }, ag.portrait ? makeImg(ag.portrait, "") : null),
      h("div", { class: "mas-head" },
        masPortrait(ag, "lg"),
        h("div", { class: "mas-title" },
          h("small", { text: "Act levels" }),
          h("h3", { text: ag.name }),
          h("span", { class: "mas-ends", text: daysLeft == null ? "" : daysLeft === 1 ? "Act ends in 1 day" : `Act ends in ${daysLeft} days` }),
          h("span", { class: "mas-prev", text: `Previous act level: ${ag.previous}` }))),
      h("div", { class: "mas-lifetime" },
        h("div", {}, h("small", { text: "Lifetime level" }), h("b", { text: String(ag.lifetime) })),
        h("div", {}, h("small", { text: "Frame" }), h("b", { text: masFrame(ag.lifetime) })),
        h("div", {}, h("small", { text: next ? `Frame ${next[1]} at` : "Top frame" }), h("b", { text: next ? `Level ${next[0]}` : "Unlocked" }))),
      h("div", { class: "mas-trackbox" },
        h("div", { class: "mas-track-scroll" },
          h("div", { class: "mas-track" }, label, h("div", { class: "mas-segs" }, ...segs), h("div", { class: "mas-miles" }, ...marks)))));
  }

  function renderMasteryPanel(box, a) {
    const st = bloom[a.puuid] || (bloom[a.puuid] = {});
    if (!st.data && !st.error && !st.pending) fetchBloom(a.puuid);
    const head = h("div", { class: "panel-head" }, h("h2", { text: "Agent mastery" }));
    box.appendChild(head);
    if (!st.data) {
      if (st.error && !st.pending) {
        box.appendChild(h("div", { class: "empty-state" }, iconEl("alert"), h("h3", { text: "Could not load agent mastery" }), h("p", { text: st.error }),
          h("button", { class: "btn btn-ghost", type: "button", onclick: () => { fetchBloom(a.puuid, true); renderPanel(); } }, iconEl("refresh"), "Try again")));
        return;
      }
      box.appendChild(h("div", { class: "mas-wrap" },
        h("div", { class: "mas-roster" }, ...Array.from({ length: 10 }, () => h("div", { class: "mas-pick sk" }))),
        h("section", { class: "mas-stage mas-stage-sk" },
          h("div", { class: "mas-head" }, h("span", { class: "mas-face is-lg sk" }), h("div", { class: "mas-title" }, h("span", { class: "sk sk-line w20" }), h("span", { class: "sk sk-line w60", style: "height:44px;margin-top:8px" }))),
          h("div", { class: "mas-trackbox" }, h("div", { class: "sk", style: "height:60px" })))));
      return;
    }
    head.appendChild(h("button", { class: "btn btn-ghost", type: "button", onclick: () => { fetchBloom(a.puuid, true); renderPanel(); } }, iconEl("refresh"), "Refresh"));
    const agents = st.data.agents.slice().sort((x, y) => y.points - x.points || y.lifetime - x.lifetime || x.name.localeCompare(y.name));
    if (!agents.length) {
      box.appendChild(h("div", { class: "empty-state" }, iconEl("info"), h("h3", { text: "No agents found" }), h("p", { text: "Agent mastery is not available right now." })));
      return;
    }
    if (!agents.some((x) => x.id === masSel)) masSel = agents[0].id;
    const wrap = h("div", { class: "mas-wrap" });
    const draw = () => {
      const ag = agents.find((x) => x.id === masSel) || agents[0];
      const scroll = window.scrollY;
      wrap.replaceChildren(masRosterEl(agents, (id) => { masSel = id; draw(); }), masStageEl(ag, st.data.actEnd));
      window.scrollTo({ top: scroll, behavior: "instant" });
    };
    draw();
    box.appendChild(wrap);
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
      const sharedWith = (share.recipients || []).length;
      const ok = await confirmDialog({
        title: "Stop sharing?",
        message: "Read-only access to this account ends for everyone you shared it with.",
        okLabel: "Stop sharing",
        danger: true,
        icon: "share",
        subject: acctSubject(a),
        points: [
          "The share code stops working right away.",
          sharedWith ? `${sharedWith} ${sharedWith === 1 ? "person loses" : "people lose"} access immediately.` : "Nobody has imported it yet, so no one is affected.",
          "You can create a new code any time.",
        ],
      });
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
          const ok = await confirmDialog({
            title: "Remove access?",
            message: "They can no longer see this account's shops.",
            okLabel: "Remove access",
            danger: true,
            icon: "user",
            subject: personSubject(r.name || r.id, "Read-only access to this account"),
            points: [
              "They lose access right away and it disappears from their list.",
              "They could import it again with the same code. Create a new code to prevent that.",
            ],
          });
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
    const current = S.accounts.find((x) => !x.shared && x.is_default && x.puuid !== a.puuid);
    const ok = await confirmDialog({
      title: "Set as main account?",
      message: "Discord commands like /shop use your main account when you do not pick one.",
      okLabel: "Set as main",
      icon: "crown",
      subject: acctSubject(a),
      points: [
        "It is pinned first in your account list.",
        current ? `${acctName(current)} stays linked and keeps its alerts.` : "Your other accounts stay linked and keep their alerts.",
      ],
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

  // A person (share recipient) as the same small card, for confirmation dialogs.
  function personSubject(name, meta) {
    return h("div", { class: "confirm-account" }, h("span", { class: "emblem" }, iconEl("user")), h("div", { class: "row-text" }, h("b", { text: name }), h("span", { text: meta })));
  }

  // The account as a small card (emblem, name, region) for confirmation dialogs.
  function acctSubject(a) {
    const meta = a.shared ? (a.sharedBy && a.sharedBy.name ? `Shared by ${a.sharedBy.name}` : "Shared with you") : a.is_default ? `Main account · ${(a.shard || "").toUpperCase()}` : (a.shard || "").toUpperCase();
    return h("div", { class: "confirm-account" }, emblemEl(a), h("div", { class: "row-text" }, h("b", null, nameNodes(acctName(a))), h("span", { text: meta })));
  }

  async function removeAccount(a) {
    const own = ownAccounts();
    const points = [
      "Its alerts stop.",
      "Any share code for it is revoked, and everyone it was shared with loses access.",
      "Its saved Riot sign-in is deleted from valorant shop.",
    ];
    if (a.is_default && own.length > 1) points.push("Another account becomes your main account.");
    if (own.length === 1) points.push("Your alert settings are cleared, since no accounts remain.");
    const ok = await confirmDialog({
      title: "Remove account?",
      message: "Nothing changes in VALORANT or at Riot. You can link it again any time, and your wishlist is kept.",
      okLabel: "Remove account",
      danger: true,
      icon: "trash",
      subject: acctSubject(a),
      points,
    });
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
    const ok = await confirmDialog({
      title: "Remove shared account?",
      message: "It leaves your list. You can import it again later if you still have the code.",
      okLabel: "Remove",
      danger: true,
      icon: "trash",
      subject: acctSubject(a),
    });
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
    showOverlay($("addOverlay"));
    prepareAddLink();
  }
  function closeAdd() {
    hideOverlay($("addOverlay"));
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
    showOverlay($("importOverlay"));
    $("shareCodeInput").focus();
  }
  function closeImport() {
    hideOverlay($("importOverlay"));
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
  const WL_PAGE = 48;
  const WL_TIERS = ["Select", "Deluxe", "Premium", "Exclusive", "Ultra"];
  const WL_CATEGORIES = ["Sidearm", "SMG", "Shotgun", "Rifle", "Sniper", "Heavy", "Melee"];
  const WL_CATEGORY_LABEL = { Sidearm: "Sidearms", SMG: "SMGs", Shotgun: "Shotguns", Rifle: "Rifles", Sniper: "Snipers", Heavy: "Heavy", Melee: "Melee" };
  const WL_TYPES = [["", "All"], ["buddy", "Buddies"], ["spray", "Sprays"], ["card", "Cards"], ["title", "Titles"]];
  const wlFreshFilters = () => ({ weapon: "", tier: "", collection: "", type: "", hide: false });
  let wlFilters = wlFreshFilters();
  let wlDD = {};
  // Weapon order inside a category where the game's own order beats alphabetical.
  const WL_WEAPON_ORDER = {
    Sidearm: ["Classic", "Shorty", "Frenzy", "Ghost", "Bandit", "Sheriff"],
    SMG: ["Stinger", "Spectre"],
    Sniper: ["Marshal", "Outlaw", "Operator"],
  };
  let wlIndexById = null;
  let wlIndexByName = null;
  // Wishlist entries only keep id, name and art. Tier, weapon and collection come
  // from the catalog index (by id, else by name) so they can show the same card.
  function wlEnrich(item) {
    if (!wlIndex) return item;
    if (!wlIndexById) {
      wlIndexById = new Map(wlIndex.map((x) => [x.id, x]));
      wlIndexByName = new Map(wlIndex.map((x) => [wlKey(x), x]));
    }
    const x = wlIndexById.get(item.id) || wlIndexByName.get(wlKey(item));
    return x ? { ...item, tier: x.tier, weapon: x.weapon, collection: x.collection } : item;
  }
  function wlLoadIndex() {
    const first = !wlIndex;
    return ensureWlIndex()
      .then(() => {
        fillWlFacets();
        if (first) renderWishlistGrid();
      })
      .catch(() => {});
  }
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
    try { localStorage.setItem("valo.wlCount", String(S.wishlist.daily.length + S.wishlist.accessory.length)); } catch { /* storage unavailable */ }
    renderWishlistUI();
  }

  // How many placeholder rows the wishlist shows while loading: the size it had last
  // time (capped), so the list does not jump when the real one arrives.
  function wlKnownCount() {
    try {
      const n = Number(localStorage.getItem("valo.wlCount"));
      if (Number.isFinite(n) && n > 0) return Math.min(n, 9);
    } catch { /* storage unavailable */ }
    return 4;
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
    // With "hide items on my wishlist" on, an added item has to leave the results.
    if (wlFilters.hide && $("wlPanel") && !$("wlPanel").hidden) {
      runWlSearch(true);
      return;
    }
    document.querySelectorAll("#wlPanel .wl-pick[data-item-id]").forEach((row) => {
      const on = isWishlisted({ id: row.dataset.itemId, name: row.dataset.itemName });
      row.classList.toggle("is-added", on);
      const tag = row.querySelector(".wl-pick-tag");
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
        onclick: () => { wlKind = kind; wlFilters = wlFreshFilters(); closeWlResults(); render(); },
      }, label, h("span", { class: "n", text: String(S.wishlist[kind].length) })));
    }
    const input = h("input", { type: "search", id: "wlSearchInput", class: "input", placeholder: wlKind === "daily" ? "Search skins, weapons or collections..." : "Search buddies, sprays, cards, titles...", autocomplete: "off", spellcheck: "false", "aria-label": "Search items" });
    const search = h("div", { class: "wl-search" }, h("label", { class: "search" }, iconEl("search"), input));
    view.appendChild(h("div", { class: "wl-bar" }, seg, search));
    view.appendChild(h("div", { class: "wl-filters", id: "wlFilters" }));
    view.appendChild(h("section", { class: "wl-panel", id: "wlPanel", hidden: true }));
    view.appendChild(h("div", { class: "section-title wl-list-title", id: "wlListTitle" }));
    view.appendChild(h("div", { class: "wl-picks", id: "wlGrid" }));
    view.appendChild(h("div", { id: "wlEmpty", hidden: true }));
    view.appendChild(
      h("div", { class: "tip wl-hint" }, iconEl("bell"),
        h("span", null, "Wishlist alerts are per account. Open an account's ", h("b", { text: "Alerts" }), " tab and turn on the wishlist switches."))
    );

    input.addEventListener("input", () => {
      if (wlSearchTimer) clearTimeout(wlSearchTimer);
      wlSearchTimer = setTimeout(() => runWlSearch(), 90);
    });
    input.addEventListener("focus", () => {
      wlLoadIndex();
    });
    buildWlFilters();
    renderWishlistGrid();
    runWlSearch(true);
    wlLoadIndex();
  }

  function renderWishlistGrid() {
    const grid = $("wlGrid");
    if (!grid) return;
    grid.innerHTML = "";
    const items = S.wishlist[wlKind] || [];
    const listTitle = $("wlListTitle");
    if (listTitle) {
      listTitle.innerHTML = "";
      listTitle.appendChild(h("span", { text: "On your wishlist" }));
      listTitle.appendChild(h("span", { class: "count", text: String(items.length) }));
    }
    for (const item of items) grid.appendChild(wlPick(wlEnrich(item), { listed: true }));
    const empty = $("wlEmpty");
    empty.innerHTML = "";
    if (!items.length) {
      empty.appendChild(
        S.wlLoaded
          ? h("div", { class: "empty-state" }, iconEl("star"), h("h3", { text: "Nothing here yet" }),
              h("p", { text: "Search above to add items, or tap the star on anything in a shop." }))
          : wlSkeleton(wlKnownCount())
      );
    }
    empty.hidden = items.length > 0;
  }

  function closeWlResults() {
    const panel = $("wlPanel");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
    wlRenderedKey = "";
  }

  // Empties the search box and every filter, then hides the results.
  function clearWlSearch() {
    const input = $("wlSearchInput");
    if (input) input.value = "";
    wlFilters = wlFreshFilters();
    syncWlFilterUI();
    closeWlResults();
  }

  function ensureWlIndex() {
    if (wlIndex) return Promise.resolve(wlIndex);
    if (wlIndexPromise) return wlIndexPromise;
    wlIndexPromise = api("/api/items/index", { timeoutMs: 30000 })
      .then((data) => {
        wlIndex = (data.items || []).map((x) => ({ id: x.i, name: x.n, type: x.t, icon: x.c, art: x.a ? { small: x.a.s, wide: x.a.w, large: x.a.l } : null, weapon: x.w || null, category: x.g || null, tier: x.e || null, collection: x.k || null }));
        wlIndexFailed = false;
        wlIndexById = null;
        wlIndexByName = null;
        return wlIndex;
      })
      .catch((err) => {
        wlIndexPromise = null;
        wlIndexFailed = true;
        throw err;
      });
    return wlIndexPromise;
  }

  // Every word of the query has to appear in the skin's name, weapon or
  // collection ("vandal prime"), and the filters narrow it further.
  function filterWlIndex(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const f = wlFilters;
    const out = [];
    for (const item of wlIndex) {
      if ((item.type === "skin" ? "daily" : "accessory") !== wlKind) continue;
      if (wlKind === "daily") {
        if (f.weapon && item.weapon !== f.weapon) continue;
        if (f.tier && item.tier !== f.tier) continue;
        if (f.collection && item.collection !== f.collection) continue;
      } else if (f.type && item.type !== f.type) continue;
      if (f.hide && isWishlisted(item)) continue;
      if (words.length) {
        const hay = `${item.name || ""} ${item.weapon || ""} ${item.collection || ""}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      out.push(item);
    }
    const first = words[0] || "";
    out.sort((a, b) => {
      const an = String(a.name || "").toLowerCase();
      const bn = String(b.name || "").toLowerCase();
      return (first && (an.startsWith(first) ? 0 : 1) - (bn.startsWith(first) ? 0 : 1)) || an.localeCompare(bn);
    });
    return out;
  }

  /* ---------- custom dropdown ---------- */
  // A button plus a listbox popover, so the closed control and the open list both
  // match the rest of the UI. `searchable` adds a filter box for long lists.
  // groups: [{ label: string | null, options: [{ value, text, n? }] }].
  let openDropdown = null;
  let ddBound = false;

  function closeDropdown() {
    if (openDropdown) openDropdown.close();
  }

  function dropdownEl({ id, label, allLabel, searchable, toggle, onChange }) {
    if (!ddBound) {
      ddBound = true;
      document.addEventListener("pointerdown", (e) => {
        if (openDropdown && !openDropdown.root.contains(e.target)) openDropdown.close();
      });
      window.addEventListener("resize", closeDropdown);
    }
    const labelEl = h("span", { class: "dd-label", text: allLabel });
    const btn = h("button", { type: "button", class: "dd-btn", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": label }, labelEl, iconEl("chevron-down"));
    const search = searchable
      ? h("input", { type: "search", class: "dd-search", placeholder: `Search ${label.toLowerCase()}s...`, "aria-label": `Search ${label.toLowerCase()}s`, autocomplete: "off", spellcheck: "false" })
      : null;
    const list = h("div", { class: "dd-list", role: "listbox", "aria-label": label });
    const pop = h("div", { class: "dd-pop", hidden: true }, search ? h("div", { class: "dd-search-wrap" }, iconEl("search"), search) : null, list);
    const root = h("div", { class: "dd", id }, btn, pop);
    let groups = [];
    let value = "";
    let opts = [];

    const visible = () => opts.filter((o) => !o.hidden);
    const render = () => {
      list.innerHTML = "";
      opts = [];
      for (const g of groups) {
        if (g.label) list.appendChild(h("div", { class: "dd-group", role: "presentation", text: g.label, dataset: { group: g.label } }));
        for (const o of g.options) {
          const el = h("button", { type: "button", class: "dd-opt", role: "option", tabindex: "-1", dataset: { value: o.value, group: g.label || "" } },
            h("span", { class: "dd-check" }, iconEl("check")),
            h("span", { class: "dd-text", text: o.text }),
            o.n != null ? h("span", { class: "dd-n", text: String(o.n) }) : null);
          el.addEventListener("click", () => pick(toggle && o.value === value ? "" : o.value));
          list.appendChild(el);
          opts.push(el);
        }
      }
      list.appendChild(h("div", { class: "dd-empty", hidden: true, text: "No matches." }));
      mark();
    };
    const mark = () => {
      let text = allLabel;
      for (const g of groups) for (const o of g.options) if (o.value === value && value !== "") text = o.text;
      labelEl.textContent = text;
      btn.classList.toggle("is-set", value !== "");
      for (const el of opts) {
        const on = el.dataset.value === value;
        el.classList.toggle("is-selected", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
      }
    };
    const filter = (q) => {
      const needle = q.trim().toLowerCase();
      let any = false;
      const shownGroups = new Set();
      for (const el of opts) {
        const text = el.querySelector(".dd-text").textContent.toLowerCase();
        const show = !needle || el.dataset.value === "" ? !needle : text.includes(needle);
        el.hidden = !show;
        if (show) {
          any = true;
          if (el.dataset.group) shownGroups.add(el.dataset.group);
        }
      }
      list.querySelectorAll(".dd-group").forEach((g) => { g.hidden = !shownGroups.has(g.dataset.group); });
      const empty = list.querySelector(".dd-empty");
      if (empty) empty.hidden = any;
    };
    const pick = (v) => {
      value = v;
      mark();
      close(true);
      onChange(v);
    };
    const place = () => {
      root.classList.remove("dd-up", "dd-right");
      const r = pop.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      if (r.bottom > innerHeight - 8 && b.top > r.height + 16) root.classList.add("dd-up");
      if (r.right > innerWidth - 8) root.classList.add("dd-right");
    };
    const open = () => {
      if (openDropdown && openDropdown.root !== root) openDropdown.close();
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      root.classList.add("is-open");
      place();
      openDropdown = api;
      const selected = opts.find((o) => o.classList.contains("is-selected") && !o.hidden);
      if (selected) selected.scrollIntoView({ block: "nearest" });
      const touch = window.matchMedia && matchMedia("(pointer: coarse)").matches;
      if (search && !touch) search.focus();
      else (selected || visible()[0] || btn).focus();
    };
    function close(restoreFocus) {
      if (pop.hidden) return;
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      root.classList.remove("is-open", "dd-up", "dd-right");
      if (search) {
        search.value = "";
        filter("");
      }
      if (openDropdown === api) openDropdown = null;
      if (restoreFocus) btn.focus();
    }
    const move = (from, dir) => {
      const list_ = visible();
      if (!list_.length) return;
      const i = list_.indexOf(from);
      const next = i < 0 ? (dir > 0 ? list_[0] : list_[list_.length - 1]) : list_[Math.max(0, Math.min(list_.length - 1, i + dir))];
      if (i === 0 && dir < 0 && search) search.focus();
      else next.focus();
    };

    btn.addEventListener("click", () => (pop.hidden ? open() : close(false)));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (pop.hidden) open();
      }
    });
    if (search) search.addEventListener("input", () => filter(search.value));
    pop.addEventListener("keydown", (e) => {
      const el = document.activeElement;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === "Tab") {
        close(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        move(el === search ? null : el, e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Home" || e.key === "End") {
        if (el === search) return;
        e.preventDefault();
        const v = visible();
        (e.key === "Home" ? v[0] : v[v.length - 1]).focus();
      } else if (e.key === "Enter" && el === search) {
        e.preventDefault();
        const first = visible().find((o) => o.dataset.value !== "") || visible()[0];
        if (first) pick(first.dataset.value);
      } else if (e.key.length === 1 && el !== search && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const hit = visible().find((o) => o.querySelector(".dd-text").textContent.toLowerCase().startsWith(e.key.toLowerCase()));
        if (hit) hit.focus();
      }
    });

    const api = {
      root,
      close,
      setGroups(next) {
        groups = next;
        render();
      },
      setValue(v) {
        value = v || "";
        mark();
      },
    };
    render();
    return api;
  }

  // Filter row: weapon, tier and collection for skins; type for accessories.
  // Built once per view, updated in place so a select never loses focus.
  function buildWlFilters() {
    const box = $("wlFilters");
    if (!box) return;
    box.innerHTML = "";
    closeDropdown();
    wlDD = {};
    const changed = () => {
      syncWlFilterUI();
      runWlSearch(true);
    };
    if (wlKind === "daily") {
      wlDD.weapon = dropdownEl({ id: "wlWeapon", label: "Weapon", allLabel: "All weapons", onChange: (v) => { wlFilters.weapon = v; changed(); } });
      wlDD.collection = dropdownEl({ id: "wlCollection", label: "Collection", allLabel: "Collection", searchable: true, toggle: true, onChange: (v) => { wlFilters.collection = v; changed(); } });
      const tiers = h("div", { class: "wl-pills", role: "group", "aria-label": "Tier" });
      for (const t of WL_TIERS) {
        const b = h("button", { type: "button", class: "pill pill-tier", title: t, "aria-label": t, dataset: { tier: t }, "aria-pressed": "false" }, tierIconEl(t) || t);
        b.addEventListener("click", () => { wlFilters.tier = wlFilters.tier === t ? "" : t; changed(); });
        tiers.appendChild(b);
      }
      box.appendChild(wlDD.weapon.root);
      box.appendChild(wlDD.collection.root);
      box.appendChild(tiers);
    } else {
      const types = h("div", { class: "wl-pills", role: "group", "aria-label": "Type" });
      for (const [value, label] of WL_TYPES) {
        const b = h("button", { type: "button", class: "pill", dataset: { type: value }, "aria-pressed": "false" }, label);
        b.addEventListener("click", () => { wlFilters.type = value; changed(); });
        types.appendChild(b);
      }
      box.appendChild(types);
    }
    const hide = h("button", { type: "button", class: "wl-hide", id: "wlHide", role: "switch", "aria-checked": "false" },
      h("span", { class: "wl-hide-track", "aria-hidden": "true" }), h("span", { text: "Hide items on my wishlist" }));
    hide.addEventListener("click", () => { wlFilters.hide = !wlFilters.hide; changed(); });
    box.appendChild(hide);
    const clear = h("button", { type: "button", class: "btn btn-quiet sm wl-clear", id: "wlClear", hidden: true }, iconEl("x"), "Clear");
    clear.addEventListener("click", clearWlSearch);
    box.appendChild(clear);
    fillWlFacets();
    syncWlFilterUI();
  }

  // Weapon and collection options come from the loaded index, with counts.
  function fillWlFacets() {
    if (!wlIndex || wlKind !== "daily" || !wlDD.weapon || !wlDD.collection) return;
    const byCat = new Map();
    const colls = new Map();
    for (const it of wlIndex) {
      if (it.type !== "skin") continue;
      if (it.weapon) {
        const cat = it.category || "Other";
        if (!byCat.has(cat)) byCat.set(cat, new Map());
        const m = byCat.get(cat);
        m.set(it.weapon, (m.get(it.weapon) || 0) + 1);
      }
      if (it.collection) colls.set(it.collection, (colls.get(it.collection) || 0) + 1);
    }
    const weaponRank = (cat, w) => {
      const i = (WL_WEAPON_ORDER[cat] || []).indexOf(w);
      return i < 0 ? 99 : i;
    };
    const cats = [...WL_CATEGORIES.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !WL_CATEGORIES.includes(c)).sort()];
    const weaponGroups = [{ label: null, options: [{ value: "", text: "All weapons" }] }];
    for (const cat of cats) {
      weaponGroups.push({
        label: WL_CATEGORY_LABEL[cat] || cat,
        options: [...byCat.get(cat)].sort((a, b) => weaponRank(cat, a[0]) - weaponRank(cat, b[0]) || a[0].localeCompare(b[0])).map(([w, n]) => ({ value: w, text: w, n })),
      });
    }
    wlDD.weapon.setGroups(weaponGroups);
    wlDD.collection.setGroups([
      { label: null, options: [...colls].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" })).map(([c, n]) => ({ value: c, text: c, n })) },
    ]);
  }

  function syncWlFilterUI() {
    const f = wlFilters;
    if (wlDD.weapon) wlDD.weapon.setValue(f.weapon);
    if (wlDD.collection) wlDD.collection.setValue(f.collection);
    document.querySelectorAll("#wlFilters [data-tier]").forEach((b) => {
      const on = b.dataset.tier === f.tier;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll("#wlFilters [data-type]").forEach((b) => {
      const on = b.dataset.type === f.type;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const hide = $("wlHide");
    if (hide) hide.setAttribute("aria-checked", f.hide ? "true" : "false");
    const input = $("wlSearchInput");
    const clear = $("wlClear");
    if (clear) clear.hidden = !(wlHasCriteria() || f.hide || (input && input.value));
  }

  function wlHasCriteria() {
    const input = $("wlSearchInput");
    const f = wlFilters;
    return Boolean((input && input.value.trim()) || (wlKind === "daily" ? f.weapon || f.tier || f.collection : f.type));
  }

  // Card for a search result and for the wishlist itself. The art opens the
  // preview; the details below toggle the wishlist state.
  function wlPick(item, opts) {
    const listed = Boolean(opts && opts.listed);
    const added = listed || isWishlisted(item);
    const color = tierColor(item.tier);
    const art = h("div", { class: "wl-pick-art" });
    const src = (item.type === "card" && item.art && item.art.small) || item.icon;
    if (item.type === "title") art.appendChild(h("span", { class: "title-text", text: titleName(item.name) }));
    else if (src) art.appendChild(imgOrFallback(src, item.name));
    else art.appendChild(fallbackText(item.name));
    const thumb = canPreview(item)
      ? h("button", { type: "button", class: "wl-pick-thumb", title: `Preview ${item.name || "item"}`, "aria-label": `Preview ${item.name || "item"}` }, art)
      : h("div", { class: "wl-pick-thumb" }, art);
    if (canPreview(item)) thumb.addEventListener("click", () => openPreview(item));
    const sub = h("span", { class: "wl-pick-sub" });
    if (item.type === "skin") {
      if (item.tier) sub.appendChild(tierIconEl(item.tier) || h("span", { style: color ? `color:${color}` : null, text: item.tier }));
    } else sub.textContent = TYPE_LABEL[item.type] || "";
    const label = added ? `Remove ${item.name || "item"} from wishlist` : `Add ${item.name || "item"} to wishlist`;
    const body = h("button", { type: "button", class: "wl-pick-body", title: added ? "Remove from wishlist" : "Add to wishlist", "aria-label": label },
      h("span", { class: "wl-pick-name", text: item.name || "Unknown", title: item.name || "" }),
      h("span", { class: "wl-pick-meta" }, sub, h("span", { class: "wl-pick-tag", text: listed ? "Remove" : added ? "Added" : "Add" })));
    body.addEventListener("click", () => {
      if (isWishlisted(item)) removeWishlist(item);
      else addWishlist(item);
    });
    return h("article", { class: `wl-pick${listed ? " is-listed" : added ? " is-added" : ""}`, style: color ? `--tier:${color}` : null, dataset: { itemId: String(item.id || ""), itemName: String(item.name || "") } }, thumb, body);
  }

  function renderWlPanel(list) {
    const panel = $("wlPanel");
    if (!panel) return;
    panel.innerHTML = "";
    panel.appendChild(
      h("div", { class: "wl-panel-head" }, h("span", { class: "wl-panel-count", text: `${fmt(list.length)} ${list.length === 1 ? "result" : "results"}` }))
    );
    if (!list.length) {
      panel.appendChild(h("div", { class: "wl-empty", text: "Nothing matches. Try fewer filters." }));
      panel.hidden = false;
      return;
    }
    const grid = h("div", { class: "wl-picks" });
    let shown = 0;
    const more = h("button", { class: "btn btn-ghost sm wl-more", type: "button" });
    const showNext = () => {
      for (const item of list.slice(shown, shown + WL_PAGE)) grid.appendChild(wlPick(item));
      shown = Math.min(list.length, shown + WL_PAGE);
      if (shown >= list.length) more.remove();
      else more.textContent = `Show more (${fmt(list.length - shown)} left)`;
    };
    more.addEventListener("click", showNext);
    panel.appendChild(grid);
    panel.appendChild(more);
    showNext();
    panel.hidden = false;
  }

  async function runWlSearch(force) {
    const input = $("wlSearchInput");
    const panel = $("wlPanel");
    if (!input || !panel) return;
    syncWlFilterUI();
    const q = input.value.trim();
    if (!wlHasCriteria()) {
      closeWlResults();
      return;
    }
    const key = JSON.stringify([wlKind, q, wlFilters]);
    if (!force && key === wlRenderedKey) return;
    if (!wlIndex && !wlIndexFailed) {
      panel.innerHTML = "";
      panel.appendChild(wlSkeleton(8));
      panel.hidden = false;
      try {
        await ensureWlIndex();
        fillWlFacets();
      } catch {
        /* fall back to server search */
      }
    }
    if (!$("wlSearchInput") || $("wlSearchInput").value.trim() !== q) return;
    if (!wlIndex) {
      try {
        const data = await api(`/api/items/search?q=${encodeURIComponent(q)}&kind=${wlKind}`);
        if ($("wlSearchInput") && $("wlSearchInput").value.trim() === q) renderWlPanel(data.results || []);
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    renderWlPanel(filterWlIndex(q));
    wlRenderedKey = key;
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
      if (e.target.closest(".star-btn")) return;
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
    setPreviewHead(item, null);
    const body = $("previewBody");
    body.innerHTML = "";
    body.appendChild(h("div", { class: "preview-stage sk" }));
    if (item.type === "skin") body.appendChild(previewFactsSkeleton());
    showOverlay($("previewOverlay"));
    let data;
    try {
      data = await previewData(item);
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(h("p", { class: "preview-empty", text: err.message || "Could not load this preview." }));
      return;
    }
    if ($("previewOverlay").hidden || $("previewOverlay").classList.contains("is-closing")) return;
    setPreviewHead(item, data);
    if (item.type === "card") renderCardPreview(data);
    else renderSkinPreview(item, data);
  }

  // Header of the preview dialog: the rarity icon in the icon box, the item name,
  // and "rarity · weapon" (or "Player card") under it. Called once with what the
  // card already knows and again when the full details arrive.
  function setPreviewHead(item, data) {
    const d = { ...item, ...(data || {}) };
    $("previewTitle").textContent = d.name || "Item";
    const box = $("previewIcon");
    const color = d.type === "skin" ? tierColor(d.tier) : null;
    const tierImg = d.type === "skin" ? tierIconEl(d.tier) : null;
    box.hidden = false;
    box.className = `dlg-icon${color ? " has-tier" : ""}`;
    box.style.cssText = color ? `--tier:${color}` : "";
    box.replaceChildren(tierImg || iconEl("sparkle"));
    const sub = $("previewSub");
    const parts = d.type === "skin" ? [d.tier, d.weapon] : [TYPE_LABEL[d.type]];
    const text = parts.filter(Boolean).join(" \u00b7 ");
    sub.textContent = text;
    sub.hidden = !text;
  }

  // Label and value tiles under the artwork. Only tiles with a value are shown.
  function previewFacts(d) {
    const fact = (label, ...value) => h("div", { class: "fact" }, h("span", { class: "fact-label", text: label }), h("b", { class: "fact-value" }, ...value));
    const tiles = [];
    if (d.tier) tiles.push(fact("Rarity", tierIconEl(d.tier), d.tier));
    if (d.weapon) tiles.push(fact("Weapon", d.weapon));
    if (d.collection) {
      const t = fact("Collection", h("span", { class: "fact-text", text: d.collection, title: d.collection }));
      tiles.push(t);
    }
    const levels = (d.levels || []).length;
    if (levels > 1) tiles.push(fact("Levels", String(levels)));
    return tiles.length ? h("div", { class: "preview-facts" }, ...tiles) : null;
  }

  function previewFactsSkeleton() {
    return h("div", { class: "preview-facts" }, ...[0, 1, 2].map(() => h("div", { class: "fact" }, h("span", { class: "sk sk-line w40" }), h("span", { class: "sk sk-line w80" }))));
  }

  function renderSkinPreview(item, data) {
    const body = $("previewBody");
    body.innerHTML = "";
    const chromas = (data.chromas || []).filter((c) => c && c.render);
    const stageImg = makeImg((chromas[0] && chromas[0].render) || data.render || item.icon || "", item.name || "Item", (img) => img.replaceWith(fallbackText(item.name)));
    stageImg.loading = "eager";
    const color = tierColor(item.tier || data.tier);
    body.appendChild(h("div", { class: `preview-stage${color ? " has-tier" : ""}`, style: color ? `--tier:${color}` : null }, stageImg));
    const facts = previewFacts({ ...item, ...data });
    if (facts) body.appendChild(facts);
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
    hideOverlay($("previewOverlay"), () => { $("previewBody").innerHTML = ""; });
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
      for (let i = 0; i < 2; i++) list.appendChild(h("div", { class: "bundle-card" }, h("div", { class: "bundle-banner sk", style: "border-radius:0" }), h("div", { class: "bundle-items" }, ...Array.from({ length: 4 }, () => h("div", { class: "card grid-sk" }, h("div", { class: "card-media sk", style: "border-radius:0" }), h("div", { class: "card-body" }, h("div", { class: "sk sk-line w80" }), h("div", { class: "sk sk-line w40" })))))));
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

  // Bundle items reuse the shop card (tier glow, art, name, price). No wishlist
  // star here: bundle items are not added to the wishlist from this page.
  // Prices stay at their base value: the discount is a whole-bundle deal, so
  // per-item strike-throughs would mislead. Skins show their tier, everything
  // else shows its type.
  function bundleItemEl(it) {
    const price = it.base != null ? it.base : it.disc;
    return card({ ...it, price: price != null ? price : null, currency: "vp" }, { banner: true, showType: it.type !== "skin" });
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
    const namesRow = h("div", { class: "row row-sub", hidden: !S.prefs.wishlist_nm },
      iconEl("eye"), h("div", { class: "row-text" }, h("b", { text: "Show item names" }), h("span", { text: "Off keeps it a surprise: the DM only says an item from your wishlist is in your Night Market." })),
      switchEl(S.prefs.nm_names, "Show item names in Night Market wishlist alerts", (on) => { S.prefs.nm_names = on; patchPrefs({ nm_names: on }).then(() => toast(`Item names ${on ? "shown" : "hidden"} in Night Market alerts.`, "ok"), () => {}); }));
    left.appendChild(
      h("div", { class: "rows" },
        h("div", { class: "row" }, iconEl("moon"), h("div", { class: "row-text" }, h("b", { text: "Night Market opens" }), h("span", { text: "One DM when the Night Market starts, for your main account." })),
          switchEl(S.prefs.nm, "Night Market alerts", (on) => { S.prefs.nm = on; patchPrefs({ nm: on }).then(() => toast(`Night Market alerts ${on ? "on" : "off"}.`, "ok"), () => {}); })),
        h("div", { class: "row" }, iconEl("star"), h("div", { class: "row-text" }, h("b", { text: "Wishlist in Night Market" }), h("span", { text: "A DM when a skin from your wishlist is in the Night Market of any of your accounts." })),
          switchEl(S.prefs.wishlist_nm, "Wishlist in Night Market alerts", (on) => { S.prefs.wishlist_nm = on; namesRow.hidden = !on; patchPrefs({ wishlist_nm: on }).then(() => toast(`Night Market wishlist alerts ${on ? "on" : "off"}.`, "ok"), () => {}); })),
        namesRow,
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
    showOverlay($("wipeOverlay"));
    // On a phone the keyboard would cover the dialog the moment it opens.
    if (!isTouchLayout()) $("wipeInput").focus();
  }
  function closeWipe() {
    hideOverlay($("wipeOverlay"));
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
      if (expired && !refreshing && now - lastRefreshAt > staleGap()) runAutoRefresh();
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

  // After a rotation Riot can serve the old shop for a few seconds. While anything
  // loaded is past its end we retry quickly, backing off so a stuck panel stays cheap.
  let staleTries = 0;
  function staleGap() {
    return Math.min(2500 * Math.pow(1.5, staleTries), 20000);
  }

  function endTimes() {
    const times = [];
    const add = (at) => { if (at) times.push(at); };
    for (const a of S.accounts) {
      const s = S.store[a.puuid];
      if (!s) continue;
      add(s.daily && s.daily.expiresAt);
      add(s.kingdomShop && s.kingdomShop.expiresAt);
      add(s.nightMarket && s.nightMarket.expiresAt);
    }
    for (const b of S.bundles || []) add(b.leavesAt);
    return times;
  }

  function hasStale() {
    const now = Date.now();
    return endTimes().some((at) => at <= now);
  }

  function nextExpiry() {
    const now = Date.now();
    let min = 0;
    for (const at of endTimes()) if (at > now && (min === 0 || at < min)) min = at;
    return min;
  }

  // A new bundle can show up on any hour (the bot checks at :00), not only when the
  // current one leaves, so a loaded bundles list is also re-read just after each hour.
  function nextHourCheck() {
    const now = Date.now();
    const at = Math.floor(now / 3600000) * 3600000 + 6000;
    return at > now ? at : at + 3600000;
  }

  function scheduleAutoRefresh() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    const now = Date.now();
    let delay;
    if (hasStale()) {
      delay = staleGap();
    } else {
      const expiry = nextExpiry();
      let fireAt = expiry ? expiry + 1500 : 0;
      if (S.bundles) {
        const hourly = nextHourCheck();
        if (!fireAt || hourly < fireAt) fireAt = hourly;
      }
      if (fireAt) delay = Math.min(Math.max(2000, fireAt - now), S.bundles ? 10 * 60 * 1000 : 30 * 60 * 1000);
      else if (S.accounts.some((a) => a.linked && !S.store[a.puuid])) delay = 20000;
      else if (S.accounts.some((a) => a.linked)) delay = 5 * 60 * 1000;
      else return;
    }
    autoTimer = setTimeout(runAutoRefresh, delay);
  }

  async function runAutoRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      // While waiting out a rotation, only the accounts that actually rotated are re-read.
      const staleNow = hasStale();
      const now = Date.now();
      const rotated = (a) => {
        const st = S.store[a.puuid];
        if (!st) return true;
        return [st.daily, st.kingdomShop, st.nightMarket].some((b) => b && b.expiresAt && b.expiresAt <= now);
      };
      const targets = S.accounts.filter((a) => a.linked && (!staleNow || rotated(a)));
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
      staleTries = hasStale() ? staleTries + 1 : 0;
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

    $("slClose").addEventListener("click", closeLoadShare);
    onBackdrop($("shareLinkOverlay"), closeLoadShare);

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
    });
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, { passive: true });

    document.addEventListener("keydown", (e) => {
      const box = $("wlPanel");
      if (e.key !== "Escape") return;
      if (menuEl) closeMenu();
      else if (!$("confirmOverlay").hidden) closeConfirm(false);
      else if (!$("wipeOverlay").hidden) closeWipe();
      else if (!$("previewOverlay").hidden) closePreview();
      else if (!$("importOverlay").hidden) closeImport();
      else if (!$("shareLinkOverlay").hidden) closeLoadShare();
      else if (!$("addOverlay").hidden) closeAdd();
      else if (box && !box.hidden) clearWlSearch();
      else if ($("sidebar").classList.contains("is-open")) closeSidebar();
    });

    // Lock page scroll while a modal is open. scrollbar-gutter keeps the
    // layout from shifting when the scrollbar comes and goes.
    const lock = () => {
      const locked = Boolean(document.querySelector(".overlay:not([hidden])")) || $("sidebar").classList.contains("is-open");
      document.documentElement.style.overflow = locked ? "hidden" : "";
    };
    const observer = new MutationObserver((records) => {
      lock();
      for (const r of records) if (r.target.classList && r.target.classList.contains("overlay")) onDialogToggle(r.target);
    });
    initDialogFocus();
    initSheetDrag($("addOverlay"), closeAdd);
    initSheetDrag($("importOverlay"), closeImport);
    initSheetDrag($("shareLinkOverlay"), closeLoadShare);
    initSheetDrag($("wipeOverlay"), closeWipe);
    initSheetDrag($("confirmOverlay"), () => closeConfirm(false));
    initSheetDrag($("previewOverlay"), closePreview);
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
