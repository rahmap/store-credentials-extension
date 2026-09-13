// Lapisan vault: persistensi terenkripsi, cache sesi, dan operasi CRUD.

import {
  SCHEMA,
  KDF,
  randomBytes,
  toB64,
  uuid,
  deriveKey,
  exportKeyRaw,
  importKeyRaw,
  encryptJson,
  decryptJson,
  makeVerifier,
  checkVerifier,
  hostnameOf,
  domainKey,
  urlParts,
} from "./crypto.js";

const VAULT_KEY = "vault";
const SETTINGS_KEY = "settings";
const SESSION_KEY = "session";
const HISTORY_LIMIT = 5;

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 180,
  clipboardClearSeconds: 25,
  autofill: "prompt",
  showBadge: true,
  captureOnSubmit: true,
  autoFillSites: [],
  iterations: KDF.iterations,
};

const state = {
  key: null,
  rawKey: null,
  payload: null,
  lastActivity: Date.now(),
  bootstrapped: null,
};

function now() {
  return Date.now();
}

export function normalizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  s.autoLockMinutes = clamp(Number(s.autoLockMinutes), 1, 1440, 180);
  s.clipboardClearSeconds = clamp(Number(s.clipboardClearSeconds), 0, 300, 25);
  s.iterations = clamp(Number(s.iterations), 100000, 2000000, KDF.iterations);
  s.autofill = ["prompt", "auto", "off"].includes(s.autofill)
    ? s.autofill
    : "prompt";
  s.showBadge = Boolean(s.showBadge);
  s.captureOnSubmit = s.captureOnSubmit !== false;
  s.autoFillSites = Array.isArray(s.autoFillSites)
    ? Array.from(
        new Set(
          s.autoFillSites.map((x) => String(x).toLowerCase()).filter(Boolean),
        ),
      ).sort()
    : [];
  delete s.revealOnHover;
  return s;
}

function clamp(v, min, max, fallback) {
  if (!Number.isFinite(v)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, v));
}

export async function loadSettings() {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(obj[SETTINGS_KEY]);
}

export async function saveSettings(patch) {
  const next = normalizeSettings(
    Object.assign({}, await loadSettings(), patch || {}),
  );
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function vaultExists() {
  const obj = await chrome.storage.local.get(VAULT_KEY);
  return Boolean(obj[VAULT_KEY] && obj[VAULT_KEY].blob);
}

export async function readVaultFile() {
  const obj = await chrome.storage.local.get(VAULT_KEY);
  return obj[VAULT_KEY] || null;
}

async function writeVaultFile(file) {
  file.updatedAt = now();
  await chrome.storage.local.set({ [VAULT_KEY]: file });
  return file;
}

function emptyPayload() {
  return { items: [], meta: { created: now() } };
}

export function normalizeItem(raw) {
  const src = raw || {};
  const base = {
    id: typeof src.id === "string" && src.id ? src.id : uuid(),
    title: str(src.title) || str(src.url) || "tanpa nama",
    username: str(src.username),
    password: str(src.password),
    url: str(src.url),
    notes: str(src.notes),
    totp: str(src.totp).replace(/\s+/g, ""),
    tags: Array.isArray(src.tags) ? src.tags.map(str).filter(Boolean) : [],
    fields: Array.isArray(src.fields)
      ? src.fields
          .map((f) => {
            if (!f || typeof f !== "object") return null;
            return {
              id: str(f.id) || uuid(),
              name: str(f.name),
              label: str(f.label) || str(f.name) || "field",
              type: ["password", "text", "email", "tel", "number"].includes(
                f.type,
              )
                ? f.type
                : "text",
              value:
                typeof f.value === "string"
                  ? f.value
                  : f.value == null
                    ? ""
                    : String(f.value),
            };
          })
          .filter((f) => f && (f.name || f.label || f.value))
      : [],
    favorite: Boolean(src.favorite),
    history: Array.isArray(src.history)
      ? src.history.slice(0, HISTORY_LIMIT)
      : [],
    createdAt: Number(src.createdAt) || now(),
    updatedAt: Number(src.updatedAt) || now(),
  };
  if (!base.title) {
    base.title = hostnameOf(base.url) || "tanpa nama";
  }
  return base;
}

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

async function persist() {
  if (!state.key || !state.payload) {
    throw new Error("vault terkunci");
  }
  const file = await readVaultFile();
  if (!file) {
    throw new Error("file vault hilang");
  }
  file.count = state.payload.items.length;
  file.blob = await encryptJson(state.key, state.payload);
  return writeVaultFile(file);
}

async function saveSession(rawKey) {
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      key: rawKey,
      unlockedAt: state.unlockedAt || now(),
      lastActivity: now(),
    },
  });
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

