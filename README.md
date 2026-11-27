# BaxdeStudio Asset Permission Blaster

Website lokal untuk memberi permission **Use** atas banyak aset Roblox ke sebuah **Universe** (Experience) lewat Roblox Open Cloud Asset Permissions API. Backend Node.js/Express memegang API key; browser tidak pernah menerimanya kembali.

## 1. Instalasi

Butuh Node.js 18.17 atau lebih baru.

```bash
cd baxdestudio-asset-blaster
npm install
cp .env.example .env     # opsional
npm start
```

Buka http://127.0.0.1:3000.

## 2. Endpoint Roblox yang dipakai (diverifikasi dari dokumentasi resmi)

| Fungsi | Request |
|---|---|
| Grant permission | `PATCH https://apis.roblox.com/asset-permissions-api/v1/assets/permissions` |
| Header | `x-api-key: <key>` |
| Body | `{ "subjectType": "Universe", "subjectId": "<universeId>", "action": "Use", "requests": [{ "assetId": 123 }] }` |
| Respons 200 | `{ "successAssetIds": [..], "errors": [{ "assetId": .., "code": ".." }] }` |
| Scope | `asset-permissions:write` |
| Rate limit | 100 request per menit per pemilik API key |
| Deteksi tipe (opsional) | `GET /assets/v1/assets/{assetId}`, scope `asset:read` |

Endpoint ini berstatus **Beta** di dokumentasi Roblox. Cek ulang di https://create.roblox.com/docs/cloud/reference/domains/apis jika Roblox mengubahnya.

## 3. Membuat API key

1. Buka Creator Hub: https://create.roblox.com/dashboard/credentials
2. Klik **Create API Key**, beri nama.
3. Pada **Access Permissions**, tambahkan API system yang memuat scope `asset-permissions:write` (Asset Permissions) dengan operasi write. Jika ingin fitur deteksi tipe aset, tambahkan juga `asset:read`.
4. Pada **Accepted IP Addresses**, isi IP Anda, atau `0.0.0.0/0` bila Anda paham risikonya.
5. Atur expiration, lalu salin key (hanya tampil sekali).

Syarat otorisasi: pemilik API key (user atau group) harus mengelola **semua aset** dan **Universe** yang dimasukkan. Jika tidak, Roblox mengembalikan error per aset seperti `CannotManageAsset` atau `CannotManageSubject`.

## 4. Cara memakai

1. Tempel API key, klik **Save key**, lalu **Test API connection**.
2. Isi Universe ID (bukan Place ID, User ID, atau Group ID).
3. Tempel Asset ID, satu per baris (atau Import TXT). Duplikat dan baris kosong dibuang otomatis, ID non-angka ditandai.
4. Klik **START BLAST**. Aset dibagi per 50, dikirim satu batch demi satu batch.
5. Pantau dashboard dan tabel hasil. Gunakan Pause, Resume, Cancel, Reset.
6. Ekspor laporan TXT atau CSV, atau buka riwayat.

## 5. Perilaku penting

- **Konfirmasi ketat.** Aset hanya berstatus Success jika Roblox mencantumkannya di `successAssetIds`. HTTP 200 tanpa itu ditandai Failed ("Not confirmed"), karena dokumentasi Roblox memperingatkan key tanpa scope yang tepat bisa menerima request tanpa menerapkan perubahan.
- **Error asli.** Kode error Roblox ditampilkan apa adanya, lalu penjelasan singkat setelahnya.
- **Rate limit.** Batch berjalan berurutan dengan jeda `BATCH_DELAY_MS` (default 800 ms). HTTP 429 dicoba ulang sampai 5 kali (mengikuti `Retry-After`, atau backoff eksponensial). Error 5xx dan jaringan dicoba ulang 2 kali. Aset yang sudah Success tidak pernah dikirim ulang.
- **Pause** berhenti di antara batch (batch yang sedang berjalan diselesaikan dulu). **Cancel** tidak membatalkan request yang sedang terbang, supaya hasilnya tetap tercatat; sisa aset menjadi Skipped.
- **Deteksi tipe** (opsional) hanya melewati aset bertipe `Place`, karena dokumentasi menyatakan Place tidak mendukung aksi Use. Tipe lain tetap dikirim dan divalidasi oleh Roblox.
- **Test API connection** memakai request kosong yang tidak mengubah apa pun, jadi hanya membuktikan key tidak ditolak, bukan scope atau kepemilikan aset.
- Tipe aset yang didukung aksi Use menurut dokumentasi: Animation, Audio, Decal, Image, Mesh, MeshPart, Model, Video.

## 6. Keamanan

- API key hanya ada di memori proses server: tidak ke disk, localStorage, URL, console, atau riwayat. UI hanya menampilkan 4 karakter terakhir. Key hilang saat server dihentikan, kecuali Anda mengisi `ROBLOX_API_KEY` di `.env`.
- Server hanya mendengarkan `127.0.0.1`, menolak Host selain loopback (anti DNS-rebinding), menolak Origin lintas situs dan request tanpa header `X-Baxde-Client` (anti CSRF), serta memakai CSP ketat.
- Pesan error dari Roblox dibersihkan dari nilai API key sebelum disimpan.
- Jangan mengubah `HOST` ke `0.0.0.0` kecuali Anda menambahkan autentikasi sendiri.

## 7. Struktur

```
server/server.js              Express, route REST, guard keamanan
server/roblox-api.js          Klien HTTP Roblox
server/permission-service.js  Retry, 429, penafsiran respons
server/queue.js               Antrean batch, pause/resume/cancel
server/validator.js           Validasi input, batas 50 per batch
server/history.js             Riwayat lokal (data/history.json)
public/                       index.html, style.css, app.js
```
