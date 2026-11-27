# BaxdeStudio Asset Permission Blaster (Cloudflare Pages)

Beri permission **Use** untuk banyak aset Roblox ke sebuah **Universe** lewat Roblox Open Cloud.

## Kenapa sebelumnya 404 di Cloudflare Pages
Versi lama memakai server Express (Node) yang menyimpan key, antrean, dan riwayat di memori/disk server.
Cloudflare Pages hanya menyajikan file statis, jadi server itu tidak berjalan dan root tidak ketemu.

## Arsitektur sekarang
- `public/` : situs statis (tema BAXDEV).
- `functions/api/roblox.js` : proxy stateless (Pages Function) ke Roblox, karena browser tidak bisa memanggil Roblox langsung (CORS). Key dikirim per request dan tidak disimpan/dilog.
- Antrean batch (50 per batch, pause/resume/cancel, retry 429) kini berjalan di browser. Biarkan tab tetap terbuka selama blast.
- Riwayat disimpan di localStorage browser. API key hanya di sessionStorage tab (hilang saat tab ditutup).

## Deploy di Cloudflare Pages
Cara 1 (Git, dari repo GitHub):
1. Cloudflare Dashboard > Workers & Pages > Create > Pages > Connect to Git, pilih repo.
2. Framework preset: **None**. Build command: **(kosongkan)**. Build output directory: **public**. Root directory: kosongkan.
3. Save and Deploy. Folder `functions/` otomatis dikenali.

Cara 2 (CLI): `npm install` lalu `npm run deploy`.

## Catatan Roblox
- Scope API key: `asset-permissions:write` (opsional `asset:read` untuk deteksi tipe).
- Accepted IP: Cloudflare memakai banyak IP, jadi isi `0.0.0.0/0` bila Anda paham risikonya.
