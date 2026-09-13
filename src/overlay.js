// UI overlay di dalam iframe: unlock, picker kandidat, prompt simpan dinamis.

const MSG = "vault-local";
const FRAME_MSG = "vault-local-frame";

const el = (id) => document.getElementById(id);
const views = {
  lock: el("view-lock"),
  create: el("view-create"),
  save: el("view-save"),
  picker: el("view-picker"),
};

let status = null;
let tabUrl = "";

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ source: MSG }, msg), (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

function parentOrigin() {
  const origins = window.location.ancestorOrigins;
  if (origins && origins.length > 0) {
    return origins[origins.length - 1];
  }
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "";
  }
}

function notifyParent(type) {
  const target = parentOrigin();
  if (!target) {
    return;
  }
  window.parent.postMessage({ source: FRAME_MSG, type }, target);
}

function closeSelf() {
  notifyParent("CLOSE");
}

function show(name) {
  for (const key of Object.keys(views)) {
    views[key].classList.toggle("hidden", key !== name);
  }
}

function toast(text, ms = 1600) {
  const t = el("toast");
  t.textContent = text;
  t.classList.add("is-on");
  window.setTimeout(() => t.classList.remove("is-on"), ms);
}

function showError(node, message) {
  if (!node) {
    return;
  }
  if (!message) {
    node.classList.add("hidden");
    node.textContent = "";
    return;
  }
  node.classList.remove("hidden");
  node.textContent = message;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function itemRow(item) {
  const row = document.createElement("div");
  row.className = "item";
  row.tabIndex = 0;

  const main = document.createElement("div");
  main.className = "item__main";
  const display =
    item.label ||
    item.username ||
    item.title ||
    hostOf(item.url) ||
    "tanpa nama";
  const title = document.createElement("div");
  title.className = "item__title";
  title.textContent = display;
  const host = hostOf(item.url);
  const sub = document.createElement("div");
  sub.className = "item__sub";
  sub.textContent =
    item.label && item.username && item.label !== item.username
      ? `${item.username} · ${host || item.url}`
      : host || item.url || "";
  main.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "item__actions";
  if (item.hasTotp) {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = "TOTP";
    actions.appendChild(t);
  }
  if (Array.isArray(item.fields) && item.fields.length > 0) {
    const cf = document.createElement("span");
    cf.className = "tag";
    cf.textContent = item.fields.length + " field";
    actions.appendChild(cf);
  }
  const fill = document.createElement("button");
  fill.className = "btn btn--sm";
  fill.textContent = "Isi";
  fill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    requestFill(item.id);
  });
  actions.appendChild(fill);

  row.append(main, actions);
  row.addEventListener("click", () => requestFill(item.id));
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      requestFill(item.id);
    }
  });
  return row;
}

function renderResults(items, note) {
  const box = el("results");
  box.replaceChildren();
  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = note || "Tidak ada entri yang cocok dengan situs ini.";
    box.appendChild(empty);
    return;
  }
  for (const it of items) {
    box.appendChild(itemRow(it));
  }
}

async function loadCandidates(query) {
  const res = await send({ type: "CANDIDATES", query: query || "" });
  if (!res || !res.ok) {
    showError(el("picker-error"), (res && res.error) || "gagal membaca vault");
    renderResults([]);
    return;
  }
  if (res.result.locked) {
    await init();
    return;
  }
  showError(el("picker-error"), "");
  const q = String(query || "").trim();
  const items = res.result.items || [];
  renderResults(
    items,
    q
      ? "Tidak ada hasil untuk pencarian itu."
      : "Tidak ada entri yang cocok dengan situs ini.",
  );
}

async function requestFill(id) {
  const res = await send({ type: "FILL_REQUEST", id });
  if (!res || !res.ok) {
    showError(el("picker-error"), (res && res.error) || "gagal mengisi");
    return;
  }
  notifyParent("FILLED");
  toast("Terisi");
  window.setTimeout(closeSelf, 220);
}

