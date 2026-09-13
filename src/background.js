// Service worker MV3: router pesan, auto-lock, clipboard, koordinasi autofill.

import {
  generatePassword,
  hostnameOf,
  passwordEntropy,
  totpCode,
  totpRemaining,
} from "./crypto.js";
import * as store from "./store.js";

const AUTOLOCK_ALARM = "vault-autolock";
const CLIPBOARD_ALARM = "vault-clipboard-clear";
const OFFSCREEN_URL = "src/offscreen.html";

const MSG = "vault-local";
const CAPTURE_TTL = 120000;

let lastClipboard = null;
let offscreenCreating = null;
const pendingCapture = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 0.4 });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "vault-fill",
      title: "Isi dari Vault Local",
      contexts: ["editable"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
    chrome.contextMenus.create({
      id: "vault-lock",
      title: "Kunci Vault Local",
      contexts: ["action"],
    });
  });
  if (
    chrome.storage &&
    chrome.storage.session &&
    typeof chrome.storage.session.setAccessLevel === "function"
  ) {
    chrome.storage.session
      .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
      .catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 0.4 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) {
    await store.ensureUnlocked();
    const locked = await store.enforceAutoLock();
    if (locked) {
      pendingCapture.clear();
      broadcast({ type: "STATE", unlocked: false });
      refreshBadge();
    }
    return;
  }
  if (alarm.name === CLIPBOARD_ALARM) {
    await clearClipboardIfOurs();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "lock-now") {
    await store.lock();
    broadcast({ type: "STATE", unlocked: false });
    refreshBadge();
    return;
  }
  if (command === "fill-current") {
    const tab = await activeTab();
    if (tab && tab.id != null) {
      sendToTab(tab.id, { type: "OPEN_PICKER" });
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "vault-fill" && tab && tab.id != null) {
    sendToTab(tab.id, { type: "OPEN_PICKER" });
    return;
  }
  if (info.menuItemId === "vault-lock") {
    await store.lock();
    broadcast({ type: "STATE", unlocked: false });
    refreshBadge();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => pendingCapture.delete(tabId));

chrome.tabs.onActivated.addListener(() => refreshBadge());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    refreshBadge();
  }
  if (changeInfo.status === "complete") {
    const entry = pendingCapture.get(tabId);
    if (entry && Date.now() - entry.at < CAPTURE_TTL) {
      setTimeout(() => {
        sendToTab(tabId, {
          source: MSG,
          type: "SHOW_SAVE_PROMPT",
          payload: entry.payload,
        });
      }, 400);
    }
  }
});

function activeTab() {
  return chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => tabs[0] || null)
    .catch(() => null);
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

function broadcast(msg) {
  return chrome.runtime
    .sendMessage(Object.assign({ source: MSG }, msg))
    .catch(() => null);
}

async function refreshBadge() {
  try {
    if (!store.isUnlocked()) {
      await chrome.action.setBadgeText({ text: "LOCK" });
      await chrome.action.setBadgeBackgroundColor({ color: "#f85149" });
      await chrome.action.setTitle({
        title: "Vault Local — Terkunci (klik untuk buka)",
      });
      return;
    }
    const tab = await activeTab();
    const isWeb = tab && /^https?:/.test(tab.url || "");
    const count = isWeb ? store.queryItems({ url: tab.url }).length : 0;
    if (count > 0) {
      await chrome.action.setBadgeText({ text: String(count) });
      await chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
      await chrome.action.setTitle({
        title: `Vault Local — ${count} akun cocok`,
      });
    } else {
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#238636" });
      await chrome.action.setTitle({
        title: "Vault Local — Terbuka (sesi aktif)",
      });
    }
  } catch {
    /* badge bersifat dekoratif */
  }
}

function trusted(sender) {
  return sender && sender.id === chrome.runtime.id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== MSG) {
    return false;
  }
  if (!trusted(sender)) {
    return false;
  }
  handle(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) =>
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      }),
    );
  return true;
});

