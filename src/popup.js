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
  openManager,
  strengthMeter,
} from "./ui.js";

let status = null;
let tab = null;
let filterSite = true;
let query = "";
let revealed = new Set();
let totpTimers = [];

async function boot() {
  tab = await chrome.tabs
    .query({ active: true, currentWindow: true })
    .then((t) => t[0] || null);
  if (!tab || !/^https?:/.test(tab.url || "")) {
    filterSite = false;
  }
  status = await call({ type: "STATUS" });
  el("site").textContent =
    tab && /^https?:/.test(tab.url || "") ? hostOf(tab.url) : "Vault Local";
  render();
}

function render() {
  el("view-create").classList.toggle(
    "hidden",
    status.initialized !== false || status.unlocked,
  );
  el("view-unlock").classList.toggle(
    "hidden",
    !(status.initialized && !status.unlocked),
  );
  el("view-main").classList.toggle("hidden", !status.unlocked);
  el("btn-lock").classList.toggle("hidden", !status.unlocked);
  el("lock-dot").classList.toggle("is-open", Boolean(status.unlocked));

  if (status.initialized && !status.unlocked) {
    const kdf = status.kdf || {};
    el("unlock-meta").textContent =
      `${status.count || 0} entri · ${kdf.alg || "PBKDF2-SHA256"} ${(kdf.iterations || 0).toLocaleString("id-ID")} iterasi`;
    el("mp").focus();
  }
  if (!status.initialized) {
    el("new-pass").focus();
  }
  el("foot-status").textContent = status.unlocked
    ? `${status.count} entri · auto-lock ${status.settings.autoLockMinutes}m`
    : status.initialized
      ? "terkunci"
      : "belum dibuat";
  el("btn-add").disabled = !status.unlocked;
}

async function loadResults() {
  if (!status.unlocked) {
    return;
  }
  const isWeb = tab && /^https?:/.test(tab.url || "");
  const url = filterSite && isWeb ? tab.url : "";
  const res = await call({ type: "LIST", query, url, limit: 60 });
  renderChips(res.items.length);
  renderList(res.items);
}

function renderChips(matchCount) {
  const chips = el("chips");
  chips.replaceChildren();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    return;
  }
  const mk = (label, active, handler) => {
    const c = make("button", "chip" + (active ? " is-on" : ""), label);
    c.type = "button";
    on(c, "click", handler);
    chips.appendChild(c);
  };
  mk(`Cocok (${matchCount})`, filterSite, () => {
    filterSite = true;
    loadResults();
  });
  mk("Semua", !filterSite, () => {
    filterSite = false;
    loadResults();
  });
}

function renderList(items) {
  const box = el("results");
  box.replaceChildren();
  clearTotp();
  if (items.length === 0) {
    box.appendChild(
      make(
        "div",
        "empty",
        query
          ? "Tidak ada hasil."
          : "Belum ada entri yang cocok dengan situs ini.",
      ),
    );
    return;
  }
  for (const it of items) {
    box.appendChild(row(it));
  }
}

function clearTotp() {
  for (const t of totpTimers) {
    window.clearInterval(t);
  }
  totpTimers = [];
}

