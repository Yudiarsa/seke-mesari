/* =========================================================
   SEKE MESARI — Lapisan akses data Supabase
   Semua komunikasi ke database lewat file ini. Prinsip: tiap aksi
   mutasi (approve pinjaman, verifikasi bukti, dst) menulis ke Supabase
   lalu app.js memanggil dbFetchState() ulang untuk menyegarkan seluruh
   data — bukan menghitung ulang manual di sisi klien. Untuk skala satu
   keluarga/koperasi kecil ini jauh lebih sederhana & tidak mungkin
   "meleset" dari data sungguhan di database.

   File ini murni fungsi data (tidak baca elemen DOM apa pun) supaya
   gampang dites terpisah dari tampilan.
   ========================================================= */

const SUPABASE_URL = "https://pkftykrbgbsrqkepnkmt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrZnR5a3JiZ2JzcnFrZXBua210Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MDE4MDQsImV4cCI6MjEwNDk3NzgwNH0.Yw8OGRLw_TkunGjvDdS1xKP7sevU-GBOuq1Wo-y0azI";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ===== Konstanta aturan bisnis (dipakai app.js & file ini) ===== */
const BUNGA_PERSEN = 1;
const TOTAL_CICILAN = 10;
const TOTAL_PERIODE = 10;

/* ===== Util tanggal & format (dipakai app.js & file ini) ===== */
function todayIso() { return new Date().toISOString().slice(0, 10); }
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function nowIso() { return new Date().toISOString(); }
function formatRupiah(n) {
  n = Math.round(n || 0);
  return "Rp" + n.toLocaleString("id-ID");
}

/* ===== Auth =====
   Nomor HP dipetakan ke email sintetis supaya bisa pakai Supabase Auth
   (email+password) tanpa perlu SMS OTP berbayar. Lihat supabase/schema.sql. */
function hpToEmail(hp) { return hp.trim() + "@sekemesari.local"; }

async function dbSignUp(nama, hp, password) {
  const { data, error } = await db.auth.signUp({ email: hpToEmail(hp), password });
  if (error) {
    if (error.message.includes("already registered")) throw new Error("Nomor HP ini sudah terdaftar.");
    throw new Error(error.message);
  }
  if (!data.session) {
    throw new Error("Pendaftaran perlu konfirmasi email. Admin perlu mematikan 'Confirm email' di pengaturan Supabase Auth.");
  }
  const { error: insertErr } = await db.from("anggota").insert({ id: data.user.id, nama: nama.trim(), hp: hp.trim(), role: "anggota" });
  if (insertErr) throw new Error("Akun dibuat tapi gagal menyimpan data anggota: " + insertErr.message);
}

async function dbSignIn(hp, password) {
  const { error } = await db.auth.signInWithPassword({ email: hpToEmail(hp), password });
  if (error) throw new Error("Nomor HP atau password salah.");
}

async function dbSignOut() {
  await db.auth.signOut();
}

async function dbGetSessionUserId() {
  const { data } = await db.auth.getSession();
  return data.session ? data.session.user.id : null;
}

/* Ganti password untuk anggota yang masih bisa login (ingat password lama).
   Untuk anggota yang benar-benar lupa password (tidak bisa login sama
   sekali), tidak ada jalur self-service: akun memakai email sintetis
   (nomor HP + "@sekemesari.local"), bukan email asli, jadi Supabase tidak
   punya alamat nyata untuk kirim link reset. Admin harus reset manual
   lewat Supabase Dashboard — lihat README bagian Keamanan. */
async function dbGantiPassword(passwordBaru) {
  const { error } = await db.auth.updateUser({ password: passwordBaru });
  if (error) throw new Error(error.message);
}

/* ===== Fetch seluruh state =====
   Mengembalikan objek dengan bentuk yang SAMA PERSIS dengan `state` versi
   localStorage sebelumnya, supaya semua fungsi render di app.js tidak
   perlu diubah. */
function mapAnggotaRow(a, pinjamanRow) {
  return {
    id: a.id,
    nama: a.nama,
    hp: a.hp,
    role: a.role,
    tanggalBergabung: a.tanggal_bergabung,
    status: a.status,
    totalSimpanan: a.total_simpanan,
    tunggakan: a.tunggakan,
    pinjaman: pinjamanRow ? {
      id: pinjamanRow.id,
      jumlah: pinjamanRow.jumlah,
      totalCicilan: pinjamanRow.total_cicilan,
      cicilanTerbayar: pinjamanRow.cicilan_terbayar,
      bungaPersenBulan: pinjamanRow.bunga_persen_bulan,
      jatuhTempo: pinjamanRow.jatuh_tempo
    } : null
  };
}