async function handle(msg, sender) {
  if (msg.type !== "UNLOCK" && msg.type !== "CREATE") {
    await store.ensureUnlocked();
  }
  store.touch();
  switch (msg.type) {
    case "STATUS": {
      const st = await store.status();
      st.tabUrl = sender && sender.tab ? sender.tab.url || "" : "";
      return st;
    }

    case "CREATE":
      return store.createVault(msg.password, { iterations: msg.iterations });

    case "UNLOCK":
      return store.unlock(msg.password);

    case "LOCK":
      await store.lock();
      pendingCapture.clear();
      broadcast({ type: "STATE", unlocked: false });
      refreshBadge();
      return { unlocked: false };

    case "RESTORE":
      await store.restoreSession();
      return store.status();

    case "LIST":
      return {
        items: store.queryItems({
          query: msg.query,
          url: msg.url,
          reveal: msg.reveal,
          limit: msg.limit,
        }),
      };

    case "GET":
      return store.getItem(msg.id, true);

    case "SAVE": {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (tabId != null && (msg.fromCapture || msg.fromPrompt)) {
        pendingCapture.delete(tabId);
      }
      return store.upsertItem(msg.item);
    }

    case "DELETE":
      return store.deleteItem(msg.id);

    case "FAVORITE":
      return store.toggleFavorite(msg.id);

    case "GENERATE":
      return {
        password: generatePassword(msg.options || {}),
        entropy: passwordEntropy(generatePassword(msg.options || {})),
      };

    case "TOTP": {
      const item = msg.id ? store.getItem(msg.id, true) : null;
      const secret = item ? item.totp : msg.secret;
      if (!secret) {
        throw new Error("tidak ada secret TOTP");
      }
      const period = Number(msg.period) || 30;
      return {
        code: await totpCode(secret, {
          period,
          digits: Number(msg.digits) || 6,
        }),
        remaining: totpRemaining(period),
      };
    }

    case "COPY":
      return copyText(
        String(msg.text == null ? "" : msg.text),
        msg.secret !== false,
      );

    case "SETTINGS_GET":
      return store.loadSettings();

    case "SETTINGS_SET":
      return store.saveSettings(msg.patch);

    case "CHANGE_PASSWORD":
      return store.changeMasterPassword(msg.current, msg.next);

    case "EXPORT":
      if (msg.format === "csv") {
        return { format: "csv", text: store.exportCsv() };
      }
      if (msg.format === "plain") {
        return { format: "json", text: await store.exportPlain() };
      }
      return { format: "encrypted", text: await store.exportEncrypted() };

    case "IMPORT":
      return store.importData(String(msg.text), {
        mode: msg.mode,
        password: msg.password,
        allowDuplicates: msg.allowDuplicates,
      });

    case "WIPE":
      await store.wipeVault();
      refreshBadge();
      return { wiped: true };

    case "BEST_MATCH":
      return store.bestMatch(msg.url);

    case "CANDIDATES": {
      if (!store.isUnlocked()) {
        return { locked: true, items: [] };
      }
      const url = msg.url || (sender.tab ? sender.tab.url : "");
      return {
        locked: false,
        url,
        items: store.queryItems({ url, limit: 8 }).map(stripSecret),
      };
    }

    case "FILL_ITEM": {
      if (!store.isUnlocked()) {
        throw new Error("vault terkunci");
      }
      const item = store.getItem(msg.id, true);
      if (item.totp) {
        item.totpCode = await totpCode(item.totp, {});
      }
      return { item: item };
    }

    case "FILL_ACTIVE": {
      const tab = await activeTab();
      if (!tab || tab.id == null) {
        throw new Error("tidak ada tab aktif");
      }
      sendToTab(tab.id, { type: "OPEN_PICKER" });
      return { sent: true };
    }

    case "REMEMBER_SITE": {
      const host = hostnameOf(sender && sender.tab ? sender.tab.url : "");
      if (!host) {
        throw new Error("host tidak dikenali");
      }
      const settings = await store.loadSettings();
      const sites = new Set(settings.autoFillSites || []);
      sites.add(host);
      return store.saveSettings({ autoFillSites: Array.from(sites) });
    }

    case "FORGET_SITE": {
      const settings = await store.loadSettings();
      const host = String(msg.host || "").toLowerCase();
      return store.saveSettings({
        autoFillSites: (settings.autoFillSites || []).filter((x) => x !== host),
      });
    }

    case "AUTOFILL_CHECK": {
      if (!store.isUnlocked()) {
        return { item: null };
      }
      const settings = await store.loadSettings();
      const url = msg.url || (sender && sender.tab ? sender.tab.url : "");
      const host = hostnameOf(url);
      const allowed =
        settings.autofill === "auto" ||
        (settings.autoFillSites || []).includes(host);
      if (!host || !allowed) {
        return { item: null };
      }
      const item = store.exactMatch(url);
      return { item: item ? item : null };
    }

    case "CAPTURE": {
      const settings = await store.loadSettings();
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (settings.captureOnSubmit === false || tabId == null || !msg.payload) {
        return { captured: false };
      }
      if (store.isUnlocked()) {
        const existing = store.queryItems({ url: msg.payload.url });
        const existingMatch = existing.find((it) => {
          if (it.username && msg.payload.username) {
            return (
              it.username.toLowerCase() === msg.payload.username.toLowerCase()
            );
          }
          return !it.username && !msg.payload.username;
        });
        if (existingMatch) {
          if (existingMatch.password === msg.payload.password) {
            return { captured: false, reason: "already_exists" };
          }
          const updatePayload = Object.assign({}, msg.payload, {
            mode: "update",
            updateId: existingMatch.id,
            existingTitle: existingMatch.title,
            oldPassword: existingMatch.password,
          });
          pendingCapture.set(tabId, {
            payload: updatePayload,
            at: Date.now(),
            fromUrl: sender.tab ? sender.tab.url : "",
          });
          return { captured: true, mode: "update", title: existingMatch.title };
        }
      }
      const createPayload = Object.assign({}, msg.payload, { mode: "create" });
      pendingCapture.set(tabId, {
        payload: createPayload,
        at: Date.now(),
        fromUrl: sender.tab ? sender.tab.url : "",
      });
      return { captured: true, mode: "create" };
    }

    case "PENDING_CAPTURE": {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const entry = tabId == null ? null : pendingCapture.get(tabId);
      if (!entry) {
        return { payload: null };
      }
      if (Date.now() - entry.at > CAPTURE_TTL) {
        pendingCapture.delete(tabId);
        return { payload: null };
      }
      if (!store.isUnlocked()) {
        return { payload: null };
      }
      return { payload: entry.payload };
    }

    case "DISMISS_CAPTURE": {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (tabId != null) {
        pendingCapture.delete(tabId);
      }
      return { dismissed: true };
    }

    case "FILL_TAB": {
      if (!store.isUnlocked()) {
        throw new Error("vault terkunci");
      }
      const tabId = Number(msg.tabId);
      if (!Number.isFinite(tabId)) {
        throw new Error("tab tidak valid");
      }
      const item = store.getItem(msg.id, true);
      if (item.totp) {
        item.totpCode = await totpCode(item.totp, {});
      }
      const res = await chrome.tabs
        .sendMessage(tabId, { source: MSG, type: "FILL_NOW", item })
        .catch(() => null);
      return { filled: Boolean(res && res.filled) };
    }

    case "REKEY":
      return store.rekey(msg.password, msg.iterations);

    case "USAGE":
      return store.storageUsage();

    case "FILL_REQUEST": {
      if (!store.isUnlocked()) {
        throw new Error("vault terkunci");
      }
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (tabId == null) {
        throw new Error("tab tidak dikenali");
      }
      const item = store.getItem(msg.id, true);
      if (item.totp) {
        item.totpCode = await totpCode(item.totp, {});
      }
      const res = await chrome.tabs
        .sendMessage(tabId, { source: MSG, type: "FILL_NOW", item })
        .catch(() => null);
      return { filled: Boolean(res), item: item.title };
    }

    default:
      throw new Error("pesan tidak dikenal: " + String(msg.type));
  }
}

