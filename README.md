# Monopoli Nusantara — server online

Backend realtime (Node + WebSocket) + database sendiri (Neon Postgres) buat Monopoli Nusantara online. Frontend statis ada di `public/index.html`, disajikan langsung oleh server yang sama.

## Jalanin lokal

```
npm install
npm start
```

Buka http://localhost:3000 — bisa buka 2 tab buat simulasi 2 pemain.

Koneksi database diambil dari `.env` (`DATABASE_URL`). Sudah keisi pakai Neon punyamu — **jangan commit file `.env`** (sudah masuk `.gitignore`).

## Deploy ke Render (gratis)

1. **Push ke GitHub** (folder `server/` ini jadi satu repo sendiri):
   ```
   git init
   git add .
   git commit -m "init: monopoli nusantara online server"
   ```
   Bikin repo baru di https://github.com/new (kosongkan, jangan centang README), lalu:
   ```
   git remote add origin https://github.com/USERNAME/monopoli-nusantara.git
   git branch -M main
   git push -u origin main
   ```

2. **Render**: buka https://dashboard.render.com → **New +** → **Web Service** → connect repo GitHub yang barusan dibuat.
   - Environment: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
   - Tambah Environment Variable: `DATABASE_URL` = (paste connection string Neon kamu, yang ada di `.env`)
   - Klik **Create Web Service**

   (Kalau mau lebih cepat: repo ini sudah ada `render.yaml` — pakai **New +** → **Blueprint** dan Render akan baca konfigurasinya otomatis, kamu tinggal isi `DATABASE_URL` waktu diminta.)

3. Tunggu build selesai (±1-2 menit). Render kasih URL publik kayak `https://monopoli-nusantara.onrender.com` — itu link yang dibagikan ke teman.

### Catatan plan gratis Render

- Server "tidur" kalau tidak ada yang akses ±15 menit. Yang pertama buka setelah itu bakal nunggu ~30-60 detik server bangun (halaman sudah otomatis retry, tinggal tunggu, tidak perlu refresh manual).
- Selama ada yang main (koneksi WebSocket aktif), server tetap bangun.
- Kalau mau tanpa jeda bangun sama sekali, upgrade ke plan berbayar Render, atau pakai layanan lain (Fly.io/Railway) — kode ini portable, tinggal deploy ulang di mana saja yang jalanin Node.

## Arsitektur singkat

- **Postgres (Neon)** — satu tabel `rooms(code, lobby jsonb, game jsonb, ...)`, dibuat otomatis saat server start. Ini yang bikin room tahan refresh/restart.
- **In-memory + WebSocket** — state room di-cache di memori proses, broadcast realtime ke semua client di room yang sama. Postgres cuma lapisan penyimpanan (durability), bukan jalur realtime — makanya butuh 1 instance server (plan Free Render pas, tidak perlu scale-out).
- **Frontend** (`public/index.html`) — satu file HTML/CSS/JS, terhubung ke server sendiri lewat `wss://.../ws`. Tidak ada lagi ketergantungan ke Claude — siapa pun dengan link bisa join, tidak dibatasi organisasi.
- Room otomatis dihapus dari database kalau tidak disentuh 3 hari (lihat `initSchema()` di `server.js`).

## File penting

- `server.js` — server Express + WebSocket + koneksi Postgres.
- `public/index.html` — game lengkap (papan, animasi, bot CPU, trading, lelang, house rules).
- `schema` dibuat otomatis, tidak perlu migrasi manual.
- `smoketest.js` / `smoketest2.js` — script uji protokol WebSocket end-to-end (jalankan `node smoketest.js` sambil server nyala kalau mau re-test setelah ubah kode).