async function dbFetchState() {
  const [anggotaRes, pinjamanRes, transaksiRes, pengajuanRes, buktiRes, pengumumanRes, auditRes, pengaturanRes] = await Promise.all([
    db.from("anggota").select("*").order("tanggal_bergabung"),
    db.from("pinjaman").select("*").eq("status", "aktif"),
    db.from("transaksi").select("*"),
    db.from("pengajuan_pinjaman").select("*"),
    db.from("bukti_pembayaran").select("*"),
    db.from("pengumuman").select("*"),
    db.from("audit_log").select("*").order("waktu", { ascending: false }),
    db.from("pengaturan").select("*").eq("id", 1).single()
  ]);
  [anggotaRes, pinjamanRes, transaksiRes, pengajuanRes, buktiRes, pengumumanRes, auditRes, pengaturanRes].forEach(r => {
    if (r.error) throw new Error(r.error.message);
  });

  const pinjamanByAnggota = {};
  pinjamanRes.data.forEach(p => { pinjamanByAnggota[p.anggota_id] = p; });

  return {
    periodeSekarang: pengaturanRes.data.periode_sekarang,
    totalPeriode: pengaturanRes.data.total_periode,
    kasTerkumpulAwal: pengaturanRes.data.kas_terkumpul_awal,
    anggota: anggotaRes.data.map(a => mapAnggotaRow(a, pinjamanByAnggota[a.id])),
    transaksi: transaksiRes.data.map(t => ({
      id: t.id, tanggal: t.tanggal, anggotaId: t.anggota_id, jenis: t.jenis,
      jumlah: t.jumlah, arah: t.arah, keterangan: t.keterangan, dibatalkan: t.dibatalkan
    })),
    pengajuanPinjaman: pengajuanRes.data.map(p => ({
      id: p.id, anggotaId: p.anggota_id, jumlah: p.jumlah, tujuan: p.tujuan,
      status: p.status, createdAt: p.created_at
    })),
    buktiPembayaran: buktiRes.data.map(b => ({
      id: b.id, anggotaId: b.anggota_id, tanggal: b.tanggal, nominal: b.nominal,
      catatan: b.catatan, status: b.status, fotoUrl: b.foto_url, createdAt: b.created_at
    })),
    pengumuman: pengumumanRes.data.map(p => ({ id: p.id, teks: p.teks, tanggal: p.tanggal })),
    auditLog: auditRes.data.map(l => ({ id: l.id, actor: l.actor, aksi: l.aksi, waktu: l.waktu }))
  };
}

/* ===== Audit log ===== */
async function dbLogAudit(actorNama, aksi) {
  const { error } = await db.from("audit_log").insert({ actor: actorNama, aksi });
  if (error) console.warn("Gagal mencatat audit log:", error.message);
}

/* ===== Pengumuman ===== */
async function dbInsertPengumuman(teks) {
  const { error } = await db.from("pengumuman").insert({ teks });
  if (error) throw new Error(error.message);
}

