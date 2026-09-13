import {
  call,
  send,
  el,
  make,
  on,
  toast,
  showError,
  hostOf,
  copyViaBackground,
  download,
  readFile,
  formatDate,
  strengthMeter,
} from "./ui.js";

let status = null;
let settings = null;
let items = [];
let selectedId = null;
let current = null;
let totpTimer = null;
let view = "entries";

const VIEWS = ["entries", "generator", "data", "settings", "diag"];

async function boot() {
  status = await call({ type: "STATUS" });
  settings = status.settings || null;
  renderGate();
  if (status.unlocked) {
    await enterApp();
  }
  route();
}

async function enterApp() {
  status = await call({ type: "STATUS" });
  settings = status.settings;
  renderGate();
  el("vault-meta").textContent =
    `${status.count} entri · ${status.kdf ? status.kdf.iterations.toLocaleString("id-ID") : "-"} iterasi`;
  await refreshList();
  loadSettingsForm();
}

function renderGate() {
  const locked = !status.unlocked;
  el("gate").classList.toggle("hidden", !locked);
  el("tabs").classList.toggle("hidden", locked);
  el("btn-lock").classList.toggle("hidden", !locked);
  el("lock-dot").classList.toggle("is-open", Boolean(status.unlocked));
  for (const v of VIEWS) {
    el("view-" + v).classList.add("hidden");
  }
  if (locked) {
    const create = !status.initialized;
    el("gate-create").classList.toggle("hidden", !create);
    el("gate-unlock").classList.toggle("hidden", create);
    el("gate-title").textContent = create ? "Buat vault lokal" : "Buka vault";
    el("gate-submit").textContent = create ? "Buat vault" : "Buka vault";
    el("vault-meta").textContent = "";
    if (create) {
      el("new-iter").value = String(settings ? settings.iterations : 600000);
    } else {
      el("mp").focus();
    }
    return;
  }
  setView(view);
}

function setView(name) {
  view = VIEWS.includes(name) ? name : "entries";
  for (const v of VIEWS) {
    el("view-" + v).classList.toggle("hidden", v !== view);
  }
  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("is-on", btn.dataset.view === view);
  }
  if (view === "diag") {
    runDiagnostics();
  }
}

function parseHash() {
  const h = String(location.hash || "").replace(/^#/, "");
  if (!h) {
    return { view: "entries" };
  }
  const eq = h.indexOf("=");
  if (eq > 0) {
    return { view: h.slice(0, eq), arg: h.slice(eq + 1) };
  }
  return { view: h };
}

function route() {
  if (!status.unlocked) {
    return;
  }
  const r = parseHash();
  if (r.view === "edit") {
    setView("entries");
    select(r.arg);
    return;
  }
  if (r.view === "new") {
    setView("entries");
    newEntry(decodeURIComponent(r.arg || ""));
    return;
  }
  setView(r.view);
}

window.addEventListener("hashchange", route);

for (const btn of document.querySelectorAll(".tab")) {
  on(btn, "click", () => {
    location.hash = btn.dataset.view;
    setView(btn.dataset.view);
  });
}

on(el("gate-submit"), "click", async () => {
  showError(el("gate-error"), "");
  el("gate-submit").disabled = true;
  try {
    if (!status.initialized) {
      const p1 = el("new-pass").value;
      const p2 = el("new-pass2").value;
      if (p1.length < 8) {
        throw new Error("Password master minimal 8 karakter.");
      }
      if (p1 !== p2) {
        throw new Error("Konfirmasi password tidak cocok.");
      }
      await call({
        type: "CREATE",
        password: p1,
        iterations: Number(el("new-iter").value),
      });
      el("new-pass").value = "";
      el("new-pass2").value = "";
    } else {
      const password = el("mp").value;
      if (!password) {
        throw new Error("Masukkan password master.");
      }
      await call({ type: "UNLOCK", password });
      el("mp").value = "";
    }
    await enterApp();
    toast("Vault terbuka");
  } catch (err) {
    showError(el("gate-error"), err.message);
  } finally {
    el("gate-submit").disabled = false;
  }
});

on(el("mp"), "keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    el("gate-submit").click();
  }
});

on(el("new-pass"), "input", () => {
  const m = strengthMeter(el("new-pass").value);
  el("new-meter").style.width = m.pct + "%";
  el("new-meter").style.background = m.color;
  el("new-hint").textContent = m.bits
    ? `${m.bits} bit entropi · ${m.text}`
    : "";
});