function row(item) {
  const node = make("div", "item");
  const main = make("div", "item__main");
  const title = make("div", "item__title");
  title.textContent = item.favorite ? "★ " + item.title : item.title;
  const customSummary = Array.isArray(item.fields)
    ? item.fields
        .filter((f) => f.type !== "password" && f.value)
        .map((f) => `${f.label}: ${f.value}`)
        .join(" · ")
    : "";
  const subText =
    item.username ||
    customSummary ||
    item.url ||
    (item.password ? "hanya password" : "");
  const sub = make("div", "item__sub", subText);
  main.append(title, sub);

  const actions = make("div", "item__actions");

  const act = (label, titleText, handler, primary) => {
    const b = make(
      "button",
      "btn btn--sm" + (primary ? " btn--primary" : ""),
      label,
    );
    b.type = "button";
    b.title = titleText;
    on(b, "click", async (ev) => {
      ev.stopPropagation();
      await handler(b);
    });
    actions.appendChild(b);
    return b;
  };

  if (tab && /^https?:/.test(tab.url || "")) {
    act(
      "Isi",
      "Isi ke halaman ini",
      async () => {
        try {
          const res = await call({
            type: "FILL_TAB",
            id: item.id,
            tabId: tab.id,
          });
          toast(res.filled ? "Terisi" : "Field tidak ditemukan");
          window.setTimeout(() => window.close(), 250);
        } catch (err) {
          toast(err.message);
        }
      },
      true,
    );
  }

  if (item.username) {
    act("U", "Salin username", async () => {
      const ok = await copyViaBackground(item.username, false);
      toast(ok ? "Username disalin" : "Clipboard ditolak");
    });
  } else if (Array.isArray(item.fields)) {
    const firstText = item.fields.find((f) => f.type !== "password" && f.value);
    if (firstText) {
      act("F", "Salin " + (firstText.label || "field"), async () => {
        const ok = await copyViaBackground(firstText.value, false);
        toast(
          ok ? (firstText.label || "Field") + " disalin" : "Clipboard ditolak",
        );
      });
    }
  }

  if (item.hasPassword || item.password) {
    act("P", "Salin password", async () => {
      try {
        const full = await call({ type: "GET", id: item.id });
        const ok = await copyViaBackground(full.password, true);
        toast(
          ok
            ? "Password disalin, clipboard dibersihkan otomatis"
            : "Clipboard ditolak",
        );
      } catch (err) {
        toast(err.message);
      }
    });
    act("•", "Lihat password", async (btn) => {
      try {
        const full = await call({ type: "GET", id: item.id });
        if (revealed.has(item.id)) {
          revealed.delete(item.id);
          sub.textContent = item.username || item.url || "";
          btn.textContent = "•";
          return;
        }
        revealed.add(item.id);
        sub.textContent =
          (item.username ? item.username + "  ·  " : "") + full.password;
        btn.textContent = "sembunyi";
        window.setTimeout(() => {
          if (revealed.has(item.id)) {
            revealed.delete(item.id);
            sub.textContent = item.username || item.url || "";
            btn.textContent = "•";
          }
        }, 8000);
      } catch (err) {
        toast(err.message);
      }
    });
  }

  if (item.hasTotp) {
    const code = act("TOTP", "Salin kode 2FA", async () => {
      try {
        const res = await call({ type: "TOTP", id: item.id });
        const ok = await copyViaBackground(res.code, false);
        toast(
          ok
            ? `Kode ${res.code} disalin (${res.remaining}s)`
            : "Clipboard ditolak",
        );
      } catch (err) {
        toast(err.message);
      }
    });
    code.textContent = "······";
    const tick = async () => {
      try {
        const res = await call({ type: "TOTP", id: item.id });
        code.textContent = res.code + " " + res.remaining + "s";
      } catch {
        code.textContent = "TOTP";
      }
    };
    tick();
    totpTimers.push(window.setInterval(tick, 1000));
  }

  node.append(main, actions);
  on(node, "dblclick", () => openManager("edit=" + item.id));
  return node;
}

on(el("btn-create"), "click", async () => {
  const p1 = el("new-pass").value;
  const p2 = el("new-pass2").value;
  showError(el("create-error"), "");
  if (p1.length < 8) {
    showError(el("create-error"), "Password master minimal 8 karakter.");
    return;
  }
  if (p1 !== p2) {
    showError(el("create-error"), "Konfirmasi tidak cocok.");
    return;
  }
  el("btn-create").disabled = true;
  try {
    await call({ type: "CREATE", password: p1 });
    status = await call({ type: "STATUS" });
    el("new-pass").value = "";
    el("new-pass2").value = "";
    toast("Vault dibuat");
    render();
    await loadResults();
  } catch (err) {
    showError(el("create-error"), err.message);
  } finally {
    el("btn-create").disabled = false;
  }
});

on(el("new-pass"), "input", () => {
  const m = strengthMeter(el("new-pass").value);
  const meter = el("new-meter");
  meter.style.width = m.pct + "%";
  meter.style.background = m.color;
  el("new-hint").textContent = m.bits
    ? `${m.bits} bit entropi · ${m.text}`
    : "";
});

on(el("btn-unlock"), "click", async () => {
  await doUnlock();
});

on(el("mp"), "keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    doUnlock();
  }
});

async function doUnlock() {
  const password = el("mp").value;
  showError(el("unlock-error"), "");
  if (!password) {
    return;
  }
  el("btn-unlock").disabled = true;
  el("btn-unlock").textContent = "Membuka…";
  try {
    await call({ type: "UNLOCK", password });
    el("mp").value = "";
    status = await call({ type: "STATUS" });
    render();
    await loadResults();
  } catch (err) {
    showError(el("unlock-error"), err.message);
    el("mp").select();
  } finally {
    el("btn-unlock").disabled = false;
    el("btn-unlock").textContent = "Buka vault";
  }
}

on(el("btn-lock"), "click", async () => {
  await call({ type: "LOCK" });
  status = await call({ type: "STATUS" });
  render();
  toast("Terkunci");
});

on(el("btn-add"), "click", () => {
  const url = tab && /^https?:/.test(tab.url || "") ? tab.url : "";
  openManager("new=" + encodeURIComponent(url));
});

on(el("btn-manager"), "click", () => openManager(""));

let searchTimer = null;
on(el("search"), "input", () => {
  window.clearTimeout(searchTimer);
  query = el("search").value;
  searchTimer = window.setTimeout(loadResults, 130);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== "vault-local") {
    return;
  }
  if (msg.type === "STATE") {
    call({ type: "STATUS" }).then((s) => {
      status = s;
      render();
      if (s.unlocked) {
        loadResults();
      }
    });
  }
});

boot().catch((err) => {
  showError(el("unlock-error"), err.message);
});
