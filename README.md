# KPI Report — renderer GitHub Actions

Renderer PNG laporan **KPI MTEL** (FIBERISASI & TIS) dan **KPI Lintas Arta**
gaya dashboard (tabel gelap, warna hijau/amber/merah, action item per branch).
Dipicu dari bot Telegram (`/kpimtel`, `/kpila`, atau tombol admin
"📊 KPI MTEL ke Grup" / "📊 KPI LA ke Grup") lewat `repository_dispatch`,
lalu mengirim foto + caption ke chat/grup.

## Isi folder

```
.github/workflows/kpi-report.yml   workflow GitHub Actions
render-kpi.js                      fetcher data + builder HTML + Playwright + kirim Telegram
kpi-style.css                      CSS dashboard (diextrak dari Index dashboard) supaya tampilan sama
package.json
```

## Cara pasang (sekali saja)

1. **Copy folder ini ke repo GitHub yang sama dengan screenshot RSL**
   (`GITHUB_REPO` yang sudah dipakai bot). Struktur akhir di repo:

   ```
   .github/workflows/kpi-report.yml
   render-kpi.js
   kpi-style.css
   package.json
   ```

   Kalau repo RSL sudah punya `.github/workflows/`, tambahkan file `kpi-report.yml`
   di folder yang sama (jangan menimpa workflow RSL).

2. **Repo → Settings → Secrets and variables → Actions → New repository secret**

   | Nama | Isi |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | token bot (`8725524193:AAFK...`) — kalau sudah ada untuk RSL, pakai yang sama |
   | `KPI_JSON_URL` | `https://script.google.com/macros/s/AKfycbwvFQX1vpHrLDXeyYVvGkeemUHuRX1-IOl4UfUCreFTrf4ThPIgVZMt-XMroJmSYt39xQ/exec?op=kpiMtEl&token=kpi-report-ms-eksternal-2026-3f9a7c1e5b8d2` |

   Endpoint LA **tidak perlu** secret tambahan: renderer otomatis mengganti
   `op=kpiMtEl` → `op=kpiLa` dari URL yang sama. (Kalau suatu saat mau dipisah,
   tambahkan secret `KPI_LA_JSON_URL`.)

3. **Commit & push ke branch default** (`main`/`master`). Workflow harus ada di
   branch default supaya `repository_dispatch` jalan.

4. **Bot Apps Script** — Script Properties (sudah ada untuk RSL, tidak perlu diubah):

   - `GITHUB_TOKEN` — PAT dengan izin dispatch repo
   - `GITHUB_REPO` — `username/nama-repo`

5. Tes manual: repo → **Actions → KPI MTEL report → Run workflow**. (Tanpa payload
   chat id, job akan gagal di langkah render dengan pesan `chat_ids kosong` — itu normal;
   tes yang sebenarnya dari bot.)

## Alur dari bot

### KPI MTEL (`/kpimtel`)

1. Admin kirim `/kpimtel` (atau tombol **📊 KPI MTEL ke Grup**).
2. Bot mengambil angka dari endpoint `op=kpiMtEl` → menyusun caption → kirim
   `repository_dispatch` event `kpi-report` berisi `kind: "mtel"`, `chat_ids`,
   `fib_caption`, `tis_caption`.
3. GitHub Actions render 2 PNG (FIBERISASI & TIS) dari HTML bergaya dashboard.
4. Workflow kirim 2 foto + caption ke chat/grup tujuan (via `sendPhoto`).

### KPI Lintas Arta (`/kpila`)

1. Admin kirim `/kpila` (atau tombol **📊 KPI LA ke Grup**).
2. Bot mengambil data dari endpoint `op=kpiLa` (SLA per branch: `scoreRT`,
   `scoreOST`, `scoreTTR`, `scoreTTP`, `scorePM`, `final`, `prevRank`) →
   caption per branch + GT → dispatch dengan `kind: "la"` dan `la_caption`.
3. Actions render 1 PNG tabel KPI Lintas Arta (kolom RT/OST/TTR/TTP/PM/FINAL,
   MOM, status, action item) lalu kirim ke chat/grup.

Kalau `GITHUB_TOKEN`/`GITHUB_REPO` belum diisi, bot otomatis fallback: MTEL
memakai render Google Charts lama (tabel putih), LA mengirim caption teks saja.

## Catatan

- Data & angka berasal dari endpoint dashboard yang sama dengan tombol **📋 Report KPI**
  (MTEL) dan tabel KPI Lintas Arta di dashboard, jadi MTTR/COMP/AVAIL/PM/OVERALL/
  FINAL/ranking konsisten.
- Caption disusun bot dari JSON yang sama, jadi caption dan gambar tidak beda angka.
- LA: `BOGOR` ditampilkan sebagai `SUKABUMI` (sama dengan dashboard).
- Biaya: GitHub Actions gratis untuk repo publik; repo privat memakai kuota menit bulanan.
