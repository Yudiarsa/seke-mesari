-- ============================================================================
-- SEKE MESARI — Skema Database Supabase (Postgres)
-- ============================================================================
-- Jalankan file ini di: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Aman dijalankan berkali-kali (idempotent) — kalau gagal di tengah jalan,
-- tinggal jalankan ulang dari awal, tidak akan error "already exists".
--
-- Desain autentikasi: login tetap "HP + Password" seperti aplikasi sekarang
-- (tanpa OTP SMS, karena SMS OTP tidak gratis di provider manapun). Triknya:
-- nomor HP diubah jadi email sintetis (mis. "081111000001@sekemesari.local")
-- lalu didaftarkan lewat Supabase Auth biasa (email+password). Ini memakai
-- sistem hashing password & session token bawaan Supabase Auth yang sudah
-- teruji, alih-alih kita bikin sendiri — jauh lebih aman daripada password
-- polos di app.js seperti sekarang.
--
-- Setiap baris di tabel "anggota" itu 1:1 dengan satu user di Supabase Auth
-- (anggota.id = auth.users.id). Saat anggota "Daftar" sendiri di app nanti,
-- itu otomatis membuat 1 baris di auth.users (lewat supabase.auth.signUp)
-- + 1 baris di tabel anggota (lewat insert biasa) yang saling terhubung.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ANGGOTA
-- ---------------------------------------------------------------------------
create table if not exists public.anggota (
  id uuid primary key references auth.users(id) on delete cascade,
  nama text not null,
  hp text not null unique,
  role text not null default 'anggota' check (role in ('admin', 'anggota')),
  tanggal_bergabung date not null default current_date,
  status text not null default 'aktif' check (status in ('aktif', 'nonaktif')),
  total_simpanan bigint not null default 0,
  tunggakan int not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.anggota is 'Data anggota koperasi. id = auth.users.id (satu akun login = satu anggota).';

-- ---------------------------------------------------------------------------
-- 2. PINJAMAN (satu anggota hanya boleh punya 1 pinjaman aktif sekaligus —
--    dijaga lewat unique index di bawah, bukan cuma di kode aplikasi)
-- ---------------------------------------------------------------------------
create table if not exists public.pinjaman (
  id uuid primary key default gen_random_uuid(),
  anggota_id uuid not null references public.anggota(id),
  jumlah bigint not null,
  total_cicilan int not null default 10,
  cicilan_terbayar int not null default 0,
  bunga_persen_bulan numeric not null default 1,
  jatuh_tempo date not null,
  status text not null default 'aktif' check (status in ('aktif', 'lunas')),
  created_at timestamptz not null default now()
);

create unique index if not exists satu_pinjaman_aktif_per_anggota
  on public.pinjaman (anggota_id)
  where status = 'aktif';

-- ---------------------------------------------------------------------------
-- 3. TRANSAKSI (Buku Kas — audit trail: hanya bisa dibatalkan, tidak dihapus)
-- ---------------------------------------------------------------------------
create table if not exists public.transaksi (
  id uuid primary key default gen_random_uuid(),
  tanggal date not null,
  anggota_id uuid not null references public.anggota(id),
  jenis text not null check (jenis in ('setoran', 'pinjaman', 'angsuran')),
  jumlah bigint not null,
  arah text not null check (arah in ('masuk', 'keluar')),
  keterangan text,
  dibatalkan boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. PENGAJUAN PINJAMAN
-- ---------------------------------------------------------------------------
create table if not exists public.pengajuan_pinjaman (
  id uuid primary key default gen_random_uuid(),
  anggota_id uuid not null references public.anggota(id),
  jumlah bigint not null,
  tujuan text,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. BUKTI PEMBAYARAN (foto disimpan di Supabase Storage, kolom ini cuma URL)
-- ---------------------------------------------------------------------------
create table if not exists public.bukti_pembayaran (
  id uuid primary key default gen_random_uuid(),
  anggota_id uuid not null references public.anggota(id),
  tanggal date not null,
  nominal bigint not null,
  catatan text,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak')),
  foto_url text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6. PENGUMUMAN
-- ---------------------------------------------------------------------------
create table if not exists public.pengumuman (
  id uuid primary key default gen_random_uuid(),
  teks text not null,
  tanggal date not null default current_date,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. AUDIT LOG (immutable — tidak ada policy UPDATE/DELETE sama sekali)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  aksi text not null,
  waktu timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8. PENGATURAN (satu baris saja: periode berjalan, kas awal)
-- ---------------------------------------------------------------------------
create table if not exists public.pengaturan (
  id int primary key default 1,
  periode_sekarang int not null default 1,
  total_periode int not null default 10,
  kas_terkumpul_awal bigint not null default 0,
  constraint pengaturan_singleton check (id = 1)
);
insert into public.pengaturan (id) values (1) on conflict (id) do nothing;

-- ============================================================================
-- ROW LEVEL SECURITY
-- Prinsip: transparansi publik (siapapun yang login bisa BACA semua data —
-- sama seperti sekarang, anggota tab memang publik) tapi hanya admin atau
-- pemilik data yang boleh MENULIS.
-- ============================================================================

-- Helper: cek apakah user yang sedang login adalah admin
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.anggota
    where id = auth.uid() and role = 'admin'
  );
$$;

alter table public.anggota enable row level security;
alter table public.pinjaman enable row level security;
alter table public.transaksi enable row level security;
alter table public.pengajuan_pinjaman enable row level security;
alter table public.bukti_pembayaran enable row level security;
alter table public.pengumuman enable row level security;
alter table public.audit_log enable row level security;
alter table public.pengaturan enable row level security;

-- Semua "create policy" didahului "drop policy if exists" supaya file ini
-- aman dijalankan berulang kali (Postgres tidak punya "create policy if not
-- exists" bawaan).

-- anggota: semua yang login boleh baca; daftar sendiri (insert baris sendiri,
-- selalu sebagai role 'anggota'); hanya admin yang boleh update (nonaktifkan,
-- ubah role, dst) — anggota TIDAK punya jalur update baris sendiri sama
-- sekali, supaya tidak ada celah mengubah role/simpanan/tunggakan sendiri
-- lewat panggilan API langsung.
drop policy if exists "anggota_select_all" on public.anggota;
create policy "anggota_select_all" on public.anggota for select to authenticated using (true);
-- PENTING: wajib cek role='anggota' juga, bukan cuma id=auth.uid() —
-- kalau tidak, siapapun yang daftar bisa set role sendiri jadi 'admin'
-- langsung lewat API/console browser, melewati form aplikasi.
drop policy if exists "anggota_insert_self" on public.anggota;
create policy "anggota_insert_self" on public.anggota for insert to authenticated with check (id = auth.uid() and role = 'anggota');
drop policy if exists "anggota_update_admin" on public.anggota;
create policy "anggota_update_admin" on public.anggota for update to authenticated using (public.is_admin());
drop policy if exists "anggota_update_self" on public.anggota;

-- pinjaman, transaksi, pengajuan_pinjaman, bukti_pembayaran, pengumuman: baca semua
drop policy if exists "pinjaman_select_all" on public.pinjaman;
create policy "pinjaman_select_all" on public.pinjaman for select to authenticated using (true);
drop policy if exists "transaksi_select_all" on public.transaksi;
create policy "transaksi_select_all" on public.transaksi for select to authenticated using (true);
drop policy if exists "pengajuan_select_all" on public.pengajuan_pinjaman;
create policy "pengajuan_select_all" on public.pengajuan_pinjaman for select to authenticated using (true);
drop policy if exists "bukti_select_all" on public.bukti_pembayaran;
create policy "bukti_select_all" on public.bukti_pembayaran for select to authenticated using (true);
drop policy if exists "pengumuman_select_all" on public.pengumuman;
create policy "pengumuman_select_all" on public.pengumuman for select to authenticated using (true);
drop policy if exists "auditlog_select_all" on public.audit_log;
create policy "auditlog_select_all" on public.audit_log for select to authenticated using (true);
drop policy if exists "pengaturan_select_all" on public.pengaturan;
create policy "pengaturan_select_all" on public.pengaturan for select to authenticated using (true);

-- pinjaman & transaksi: hanya admin yang menulis (dibuat lewat alur approval)
drop policy if exists "pinjaman_write_admin" on public.pinjaman;
create policy "pinjaman_write_admin" on public.pinjaman for all to authenticated using (public.is_admin());
drop policy if exists "transaksi_write_admin" on public.transaksi;
create policy "transaksi_write_admin" on public.transaksi for all to authenticated using (public.is_admin());

-- pengajuan_pinjaman: anggota ajukan punya sendiri; admin putuskan (update) semua
drop policy if exists "pengajuan_insert_self" on public.pengajuan_pinjaman;
create policy "pengajuan_insert_self" on public.pengajuan_pinjaman for insert to authenticated with check (anggota_id = auth.uid());
drop policy if exists "pengajuan_update_admin" on public.pengajuan_pinjaman;
create policy "pengajuan_update_admin" on public.pengajuan_pinjaman for update to authenticated using (public.is_admin());

-- bukti_pembayaran: anggota upload punya sendiri; admin verifikasi (update) semua
drop policy if exists "bukti_insert_self" on public.bukti_pembayaran;
create policy "bukti_insert_self" on public.bukti_pembayaran for insert to authenticated with check (anggota_id = auth.uid());
drop policy if exists "bukti_update_admin" on public.bukti_pembayaran;
create policy "bukti_update_admin" on public.bukti_pembayaran for update to authenticated using (public.is_admin());

-- pengumuman & pengaturan: admin-only untuk tulis
drop policy if exists "pengumuman_write_admin" on public.pengumuman;
create policy "pengumuman_write_admin" on public.pengumuman for all to authenticated using (public.is_admin());
drop policy if exists "pengaturan_write_admin" on public.pengaturan;
create policy "pengaturan_write_admin" on public.pengaturan for all to authenticated using (public.is_admin());

-- audit_log: siapapun yang login boleh menambah baris (setiap aksi tercatat),
-- TIDAK ADA policy update/delete sama sekali -> log tidak bisa diubah/dihapus.
drop policy if exists "auditlog_insert_all" on public.audit_log;
create policy "auditlog_insert_all" on public.audit_log for insert to authenticated with check (true);

-- ============================================================================
-- STORAGE (bucket "bukti-pembayaran")
-- "Public bucket" di dashboard hanya mengizinkan orang MEMBACA file lewat
-- URL publik — mengunggah (insert) tetap butuh policy RLS sendiri di sini.
-- Bucket-nya sendiri harus dibuat manual sekali lewat dashboard (Storage ->
-- New bucket -> nama "bukti-pembayaran" -> Public bucket: ON), SQL tidak
-- bisa membuat bucket.
-- ============================================================================
drop policy if exists "bukti_pembayaran_upload_own_folder" on storage.objects;
create policy "bukti_pembayaran_upload_own_folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'bukti-pembayaran'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