on(el("btn-lock"), "click", async () => {
  await call({ type: "LOCK" });
  current = null;
  selectedId = null;
  items = [];
  status = await call({ type: "STATUS" });
  renderGate();
  toast("Vault terkunci");
});

async function refreshList() {
  const q = el("search").value;
  const res = await call({ type: "LIST", query: q });
  items = res.items;
  el("count").textContent = `${items.length} entri`;
  const box = el("list");
  box.replaceChildren();
  if (items.length === 0) {
    box.appendChild(make("div", "empty", "Tidak ada entri."));
    return;
  }
  for (const it of items) {
    const node = make(
      "div",
      "item" + (it.id === selectedId ? " is-active" : ""),
    );
    const main = make("div", "item__main");
    main.append(
      make("div", "item__title", it.favorite ? "★ " + it.title : it.title),
      make("div", "item__sub", it.username || it.url || ""),
    );
    const acts = make("div", "item__actions");
    const fav = make("button", "btn btn--sm", it.favorite ? "★" : "☆");
    fav.type = "button";
    fav.title = "Favorit";
    on(fav, "click", async (ev) => {
      ev.stopPropagation();
      await call({ type: "FAVORITE", id: it.id });
      await refreshList();
    });
    acts.appendChild(fav);
    node.append(main, acts);
    on(node, "click", () => select(it.id));
    box.appendChild(node);
  }
}

let searchTimer = null;
on(el("search"), "input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(refreshList, 140);
});

on(el("btn-new"), "click", () => newEntry(""));

function newEntry(url) {
  current = null;
  selectedId = null;
  el("editor").classList.remove("hidden");
  el("detail-empty").classList.add("hidden");
  el("f-title").value = url ? hostOf(url) || "entri baru" : "";
  el("f-url").value = url || "";
  el("f-username").value = "";
  el("f-password").value = "";
  el("f-totp").value = "";
  el("f-tags").value = "";
  el("f-notes").value = "";
  el("f-fav").textContent = "☆";
  renderCustomFields([]);
  el("f-history").classList.add("hidden");
  el("f-meta").textContent = "entri baru";
  showError(el("edit-error"), "");
  updateMeter();
  startTotpTicker();
  el("f-title").focus();
  markUnsaved();
}

function markUnsaved() {
  for (const node of el("list").querySelectorAll(".item")) {
    node.classList.remove("is-active");
  }
}

async function select(id) {
  selectedId = id;
  for (const node of el("list").querySelectorAll(".item")) {
    node.classList.toggle(
      "is-active",
      node.querySelector(".item__sub") !== null && false,
    );
  }
  try {
    current = await call({ type: "GET", id });
  } catch (err) {
    showError(el("edit-error"), err.message);
    return;
  }
  el("editor").classList.remove("hidden");
  el("detail-empty").classList.add("hidden");
  el("f-title").value = current.title || "";
  el("f-url").value = current.url || "";
  el("f-username").value = current.username || "";
  el("f-password").value = current.password || "";
  el("f-password").type = "password";
  el("f-reveal").textContent = "lihat";
  el("f-totp").value = current.totp || "";
  el("f-tags").value = (current.tags || []).join(", ");
  el("f-notes").value = current.notes || "";
  renderCustomFields(current.fields || []);
  el("f-fav").textContent = current.favorite ? "★" : "☆";
  el("f-meta").textContent =
    `dibuat ${formatDate(current.createdAt)} · diubah ${formatDate(current.updatedAt)} · id ${current.id}`;
  showError(el("edit-error"), "");
  renderHistory();
  updateMeter();
  startTotpTicker();
  refreshList();
}

function renderCustomFields(fields) {
  const box = el("f-custom-fields");
  box.replaceChildren();
  const list = Array.isArray(fields) ? fields : [];
  for (const f of list) {
    box.appendChild(customFieldRow(f));
  }
}

