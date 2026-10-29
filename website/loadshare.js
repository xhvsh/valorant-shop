(() => {
  "use strict";

  // The link lives in the URL fragment, so it is never sent to the server as part of a
  // request line or a Referer. It is moved into memory and removed from the address bar.
  const TOKEN = location.hash.replace(/^#/, "");
  try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }

  const BASE = location.pathname.replace(/\/loadout-share\/?$/, "/");
  const $ = (id) => document.getElementById(id);
  const app = $("app");

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
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
  const img = (src, alt) => {
    const i = document.createElement("img");
    i.loading = "lazy";
    i.decoding = "async";
    i.alt = alt || "";
    i.referrerPolicy = "no-referrer";
    if (src) i.src = src;
    return i;
  };

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

  let V = null;          // what the server sent: guns, buddies, cosmetics
  let nonce = "";
  let expiresAt = 0;
  let edits = null;      // { guns: { [weaponId]: { skin, level, chroma, buddy } }, cosmetics }
  let selected = null;   // weapon id being edited
  let tab = "skin";
  let filter = "";
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

  /* ---------- rendering ---------- */

  function render() {
    app.replaceChildren();
    app.appendChild(h("div", { class: "ls-note" },
      h("b", { text: "One save only. " }),
      "This link works for a single save and ends 30 minutes after it was made. Only items this account owns can be equipped, and nothing is sent until you press Save."));
    app.appendChild(gunsSection());
    if (selected && gunOf(selected)) app.appendChild(editor(gunOf(selected)));
    if (V.cosmetics) app.appendChild(cosmeticsSection());
    updateBar();
  }

  function gunsSection() {
    const grid = h("div", { class: "ls-guns" });
    for (const g of V.guns) {
      const e = edits.guns[g.weapon];
      const skin = skinOf(g, e.skin);
      const buddy = e.buddy && V.buddies.find((b) => b.instance === e.buddy);
      const changed = changedGuns().includes(g);
      grid.appendChild(h("button", {
        type: "button",
        class: `ls-gun${selected === g.weapon ? " is-sel" : ""}${changed ? " is-changed" : ""}`,
        onclick: () => { selected = g.weapon; tab = "skin"; filter = ""; render(); },
      },
        h("div", { class: "ls-gun-art" }, skin && skin.icon ? img(chromaIcon(skin, e.chroma) || skin.icon, skin.name) : null),
        h("div", { class: "ls-gun-name" }, g.name, h("span", { class: "ls-gun-skin", text: skin ? skin.name : "" })),
        buddy ? h("div", { class: "ls-gun-buddy" }, img(buddy.icon, buddy.name)) : null));
    }
    return h("section", { class: "ls-sec" }, h("h2", { text: "Weapons" }), grid);
  }

  function chromaIcon(skin, chromaId) {
    const c = skin.chromas.find((x) => x.id === chromaId);
    return c && c.icon;
  }

  function editor(g) {
    const e = edits.guns[g.weapon];
    const tabs = h("div", { class: "ls-tabs" },
      h("button", { type: "button", class: `btn sm ${tab === "skin" ? "" : "btn-ghost"}`, onclick: () => { tab = "skin"; render(); } }, "Skin"),
      g.melee ? null : h("button", { type: "button", class: `btn sm ${tab === "buddy" ? "" : "btn-ghost"}`, onclick: () => { tab = "buddy"; render(); } }, "Gun buddy"));
    const body = tab === "buddy" && !g.melee ? buddyPicker(g, e) : skinPicker(g, e);
    return h("section", { class: "ls-edit" }, h("h3", { text: g.name }), tabs, body);
  }

  function skinPicker(g, e) {
    const wrap = h("div", { style: "display:grid;gap:12px" });
    const search = h("input", { class: "input ls-search", type: "search", placeholder: "Search skins", value: filter, "aria-label": "Search skins" });
    search.addEventListener("input", () => { filter = search.value; fill(); });
    const grid = h("div", { class: "ls-grid" });
    const detail = h("div", { style: "display:grid;gap:8px" });
    const order = { standard: 0, random: 1, normal: 2 };
    const list = [...g.skins].sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
    function fill() {
      grid.replaceChildren();
      const q = filter.trim().toLowerCase();
      for (const s of list) {
        if (q && !s.name.toLowerCase().includes(q)) continue;
        grid.appendChild(h("button", { type: "button", class: `ls-tile${e.skin === s.id ? " is-sel" : ""}`, onclick: () => pick(s) },
          h("div", { class: "art" }, s.icon ? img(s.icon, s.name) : null),
          h("div", { class: "nm", title: s.name, text: s.name }),
          s.kind === "random" ? h("div", { class: "tag", text: "Random favorite" }) : s.kind === "standard" ? h("div", { class: "tag", text: "Standard" }) : null));
      }
    }
    function pick(s) {
      e.skin = s.id;
      e.level = s.levels[s.levels.length - 1].id;
      e.chroma = s.chromas[0].id;
      render();
    }
    const cur = skinOf(g, e.skin);
    if (cur && (cur.levels.length > 1 || cur.chromas.length > 1)) {
      if (cur.levels.length > 1) {
        detail.appendChild(h("div", { class: "ls-row" }, h("span", { class: "lbl", text: "Level" }),
          ...cur.levels.map((l, i) => h("button", { type: "button", class: `btn sm ${e.level === l.id ? "" : "btn-ghost"}`, onclick: () => { e.level = l.id; render(); } }, String(i + 1)))));
      }
      if (cur.chromas.length > 1) {
        detail.appendChild(h("div", { class: "ls-row" }, h("span", { class: "lbl", text: "Variant" }),
          ...cur.chromas.map((c, i) => h("button", { type: "button", class: `ls-sw${e.chroma === c.id ? " is-sel" : ""}`, title: c.name || `Variant ${i + 1}`, onclick: () => { e.chroma = c.id; render(); } }, c.icon ? img(c.icon, c.name) : String(i + 1)))));
      }
    }
    wrap.append(search, detail, grid);
    fill();
    return wrap;
  }

  function buddyPicker(g, e) {
    const grid = h("div", { class: "ls-grid" });
    grid.appendChild(h("button", { type: "button", class: `ls-tile${e.buddy ? "" : " is-sel"}`, onclick: () => { e.buddy = null; render(); } },
      h("div", { class: "art" }), h("div", { class: "nm", text: "No gun buddy" })));
    for (const b of V.buddies) {
      const holder = V.guns.find((x) => x.weapon !== g.weapon && edits.guns[x.weapon].buddy === b.instance);
      grid.appendChild(h("button", {
        type: "button",
        class: `ls-tile${e.buddy === b.instance ? " is-sel" : ""}`,
        onclick: () => {
          // A copy sits on one weapon at a time: taking it frees it from the other.
          if (holder) edits.guns[holder.weapon].buddy = null;
          e.buddy = b.instance;
          render();
        },
      },
        h("div", { class: "art" }, b.icon ? img(b.icon, b.name) : null),
        h("div", { class: "nm", title: b.name, text: b.name }),
        holder ? h("div", { class: "tag", text: `On ${holder.name}` }) : null));
    }
    return h("div", { style: "display:grid;gap:12px" },
      V.buddies.length ? null : h("p", { class: "muted", text: "This account has no gun buddies." }), grid);
  }

  function cosmeticsSection() {
    const C = V.cosmetics, e = edits.cosmetics;
    const cards = h("div", { class: "ls-grid" });
    for (const c of C.cards) {
      cards.appendChild(h("button", { type: "button", class: `ls-tile cardish${e.card === c.id ? " is-sel" : ""}`, onclick: () => { e.card = c.id; render(); } },
        h("div", { class: "art" }, c.icon ? img(c.icon, c.name) : null), h("div", { class: "nm", title: c.name, text: c.name })));
    }
    const titleSel = h("select", { "aria-label": "Title" });
    for (const t of C.titles) titleSel.appendChild(h("option", { value: t.id, text: t.name, selected: t.id === e.title }));
    titleSel.addEventListener("change", () => { e.title = titleSel.value; updateBar(); });

    const slots = h("div", { class: "ls-slots" });
    e.expressions.forEach((x, i) => {
      const sel = h("select", { "aria-label": `Slot ${i + 1}` });
      const sp = h("optgroup", { label: "Sprays" }), fx = h("optgroup", { label: "Flexes" });
      for (const s of C.sprays) sp.appendChild(h("option", { value: `spray:${s.id}`, text: s.name, selected: x.type === "spray" && x.id === s.id }));
      for (const f of C.flexes) fx.appendChild(h("option", { value: `flex:${f.id}`, text: f.name, selected: x.type === "flex" && x.id === f.id }));
      sel.append(sp, fx);
      sel.addEventListener("change", () => { const [type, id] = sel.value.split(":"); e.expressions[i] = { type, id }; updateBar(); });
      slots.appendChild(h("label", {}, `Slot ${i + 1}`, sel));
    });
    return h("section", { class: "ls-sec" }, h("h2", { text: "Cosmetics" }),
      h("div", { class: "ls-edit" },
        h("h3", { text: "Player card" }), cards,
        h("h3", { text: "Title" }), h("div", { class: "ls-row" }, titleSel),
        h("h3", { text: "Sprays and flexes" }), slots));
  }

  /* ---------- save bar ---------- */

  function setMsg(text, kind) {
    const m = $("barMsg");
    m.textContent = text || "";
    m.className = `ls-bar-msg${kind ? ` is-${kind}` : ""}`;
  }
  function updateBar() {
    if (!V || done) return;
    const n = changeCount();
    $("bar").hidden = false;
    $("saveBtn").disabled = n === 0;
    $("resetBtn").disabled = n === 0;
    setMsg(n ? `${n} change${n === 1 ? "" : "s"} not saved yet` : "No changes yet", "");
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
  $("resetBtn").addEventListener("click", () => { startEdits(); render(); });

  (async () => {
    if (!TOKEN) return finish("This link is not valid.");
    try {
      const res = await call("api/loadshare/view");
      V = res.view;
      nonce = res.nonce;
      expiresAt = res.expiresAt;
      startEdits();
      selected = V.guns[0] ? V.guns[0].weapon : null;
      render();
      tick();
      setInterval(tick, 1000);
    } catch (err) {
      finish(err.message);
    }
  })();
})();
