# Vault Local — Chrome Extension Kredensial Offline

Extension Chrome mandiri untuk menyimpan dan mengisi kredensial secara lokal dengan enkripsi kelas militer (AES-256-GCM + PBKDF2-SHA256 600.000 iterasi). Tidak ada server, tidak ada cloud, tidak ada telemetri. Data tetap di disk mesin ini.

Dirancang khusus untuk laptop kantor yang mematikan fitur simpan password bawaan browser via kebijakan grup (GPO).

---

## 1. Jawaban Langsung

**Bisa, 100% lokal dan terenkripsi.**

- **Kenapa kebijakan kantor mematikan save password bawaan?**  
  Kebijakan seperti `PasswordManagerEnabled = false` di `chrome://policy` hanya mematikan fitur Google Password Manager internal. Extension ini berjalan sebagai aplikasi mandiri di atas Web Extensions API, menyimpan payload terenkripsi ke `chrome.storage.local`, dan mengisi form via DOM manipulation di Content Script yang terisolasi.
- **Bagaimana keamanannya?**
  - Data dienkripsi menggunakan **AES-256-GCM** dengan IV acak 96-bit per simpanan.
  - Kunci enkripsi diturunkan dari password master via **PBKDF2-SHA256** sebanyak **600.000 iterasi** (standar OWASP terkini) ditambah salt acak 128-bit.
  - Kunci enkripsi aktif hanya disimpan di memori kerja sesi browser (`chrome.storage.session`, bukan disk). Saat browser ditutup atau timer _auto-lock_ habis, kunci dihapus dari RAM.
  - Pembersihan clipboard otomatis setelah menyalin password (default 25 detik).

---

## 2. Cara Pasang di Chrome

1. Buka Chrome, ketik di address bar:  
   `chrome://extensions/`
2. Di pojok kanan atas, nyalakan toggle **Developer mode**.
3. Klik tombol **Load unpacked** (Muat yang belum dibongkar) di pojok kiri atas.
4. Pilih folder ini:  
   `D:\SC\store-credentials-extension`
5. Extension **Vault Local** akan muncul. Klik ikon puzzle di toolbar Chrome dan sematkan (pin) ikon gembok ke toolbar.

> **Catatan kebijakan kantor:**  
> Jika tombol _Developer mode_ atau _Load unpacked_ abu-abu/hilang, kantor memasang kebijakan `DeveloperToolsAvailability` atau `ExtensionInstallBlocklist`. Cek di tab `chrome://policy`. Jika Developer mode diizinkan, extension ini langsung berfungsi normal tanpa butuh izin admin Windows.

---

## 3. Fitur Utama

- **Offline total**: Tanpa server backend, tanpa akun, tanpa analytics, izin jaringan eksternal nol.
- **Penyimpanan terenkripsi**: Master password tidak pernah disimpan di disk dalam bentuk apa pun. Yang disimpan hanya salt dan verifier hash.
- **Autofill cerdas**:
  - Badge kecil **V** muncul di dekat input username/password pada halaman login web internal kantor.
  - Dukungan shortcut keyboard:
    - `Alt+Shift+V` : Buka popup vault
    - `Alt+Shift+F` : Buka pemilih kredensial dan isi tab aktif
    - `Alt+Shift+L` : Kunci vault seketika
  - Mode prompt (tanya dulu), mode auto (hanya untuk host yang persis), atau izin per situs.
- **Deteksi Form Login**: Menangkap form saat submit dan menawarkan opsi simpan ke vault.
- **Generator password**: Panjang 6–128 karakter, set karakter (besar, kecil, angka, simbol), penghindaran karakter ambigu, dan indikator bit entropi.
- **TOTP / 2FA Authenticator (RFC 6238)**: Simpan secret base32, langsung tampilkan kode 6 digit dengan hitung mundur waktu (berguna untuk web kantor yang pakai OTP).
- **Riwayat Password**: Menyimpan hingga 5 password lama per entri (berguna saat kantor mewajibkan ganti password berkala).
- **Ekspor & Impor Fleksibel**:
  - Backup terenkripsi penuh `.json` (aman disimpan di flashdisk/backup).
  - Ekspor `.csv` dan plaintext `.json` (untuk migrasi darurat).
  - Impor `.csv` dari LastPass, Bitwarden, Chrome Passwords, atau 1Password.
- **Auto-lock**: Otomatis mengunci setelah tidak aktif (default 10 menit, dapat disesuaikan 1–240 menit).

---

## 4. Struktur Proyek

```
store-credentials-extension/
├── manifest.json            # Manifest V3 deklarasi extension
├── assets/                  # Ikon aplikasi (16, 32, 48, 128 px)
├── src/
│   ├── background.js        # Service worker: pesan, alarm auto-lock, session
│   ├── crypto.js            # Primitif WebCrypto (AES-GCM, PBKDF2, TOTP, KDF)
│   ├── store.js             # Lapisan storage, CRUD, pencarian, ekspor/impor
│   ├── ui.js                # Utilitas UI bersama
│   ├── ui.css               # Tema dark/light terpadu
│   ├── popup.html / .js     # UI cepat saat klik ikon di toolbar
│   ├── manager.html / .js   # Dasbor lengkap (entri, generator, data, pengaturan)
│   ├── overlay.html / .js   # Dialog modal terisolasi di halaman web (autofill)
│   ├── offscreen.html / .js # Penangan clipboard aman di background
│   └── content/
│       ├── fill.js          # Content script: pendeteksi input dan autofill
│       └── fill.css         # Efek visual saat field diisi
└── tests/
    └── self_test.mjs        # Verifikasi kriptografi & TOTP mandiri
```

---

## 5. Menjalankan Tes Mandiri

Proyek ini dilengkapi pengujian mandiri tanpa framework (menguji WebCrypto, vektor RFC 6238 TOTP, hashing, dan parser CSV):

```powershell
node tests/self_test.mjs
```

Hasil:

- Enkripsi dan dekripsi round-trip AES-256-GCM.
- 5 vektor resmi RFC 6238 TOTP Appendix B terverifikasi persis.
- Simulasi CRUD vault, multi-version password history, rotasi master password, dan re-key KDF.
