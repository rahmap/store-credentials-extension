// Primitif kriptografi vault. WebCrypto murni, tanpa dependency eksternal.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const SCHEMA = 1;
export const KDF = {
  alg: "PBKDF2-SHA256",
  hash: "SHA-256",
  iterations: 600000,
};
const VERIFIER_PLAINTEXT = "vault-local/verifier/v1";

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function toB64(input) {
  const arr = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    s += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromB64(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function uuid() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function secureInt(maxExclusive) {
  if (maxExclusive <= 0) {
    return 0;
  }
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let v = 0;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % maxExclusive;
}

export async function deriveKey(password, salt, iterations = KDF.iterations) {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: KDF.hash },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportKeyRaw(key) {
  return toB64(await crypto.subtle.exportKey("raw", key));
}

export async function importKeyRaw(rawB64) {
  return crypto.subtle.importKey(
    "raw",
    fromB64(rawB64),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson(key, blob) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(blob.iv) },
    key,
    fromB64(blob.ct),
  );
  return JSON.parse(dec.decode(pt));
}

export function makeVerifier(key) {
  return encryptJson(key, VERIFIER_PLAINTEXT);
}

export async function checkVerifier(key, blob) {
  try {
    return (await decryptJson(key, blob)) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

const CHARSETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  symbol: "!@#$%^&*-_=+?.:~",
};
const AMBIGUOUS = "Il1O0o|`'\"{}[]()/<>\\";

function charset(kind, avoidAmbiguous) {
  let s = CHARSETS[kind] || "";
  if (avoidAmbiguous) {
    s = Array.from(s)
      .filter((c) => !AMBIGUOUS.includes(c))
      .join("");
  }
  return s;
}

export function generatePassword(opts = {}) {
  const length = Math.min(128, Math.max(6, Number(opts.length) || 20));
  const kinds = [];
  if (opts.lower !== false) kinds.push("lower");
  if (opts.upper !== false) kinds.push("upper");
  if (opts.digit !== false) kinds.push("digit");
  if (opts.symbol === true) kinds.push("symbol");
  if (kinds.length === 0) {
    kinds.push("lower", "upper", "digit");
  }

  const avoid = opts.ambiguous === true;
  const pools = kinds.map((k) => charset(k, avoid)).filter((s) => s.length > 0);
  let all = pools.join("");
  if (all.length === 0) {
    all = charset("lower", false) + charset("digit", false);
    pools.push(all);
  }

  const out = pools.map((pool) => pool[secureInt(pool.length)]);
  while (out.length < length) {
    out.push(all[secureInt(all.length)]);
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out.slice(0, length).join("");
}

export function passwordEntropy(pwd) {
  let pool = 0;
  if (/[a-z]/.test(pwd)) pool += 26;
  if (/[A-Z]/.test(pwd)) pool += 26;
  if (/[0-9]/.test(pwd)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pwd)) pool += 32;
  if (pool === 0) {
    return 0;
  }
  return Math.round(pwd.length * Math.log2(pool));
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input) {
  const clean = String(input)
    .toUpperCase()
    .replace(/=+$/, "")
    .replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) {
      throw new Error("karakter base32 tidak valid: " + ch);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totpCode(secret, opts = {}) {
  const period = Number(opts.period) || 30;
  const digits = Number(opts.digits) || 6;
  const hash = opts.alg || "SHA-1";
  const at = Number(opts.at) || Date.now();
  const counter = BigInt(Math.floor(at / 1000 / period));

  const keyBuf = base32Decode(secret);
  if (keyBuf.length === 0) {
    throw new Error("secret TOTP kosong");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const msg = new ArrayBuffer(8);
  new DataView(msg).setBigUint64(0, counter);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpRemaining(period = 30, at = Date.now()) {
  return period - (Math.floor(at / 1000) % period);
}

export function hostnameOf(url) {
  try {
    let raw = String(url || "").trim();
    if (raw && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      raw = "http://" + raw;
    }
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostOf(url) {
  try {
    let raw = String(url || "").trim();
    if (raw && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      raw = "http://" + raw;
    }
    return new URL(raw).host.toLowerCase();
  } catch {
    return "";
  }
}

const COMMON_SLDS = new Set([
  "co",
  "or",
  "go",
  "ac",
  "sch",
  "mil",
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "web",
]);

const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

export function isIpOrSingleHost(host) {
  if (!host) {
    return false;
  }
  return (
    IPV4_PATTERN.test(host) ||
    host.includes(":") ||
    host.startsWith("[") ||
    !host.includes(".")
  );
}

export function domainKey(url) {
  const host = hostnameOf(url);
  if (!host) {
    return "";
  }
  if (isIpOrSingleHost(host)) {
    return host;
  }
  const clean = host.replace(/^www\./, "");
  const parts = clean.split(".");
  if (parts.length <= 2) {
    return clean;
  }
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (
    tld.length === 2 &&
    (COMMON_SLDS.has(sld) || sld.length <= 3) &&
    parts.length >= 3
  ) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}
export function urlParts(url) {
  try {
    let raw = String(url || "").trim();
    if (raw && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      raw = "http://" + raw;
    }
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    return {
      host: u.hostname.toLowerCase(),
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
      path: pathname.toLowerCase(),
      protocol: u.protocol,
    };
  } catch {
    return { host: "", port: "", path: "/", protocol: "" };
  }
}