function customFieldRow(f = {}) {
  const row = make("div", "row");
  row.className = "row custom-field-row";

  const nameInput = make("input", "input sm");
  nameInput.type = "text";
  nameInput.placeholder = "Label (mis. NIP)";
  nameInput.value = f.label || f.name || "";
  nameInput.className = "input sm custom-field-label";

  const valInput = make("input", "input mono grow");
  valInput.type = f.type === "password" ? "password" : "text";
  valInput.placeholder = "Nilai";
  valInput.value = f.value || "";
  valInput.className = "input mono grow custom-field-val";

  const typeSel = make("select", "input sm custom-field-type");
  const optText = make("option", "", "Teks");
  optText.value = "text";
  const optPass = make("option", "", "Sandi");
  optPass.value = "password";
  typeSel.append(optText, optPass);
  typeSel.value = f.type === "password" ? "password" : "text";
  on(typeSel, "change", () => {
    valInput.type = typeSel.value === "password" ? "password" : "text";
  });

  const delBtn = make("button", "btn btn--sm btn--danger", "×");
  delBtn.type = "button";
  delBtn.title = "Hapus field ini";
  on(delBtn, "click", () => row.remove());

  row.append(nameInput, valInput, typeSel, delBtn);
  return row;
}

function collectCustomFields() {
  const rows = el("f-custom-fields").querySelectorAll(".custom-field-row");
  const out = [];
  for (const r of rows) {
    const label = r.querySelector(".custom-field-label").value.trim();
    const val = r.querySelector(".custom-field-val").value;
    const type = r.querySelector(".custom-field-type").value;
    if (label || val) {
      out.push({
        name: label.toLowerCase().replace(/s+/g, "_"),
        label: label || "Field",
        type: type === "password" ? "password" : "text",
        value: val,
      });
    }
  }
  return out;
}

function renderHistory() {
  const box = el("f-history-list");
  box.replaceChildren();
  const hist = (current && current.history) || [];
  el("f-history").classList.toggle("hidden", hist.length === 0);
  for (const h of hist) {
    const row = make("div", "hist-row");
    row.append(
      make("span", "mono", "\u2022".repeat(10)),
      make("span", "muted tiny", formatDate(h.at)),
    );
    const copy = make("button", "btn btn--sm", "salin");
    copy.type = "button";
    on(copy, "click", async () => {
      const ok = await copyViaBackground(h.password, true);
      toast(ok ? "Password lama disalin" : "Clipboard ditolak");
    });
    const use = make("button", "btn btn--sm", "pakai lagi");
    use.type = "button";
    on(use, "click", () => {
      el("f-password").value = h.password;
      updateMeter();
    });
    row.append(copy, use);
    box.appendChild(row);
  }
}

function updateMeter() {
  const m = strengthMeter(el("f-password").value);
  el("f-meter").style.width = m.pct + "%";
  el("f-meter").style.background = m.color;
  el("f-hint").textContent = m.bits ? `${m.bits} bit entropi · ${m.text}` : "";
}

on(el("f-password"), "input", updateMeter);

on(el("f-reveal"), "click", () => {
  const input = el("f-password");
  input.type = input.type === "password" ? "text" : "password";
  el("f-reveal").textContent = input.type === "password" ? "lihat" : "sembunyi";
});

on(el("f-copy"), "click", async () => {
  const value = el("f-password").value;
  if (!value) {
    toast("password kosong");
    return;
  }
  const ok = await copyViaBackground(value, true);
  toast(ok ? "Password disalin" : "Clipboard ditolak");
});

on(el("f-gen"), "click", async () => {
  const res = await call({
    type: "GENERATE",
    options: {
      length: 20,
      lower: true,
      upper: true,
      digit: true,
      symbol: true,
    },
  });
  el("f-password").value = res.password;
  el("f-password").type = "text";
  el("f-reveal").textContent = "sembunyi";
  updateMeter();
});

function startTotpTicker() {
  if (totpTimer) {
    window.clearInterval(totpTimer);
    totpTimer = null;
  }
  const tick = async () => {
    const secret = el("f-totp").value.trim();
    if (!secret) {
      el("f-totp-code").textContent = "—";
      return;
    }
    try {
      const res = await call({ type: "TOTP", secret });
      el("f-totp-code").textContent = `${res.code} (${res.remaining}s)`;
    } catch (err) {
      el("f-totp-code").textContent = "err";
      el("f-totp-code").title = err.message;
    }
  };
  tick();
  totpTimer = window.setInterval(tick, 1000);
}

on(el("btn-add-field"), "click", () => {
  el("f-custom-fields").appendChild(customFieldRow({ type: "text" }));
});

on(el("f-fav"), "click", async () => {
  if (!current) {
    el("f-fav").textContent = el("f-fav").textContent === "★" ? "☆" : "★";
    return;
  }
  const res = await call({ type: "FAVORITE", id: current.id });
  current.favorite = res.favorite;
  el("f-fav").textContent = res.favorite ? "★" : "☆";
  refreshList();
});