export async function createVault(password, options = {}) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("password master minimal 8 karakter");
  }
  const iterations = clamp(
    Number(options.iterations),
    100000,
    2000000,
    KDF.iterations,
  );
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, iterations);
  const payload = emptyPayload();
  const file = {
    schema: SCHEMA,
    kdf: { alg: KDF.alg, hash: KDF.hash, iterations, salt: toB64(salt) },
    verifier: await makeVerifier(key),
    blob: await encryptJson(key, payload),
    count: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  await writeVaultFile(file);
  state.key = key;
  state.rawKey = await exportKeyRaw(key);
  state.payload = payload;
  state.lastActivity = now();
  await saveSession(state.rawKey);
  await saveSettings({ iterations });
  return publicStatus();
}

export async function unlock(password) {
  const file = await readVaultFile();
  if (!file) {
    throw new Error("vault belum dibuat");
  }
  const kdf = file.kdf || KDF;
  const key = await deriveKey(
    String(password),
    fromB64Safe(kdf.salt),
    Number(kdf.iterations) || KDF.iterations,
  );
  if (!(await checkVerifier(key, file.verifier))) {
    throw new Error("password master salah");
  }
  state.key = key;
  state.rawKey = await exportKeyRaw(key);
  state.payload = await decryptJson(key, file.blob);
  if (!state.payload || !Array.isArray(state.payload.items)) {
    state.payload = emptyPayload();
  }
  state.lastActivity = now();
  await saveSession(state.rawKey);
  return publicStatus();
}

function fromB64Safe(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export async function restoreSession() {
  if (state.key && state.payload) {
    const settings = await loadSettings();
    const idleMs = (settings.autoLockMinutes || 180) * 60000;
    if (now() - state.lastActivity > idleMs) {
      await lock();
      return false;
    }
    state.lastActivity = now();
    return true;
  }
  const obj = await chrome.storage.session.get(SESSION_KEY);
  const sess = obj[SESSION_KEY];
  if (!sess || !sess.key) {
    return false;
  }
  const settings = await loadSettings();
  const idleMs = (settings.autoLockMinutes || 180) * 60000;
  const lastActive = sess.lastActivity || sess.unlockedAt || sess.at || 0;
  if (now() - lastActive > idleMs) {
    await lock();
    return false;
  }
  const file = await readVaultFile();
  if (!file) {
    await clearSession();
    return false;
  }
  try {
    const key = await importKeyRaw(sess.key);
    const payload = await decryptJson(key, file.blob);
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("payload rusak");
    }
    state.key = key;
    state.rawKey = sess.key;
    state.payload = payload;
    state.unlockedAt = sess.unlockedAt || sess.at || now();
    state.lastActivity = now();
    return true;
  } catch {
    await clearSession();
    return false;
  }
}

export async function ensureUnlocked() {
  if (isUnlocked()) {
    const settings = await loadSettings();
    const idleMs = (settings.autoLockMinutes || 180) * 60000;
    if (now() - state.lastActivity > idleMs) {
      await lock();
      return false;
    }
    touch();
    return true;
  }
  return restoreSession();
}

export async function lock() {
  state.key = null;
  state.rawKey = null;
  state.payload = null;
  await clearSession();
  return publicStatus();
}

export function isUnlocked() {
  return Boolean(state.key && state.payload);
}

export function touch() {
  state.lastActivity = now();
  if (state.rawKey && chrome.storage && chrome.storage.session) {
    chrome.storage.session
      .set({
        [SESSION_KEY]: {
          key: state.rawKey,
          unlockedAt: state.unlockedAt || now(),
          lastActivity: state.lastActivity,
        },
      })
      .catch(() => {});
  }
}

export async function enforceAutoLock() {
  if (!isUnlocked()) {
    return false;
  }
  const settings = await loadSettings();
  const idleMs = settings.autoLockMinutes * 60000;
  if (now() - state.lastActivity > idleMs) {
    await lock();
    return true;
  }
  return false;
}

function publicStatus() {
  return {
    initialized: true,
    unlocked: isUnlocked(),
    count: state.payload ? state.payload.items.length : 0,
    lastActivity: state.lastActivity,
    updatedAt: now(),
  };
}

