# SEKE MESARI — Arisan & Pinjaman Keluarga

Aplikasi web untuk mengelola arisan & pinjaman keluarga SEKE MESARI:
transparansi kas, status pinjaman tiap anggota, verifikasi pembayaran,
dan audit trail — dengan tampilan mobile-first bergaya aplikasi fintech.

## Menjalankan

Frontend-nya static site (HTML/CSS/JS murni, tanpa build step), tapi
aplikasi ini **butuh koneksi internet** karena data tersimpan di backend
Supabase (Postgres + Auth + Storage), bukan lagi di `localStorage`.

```bash
python3 -m http.server 8000
# lalu buka http://localhost:8000
```

Setup Supabase (sekali saja, per instalasi): ikuti `supabase/SETUP.md`.

## Login & Daftar

Anggota mendaftar sendiri lewat tombol **"Belum punya akun? Daftar di
sini"** di layar login (nama, nomor HP, password) — admin tidak perlu
tahu/mengisi data anggota sebelumnya. Akun baru otomatis berperan
**anggota**; admin pertama harus di-set manual sekali lewat SQL (lihat
`supabase/SETUP.md` langkah 5) — ini sengaja, supaya tidak ada yang bisa
mengangkat diri sendiri jadi admin.

Login pakai nomor HP + password yang didaftarkan sendiri. Di balik layar,
nomor HP dipetakan ke email sintetis (`08xxxx@sekemesari.local`) supaya
bisa memakai sistem Supabase Auth (hash password + session token) tanpa
perlu SMS OTP berbayar.

### Ganti Password & Lupa Password

- **Ganti password** (masih ingat password lama, masih bisa login) — ada
  di menu **Lainnya → Ganti Password**, bisa dilakukan sendiri oleh
  anggota kapan saja.