on(el("editor"), "submit", async (ev) => {
  ev.preventDefault();
  showError(el("edit-error"), "");
  const item = {
    id: current ? current.id : undefined,
    title: el("f-title").value,
    url: el("f-url").value,
    username: el("f-username").value,
    password: el("f-password").value,
    totp: el("f-totp").value,
    tags: el("f-tags")
      .value.split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    notes: el("f-notes").value,
    fields: collectCustomFields(),
    favorite: current
      ? Boolean(current.favorite)
      : el("f-fav").textContent === "★",
    history: current ? current.history || [] : [],
  };
  try {
    const saved = await call({ type: "SAVE", item });
    current = saved;
    selectedId = saved.id;
    status = await call({ type: "STATUS" });
    el("vault-meta").textContent =
      `${status.count} entri · ${status.kdf.iterations.toLocaleString("id-ID")} iterasi`;
    el("f-meta").textContent =
      `dibuat ${formatDate(saved.createdAt)} · diubah ${formatDate(saved.updatedAt)} · id ${saved.id}`;
    toast("Tersimpan");
    await refreshList();
    renderHistory();
  } catch (err) {
    showError(el("edit-error"), err.message);
  }
});

async function targetTabForFill() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs
    .filter((t) => /^https?:/.test(t.url || "") && t.id !== undefined)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0] || null;
}

on(el("f-fill"), "click", async () => {
  if (!current) {
    toast("simpan entri lebih dulu");
    return;
  }
  const tab = await targetTabForFill();
  if (!tab) {
    toast("tidak ada tab http(s) terbuka");
    return;
  }
  const res = await call({ type: "FILL_TAB", id: current.id, tabId: tab.id });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  toast(
    res.filled
      ? "Terisi di " + hostOf(tab.url)
      : "Field tidak ditemukan di " + hostOf(tab.url),
  );
});

on(el("f-duplicate"), "click", async () => {
  if (!current) {
    toast("tidak ada entri terpilih");
    return;
  }
  const copy = Object.assign({}, current, {
    id: undefined,
    title: current.title + " (salinan)",
    createdAt: undefined,
    updatedAt: undefined,
    history: [],
  });
  const saved = await call({ type: "SAVE", item: copy });
  await refreshList();
  select(saved.id);
  toast("Diduplikat");
});

on(el("f-delete"), "click", async () => {
  if (!current) {
    return;
  }
  if (!window.confirm(`Hapus entri "${current.title}"?`)) {
    return;
  }
  await call({ type: "DELETE", id: current.id });
  current = null;
  selectedId = null;
  el("editor").classList.add("hidden");
  el("detail-empty").classList.remove("hidden");
  status = await call({ type: "STATUS" });
  el("vault-meta").textContent = `${status.count} entri`;
  toast("Dihapus");
  await refreshList();
});

on(el("g-run"), "click", async () => {
  const res = await call({
    type: "GENERATE",
    options: {
      length: Number(el("g-len").value),
      lower: el("g-lower").checked,
      upper: el("g-upper").checked,
      digit: el("g-digit").checked,
      symbol: el("g-symbol").checked,
      ambiguous: el("g-ambiguous").checked,
    },
  });
  el("g-out").value = res.password;
  el("g-out").textContent = res.password;
  const m = strengthMeter(res.password);
  el("g-entropy").textContent = `${m.bits} bit entropi · ${m.text}`;
});

on(el("g-copy"), "click", async () => {
  const text = el("g-out").textContent;
  if (!text || text === "—") {
    toast("acak dulu");
    return;
  }
  const ok = await copyViaBackground(text, true);
  toast(ok ? "Disalin" : "Clipboard ditolak");
});

on(el("g-use"), "click", () => {
  const text = el("g-out").textContent;
  if (!text || text === "—") {
    toast("acak dulu");
    return;
  }
  el("f-password").value = text;
  el("f-password").type = "text";
  updateMeter();
  setView("entries");
  toast("Dimasukkan ke editor");
});

on(el("exp-enc"), "click", async () => {
  const res = await call({ type: "EXPORT", format: "encrypted" });
  download(`vault-backup-${stamp()}.json`, res.text);
  toast("Backup terenkripsi diunduh");
});

on(el("exp-plain"), "click", async () => {
  if (
    !window.confirm(
      "Ekspor plaintext menuliskan SEMUA password tanpa enkripsi. Lanjutkan?",
    )
  ) {
    return;
  }
  const res = await call({ type: "EXPORT", format: "plain" });
  download(`vault-plain-${stamp()}.json`, res.text);
  toast("Ekspor plaintext diunduh");
});