export async function status() {
  const exists = await vaultExists();
  const settings = await loadSettings();
  if (!exists) {
    return { initialized: false, unlocked: false, count: 0, settings };
  }
  const file = await readVaultFile();
  return {
    initialized: true,
    unlocked: isUnlocked(),
    count: isUnlocked() ? state.payload.items.length : Number(file.count) || 0,
    updatedAt: file.updatedAt,
    kdf: file.kdf,
    lastActivity: state.lastActivity,
    settings,
  };
}

function requireUnlocked() {
  if (!isUnlocked()) {
    throw new Error("vault terkunci");
  }
}

function sanitize(item, reveal) {
  const out = Object.assign({}, item);
  if (!reveal) {
    if (out.password) {
      out.password = "\u2022".repeat(Math.min(12, out.password.length));
      out.hasPassword = true;
    }
    if (out.totp) {
      out.hasTotp = true;
      out.totp = "";
    }
    if (Array.isArray(out.fields)) {
      out.fields = out.fields.map((f) => {
        const masked = Object.assign({}, f);
        if (masked.type === "password") {
          masked.hasValue = Boolean(masked.value);
          masked.value = "•".repeat(Math.min(12, (masked.value || "").length));
        }
        return masked;
      });
    }
  }
  return out;
}

export function scoreMatch(item, targetUrl) {
  const target = urlParts(targetUrl);
  const itemParts = urlParts(item.url);
  if (!target.host || !itemParts.host) {
    return 0;
  }

  let s = 0;
  if (itemParts.host === target.host) {
    s = 100;
  } else if (
    itemParts.host.endsWith("." + target.host) ||
    target.host.endsWith("." + itemParts.host)
  ) {
    s = 80;
  } else {
    const dTarget = domainKey(targetUrl);
    const dItem = domainKey(item.url);
    if (dTarget && dItem && dTarget === dItem) {
      s = 60;
    } else {
      return 0;
    }
  }

  // Port check
  if (itemParts.port && target.port) {
    if (itemParts.port === target.port) {
      s += 10;
    } else {
      s -= 30;
    }
  }

  // Path check
  const iPath = itemParts.path;
  const tPath = target.path;

  if (iPath !== "/") {
    if (iPath === tPath) {
      s += 60;
    } else if (tPath.startsWith(iPath + "/") || tPath === iPath) {
      s += 50;
    } else {
      const iFirst = iPath.split("/").filter(Boolean)[0];
      const tFirst = tPath.split("/").filter(Boolean)[0];
      if (iFirst && tFirst && iFirst === tFirst) {
        s += 40;
      } else {
        s -= 60;
      }
    }
  }

  return Math.max(0, s);
}