function stripSecret(item) {
  const out = Object.assign({}, item);
  delete out.password;
  delete out.totp;
  delete out.history;
  delete out.notes;
  if (Array.isArray(out.fields)) {
    out.fields = out.fields.map((f) => {
      const stripped = Object.assign({}, f);
      if (stripped.type === "password") {
        delete stripped.value;
      }
      return stripped;
    });
  }
  return out;
}

async function ensureOffscreen() {
  if (typeof chrome.offscreen?.hasDocument === "function") {
    if (await chrome.offscreen.hasDocument()) {
      return true;
    }
  } else if (typeof chrome.runtime?.getContexts === "function") {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing && existing.length > 0) {
      return true;
    }
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["CLIPBOARD"],
        justification: "Tulis dan hapus clipboard untuk kredensial vault",
      });
    } catch (err) {
      if (!String(err).includes("Only a single offscreen document")) {
        throw err;
      }
    }
  })();
  try {
    await offscreenCreating;
    return true;
  } finally {
    offscreenCreating = null;
  }
}

async function copyText(text, secret) {
  const ok = await ensureOffscreen();
  if (!ok) {
    throw new Error("offscreen document gagal dibuat");
  }
  const res = await chrome.runtime.sendMessage({
    source: "vault-local-offscreen",
    type: "WRITE",
    text,
  });
  if (!res || !res.ok) {
    throw new Error((res && res.error) || "clipboard ditolak browser");
  }
  if (secret && text) {
    lastClipboard = text;
    const settings = await store.loadSettings();
    const seconds = settings.clipboardClearSeconds;
    if (seconds > 0) {
      chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: seconds / 60 });
    }
  }
  return {
    copied: true,
    clearAfter: secret ? (await store.loadSettings()).clipboardClearSeconds : 0,
  };
}

async function clearClipboardIfOurs() {
  if (!lastClipboard) {
    return;
  }
  const snapshot = lastClipboard;
  lastClipboard = null;
  const ok = await ensureOffscreen();
  if (!ok) {
    return;
  }
  await chrome.runtime.sendMessage({
    source: "vault-local-offscreen",
    type: "CLEAR_IF_MATCH",
    expected: snapshot,
  });
}