- **Lupa password** (tidak bisa login sama sekali) — **tidak ada
  self-service**, karena akun memakai email sintetis (`.local`), bukan
  email asli, sehingga fitur "kirim link reset ke email" bawaan Supabase
  tidak bisa mengirim apa pun ke anggota. Admin harus mereset manual:
  1. Buka [Supabase Dashboard](https://supabase.com/dashboard) → project
     SEKE MESARI → **Authentication → Users**.
  2. Cari baris dengan email `08xxxxxxxxxx@sekemesari.local` sesuai
     nomor HP anggota yang lupa password.
  3. Klik baris tersebut, lalu gunakan opsi reset/ubah password yang
     disediakan Supabase di halaman detail user itu untuk mengatur
     password baru.
  4. Sampaikan password baru itu ke anggota lewat WhatsApp/lisan, lalu
     minta mereka login dan segera ganti lagi lewat **Lainnya → Ganti
     Password** supaya admin tidak tahu password final mereka.

  Langkah 3 tergantung tampilan Supabase Dashboard yang bisa berubah
  sewaktu-waktu — kalau opsinya tidak terlihat, cek dokumentasi Supabase
  terbaru atau tanya di komunitasnya.

## Struktur Menu (5 Tab)

- **Home** — sapaan + periode arisan berjalan (ke-N dari 10), ringkasan
  (total anggota, kas terkumpul, pinjaman beredar, anggota menunggak,
  jatuh tempo bulan ini), dan pengumuman.
- **Pinjaman** — kartu pinjaman aktif (jumlah, bunga, sisa cicilan,
  sisa hutang, progress bar, jatuh tempo) + **riwayat pembayaran bernomor
  urut** (angsuran ke berapa, tanggal, jumlah) untuk anggota melihat
  pinjamannya sendiri; tombol Ajukan Pinjaman & Upload Bukti Bayar. Admin
  melihat daftar **Menunggak & Jatuh Tempo** (semua anggota berpinjaman,
  diurutkan dari yang paling perlu perhatian) dan memutuskan pengajuan
  yang menunggu.
- **Pembayaran** — upload bukti pembayaran, status verifikasi, histori
  transaksi (filter Semua/Setoran/Pinjaman/Angsuran); admin memverifikasi
  bukti yang masuk.
- **Anggota** — transparansi publik: status tiap anggota (Lancar/
  Menunggak Nx/Perlu Evaluasi Keanggotaan) dengan kode warna, klik untuk
  detail (skor kepatuhan, riwayat pembayaran bernomor urut + tanggal jatuh
  tempo, riwayat transaksi lengkap); admin bisa menonaktifkan anggota
  (anggota baru masuk lewat pendaftaran mandiri, bukan ditambahkan admin).
- **Lainnya** — Buku Kas (ledger masuk/keluar, transaksi hanya bisa
  dibatalkan, tidak dihapus), Neraca Keuangan (snapshot posisi keuangan:
  Aset vs Kewajiban & Ekuitas, format dua kolom), **Unduh Laporan
  Keuangan (PDF)** — laporan detail siap cetak/arsip (lihat bagian
  tersendiri di bawah), Timeline Periode (1–10), Audit Log, "Lihat
  Sebagai" (demo ganti peran admin/anggota tanpa logout), Tentang &
  Keterbatasan, Keluar.
- Dashboard **Home**: 3 stat card (Pinjaman Beredar, Anggota Menunggak,
  Jatuh Tempo Bulan Ini) bisa diklik admin untuk melihat daftar anggota
  terkait langsung, tanpa harus pindah tab.

## Laporan Keuangan (PDF)

Menu Lainnya → **Unduh Laporan Keuangan (PDF)** menghasilkan satu berkas
PDF berisi:

1. Ringkasan Neraca Keuangan (Aset, Kewajiban, Ekuitas) + status
   seimbang/tidak.
2. Rincian piutang pinjaman per anggota (pinjaman awal, cicilan, sisa
   hutang, jatuh tempo, status).
3. Rincian simpanan & status keanggotaan per anggota (termasuk skor
   kepatuhan).
4. Buku Kas — riwayat transaksi lengkap **dengan saldo berjalan**
   (running balance), urut tanggal, transaksi yang dibatalkan
   dikecualikan dari perhitungan (sesuai audit trail).

Setiap laporan mencatat kapan dan oleh siapa laporan itu diunduh (masuk
ke Audit Log), serta mencantumkan disclaimer bahwa ini dokumen yang
dihasilkan otomatis dari data lokal aplikasi, bukan dokumen resmi
bermaterai.

Library pembuat PDF (`jsPDF` + `jspdf-autotable`) dan client Supabase
**di-bundle lokal** di `assets/vendor/`, bukan dimuat dari CDN — supaya
tidak bergantung pada ketersediaan CDN pihak ketiga.

## Aturan bisnis yang diterapkan

- Bunga pinjaman **1%/bulan**, tenor **10x cicilan**. Angsuran per bulan
  = (jumlah pinjaman ÷ 10) × 1,01.
- Status keanggotaan otomatis berdasarkan jumlah tunggakan: 0 = Lancar,
  1–2 = Menunggak Nx, ≥3 = **Perlu Evaluasi Keanggotaan** (bukan
  penghapusan otomatis — keputusan tetap di tangan admin).
- Skor kepatuhan = `100 − (tunggakan × 15)`, minimum 35.
- **Neraca Keuangan**: Aset = Kas Koperasi + Piutang Pinjaman Anggota
  (pokok yang belum kembali). Kewajiban = total Simpanan Anggota. Ekuitas
  ("SHU / Laba Ditahan") dihitung sebagai *selisih* Aset dikurangi
  Kewajiban — bukan ditebak dari bunga per transaksi — sehingga neraca
  selalu balance sesuai persamaan akuntansi dasar (Aset = Kewajiban +
  Ekuitas), bahkan saat admin memverifikasi nominal pembayaran yang tidak
  persis mengikuti rumus angsuran.

## Struktur Berkas

```
index.html                 markup + 5 tab panel + modal + login/daftar screen
assets/style.css           tema, layout mobile-first, dark mode
assets/app.js              rendering & logika bisnis (baca/tulis lewat supabase-client.js)
assets/supabase-client.js  satu-satunya lapisan akses database (auth, fetch, mutasi)
assets/vendor/             jsPDF, jspdf-autotable, Supabase JS client (di-bundle lokal)
supabase/schema.sql        skema tabel + Row Level Security (jalankan sekali di SQL Editor)
supabase/SETUP.md          panduan setup project Supabase dari nol
```

## Keamanan

Backend sungguhan lewat Supabase — password di-hash server-side (bukan
disimpan di kode), data tersimpan di database bersama (bukan per-browser),
dan akses diatur lewat Row Level Security (RLS) di level database, bukan
cuma disembunyikan di UI:

- **Transparansi publik by design**: siapapun yang login boleh **membaca**
  seluruh data anggota lain (nama, status pinjaman, tunggakan) — ini
  sengaja, sesuai semangat "buku terbuka" koperasi keluarga, bukan
  kebocoran.
- **Menulis dibatasi ketat**: anggota hanya bisa menulis baris miliknya
  sendiri (mendaftar akun sendiri, mengajukan pinjaman sendiri, upload
  bukti bayar sendiri) — tidak bisa mengubah data anggota lain, tidak
  bisa mengubah status persetujuan, dan **tidak bisa mengangkat diri
  sendiri jadi admin** (kebijakan RLS memaksa akun baru selalu `role:
  anggota`, terlepas dari apa yang dikirim client).
- **Admin pertama** wajib di-set manual lewat SQL sekali (bukan lewat
  aplikasi) — lihat `supabase/SETUP.md` langkah 5.
- **Login HP + password tanpa OTP SMS**: SMS OTP tidak gratis di provider
  manapun, jadi nomor HP dipetakan ke email sintetis dan diautentikasi
  lewat Supabase Auth (email+password) — password tetap di-hash dengan
  benar, cuma jalur pengirimannya bukan SMS.
- **Kunci `anon` di `assets/supabase-client.js` memang publik** — ini
  sesuai desain Supabase (keamanan ada di RLS, bukan di kerahasiaan
  kunci). Yang **tidak boleh** pernah dipakai di kode client adalah kunci
  `service_role` (akses penuh, bypass RLS).

## Batasan lain

- Aplikasi butuh koneksi internet — tidak bisa dipakai offline seperti
  versi client-only sebelumnya.
- **Notifikasi**: pengingat jatuh tempo hanya muncul di dalam aplikasi
  (drawer 🔔), tidak ada push notification atau pesan WhatsApp.
- Tiap aksi (approve pinjaman, verifikasi bukti, dst) menyegarkan ulang
  seluruh data dari server setelah menulis — sederhana dan selalu akurat,
  tapi untuk koperasi dengan ratusan anggota aktif bersamaan pendekatan
  ini perlu dioptimalkan (tidak relevan untuk skala satu keluarga).
- Free tier Supabase menjeda project setelah ±1 minggu tanpa aktivitas —
  otomatis aktif lagi begitu ada yang membuka aplikasi (tunggu beberapa
  detik di percobaan pertama).