async function init() {
  const res = await send({ type: "STATUS" });
  status = (res && res.ok && res.result) || { initialized: false };
  const host = hostOf(status.tabUrl || tabUrl || "");
  tabUrl = status.tabUrl || tabUrl;
  el("host").textContent = host || "vault local";
  el("lock-host").textContent = host ? "Situs: " + host : "";
  el("foot-note").textContent = status.unlocked ? "terbuka" : "terkunci";

  if (!status.initialized) {
    show("create");
    return;
  }
  if (!status.unlocked) {
    show("lock");
    el("mp").focus();
    return;
  }

  const pending = await send({ type: "PENDING_CAPTURE" });
  if (pending && pending.ok && pending.result && pending.result.payload) {
    const p = pending.result.payload;
    el("save-url").value = p.url || "";
    const box = el("save-fields");
    box.replaceChildren();

    const fieldsToRender =
      Array.isArray(p.fields) && p.fields.length > 0
        ? p.fields
        : [
            p.username
              ? {
                  name: "username",
                  label: "Username",
                  type: "text",
                  value: p.username,
                }
              : null,
            p.password
              ? {
                  name: "password",
                  label: "Password",
                  type: "password",
                  value: p.password,
                }
              : null,
          ].filter(Boolean);

    for (const f of fieldsToRender) {
      const fieldDiv = document.createElement("div");
      fieldDiv.className = "field";
      const lbl = document.createElement("span");
      lbl.className = "field__label";
      lbl.textContent = f.label || f.name || "Field";

      const inp = document.createElement("input");
      inp.className = "input mono";
      inp.type = f.type || "text";
      inp.value = f.value || "";
      inp.dataset.fieldName = f.name || "";
      inp.dataset.fieldLabel = f.label || "";
      inp.dataset.fieldType = f.type || "text";

      if (f.type === "password") {
        const row = document.createElement("div");
        row.className = "row";
        const rev = document.createElement("button");
        rev.type = "button";
        rev.className = "btn btn--sm";
        rev.textContent = "lihat";
        rev.addEventListener("click", () => {
          inp.type = inp.type === "password" ? "text" : "password";
          rev.textContent = inp.type === "password" ? "lihat" : "sembunyi";
        });
        row.append(inp, rev);
        fieldDiv.append(lbl, row);
      } else {
        fieldDiv.append(lbl, inp);
      }
      box.appendChild(fieldDiv);
    }

    show("save");
    const firstInput = box.querySelector("input");
    if (firstInput) {
      firstInput.focus();
    }
    return;
  }

  show("picker");
  el("search").focus();
  await loadCandidates("");
}

el("close").addEventListener("click", closeSelf);

el("lock-now").addEventListener("click", async () => {
  await send({ type: "LOCK" });
  toast("Terkunci");
  window.setTimeout(closeSelf, 200);
});

el("unlock").addEventListener("click", async () => {
  const password = el("mp").value;
  if (!password) {
    showError(el("lock-error"), "password master kosong");
    return;
  }
  el("unlock").disabled = true;
  const res = await send({ type: "UNLOCK", password });
  el("unlock").disabled = false;
  if (!res || !res.ok) {
    showError(el("lock-error"), (res && res.error) || "gagal membuka vault");
    el("mp").select();
    return;
  }
  showError(el("lock-error"), "");
  el("mp").value = "";
  if (el("remember-tab").checked) {
    await send({ type: "REMEMBER_SITE" });
  }
  await init();
});

el("mp").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    el("unlock").click();
  }
});

el("open-manager").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/manager.html") });
  closeSelf();
});

let searchTimer = null;
el("search").addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const q = el("search").value;
  searchTimer = window.setTimeout(() => loadCandidates(q), 140);
});

el("search").addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") {
    return;
  }
  ev.preventDefault();
  const first = el("results").querySelector(".item .btn");
  if (first) {
    first.click();
  }
});

el("save-confirm").addEventListener("click", async () => {
  const inputs = Array.from(el("save-fields").querySelectorAll("input"));
  const fields = [];
  let username = "";
  let password = "";
  for (const inp of inputs) {
    const f = {
      name: inp.dataset.fieldName || "",
      label: inp.dataset.fieldLabel || "",
      type: inp.dataset.fieldType || "text",
      value: inp.value,
    };
    fields.push(f);
    if (f.type === "password" && !password) {
      password = f.value;
    } else if (f.type !== "password" && !username) {
      username = f.value;
    }
  }
  const item = {
    title: hostOf(el("save-url").value) || "entri baru",
    url: el("save-url").value,
    username,
    password,
    fields,
  };
  const res = await send({ type: "SAVE", item, fromCapture: true });
  if (!res || !res.ok) {
    toast((res && res.error) || "gagal menyimpan");
    return;
  }
  await send({ type: "DISMISS_CAPTURE" });
  toast("Tersimpan");
  window.setTimeout(closeSelf, 260);
});

el("save-dismiss").addEventListener("click", async () => {
  await send({ type: "DISMISS_CAPTURE" });
  closeSelf();
});

window.addEventListener("message", (ev) => {
  const data = ev.data;
  if (!data || data.source !== MSG) {
    return;
  }
  if (data.type === "CLOSE") {
    closeSelf();
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeSelf();
  }
});

init();
