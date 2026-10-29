(() => {
  "use strict";

  // The link lives in the URL fragment, so it is never sent to the server as part of a
  // request line or a Referer. It is moved into memory and removed from the address bar.
  const TOKEN = location.hash.replace(/^#/, "");
  try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }

  const BASE = location.pathname.replace(/\/loadout-share\/?$/, "/");
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const modal = $("modal");
  // Links back to the main site, wherever it is mounted.
  for (const id of ["homeLink", "homeBtn", "homeFoot"]) $(id).href = BASE;
  document.querySelector(".foot-links a").href = BASE + "legal";

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "style") node.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  const fallback = (name) => h("span", { class: "fallback", text: String(name || "?").slice(0, 2).toUpperCase() });
  function img(src, alt) {
    if (!src) return fallback(alt);
    const i = document.createElement("img");
    i.loading = "lazy";
    i.decoding = "async";
    i.draggable = false;
    i.alt = alt || "";
    i.referrerPolicy = "no-referrer";
    i.onerror = () => i.replaceWith(fallback(alt));
    i.src = src;
    return i;
  }

  async function call(path, init) {
    const res = await fetch(BASE + path, { ...init, headers: { ...((init && init.headers) || {}), "X-Share-Token": TOKEN } });
    const data = await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- loadout layout (the same columns and tile sizes as the dashboard's Loadout tab) ---------- */

  const LOADOUT_COLUMNS = [
    [["Sidearms", ["Classic", "Shorty", "Frenzy", "Ghost", "Bandit", "Sheriff"]]],
    [["SMGs", ["Stinger", "Spectre"]], ["Shotguns", ["Bucky", "Judge"]], ["Melee", ["Melee"]]],
    [["Rifles", ["Bulldog", "Guardian", "Warden", "Phantom", "Vandal"]]],
    [["Sniper rifles", ["Marshal", "Outlaw", "Operator"]], ["Machine guns", ["Ares", "Odin"]]],
  ];
  const LOADOUT_GUN_WIDTH = {
    Classic: 0.44, Shorty: 0.62, Frenzy: 0.44, Ghost: 0.6, Bandit: 0.46, Sheriff: 0.54,
    Stinger: 0.66, Spectre: 0.68, Bucky: 0.8, Judge: 0.76, Melee: 0.6,
    Bulldog: 0.78, Guardian: 0.8, Warden: 0.8, Phantom: 0.8, Vandal: 0.8,
    Marshal: 0.8, Outlaw: 0.8, Operator: 0.8, Ares: 0.8, Odin: 0.8,
  };
  const TIER_COLORS = { select: "#5a9fe2", deluxe: "#009587", premium: "#d1548d", exclusive: "#f5955b", ultra: "#fad663" };
  const tierColor = (tier) => TIER_COLORS[String(tier || "").toLowerCase().replace(/\s*edition/gi, "").trim()] || null;
  const titleName = (name) => String(name || "").replace(/\s+title$/i, "").trim() || String(name || "Title");

  /* ---------- state ---------- */

  let V = null;          // what the server sent
  let nonce = "";
  let expiresAt = 0;
  let edits = null;      // { guns: { [weaponId]: { skin, level, chroma, buddy } }, cosmetics }
  let picker = null;     // { kind: "gun" | "card" | "slot", ... , tab }
  let hideBp = false;    // skin filter
  const Q = Object.create(null); // search text per list
  let done = false;

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const gunOf = (id) => V.guns.find((g) => g.weapon === id);
  const skinOf = (g, id) => g.skins.find((s) => s.id === id);

  function startEdits() {
    edits = { guns: {}, cosmetics: null };
    for (const g of V.guns) edits.guns[g.weapon] = clone(g.current);
    if (V.cosmetics) edits.cosmetics = { card: V.cosmetics.card, title: V.cosmetics.title, expressions: clone(V.cosmetics.expressions) };
  }
  function changedGuns() {
    return V.guns.filter((g) => {
      const e = edits.guns[g.weapon], c = g.current;
      return e.skin !== c.skin || e.level !== c.level || e.chroma !== c.chroma || e.buddy !== c.buddy;
    });
  }
  function changeCount() {
    let n = changedGuns().length;
    if (edits.cosmetics) {
      const c = V.cosmetics, e = edits.cosmetics;
      if (e.card !== c.card) n += 1;
      if (e.title !== c.title) n += 1;
      if (JSON.stringify(e.expressions) !== JSON.stringify(c.expressions)) n += 1;
    }
    return n;
  }

  // Current card, title and wheel as shown: the edited choice when cosmetics are editable,
  // otherwise what the account has equipped.
  function cardNow() {
    if (!edits.cosmetics) return V.identity.card;
    return V.cosmetics.cards.find((c) => c.id === edits.cosmetics.card) || V.identity.card;
  }
  function titleNow() {
    if (!edits.cosmetics) return V.identity.title;
    return V.cosmetics.titles.find((t) => t.id === edits.cosmetics.title) || V.identity.title;
  }
  function expressionInfo(x) {
    const lists = V.cosmetics ? (x.type === "flex" ? V.cosmetics.flexes : V.cosmetics.sprays) : [];
    return lists.find((i) => i.id === x.id) || V.identity.expressions.find((i) => i.id === x.id && i.type === x.type) || null;
  }
  const wheelNow = () => (edits.cosmetics ? edits.cosmetics.expressions : V.identity.expressions);

  /* ---------- loadout screen ---------- */

  function chromaIcon(skin, chromaId) {
    const c = skin.chromas.find((x) => x.id === chromaId);
    return c && c.icon;
  }

  function gunEl(g) {
    const e = edits.guns[g.weapon];
    const skin = skinOf(g, e.skin) || {};
    const random = skin.kind === "random";
    const buddy = e.buddy && V.buddies.find((b) => b.instance === e.buddy);
    const color = !random && tierColor(skin.tier);
    const art = chromaIcon(skin, e.chroma) || skin.icon;
    const changed = changedGuns().includes(g);
    return h("button", {
      type: "button",
      class: `lo-gun ls-click${random ? " is-random" : ""}${color ? " has-tier" : ""}${changed ? " is-changed" : ""}`,
      title: random ? `${g.name}: random favorite skin` : `${g.name}: ${skin.name || ""}`,
      style: `--gw:${LOADOUT_GUN_WIDTH[g.name] || 0.7}${color ? `;--tier:${color}` : ""}`,
      onclick: () => openPicker({ kind: "gun", weapon: g.weapon, tab: "skin" }),
    },
      h("div", { class: "lo-gun-art" }, art ? img(art, skin.name) : null),
      h("span", { class: `lo-weapon${!random && skin.name ? " has-skin" : ""}` }, h("span", { class: "lo-weapon-name", text: g.name }), !random && skin.name ? h("span", { class: "lo-skin-name", text: skin.name }) : null),
      buddy ? h("div", { class: "lo-buddy", title: buddy.name }, img(buddy.icon, buddy.name)) : null);
  }

  function noteIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "i");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M12 8v5M12 16.5v.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z");
    svg.appendChild(p);
    return svg;
  }

  function renderScreen() {
    const byName = new Map(V.guns.map((g) => [g.name, g]));
    const known = new Set(LOADOUT_COLUMNS.flatMap((col) => col.flatMap(([, list]) => list)));
    const screen = h("div", { class: "lo-screen" });
    LOADOUT_COLUMNS.forEach((groups, i) => {
      const col = h("div", { class: "lo-col" });
      for (const [label, weapons] of groups) {
        col.appendChild(h("h3", { class: "lo-h", text: label }));
        for (const w of weapons) {
          const g = byName.get(w);
          col.appendChild(g ? gunEl(g) : h("div", { class: "lo-gun is-empty" }, h("span", { class: "lo-weapon" }, h("span", { class: "lo-weapon-name", text: w }))));
        }
      }
      if (i === 2) for (const g of V.guns) if (!known.has(g.name)) col.appendChild(gunEl(g));
      screen.appendChild(col);
    });

    // Player card and the expression wheel.
    const editable = Boolean(V.cosmetics);
    const card = cardNow();
    const title = titleNow();
    const cardBox = h(editable ? "button" : "div", {
      type: editable ? "button" : null,
      class: `lo-card-wrap${editable ? " ls-click" : ""}`,
      onclick: editable ? () => openPicker({ kind: "card", tab: "card" }) : null,
    },
      h("div", { class: "lo-card", title: card ? card.name : "" }, card && card.large ? img(card.large, card.name) : h("div", { class: "lo-card-none", text: "No card equipped" })),
      h("div", { class: "lo-card-name" }, h("b", { text: "Player" }), title ? h("span", {}, h("i", { text: titleName(title.name) })) : null));
    const wheel = h("div", { class: "lo-wheel" }, h("span", { class: "lo-wheel-dot" }));
    ["top", "right", "bottom", "left"].forEach((pos, i) => {
      const x = wheelNow()[i];
      const info = x && expressionInfo(x);
      wheel.appendChild(h(editable ? "button" : "div", {
        type: editable ? "button" : null,
        class: `lo-slot ${pos}${editable ? " ls-click" : ""}`,
        title: info ? info.name : "",
        onclick: editable && x ? () => openPicker({ kind: "slot", index: i, tab: x.type === "flex" ? "flex" : "spray" }) : null,
      }, info && info.icon ? img(info.icon, info.name) : null));
    });
    screen.appendChild(h("div", { class: "lo-col lo-side" },
      h("h3", { class: "lo-h", text: "Player card" }), cardBox,
      V.identity.incognito ? h("span", { class: "chip lo-incognito", text: "Incognito" }) : null,
      h("h3", { class: "lo-h lo-expr-h", text: "Expressions" }), wheel));

    app.replaceChildren(
      h("div", { class: "ls-note" }, noteIcon(),
        h("span", {}, h("b", { text: "One save only. " }),
          "This link works for a single save and ends 30 minutes after it was made. Only items this account owns can be equipped, and nothing is sent until you press Save. ",
          V.cosmetics ? "Click a weapon, the player card or a spray slot to change it." : "Click a weapon to change its skin or gun buddy.")),
      h("div", { class: "ls-panel" }, h("div", { class: "lo-wrap ls-wrap" }, screen)));
  }

  /* ---------- picker (opens on click) ---------- */

  function openPicker(p) {
    picker = p;
    renderModal();
  }
  function closePicker() {
    picker = null;
    modal.hidden = true;
    modal.replaceChildren();
  }

  // A searchable grid. `items` is filtered by the search text and, optionally, `pass`.
  function listPane(key, items, tile, { pass, controls, header } = {}) {
    const search = h("input", { class: "input ls-search", type: "search", placeholder: "Search", value: Q[key] || "", "aria-label": "Search" });
    const grid = h("div", { class: "ls-grid" });
    function fill() {
      grid.replaceChildren();
      const q = (Q[key] || "").trim().toLowerCase();
      let n = 0;
      for (const it of items) {
        if (q && !String(it.name).toLowerCase().includes(q)) continue;
        if (pass && !pass(it)) continue;
        grid.appendChild(tile(it, fill));
        n += 1;
      }
      if (!n) grid.appendChild(h("p", { class: "muted", text: "Nothing found." }));
    }
    search.addEventListener("input", () => { Q[key] = search.value; fill(); });
    fill();
    const pane = h("div", { class: "ls-pane" }, h("div", { class: "ls-tools" }, search, controls ? controls(fill) : null), header ? header(fill) : null, grid);
    return pane;
  }

  function skinPane(g) {
    const e = edits.guns[g.weapon];
    const order = { standard: 0, random: 1, normal: 2 };
    const items = [...g.skins].sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
    const detail = h("div", { class: "ls-detail" });
    function drawDetail() {
      detail.replaceChildren();
      const cur = skinOf(g, e.skin);
      if (!cur) return;
      if (cur.levels.length > 1) {
        detail.appendChild(h("div", { class: "ls-row" }, h("span", { class: "lbl", text: "Level" }),
          ...cur.levels.map((l, i) => h("button", { type: "button", class: `btn sm ${e.level === l.id ? "" : "btn-ghost"}`, onclick: () => { e.level = l.id; changed(); drawDetail(); } }, String(i + 1)))));
      }
      if (cur.chromas.length > 1) {
        detail.appendChild(h("div", { class: "ls-row" }, h("span", { class: "lbl", text: "Variant" }),
          ...cur.chromas.map((c, i) => h("button", { type: "button", class: `ls-sw${e.chroma === c.id ? " is-sel" : ""}`, title: c.name || `Variant ${i + 1}`, onclick: () => { e.chroma = c.id; changed(); drawDetail(); } }, c.icon ? img(c.icon, c.name) : String(i + 1)))));
      }
    }
    const pane = listPane(`skin:${g.weapon}`, items, (s, fill) => {
      const sel = e.skin === s.id;
      return h("button", { type: "button", class: `ls-tile${sel ? " is-sel" : ""}`, onclick: () => {
        e.skin = s.id;
        e.level = s.levels[s.levels.length - 1].id;
        e.chroma = s.chromas[0].id;
        changed();
        drawDetail();
        fill();
      } },
        h("div", { class: "art" }, s.icon ? img(s.icon, s.name) : null),
        h("div", { class: "nm", title: s.name, text: s.name }),
        s.kind === "random" ? h("div", { class: "tag", text: "Random favorite" }) : s.kind === "standard" ? h("div", { class: "tag", text: "Standard" }) : s.bp ? h("div", { class: "tag", text: "Battle pass" }) : null);
    }, {
      // Battle pass skins can be hidden; the equipped one and the free skins always stay.
      pass: (s) => !(hideBp && s.bp && s.kind === "normal" && s.id !== e.skin),
      controls: (fill) => h("label", { class: "ls-check" },
        h("input", { type: "checkbox", checked: hideBp, onchange: (ev) => { hideBp = ev.target.checked; fill(); } }),
        h("span", { text: "Hide battle pass skins" })),
    });
    drawDetail();
    pane.insertBefore(detail, pane.lastChild);
    return pane;
  }

  function buddyPane(g) {
    const e = edits.guns[g.weapon];
    const items = [{ id: "", name: "No gun buddy", none: true }, ...V.buddies.map((b) => ({ id: b.instance, name: b.name, icon: b.icon }))];
    return listPane("buddy", items, (b, fill) => {
      const holder = b.none ? null : V.guns.find((x) => x.weapon !== g.weapon && edits.guns[x.weapon].buddy === b.id);
      const sel = b.none ? !e.buddy : e.buddy === b.id;
      return h("button", { type: "button", class: `ls-tile${sel ? " is-sel" : ""}`, onclick: () => {
        // One copy sits on one weapon at a time: taking it frees it from the other.
        if (holder) edits.guns[holder.weapon].buddy = null;
        e.buddy = b.none ? null : b.id;
        changed();
        fill();
      } },
        h("div", { class: "art" }, b.icon ? img(b.icon, b.name) : null),
        h("div", { class: "nm", title: b.name, text: b.name }),
        holder ? h("div", { class: "tag", text: `On ${holder.name}` }) : null);
    });
  }

  function cardPane() {
    const e = edits.cosmetics;
    return listPane("card", V.cosmetics.cards, (c, fill) => h("button", { type: "button", class: `ls-tile cardish${e.card === c.id ? " is-sel" : ""}`, onclick: () => { e.card = c.id; changed(); fill(); } },
      h("div", { class: "art" }, c.icon ? img(c.icon, c.name) : null), h("div", { class: "nm", title: c.name, text: c.name })));
  }
  function titlePane() {
    const e = edits.cosmetics;
    return listPane("title", V.cosmetics.titles, (t, fill) => h("button", { type: "button", class: `ls-tile txt${e.title === t.id ? " is-sel" : ""}`, onclick: () => { e.title = t.id; changed(); fill(); } },
      h("div", { class: "nm", title: t.name, text: titleName(t.name) })));
  }
  function slotPane(type) {
    const e = edits.cosmetics;
    const i = picker.index;
    const list = type === "flex" ? V.cosmetics.flexes : V.cosmetics.sprays;
    return listPane(type, list, (x, fill) => h("button", { type: "button", class: `ls-tile${e.expressions[i].type === type && e.expressions[i].id === x.id ? " is-sel" : ""}`, onclick: () => { e.expressions[i] = { type, id: x.id }; changed(); fill(); } },
      h("div", { class: "art" }, x.icon ? img(x.icon, x.name) : null), h("div", { class: "nm", title: x.name, text: x.name })));
  }

  function renderModal() {
    if (!picker) return closePicker();
    let title = "";
    let tabs = [];
    if (picker.kind === "gun") {
      const g = gunOf(picker.weapon);
      title = g.name;
      tabs = [{ id: "skin", label: "Skins", pane: () => skinPane(g) }];
      if (!g.melee) tabs.push({ id: "buddy", label: "Gun buddies", pane: () => buddyPane(g) });
    } else if (picker.kind === "card") {
      title = "Player card";
      tabs = [{ id: "card", label: "Cards", pane: cardPane }, { id: "title", label: "Titles", pane: titlePane }];
    } else {
      title = `Expression slot ${picker.index + 1}`;
      tabs = [{ id: "spray", label: "Sprays", pane: () => slotPane("spray") }, { id: "flex", label: "Flexes", pane: () => slotPane("flex") }];
    }
    if (!tabs.some((t) => t.id === picker.tab)) picker.tab = tabs[0].id;
    const current = tabs.find((t) => t.id === picker.tab);
    modal.hidden = false;
    modal.replaceChildren(h("div", { class: "ls-dlg", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "ls-dlg-head" }, h("h2", { text: title }),
        h("div", { class: "ls-tabs" }, ...tabs.map((t) => h("button", { type: "button", class: `btn sm ${t.id === picker.tab ? "" : "btn-ghost"}`, onclick: () => { picker.tab = t.id; renderModal(); } }, t.label))),
        h("button", { type: "button", class: "btn btn-ghost sm", onclick: closePicker }, "Done")),
      current.pane()));
  }
  modal.addEventListener("click", (e) => { if (e.target === modal) closePicker(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picker) closePicker(); });

  // Called after any edit: the loadout behind the picker and the save bar follow along.
  function changed() {
    renderScreen();
    updateBar();
  }

  /* ---------- save bar ---------- */

  function setMsg(text, kind) {
    const m = $("barMsg");
    m.textContent = text || "";
    m.className = `ls-bar-msg${kind === "changes" ? " has-changes" : kind ? ` is-${kind}` : ""}`;
  }
  function updateBar() {
    if (!V || done) return;
    const n = changeCount();
    $("bar").hidden = false;
    $("saveBtn").disabled = n === 0;
    $("resetBtn").disabled = n === 0;
    setMsg(n ? `${n} change${n === 1 ? "" : "s"} not saved yet` : "No changes yet", n ? "changes" : "");
  }

  async function save() {
    const btn = $("saveBtn");
    btn.disabled = true;
    setMsg("Saving...", "");
    const payload = { nonce, guns: edits.guns };
    if (edits.cosmetics) payload.cosmetics = edits.cosmetics;
    try {
      const res = await call("api/loadshare/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.saved) { setMsg(res.message || "Nothing was changed.", ""); nonce = res.nonce || nonce; btn.disabled = false; return; }
      done = true;
      closePicker();
      $("bar").hidden = true;
      app.replaceChildren(h("div", { class: "ls-end" },
        h("h2", { text: "Saved" }),
        h("p", { class: "muted", text: res.verified === false ? "Riot accepted the change but did not keep all of it. Check the loadout in-game. This link is now used up." : "The loadout was updated. This link is now used up." })));
    } catch (err) {
      if (err.status === 410 || err.status === 404) return finish(err.message);
      setMsg(err.message, "error");
      btn.disabled = false;
      if (err.status === 409) setTimeout(() => location.reload(), 1500);
    }
  }

  function finish(message) {
    done = true;
    V = null;
    closePicker();
    $("bar").hidden = true;
    $("timer").hidden = true;
    app.replaceChildren(h("div", { class: "ls-end" }, h("h2", { text: "Link unavailable" }), h("p", { class: "muted", text: message })));
  }

  function tick() {
    if (!expiresAt || done) return;
    const left = expiresAt - Date.now();
    if (left <= 0) return finish("This link has expired.");
    const t = $("timer");
    t.hidden = false;
    t.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} left`;
    t.classList.toggle("is-low", left < 5 * 60000);
  }

  $("saveBtn").addEventListener("click", save);
  $("resetBtn").addEventListener("click", () => { startEdits(); changed(); if (picker) renderModal(); });

  (async () => {
    if (!TOKEN) return finish("This link is not valid.");
    try {
      const res = await call("api/loadshare/view");
      V = res.view;
      nonce = res.nonce;
      expiresAt = res.expiresAt;
      startEdits();
      renderScreen();
      updateBar();
      tick();
      setInterval(tick, 1000);
    } catch (err) {
      finish(err.message);
    }
  })();
})();
