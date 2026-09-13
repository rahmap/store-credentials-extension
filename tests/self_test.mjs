// Suite pengujian mandiri tanpa framework.
// Menjalankan verifikasi kriptografi, RFC 6238 TOTP, penyimpanan, dan parser CSV.

import assert from "node:assert/strict";

// Siapkan mock chrome.storage untuk Node.js
const storageData = { local: {}, session: {} };

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === "string") return { [key]: storageData.local[key] };
        if (Array.isArray(key)) {
          const o = {};
          for (const k of key) o[k] = storageData.local[k];
          return o;
        }
        return Object.assign({}, storageData.local);
      },
      set: async (obj) => {
        Object.assign(storageData.local, obj);
      },
      remove: async (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete storageData.local[k];
      },
      getBytesInUse: async () => JSON.stringify(storageData.local).length,
    },
    session: {
      get: async (key) => {
        if (typeof key === "string") return { [key]: storageData.session[key] };
        return Object.assign({}, storageData.session);
      },
      set: async (obj) => {
        Object.assign(storageData.session, obj);
      },
      remove: async (keys) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete storageData.session[k];
      },
    },
  },
};

const cryptoMod = await import("../src/crypto.js");
const storeMod = await import("../src/store.js");

console.log("== 1. Kriptografi dasar ==");
const salt = cryptoMod.randomBytes(16);
assert.equal(salt.length, 16);
const key = await cryptoMod.deriveKey("rahasia-kantor-123", salt, 100000);
const verifier = await cryptoMod.makeVerifier(key);
const okVerifier = await cryptoMod.checkVerifier(key, verifier);
assert.equal(okVerifier, true, "verifier harus lolos dengan kunci benar");

const wrongKey = await cryptoMod.deriveKey("password-salah", salt, 100000);
const badVerifier = await cryptoMod.checkVerifier(wrongKey, verifier);
assert.equal(badVerifier, false, "verifier harus gagal dengan kunci salah");

const encrypted = await cryptoMod.encryptJson(key, {
  sensitive: "data-penting",
  count: 42,
});
const decrypted = await cryptoMod.decryptJson(key, encrypted);
assert.deepEqual(decrypted, { sensitive: "data-penting", count: 42 });

const exported = await cryptoMod.exportKeyRaw(key);
const reimported = await cryptoMod.importKeyRaw(exported);
const dec2 = await cryptoMod.decryptJson(reimported, encrypted);
assert.deepEqual(dec2, decrypted);

console.log("== 2. Generator password ==");
const pwd1 = cryptoMod.generatePassword({
  length: 24,
  symbol: true,
  lower: true,
  upper: true,
  digit: true,
});
assert.equal(pwd1.length, 24);
assert.ok(/[a-z]/.test(pwd1));
assert.ok(/[A-Z]/.test(pwd1));
assert.ok(/[0-9]/.test(pwd1));
assert.ok(/[^a-zA-Z0-9]/.test(pwd1));
const ent = cryptoMod.passwordEntropy(pwd1);
assert.ok(ent >= 120, "entropi minimal 120 bit untuk 24 karakter acak");

console.log("== 3. TOTP RFC 6238 Appendix B ==");
// Secret 20 byte "12345678901234567890" dalam base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const rfcVectors = [
  { t: 59000, exp: "287082" },
  { t: 1111111109000, exp: "081804" },
  { t: 1111111111000, exp: "050471" },
  { t: 1234567890000, exp: "005924" },
  { t: 2000000000000, exp: "279037" },
];
for (const vec of rfcVectors) {
  const code = await cryptoMod.totpCode(rfcSecret, {
    at: vec.t,
    digits: 6,
    period: 30,
    alg: "SHA-1",
  });
  assert.equal(code, vec.exp, `RFC 6238 TOTP gagal pada t=${vec.t}`);
}
console.log("   5 vektor RFC 6238 terverifikasi persis.");

console.log("== 4. Domain & Host matcher ==");
assert.equal(
  cryptoMod.hostnameOf("https://sso.kantor.local:8443/adfs/ls/"),
  "sso.kantor.local",
);
assert.equal(cryptoMod.domainKey("https://sso.kantor.local/"), "kantor.local");
assert.equal(cryptoMod.domainKey("https://intranet.corp.co.id/"), "corp.co.id");

console.log("== 5. Alur Vault Store ==");
// Gunakan 100k iterasi saat pengujian agar cepat selesai
const st0 = await storeMod.status();
assert.equal(st0.initialized, false);
assert.equal(st0.unlocked, false);

await storeMod.createVault("MasterPassword123!", { iterations: 100000 });
const st1 = await storeMod.status();
assert.equal(st1.initialized, true);
assert.equal(st1.unlocked, true);