export function queryItems(options = {}) {
  requireUnlocked();
  const q = String(options.query || "")
    .trim()
    .toLowerCase();
  const host = hostnameOf(options.url || "");
  const domain = domainKey(options.url || "");
  const reveal = options.reveal === true;
  let items = state.payload.items.slice();

  if (options.url) {
    items = items
      .map((it) => ({ it, s: scoreMatch(it, options.url) }))
      .filter((x) => x.s > 0)
      .sort(
        (a, b) =>
          b.s - a.s || String(a.it.title).localeCompare(String(b.it.title)),
      )
      .map((x) => x.it);

    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      items = items.filter((it) => {
        const dyn = (it.fields || [])
          .map((f) => f.label + " " + (f.type !== "password" ? f.value : ""))
          .join(" ");
        const hay = [
          it.title,
          it.username,
          it.url,
          it.notes,
          (it.tags || []).join(" "),
          dyn,
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
  } else if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    items = items
      .map((it) => {
        const dynamicValues = (it.fields || [])
          .map(
            (f) =>
              f.label +
              " " +
              f.name +
              (f.type !== "password" ? " " + f.value : ""),
          )
          .join(" ");
        const hay = [
          it.title,
          it.username,
          it.url,
          it.notes,
          (it.tags || []).join(" "),
          dynamicValues,
        ]
          .join(" ")
          .toLowerCase();
        let s = 0;
        for (const t of terms) {
          if (!hay.includes(t)) {
            s = -1;
            break;
          }
          s += hay.startsWith(t) ? 3 : 2;
          if (String(it.title).toLowerCase().startsWith(t)) {
            s += 2;
          }
        }
        return { it, s };
      })
      .filter((x) => x.s > 0)
      .sort(
        (a, b) =>
          b.s - a.s || String(a.it.title).localeCompare(String(b.it.title)),
      )
      .map((x) => x.it);
  } else {
    items.sort((a, b) => {
      if (Boolean(a.favorite) !== Boolean(b.favorite)) {
        return a.favorite ? -1 : 1;
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  if (options.limit) {
    items = items.slice(0, Number(options.limit));
  }
  return items.map((it) => sanitize(it, reveal));
}

export function getItem(id, reveal = true) {
  requireUnlocked();
  const found = state.payload.items.find((it) => it.id === id);
  if (!found) {
    throw new Error("item tidak ditemukan");
  }
  return sanitize(found, reveal);
}

export function bestMatch(url) {
  requireUnlocked();
  if (!url) {
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const it of state.payload.items) {
    const s = scoreMatch(it, url);
    if (s > bestScore && (it.password || (it.fields && it.fields.length > 0))) {
      bestScore = s;
      best = it;
    }
  }
  return best ? Object.assign({}, best) : null;
}

export function exactMatch(url) {
  requireUnlocked();
  if (!url) {
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const it of state.payload.items) {
    if (!it.password && (!it.fields || it.fields.length === 0)) {
      continue;
    }
    const s = scoreMatch(it, url);
    if (s >= 100 && s > bestScore) {
      bestScore = s;
      best = it;
    }
  }
  return best ? Object.assign({}, best) : null;
}

export async function upsertItem(raw) {
  requireUnlocked();
  const item = normalizeItem(raw);
  const idx = state.payload.items.findIndex((it) => it.id === item.id);
  if (idx >= 0) {
    const old = state.payload.items[idx];
    item.createdAt = old.createdAt || item.createdAt;
    if (old.password && old.password !== item.password) {
      item.history = [{ password: old.password, at: old.updatedAt || now() }]
        .concat(old.history || [])
        .slice(0, HISTORY_LIMIT);
    } else {
      item.history = old.history || [];
    }
    item.updatedAt = now();
    state.payload.items[idx] = item;
  } else {
    item.updatedAt = now();
    state.payload.items.push(item);
  }
  await persist();
  touch();
  return sanitize(item, true);
}

export async function deleteItem(id) {
  requireUnlocked();
  const before = state.payload.items.length;
  state.payload.items = state.payload.items.filter((it) => it.id !== id);
  if (state.payload.items.length === before) {
    throw new Error("item tidak ditemukan");
  }
  await persist();
  touch();
  return { deleted: id };
}

export async function toggleFavorite(id) {
  requireUnlocked();
  const it = state.payload.items.find((x) => x.id === id);
  if (!it) {
    throw new Error("item tidak ditemukan");
  }
  it.favorite = !it.favorite;
  it.updatedAt = now();
  await persist();
  touch();
  return sanitize(it, false);
}

export async function changeMasterPassword(current, next) {
  requireUnlocked();
  const file = await readVaultFile();
  const kdf = file.kdf || KDF;
  const oldKey = await deriveKey(
    String(current),
    fromB64Safe(kdf.salt),
    Number(kdf.iterations) || KDF.iterations,
  );
  if (!(await checkVerifier(oldKey, file.verifier))) {
    throw new Error("password master lama salah");
  }
  if (typeof next !== "string" || next.length < 8) {
    throw new Error("password master minimal 8 karakter");
  }
  const iterations = clamp(
    Number(kdf.iterations),
    100000,
    2000000,
    KDF.iterations,
  );
  const salt = randomBytes(16);
  const key = await deriveKey(next, salt, iterations);
  file.kdf = { alg: KDF.alg, hash: KDF.hash, iterations, salt: toB64(salt) };
  file.verifier = await makeVerifier(key);
  state.key = key;
  state.rawKey = await exportKeyRaw(key);
  file.blob = await encryptJson(key, state.payload);
  await writeVaultFile(file);
  await saveSession(state.rawKey);
  touch();
  return { changed: true };
}

export async function exportEncrypted() {
  const file = await readVaultFile();
  if (!file) {
    throw new Error("vault belum dibuat");
  }
  return JSON.stringify(
    { app: "vault-local", kind: "encrypted-backup", schema: SCHEMA, file },
    null,
    2,
  );
}

export async function exportPlain() {
  requireUnlocked();
  const payload = {
    app: "vault-local",
    kind: "plaintext-export",
    exportedAt: now(),
    items: state.payload.items.map((it) => Object.assign({}, it)),
  };
  return JSON.stringify(payload, null, 2);
}

export function exportCsv() {
  requireUnlocked();
  const cols = [
    "title",
    "url",
    "username",
    "password",
    "totp",
    "tags",
    "notes",
    "createdAt",
    "updatedAt",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(",")];
  for (const it of state.payload.items) {
    rows.push(
      cols
        .map((c) => (c === "tags" ? (it.tags || []).join(";") : it[c]))
        .map(esc)
        .join(","),
    );
  }
  return rows.join("\r\n");
}

export async function importData(text, options = {}) {
  requireUnlocked();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data === null) {
    const rows = parseCsv(text);
    if (rows.length === 0) {
      throw new Error("format tidak dikenali: bukan JSON dan bukan CSV");
    }
    data = { items: csvToItems(rows) };
  }

  let incoming = [];
  if (Array.isArray(data)) {
    incoming = data;
  } else if (Array.isArray(data.items)) {
    incoming = data.items;
  } else if (data.file && data.file.blob) {
    if (!options.password) {
      throw new Error("backup terenkripsi butuh password master backup");
    }
    const kdf = data.file.kdf || KDF;
    const key = await deriveKey(
      String(options.password),
      fromB64Safe(kdf.salt),
      Number(kdf.iterations) || KDF.iterations,
    );
    if (!(await checkVerifier(key, data.file.verifier))) {
      throw new Error("password backup salah");
    }
    const payload = await decryptJson(key, data.file.blob);
    incoming = (payload && payload.items) || [];
  } else {
    throw new Error("struktur tidak dikenali");
  }

  const mode = options.mode === "replace" ? "replace" : "merge";
  if (mode === "replace") {
    state.payload = emptyPayload();
  }
  let added = 0;
  let updated = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const item = normalizeItem(raw);
    const idx = state.payload.items.findIndex((it) => it.id === item.id);
    if (idx >= 0) {
      state.payload.items[idx] = item;
      updated++;
    } else {
      const dup = state.payload.items.find(
        (it) =>
          it.title === item.title &&
          it.username === item.username &&
          it.url === item.url,
      );
      if (dup && !options.allowDuplicates) {
        dup.password = item.password || dup.password;
        dup.updatedAt = now();
        updated++;
      } else {
        state.payload.items.push(item);
        added++;
      }
    }
  }
  await persist();
  touch();
  return { added, updated, total: state.payload.items.length };
}

export async function rekey(password, iterations) {
  requireUnlocked();
  const file = await readVaultFile();
  const kdf = file.kdf || KDF;
  const oldKey = await deriveKey(
    String(password),
    fromB64Safe(kdf.salt),
    Number(kdf.iterations) || KDF.iterations,
  );
  if (!(await checkVerifier(oldKey, file.verifier))) {
    throw new Error("password master salah");
  }
  const iters = clamp(Number(iterations), 100000, 3000000, KDF.iterations);
  const salt = randomBytes(16);
  const key = await deriveKey(String(password), salt, iters);
  file.kdf = {
    alg: KDF.alg,
    hash: KDF.hash,
    iterations: iters,
    salt: toB64(salt),
  };
  file.verifier = await makeVerifier(key);
  state.key = key;
  state.rawKey = await exportKeyRaw(key);
  file.blob = await encryptJson(key, state.payload);
  await writeVaultFile(file);
  await saveSession(state.rawKey);
  await saveSettings({ iterations: iters });
  touch();
  return { iterations: iters };
}

export async function storageUsage() {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  return { bytes, vaultBytes: bytes };
}

export async function wipeVault() {
  await lock();
  await chrome.storage.local.remove([VAULT_KEY, SETTINGS_KEY]);
  return { wiped: true };
}
const CSV_ALIASES = {
  title: ["title", "name", "judul", "item", "account"],
  url: ["url", "uri", "site", "situs", "login_uri", "web"],
  username: [
    "username",
    "user",
    "login",
    "email",
    "pengguna",
    "login_username",
  ],
  password: ["password", "pass", "pwd", "kata sandi", "login_password"],
  totp: ["totp", "otp", "2fa", "mfa", "totp_secret"],
  notes: ["notes", "note", "catatan", "comments"],
  tags: ["tags", "group", "groups", "tag"],
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function csvToItems(rows) {
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const map = {};
  for (const key of Object.keys(CSV_ALIASES)) {
    const idx = header.findIndex((h) => CSV_ALIASES[key].includes(h));
    if (idx >= 0) {
      map[key] = idx;
    }
  }
  if (map.password == null && map.username == null) {
    throw new Error("header CSV tidak punya kolom username/password");
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (key) =>
      map[key] == null
        ? ""
        : String(r[map[key]] == null ? "" : r[map[key]]).trim();
    const url = get("url");
    const title = get("title") || (url ? hostnameOf(url) : "");
    const username = get("username");
    const password = get("password");
    if (!title && !username && !password) {
      continue;
    }
    out.push({
      title,
      url,
      username,
      password,
      totp: get("totp"),
      notes: get("notes"),
      tags: get("tags")
        .split(/[;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
    });
  }
  return out;
}
