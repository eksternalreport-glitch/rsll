# RSL Screenshot Bot

Screenshot halaman **DataPilot RSL Query** (tenant 1057) memakai GitHub Actions + Playwright, lalu mengirim hasilnya ke Telegram. Tidak perlu PC/server yang selalu menyala.

```
repository_dispatch (dari Apps Script)
        │
        ▼
GitHub Actions (ubuntu, Chromium)
  ├─ login CAS  (#username / #password / #loginButton)
  ├─ isi query tiket / hostname
  ├─ tunggu tabel hasil
  ├─ screenshot elemen hasil
  └─ kirim ke Telegram (sendPhoto)
```

## Isi repo

```
.github/workflows/rsl-shot.yml   workflow GitHub Actions
rsl-shot.js                      script Playwright
package.json                     dependency
apps-script/rsl-foto.gs          helper perintah /rslfoto untuk bot
README.md
```

## 1. Buat repo

1. Buka <https://github.com/new>.
2. Nama: `rsl-screenshot-bot` (bebas).
3. Pilih **Private** → **Create repository**.

## 2. Upload file

**Cara A — lewat web GitHub (tanpa git):**

1. Di repo baru, klik **Add file → Upload files**.
2. Drag isi folder `rsl-screenshot-bot` (kecuali `node_modules`; belum ada).
3. Kalau folder `.github` tidak ikut ter-upload (tersembunyi di Windows Explorer), buat manual:
   - **Add file → Create new file**
   - Nama file: `.github/workflows/rsl-shot.yml`
   - Paste isi `rsl-shot.yml` → **Commit changes**.
4. Pastikan file `rsl-shot.js`, `package.json`, dan `README.md` sudah ada di root repo.

**Cara B — kalau nanti ada Git:**

```bash
cd rsl-screenshot-bot
git init
git add .
git commit -m "RSL screenshot bot"
git branch -M main
git remote add origin https://github.com/USERNAME/rsl-screenshot-bot.git
git push -u origin main
```

## 3. Isi Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Nama | Isi |
|---|---|
| `RSL_USER` | username RSL / DataPilot |
| `RSL_PASS` | password RSL |
| `TELEGRAM_BOT_TOKEN` | token bot Telegram (yang dipakai bot patroli) |

Chat ID **tidak** disimpan di repo; dikirim dari bot saat memicu.

## 4. Tes manual

1. Buka tab **Actions** → pilih **RSL Screenshot** → **Run workflow**.
2. Isi:
   - `query`: `INC-20261022-00022727` (atau hostname)
   - `chat_id`: chat ID Telegram Anda (bisa dilihat dengan `/id` di bot)
3. Klik **Run workflow**.
4. Tunggu ±1–2 menit. Foto akan masuk ke Telegram.

Kalau gagal, buka run yang merah → **Artifacts → rsl-debug**:
- `page-full.png` — kondisi halaman terakhir
- `*.html` — HTML halaman
- `*-fields.json` — daftar input/tombol/select yang terdeteksi

Kirim artifact itu untuk penyesuaian selector.

## 5. Sambungkan ke bot Telegram

Di Apps Script bot, isi **Script Properties**:

| Nama | Isi |
|---|---|
| `GITHUB_TOKEN` | Personal Access Token |
| `GITHUB_REPO` | `USERNAME/rsl-screenshot-bot` |

Pembuatan token:

- **Fine-grained token** (disarankan): GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
  - Repository access: **Only select repositories** → pilih repo di atas.
  - Permissions → Repository permissions → **Contents: Read and write**.
- **Classic token**: scope `repo`.

Lalu:

1. Copy isi `apps-script/rsl-foto.gs` ke project bot (paling bawah file).
2. Sambungkan router pesan sesuai komentar di bagian bawah file itu.
3. Save → jalankan `/rslfoto INC-...` di Telegram.

## 6. Batasan & troubleshooting

- **WAF / IP diblokir**: kalau `teleows.com` menolak IP GitHub/AWS, halaman tidak bisa dibuka dari cloud. Solusinya VPS dengan IP yang diizinkan.
- **OTP SMS / captcha**: halaman login punya opsi SMS code. Kalau akun wajib OTP, login otomatis gagal.
- **Selector berubah**: kalau tampilan RSL berubah, script mungkin perlu disesuaikan. Debug artifact membantu.
- **Kuota**: repo private gratis 2.000 menit/bulan. Satu run ±1–2 menit.
- **Hasil screenshot**: default diambil per sisi (kartu Near End & Far End). Ubah lewat `CAPTURE_MODE` bila ingin full page atau dipotong.

## 7. Variabel opsional

Bisa diatur sebagai env di workflow:

| Env | Fungsi |
|---|---|
| `RSL_URL` | override URL halaman RSL |
| `RSL_QUERY_TYPE` | `ticket` / `hostname` / `order` untuk memaksa tipe query |
| `CAPTURE_MODE` | `sides` (default), `full`, `slices`, `both` |
| `CAPTURE_SLICE_PX` | tinggi potongan gambar untuk mode `slices` (default 1300) |

Arti `CAPTURE_MODE`:

| Mode | Hasil |
|---|---|
| `sides` | 2 foto: kartu Near End dan Far End (paling terbaca di HP) |
| `full` | 1 foto seluruh laporan (Near & Far berdampingan) |
| `slices` | laporan dipotong vertikal jadi beberapa foto |
| `both` | 1 foto seluruh laporan + 2 foto per sisi |

Saat tes manual (**Run workflow**) kolom `capture_mode` bisa diisi langsung, jadi tidak perlu ubah file.

## 8. Catatan tampilan

Script memakai viewport **1600×1000** supaya grid `2xl:grid-cols-2` aktif, sehingga Near End dan Far End tampil berdampingan seperti di PC, dan `deviceScaleFactor 2` agar teks tetap tajam.

Data yang ikut terlihat di screenshot: hostname, site, IP PTP, nilai CRC, dan serial SFP. Pastikan boleh dibagikan ke Telegram/runner GitHub.
