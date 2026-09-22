// Helper UI bersama untuk popup dan manager.

export const MSG = "vault-local";

export function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ source: MSG }, msg), (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

export async function call(msg) {
  const res = await send(msg);
  if (!res) {
    throw new Error("service worker tidak merespons");
  }
  if (!res.ok) {
    throw new Error(res.error || "operasi gagal");
  }
  return res.result;
}

export const el = (id) => document.getElementById(id);

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

export function on(node, event, handler, options) {
  if (!node) {
    return;
  }
  node.addEventListener(event, handler, options);
}

let toastTimer = null;
export function toast(text, ms = 1800) {
  let node = el("toast");
  if (!node) {
    node = make("div", "toast");
    node.id = "toast";
    document.body.appendChild(node);
  }
  node.textContent = text;
  node.classList.add("is-on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("is-on"), ms);
}

export function showError(node, message) {
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

export function hostOf(url) {
  try {
    let raw = String(url || "").trim();
    if (raw && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      raw = "http://" + raw;
    }
    const u = new URL(raw);
    return u.host || u.hostname;
  } catch {
    return "";
  }
}

export function formatDate(ms) {
  if (!ms) {
    return "-";
  }
  return new Date(Number(ms)).toLocaleString("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function entropyLabel(bits) {
  if (bits >= 100) {
    return { text: "sangat kuat", color: "#3fb950", pct: 100 };
  }
  if (bits >= 70) {
    return { text: "kuat", color: "#3fb950", pct: 75 };
  }
  if (bits >= 50) {
    return { text: "sedang", color: "#d29922", pct: 50 };
  }
  if (bits >= 30) {
    return { text: "lemah", color: "#f0883e", pct: 28 };
  }
  return { text: "sangat lemah", color: "#f85149", pct: 12 };
}

export function strengthMeter(pw) {
  let pool = 0;
  if (/[a-z]/.test(pw)) {
    pool += 26;
  }
  if (/[A-Z]/.test(pw)) {
    pool += 26;
  }
  if (/[0-9]/.test(pw)) {
    pool += 10;
  }
  if (/[^a-zA-Z0-9]/.test(pw)) {
    pool += 32;
  }
  const bits = pool === 0 ? 0 : Math.round(pw.length * Math.log2(pool));
  return Object.assign({ bits }, entropyLabel(bits));
}

export async function copyViaBackground(text, secret = true) {
  try {
    const res = await call({ type: "COPY", text, secret });
    if (res && res.copied) {
      return true;
    }
  } catch {
    /* lanjut ke fallback lokal */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function download(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = make("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("gagal membaca file"));
    reader.readAsText(file);
  });
}

export async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

export function openManager(hash) {
  const url =
    chrome.runtime.getURL("src/manager.html") + (hash ? "#" + hash : "");
  chrome.tabs.create({ url });
}