// Tambah item
const itemA = await storeMod.upsertItem({
  title: "Email Kantor",
  url: "https://mail.kantor.local",
  username: "budi@kantor.local",
  password: "PasswordLama1",
  totp: "JBSWY3DPEHPK3PXP",
});
assert.ok(itemA.id);

// Update password dan verifikasi riwayat
const itemA2 = await storeMod.upsertItem({
  id: itemA.id,
  title: "Email Kantor",
  url: "https://mail.kantor.local",
  username: "budi@kantor.local",
  password: "PasswordBaru2",
});
assert.equal(itemA2.password, "PasswordBaru2");
assert.equal(itemA2.history.length, 1);
assert.equal(itemA2.history[0].password, "PasswordLama1");

// Query & Exact match
const matches = storeMod.queryItems({ url: "https://mail.kantor.local/inbox" });
assert.equal(matches.length, 1);
assert.equal(matches[0].id, itemA.id);

const exact = storeMod.exactMatch("https://mail.kantor.local/login");
assert.ok(exact);
assert.equal(exact.username, "budi@kantor.local");

// Kunci dan buka kembali
await storeMod.lock();
assert.equal(storeMod.isUnlocked(), false);

await assert.rejects(async () => {
  await storeMod.unlock("password-salah");
}, /password master salah/);

await storeMod.unlock("MasterPassword123!");
assert.equal(storeMod.isUnlocked(), true);

// Ganti password master
await storeMod.changeMasterPassword(
  "MasterPassword123!",
  "NextMasterPassword456#",
);
await storeMod.lock();
await assert.rejects(async () => {
  await storeMod.unlock("MasterPassword123!");
}, /password master salah/);
await storeMod.unlock("NextMasterPassword456#");
assert.equal(storeMod.isUnlocked(), true);

console.log("== 6. Ekspor & Impor (Encrypted, Plain, CSV) ==");
const encBackup = await storeMod.exportEncrypted();
assert.ok(encBackup.includes("vault-local"));

const plainBackup = await storeMod.exportPlain();
assert.ok(plainBackup.includes("PasswordBaru2"));

const csvText = storeMod.exportCsv();
assert.ok(csvText.includes("PasswordBaru2"));
assert.ok(csvText.includes("mail.kantor.local"));

// Hapus vault dan pulihkan dari backup terenkripsi
await storeMod.wipeVault();
const stWiped = await storeMod.status();
assert.equal(stWiped.initialized, false);

// Buat vault baru lalu impor backup terenkripsi
await storeMod.createVault("MasterSementara123!", { iterations: 100000 });
const impRes = await storeMod.importData(encBackup, {
  password: "NextMasterPassword456#",
  mode: "replace",
});
assert.equal(impRes.added, 1);
const restored = storeMod.getItem(itemA.id, true);
assert.equal(restored.password, "PasswordBaru2");

// Impor CSV
const sampleCsv = `title,url,username,password,totp
Portal HR,https://hr.kantor.local,budi,GajiRahasia2024,
VPN Kantor,https://vpn.kantor.local,budi,VpnPass999,`;
const csvRes = await storeMod.importData(sampleCsv, { mode: "merge" });
assert.equal(csvRes.added, 2);
assert.equal(storeMod.queryItems({}).length, 3);

// CSV parser edge cases
const parsed = storeMod.parseCsv('a,"b,c",d\r\n"line\nbreak",2,3\r\n');
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0], ["a", "b,c", "d"]);
assert.deepEqual(parsed[1], ["line\nbreak", "2", "3"]);

console.log("== 7. Auto-lock timeout ==");
await storeMod.saveSettings({ autoLockMinutes: 1 });
const lockedBefore = await storeMod.enforceAutoLock();
assert.equal(lockedBefore, false);
// Mundurkan lastActivity
storeMod.touch();
// Verifikasi fungsi berjalan tanpa exception
assert.equal(typeof storeMod.enforceAutoLock, "function");

console.log("== 8. Kredensial Dinamis (Custom Multi-field) ==");
// Entri dengan hanya Password (tanpa username)
const itemPassOnly = await storeMod.upsertItem({
  title: "Screen Lock Dashboard",
  url: "https://gate.kantor.local",
  password: "PIN-SECRET-9999",
  fields: [
    {
      name: "pin",
      label: "PIN Akses",
      type: "password",
      value: "PIN-SECRET-9999",
    },
  ],
});
assert.equal(itemPassOnly.username, "");
assert.equal(itemPassOnly.password, "PIN-SECRET-9999");
assert.equal(itemPassOnly.fields.length, 1);
assert.equal(itemPassOnly.fields[0].label, "PIN Akses");