async function dbDeletePengumuman(id) {
  const { error } = await db.from("pengumuman").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/* ===== Pinjaman ===== */
async function dbAjukanPinjaman(anggotaId, jumlah, tujuan) {
  const { error } = await db.from("pengajuan_pinjaman").insert({ anggota_id: anggotaId, jumlah, tujuan });
  if (error) throw new Error(error.message);
}

async function dbDecidePengajuanPinjaman(pengajuan, anggotaNama, approve, actorNama) {
  const { error: updErr } = await db.from("pengajuan_pinjaman")
    .update({ status: approve ? "disetujui" : "ditolak" })
    .eq("id", pengajuan.id);
  if (updErr) throw new Error(updErr.message);

  if (approve) {
    const { error: pinjErr } = await db.from("pinjaman").insert({
      anggota_id: pengajuan.anggotaId,
      jumlah: pengajuan.jumlah,
      total_cicilan: TOTAL_CICILAN,
      cicilan_terbayar: 0,
      bunga_persen_bulan: BUNGA_PERSEN,
      jatuh_tempo: daysFromNow(30),
      status: "aktif"
    });
    if (pinjErr) throw new Error(pinjErr.message);

    const { error: anggotaErr } = await db.from("anggota").update({ tunggakan: 0 }).eq("id", pengajuan.anggotaId);
    if (anggotaErr) throw new Error(anggotaErr.message);

    const { error: txErr } = await db.from("transaksi").insert({
      tanggal: todayIso(), anggota_id: pengajuan.anggotaId, jenis: "pinjaman",
      jumlah: pengajuan.jumlah, arah: "keluar", keterangan: "Pencairan pinjaman"
    });
    if (txErr) throw new Error(txErr.message);
  }

  await dbLogAudit(actorNama, `${approve ? "Menyetujui" : "Menolak"} pengajuan pinjaman ${anggotaNama} sebesar ${formatRupiah(pengajuan.jumlah)}`);
}

/* ===== Bukti pembayaran ===== */
async function dbUploadBuktiFoto(file, anggotaId) {
  if (!file) return null;
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${anggotaId}/${Date.now()}.${ext}`;
  const { error } = await db.storage.from("bukti-pembayaran").upload(path, file);
  if (error) throw new Error("Gagal upload foto: " + error.message);
  const { data } = db.storage.from("bukti-pembayaran").getPublicUrl(path);
  return data.publicUrl;
}

async function dbUploadBukti(anggotaId, tanggal, nominal, catatan, fotoUrl) {
  const { error } = await db.from("bukti_pembayaran").insert({
    anggota_id: anggotaId, tanggal, nominal, catatan: catatan || null, foto_url: fotoUrl
  });
  if (error) throw new Error(error.message);
}

async function dbDecideBukti(bukti, anggota, approve, actorNama) {
  const { error: updErr } = await db.from("bukti_pembayaran")
    .update({ status: approve ? "disetujui" : "ditolak" })
    .eq("id", bukti.id);
  if (updErr) throw new Error(updErr.message);

  if (approve) {
    const jenis = anggota.pinjaman ? "angsuran" : "setoran";
    const { error: txErr } = await db.from("transaksi").insert({
      tanggal: bukti.tanggal, anggota_id: anggota.id, jenis, jumlah: bukti.nominal, arah: "masuk",
      keterangan: bukti.catatan || (anggota.pinjaman ? "Angsuran" : "Setoran")
    });
    if (txErr) throw new Error(txErr.message);

    if (anggota.pinjaman) {
      const cicilanBaru = Math.min(anggota.pinjaman.totalCicilan, anggota.pinjaman.cicilanTerbayar + 1);
      const lunas = cicilanBaru >= anggota.pinjaman.totalCicilan;
      const { error: pinjErr } = await db.from("pinjaman")
        .update({ cicilan_terbayar: cicilanBaru, status: lunas ? "lunas" : "aktif" })
        .eq("id", anggota.pinjaman.id);
      if (pinjErr) throw new Error(pinjErr.message);

      const { error: anggotaErr } = await db.from("anggota")
        .update({ tunggakan: Math.max(0, anggota.tunggakan - 1) })
        .eq("id", anggota.id);
      if (anggotaErr) throw new Error(anggotaErr.message);
    } else {
      const { error: anggotaErr } = await db.from("anggota")
        .update({ total_simpanan: anggota.totalSimpanan + bukti.nominal })
        .eq("id", anggota.id);
      if (anggotaErr) throw new Error(anggotaErr.message);
    }
  }

  await dbLogAudit(actorNama, `${approve ? "Menyetujui" : "Menolak"} pembayaran ${anggota.nama} sebesar ${formatRupiah(bukti.nominal)}`);
}

/* ===== Anggota ===== */
async function dbSetAnggotaStatus(anggotaId, anggotaNama, status, actorNama) {
  const { error } = await db.from("anggota").update({ status }).eq("id", anggotaId);
  if (error) throw new Error(error.message);
  await dbLogAudit(actorNama, `${status === "nonaktif" ? "Menonaktifkan" : "Mengaktifkan"} anggota ${anggotaNama}`);
}

/* ===== Admin tools: penyesuaian kas & input pinjaman/angsuran manual =====
   Dipakai untuk onboarding data riil (kas awal, pinjaman yang sudah
   berjalan sebelum pakai aplikasi ini) tanpa admin perlu SQL manual. */
async function dbSesuaikanKas(jumlah, arah, keterangan, actorNama) {
  const { error } = await db.from("transaksi").insert({
    tanggal: todayIso(), anggota_id: null, jenis: "penyesuaian", jumlah, arah, keterangan
  });
  if (error) throw new Error(error.message);
  await dbLogAudit(actorNama, `Penyesuaian kas: ${arah === "masuk" ? "+" : "-"}${formatRupiah(jumlah)} — ${keterangan}`);
}

async function dbAdminBuatPinjaman(anggotaId, anggotaNama, jumlah, tanggalPencairan, actorNama) {
  const jatuhTempo = new Date(tanggalPencairan);
  jatuhTempo.setDate(jatuhTempo.getDate() + 30);
  const { error: pinjErr } = await db.from("pinjaman").insert({
    anggota_id: anggotaId, jumlah, total_cicilan: TOTAL_CICILAN, cicilan_terbayar: 0,
    bunga_persen_bulan: BUNGA_PERSEN, jatuh_tempo: jatuhTempo.toISOString().slice(0, 10), status: "aktif"
  });
  if (pinjErr) {
    if (pinjErr.message.includes("duplicate key")) throw new Error("Anggota ini sudah punya pinjaman aktif.");
    throw new Error(pinjErr.message);
  }
  const { error: anggotaErr } = await db.from("anggota").update({ tunggakan: 0 }).eq("id", anggotaId);
  if (anggotaErr) throw new Error(anggotaErr.message);
  const { error: txErr } = await db.from("transaksi").insert({
    tanggal: tanggalPencairan, anggota_id: anggotaId, jenis: "pinjaman",
    jumlah, arah: "keluar", keterangan: "Pencairan pinjaman (input manual admin)"
  });
  if (txErr) throw new Error(txErr.message);
  await dbLogAudit(actorNama, `Input pinjaman manual untuk ${anggotaNama} sebesar ${formatRupiah(jumlah)}`);
}

async function dbAdminCatatAngsuran(anggota, tanggal, nominal, actorNama) {
  if (!anggota.pinjaman) throw new Error("Anggota ini tidak punya pinjaman aktif.");
  const { error: txErr } = await db.from("transaksi").insert({
    tanggal, anggota_id: anggota.id, jenis: "angsuran", jumlah: nominal, arah: "masuk",
    keterangan: "Angsuran (input manual admin)"
  });
  if (txErr) throw new Error(txErr.message);

  const cicilanBaru = Math.min(anggota.pinjaman.totalCicilan, anggota.pinjaman.cicilanTerbayar + 1);
  const lunas = cicilanBaru >= anggota.pinjaman.totalCicilan;
  const { error: pinjErr } = await db.from("pinjaman")
    .update({ cicilan_terbayar: cicilanBaru, status: lunas ? "lunas" : "aktif" })
    .eq("id", anggota.pinjaman.id);
  if (pinjErr) throw new Error(pinjErr.message);

  const { error: anggotaErr } = await db.from("anggota")
    .update({ tunggakan: Math.max(0, anggota.tunggakan - 1) })
    .eq("id", anggota.id);
  if (anggotaErr) throw new Error(anggotaErr.message);

  await dbLogAudit(actorNama, `Mencatat angsuran manual ${anggota.nama} sebesar ${formatRupiah(nominal)}`);
}

/* ===== Koreksi kesalahan input =====
   Prinsip: transaksi kas/angsuran/setoran DIBATALKAN (tetap tercatat,
   dikecualikan dari semua total) — bukan dihapus, supaya jejak audit
   tidak bisa dimanipulasi. Pencairan pinjaman yang BELUM ada angsuran
   sama sekali beda kasus: itu murni kesalahan input, jadi boleh benar-
   benar dihapus. Begitu sudah ada 1x angsuran, tidak boleh dihapus lagi
   — harus dibatalkan transaksinya satu per satu. */
async function dbBatalkanTransaksi(transaksi, actorNama) {
  if (transaksi.jenis === "pinjaman") {
    throw new Error("Pencairan pinjaman tidak bisa dibatalkan dari sini — gunakan \"Hapus Pinjaman\" di detail anggota (hanya bisa kalau belum ada angsuran).");
  }
  const { error: txErr } = await db.from("transaksi").update({ dibatalkan: true }).eq("id", transaksi.id);
  if (txErr) throw new Error(txErr.message);

  if (transaksi.jenis === "angsuran" && transaksi.anggotaId) {
    const { data: pinjamanRow } = await db.from("pinjaman")
      .select("*").eq("anggota_id", transaksi.anggotaId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (pinjamanRow) {
      const cicilanBaru = Math.max(0, pinjamanRow.cicilan_terbayar - 1);
      const { error } = await db.from("pinjaman")
        .update({ cicilan_terbayar: cicilanBaru, status: "aktif" })
        .eq("id", pinjamanRow.id);
      if (error) throw new Error(error.message);
      const { data: anggotaRow } = await db.from("anggota").select("tunggakan").eq("id", transaksi.anggotaId).single();
      const { error: err2 } = await db.from("anggota")
        .update({ tunggakan: (anggotaRow?.tunggakan || 0) + 1 })
        .eq("id", transaksi.anggotaId);
      if (err2) throw new Error(err2.message);
    }
  } else if (transaksi.jenis === "setoran" && transaksi.anggotaId) {
    const { data: anggotaRow } = await db.from("anggota").select("total_simpanan").eq("id", transaksi.anggotaId).single();
    const { error } = await db.from("anggota")
      .update({ total_simpanan: Math.max(0, (anggotaRow?.total_simpanan || 0) - transaksi.jumlah) })
      .eq("id", transaksi.anggotaId);
    if (error) throw new Error(error.message);
  }

  await dbLogAudit(actorNama, `Membatalkan transaksi ${transaksi.jenis} sebesar ${formatRupiah(transaksi.jumlah)}`);
}

/* Kebalikan dari dbBatalkanTransaksi — untuk kalau admin salah membatalkan. */
async function dbPulihkanTransaksi(transaksi, actorNama) {
  const { error: txErr } = await db.from("transaksi").update({ dibatalkan: false }).eq("id", transaksi.id);
  if (txErr) throw new Error(txErr.message);

  if (transaksi.jenis === "angsuran" && transaksi.anggotaId) {
    const { data: pinjamanRow } = await db.from("pinjaman")
      .select("*").eq("anggota_id", transaksi.anggotaId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (pinjamanRow) {
      const cicilanBaru = Math.min(pinjamanRow.total_cicilan, pinjamanRow.cicilan_terbayar + 1);
      const lunas = cicilanBaru >= pinjamanRow.total_cicilan;
      const { error } = await db.from("pinjaman")
        .update({ cicilan_terbayar: cicilanBaru, status: lunas ? "lunas" : "aktif" })
        .eq("id", pinjamanRow.id);
      if (error) throw new Error(error.message);
      const { data: anggotaRow } = await db.from("anggota").select("tunggakan").eq("id", transaksi.anggotaId).single();
      const { error: err2 } = await db.from("anggota")
        .update({ tunggakan: Math.max(0, (anggotaRow?.tunggakan || 0) - 1) })
        .eq("id", transaksi.anggotaId);
      if (err2) throw new Error(err2.message);
    }
  } else if (transaksi.jenis === "setoran" && transaksi.anggotaId) {
    const { data: anggotaRow } = await db.from("anggota").select("total_simpanan").eq("id", transaksi.anggotaId).single();
    const { error } = await db.from("anggota")
      .update({ total_simpanan: (anggotaRow?.total_simpanan || 0) + transaksi.jumlah })
      .eq("id", transaksi.anggotaId);
    if (error) throw new Error(error.message);
  }

  await dbLogAudit(actorNama, `Memulihkan transaksi ${transaksi.jenis} sebesar ${formatRupiah(transaksi.jumlah)}`);
}

async function dbHapusPinjaman(anggota, actorNama) {
  if (!anggota.pinjaman) throw new Error("Anggota ini tidak punya pinjaman aktif.");
  if (anggota.pinjaman.cicilanTerbayar > 0) {
    throw new Error("Pinjaman ini sudah punya riwayat angsuran, tidak bisa dihapus. Batalkan transaksinya satu per satu di Buku Kas kalau perlu.");
  }
  const { data: pencairanRows, error: selErr } = await db.from("transaksi")
    .select("id").eq("anggota_id", anggota.id).eq("jenis", "pinjaman").eq("dibatalkan", false);
  if (selErr) throw new Error(selErr.message);
  if (pencairanRows && pencairanRows.length > 0) {
    const { error: delTxErr } = await db.from("transaksi").delete().in("id", pencairanRows.map(r => r.id));
    if (delTxErr) throw new Error(delTxErr.message);
  }
  const { error: pinjErr } = await db.from("pinjaman").delete().eq("id", anggota.pinjaman.id);
  if (pinjErr) throw new Error(pinjErr.message);
  const { error: anggotaErr } = await db.from("anggota").update({ tunggakan: 0 }).eq("id", anggota.id);
  if (anggotaErr) throw new Error(anggotaErr.message);
  await dbLogAudit(actorNama, `Menghapus pinjaman ${anggota.nama} yang salah input (belum ada angsuran)`);
}