on(el("exp-csv"), "click", async () => {
  if (
    !window.confirm("CSV berisi semua password dalam teks terang. Lanjutkan?")
  ) {
    return;
  }
  const res = await call({ type: "EXPORT", format: "csv" });
  download(`vault-${stamp()}.csv`, res.text, "text/csv");
  toast("CSV diunduh");
});

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

on(el("imp-run"), "click", async () => {
  showError(el("imp-result"), "");
  let text = el("imp-text").value.trim();
  const file = el("imp-file").files && el("imp-file").files[0];
  try {
    if (file) {
      text = await readFile(file);
    }
    if (!text) {
      throw new Error("pilih file atau tempel isi JSON/CSV");
    }
    const res = await call({
      type: "IMPORT",
      text,
      mode: el("imp-mode").value,
      password: el("imp-pass").value || undefined,
      allowDuplicates: el("imp-dup").checked,
    });
    const node = el("imp-result");
    node.className = "notice notice--ok";
    node.textContent = `Impor selesai: ${res.added} ditambah, ${res.updated} diperbarui, total ${res.total}.`;
    node.classList.remove("hidden");
    el("imp-text").value = "";
    el("imp-file").value = "";
    el("imp-pass").value = "";
    status = await call({ type: "STATUS" });
    el("vault-meta").textContent = `${status.count} entri`;
    await refreshList();
  } catch (err) {
    const node = el("imp-result");
    node.className = "notice notice--err";
    node.textContent = err.message;
    node.classList.remove("hidden");
  }
});

on(el("wipe-run"), "click", async () => {
  if (el("wipe-word").value.trim() !== "HAPUS") {
    toast("ketik HAPUS untuk konfirmasi");
    return;
  }
  if (!window.confirm("Hapus vault permanen dari penyimpanan lokal?")) {
    return;
  }
  await call({ type: "WIPE" });
  status = await call({ type: "STATUS" });
  current = null;
  items = [];
  el("editor").classList.add("hidden");
  el("detail-empty").classList.remove("hidden");
  el("wipe-word").value = "";
  renderGate();
  toast("Vault dihapus");
});

function loadSettingsForm() {
  if (!settings) {
    return;
  }
  el("s-lock").value = String(settings.autoLockMinutes);
  el("s-clip").value = String(settings.clipboardClearSeconds);
  el("s-autofill").value = settings.autofill;
  el("s-badge").checked = settings.showBadge;
  el("s-capture").checked = settings.captureOnSubmit !== false;
  el("kdf-iter").value = String(
    status.kdf ? status.kdf.iterations : settings.iterations,
  );
  renderSites(settings.autoFillSites || []);
}