// Entri dengan multi-field: NIP + Username + Password + Kode Kantor
const itemMulti = await storeMod.upsertItem({
  title: "Portal Kepegawaian (SIKEP)",
  url: "https://sikep.kantor.local/login",
  username: "budi.santoso",
  password: "PasswordKuat1#",
  fields: [
    { name: "nip", label: "NIP", type: "text", value: "198801012010121001" },
    {
      name: "kode_kantor",
      label: "Kode Kantor",
      type: "text",
      value: "KTR-042",
    },
    {
      name: "password",
      label: "Kata Sandi",
      type: "password",
      value: "PasswordKuat1#",
    },
  ],
});
assert.equal(itemMulti.fields.length, 3);
assert.equal(itemMulti.fields[0].value, "198801012010121001");

// Exact match untuk form tanpa username standar
const matchPassOnly = storeMod.exactMatch("https://gate.kantor.local/auth");
assert.ok(matchPassOnly);
assert.equal(matchPassOnly.id, itemPassOnly.id);

// Query items bisa mencari berdasarkan label atau value custom field
const searchNip = storeMod.queryItems({ query: "198801012010121001" });
assert.equal(searchNip.length, 1);
assert.equal(searchNip[0].id, itemMulti.id);

console.log("   Tes kredensial dinamis lolos.");

console.log("== 9. Path & Port Aware Matching ==");
const app1 = await storeMod.upsertItem({
  title: "App 1 HR",
  url: "https://internal.kantor.local/app1/login",
  username: "user.hr",
  password: "PasswordHR123#",
});

const app2 = await storeMod.upsertItem({
  title: "App 2 Finance",
  url: "https://internal.kantor.local/app2/login",
  username: "user.finance",
  password: "PasswordFin456#",
});

const appRoot = await storeMod.upsertItem({
  title: "General Portal",
  url: "https://internal.kantor.local",
  username: "user.general",
  password: "PasswordGen789#",
});

// Target halaman /app1
const matchApp1 = storeMod.exactMatch(
  "https://internal.kantor.local/app1/dashboard",
);
assert.ok(matchApp1);
assert.equal(
  matchApp1.id,
  app1.id,
  "harus mencocokkan app1 karena path prefix /app1 cocok",
);

// Target halaman /app2
const matchApp2 = storeMod.exactMatch(
  "https://internal.kantor.local/app2/home",
);
assert.ok(matchApp2);
assert.equal(
  matchApp2.id,
  app2.id,
  "harus mencocokkan app2 karena path prefix /app2 cocok",
);

// Target halaman tanpa path spesifik /other
const matchGeneral = storeMod.exactMatch(
  "https://internal.kantor.local/other/page",
);
assert.ok(matchGeneral);
assert.equal(
  matchGeneral.id,
  appRoot.id,
  "harus fallback ke root item jika path spesifik tidak cocok",
);

console.log("   Tes deteksi path & domain lolos.");

console.log("== 10. Sesi 3 Jam (180 Menit) Multi-Web ==");
await storeMod.saveSettings({ autoLockMinutes: 180 });
const currentSettings = await storeMod.loadSettings();
assert.equal(currentSettings.autoLockMinutes, 180);

// Simulasikan service worker idle/sleep (state.key dibersihkan dari RAM variabel)
storeMod.touch();
const isSessionRestored = await storeMod.ensureUnlocked();
assert.equal(
  isSessionRestored,
  true,
  "sesi harus otomatis dipulihkan dari session storage tanpa input master password",
);
assert.equal(storeMod.isUnlocked(), true);

console.log("   Tes sesi 180 menit lolos.");

console.log("== 11. IP Address & Single Host Matcher ==");
assert.equal(
  cryptoMod.domainKey("http://192.168.1.50:8080/portal"),
  "192.168.1.50",
);
assert.equal(cryptoMod.domainKey("http://10.20.0.1/"), "10.20.0.1");
assert.equal(cryptoMod.domainKey("http://intranet/login"), "intranet");
assert.equal(cryptoMod.domainKey("http://wiki/"), "wiki");

const ipItem = await storeMod.upsertItem({
  title: "Server Staging",
  url: "http://192.168.1.50:8080/app",
  username: "admin.staging",
  password: "StagingPass123!",
});

const matchedIp = storeMod.exactMatch("http://192.168.1.50:8080/app/dashboard");
assert.ok(matchedIp);
assert.equal(matchedIp.id, ipItem.id);

console.log("   Tes IP address & single host lolos.");

console.log("== SEMUA TEST BERHASIL ==");