function renderSites(sites) {
  const box = el("s-sites");
  box.replaceChildren();
  if (sites.length === 0) {
    box.appendChild(make("span", "muted tiny", "belum ada situs"));
    return;
  }
  for (const site of sites) {
    const chip = make("span", "site-chip", site);
    const x = make("button", "", "\u00d7");
    x.type = "button";
    x.title = "Hapus";
    on(x, "click", async () => {
      settings = await call({ type: "FORGET_SITE", host: site });
      renderSites(settings.autoFillSites || []);
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

on(el("s-site-btn"), "click", async () => {
  const host = el("s-site-add").value.trim().toLowerCase();
  if (!host) {
    return;
  }
  const sites = new Set(settings.autoFillSites || []);
  sites.add(host.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  settings = await call({
    type: "SETTINGS_SET",
    patch: { autoFillSites: Array.from(sites) },
  });
  el("s-site-add").value = "";
  renderSites(settings.autoFillSites || []);
});

on(el("s-save"), "click", async () => {
  const patch = {
    autoLockMinutes: Number(el("s-lock").value),
    clipboardClearSeconds: Number(el("s-clip").value),
    autofill: el("s-autofill").value,
    showBadge: el("s-badge").checked,
    captureOnSubmit: el("s-capture").checked,
  };
  settings = await call({ type: "SETTINGS_SET", patch });
  el("s-msg").textContent =
    "tersimpan " + new Date().toLocaleTimeString("id-ID");
  toast("Pengaturan disimpan");
});

on(el("pw-run"), "click", async () => {
  const node = el("pw-msg");
  node.className = "notice hidden";
  try {
    if (el("pw-new").value.length < 8) {
      throw new Error("Password baru minimal 8 karakter.");
    }
    if (el("pw-new").value !== el("pw-new2").value) {
      throw new Error("Konfirmasi password baru tidak cocok.");
    }
    await call({
      type: "CHANGE_PASSWORD",
      current: el("pw-old").value,
      next: el("pw-new").value,
    });
    el("pw-old").value = "";
    el("pw-new").value = "";
    el("pw-new2").value = "";
    node.className = "notice notice--ok";
    node.textContent = "Password master diganti dan vault dienkripsi ulang.";
  } catch (err) {
    node.className = "notice notice--err";
    node.textContent = err.message;
  }
});

on(el("kdf-run"), "click", async () => {
  const node = el("kdf-msg");
  node.className = "notice hidden";
  try {
    const res = await call({
      type: "REKEY",
      password: el("kdf-pass").value,
      iterations: Number(el("kdf-iter").value),
    });
    el("kdf-pass").value = "";
    node.className = "notice notice--ok";
    node.textContent = `KDF diperbarui ke ${res.iterations.toLocaleString("id-ID")} iterasi.`;
    status = await call({ type: "STATUS" });
    el("vault-meta").textContent =
      `${status.count} entri · ${status.kdf.iterations.toLocaleString("id-ID")} iterasi`;
  } catch (err) {
    node.className = "notice notice--err";
    node.textContent = err.message;
  }
});

function kv(table, key, value) {
  const tr = make("tr");
  tr.append(make("td", "", key), make("td", "mono", String(value)));
  table.appendChild(tr);
}

async function runDiagnostics() {
  const table = el("diag-table");
  table.replaceChildren();
  kv(table, "Extension ID", chrome.runtime.id);
  kv(table, "Versi", chrome.runtime.getManifest().version);
  kv(
    table,
    "Chrome",
    navigator.userAgent.match(/Chrome\/[\d.]+/)
      ? navigator.userAgent.match(/Chrome\/[\d.]+/)[0]
      : navigator.userAgent,
  );
  kv(
    table,
    "Mode",
    chrome.runtime.getManifest().manifest_version === 3
      ? "Manifest V3"
      : "lainnya",
  );
  try {
    const usage = await call({ type: "USAGE" });
    kv(table, "Ukuran vault di disk", (usage.bytes / 1024).toFixed(1) + " KB");
  } catch (err) {
    kv(table, "Ukuran vault", "gagal: " + err.message);
  }
  kv(
    table,
    "chrome.offscreen",
    typeof chrome.offscreen === "object" ? "tersedia" : "tidak tersedia",
  );
  kv(
    table,
    "chrome.storage.session",
    typeof chrome.storage.session === "object"
      ? "tersedia (memori saja)"
      : "tidak tersedia",
  );

  let managed = "kosong";
  try {
    const m = await chrome.storage.managed.get(null);
    managed = m && Object.keys(m).length ? Object.keys(m).join(", ") : "kosong";
  } catch {
    managed = "tidak tersedia";
  }
  kv(table, "Managed storage", managed);

  const tab = await chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((t) => t[0] || null);
  if (tab) {
    const res = await send({ type: "SCAN", target: tab.id });
    kv(
      table,
      "Content script di tab aktif",
      res && res.ok
        ? `aktif (${res.result.count} field password)`
        : "tidak merespons (halaman chrome://, Web Store, atau diblokir kebijakan)",
    );
    kv(table, "Tab aktif", tab.url);
  }

  el("diag-note").textContent =
    "Kebijakan browser yang mematikan password manager bawaan (PasswordManagerEnabled) tidak memblokir extension ini. Yang bisa memblokir: ExtensionInstallBlocklist, DeveloperToolsAvailability, atau larangan load unpacked. Cek chrome://policy.";
}

async function renderCommands() {
  const table = el("cmd-table");
  table.replaceChildren();
  const cmds = await chrome.commands.getAll();
  for (const c of cmds) {
    kv(table, c.description || c.name, c.shortcut || "belum diatur");
  }
  if (cmds.length === 0) {
    kv(table, "-", "tidak ada command terdaftar");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== "vault-local") {
    return;
  }
  if (msg.type === "STATE" && msg.unlocked === false) {
    status.unlocked = false;
    current = null;
    renderGate();
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && ev.key === "s") {
    ev.preventDefault();
    if (view === "entries") {
      el("editor").requestSubmit();
    } else if (view === "settings") {
      el("s-save").click();
    }
  }
});

boot()
  .then(() => renderCommands())
  .catch((err) => {
    showError(el("gate-error"), err.message);
  });
