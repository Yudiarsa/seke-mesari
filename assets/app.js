/* =========================================================
   SEKE MESARI — Arisan & Pinjaman Keluarga
   Data sungguhan di Supabase (lihat assets/supabase-client.js).
   Login = Supabase Auth (email sintetis dari nomor HP + password),
   bukan lagi disimpan di kode. Lihat README bagian Keamanan.
   ========================================================= */

const THEME_KEY = "seke_mesari_theme";

/* `state` diisi lewat dbFetchState() setelah login berhasil — lihat
   assets/supabase-client.js untuk bentuk datanya (sengaja dibuat sama
   persis dengan versi localStorage sebelumnya supaya semua fungsi
   render di bawah ini tidak perlu diubah). */
let state = null;
let currentUserId = null;

let viewAsAdmin = false; // demo-only "lihat sebagai" toggle, follows session role by default
let lainnyaView = "menu";
let adminToolTargetAnggotaId = null; // anggota sedang dipilih untuk Input Pinjaman/Catat Angsuran Manual

/* ===== Helpers =====
   (formatRupiah, todayIso, daysFromNow, nowIso, BUNGA_PERSEN,
   TOTAL_CICILAN, TOTAL_PERIODE ada di assets/supabase-client.js) */
function formatDate(iso) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function formatDateTime(iso) {
  return new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function initials(name) {
  return name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
}
function getAnggota(id) { return state.anggota.find(a => a.id === id); }
function currentUser() { return currentUserId ? getAnggota(currentUserId) : null; }
function isAdmin() { const u = currentUser(); return !!u && u.role === "admin"; }

function angsuranPerBulan(pinjaman) {
  return Math.round((pinjaman.jumlah / pinjaman.totalCicilan) * (1 + pinjaman.bungaPersenBulan / 100));
}
function sisaHutang(pinjaman) {
  const pokokPerCicilan = pinjaman.jumlah / pinjaman.totalCicilan;
  return Math.max(0, Math.round(pinjaman.jumlah - pokokPerCicilan * pinjaman.cicilanTerbayar));
}
function statusPinjaman(a) {
  if (!a.pinjaman) return { label: "Tidak Ada Pinjaman", cls: "none" };
  if (a.tunggakan >= 3) return { label: "Perlu Evaluasi Keanggotaan", cls: "evaluasi" };
  if (a.tunggakan >= 1) return { label: `Menunggak ${a.tunggakan}x`, cls: "telat" };
  return { label: "Lancar", cls: "lancar" };
}
function skorKepatuhan(a) {
  return Math.max(35, 100 - a.tunggakan * 15);
}
function starsForScore(score) {
  const n = Math.max(1, Math.min(5, Math.round(score / 20)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

/* ===== Derived totals ===== */
function totalAnggotaAktif() { return state.anggota.filter(a => a.status === "aktif").length; }
function kasTerkumpul() {
  const dariTransaksi = state.transaksi
    .filter(t => !t.dibatalkan)
    .reduce((s, t) => s + (t.arah === "masuk" ? t.jumlah : -t.jumlah), 0);
  return state.kasTerkumpulAwal + dariTransaksi;
}
function pinjamanBeredar() {
  return state.anggota.reduce((s, a) => s + (a.pinjaman ? sisaHutang(a.pinjaman) : 0), 0);
}
function totalSimpananAnggota() {
  return state.anggota.reduce((s, a) => s + a.totalSimpanan, 0);
}
/* Neraca (balance sheet). Aset = Kas + Piutang Pinjaman (pokok yang
   belum kembali). Kewajiban = Simpanan Anggota (dana titipan yang jadi
   tanggungan koperasi ke anggota). Ekuitas dihitung sebagai SISA
   (Aset − Kewajiban), bukan ditebak dari bunga per transaksi — supaya
   neraca selalu balance secara definisi, sesuai persamaan akuntansi
   dasar (Aset = Kewajiban + Ekuitas), dan tetap benar walau nominal
   pembayaran yang diverifikasi admin tidak persis mengikuti rumus
   angsuran. */
function totalAsetNeraca() {
  return kasTerkumpul() + pinjamanBeredar();
}
function totalKewajibanNeraca() {
  return totalSimpananAnggota();
}
function ekuitasNeraca() {
  return totalAsetNeraca() - totalKewajibanNeraca();
}
function anggotaMenunggak() { return state.anggota.filter(a => a.pinjaman && a.tunggakan >= 1).length; }
function jatuhTempoBulanIni() {
  const now = new Date();
  return state.anggota.filter(a => {
    if (!a.pinjaman) return false;
    const d = new Date(a.pinjaman.jatuhTempo);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
}
/* Riwayat angsuran untuk pinjaman yang SEDANG aktif milik satu anggota.
   Transaksi tidak menyimpan id pinjaman, tapi karena anggota hanya boleh
   punya satu pinjaman aktif sekaligus (pinjaman baru hanya bisa diajukan
   setelah pinjaman lama lunas), N transaksi "angsuran" terakhir milik
   anggota ini (N = cicilanTerbayar pinjaman aktif) pasti pembayaran
   untuk pinjaman yang sedang berjalan. */
function riwayatAngsuranAktif(a) {
  if (!a.pinjaman || a.pinjaman.cicilanTerbayar === 0) return [];
  const semua = state.transaksi
    .filter(t => t.anggotaId === a.id && t.jenis === "angsuran" && !t.dibatalkan)
    .sort((x, y) => new Date(x.tanggal) - new Date(y.tanggal));
  return semua.slice(-a.pinjaman.cicilanTerbayar);
}

/* Baris "nama - status jatuh tempo - sisa hutang" dipakai bersama oleh
   list "Menunggak & Jatuh Tempo" (tab Pinjaman) dan modal drilldown dari
   stat card Home, supaya tampilannya konsisten dan tidak dobel logika. */
function buildPinjamanStatusRows(anggotaList) {
  const now = new Date();
  return anggotaList
    .map(a => {
      const diffDays = Math.ceil((new Date(a.pinjaman.jatuhTempo) - now) / 86400000);
      return { a, diffDays, st: statusPinjaman(a) };
    })
    .sort((x, y) => {
      if (x.a.tunggakan !== y.a.tunggakan) return y.a.tunggakan - x.a.tunggakan;
      return x.diffDays - y.diffDays;
    });
}
function renderPinjamanStatusList(containerEl, rows, emptyText) {
  if (rows.length === 0) {
    containerEl.innerHTML = `<div class="activity-empty">${emptyText}</div>`;
    return;
  }
  containerEl.innerHTML = rows.map(x => {
    const tempoLabel = x.diffDays < 0
      ? `Terlambat ${Math.abs(x.diffDays)} hari`
      : x.diffDays === 0 ? "Jatuh tempo hari ini" : `Jatuh tempo ${x.diffDays} hari lagi`;
    return `
    <div class="activity-item" data-member="${x.a.id}" style="cursor:pointer">
      <div class="activity-icon ${x.diffDays < 0 ? "out" : "in"}">${x.diffDays < 0 ? "⚠️" : "📄"}</div>
      <div class="activity-main">
        <div class="activity-title">${x.a.nama}</div>
        <div class="activity-sub">${tempoLabel} · ${formatDate(x.a.pinjaman.jatuhTempo)} · sisa ${formatRupiah(sisaHutang(x.a.pinjaman))}</div>
      </div>
      <div class="status-pill ${x.st.cls}">${x.st.label}</div>
    </div>`;
  }).join("");
  containerEl.querySelectorAll("[data-member]").forEach(el => {
    el.addEventListener("click", () => {
      document.getElementById("statDrilldownOverlay").hidden = true;
      openMemberDetail(el.dataset.member);
    });
  });
}
function openStatDrilldown(title, anggotaList, emptyText) {
  document.getElementById("statDrilldownTitle").textContent = title;
  renderPinjamanStatusList(document.getElementById("statDrilldownList"), buildPinjamanStatusRows(anggotaList), emptyText);
  document.getElementById("statDrilldownOverlay").hidden = false;
}

function pengingatList() {
  const now = new Date();
  return state.anggota
    .filter(a => a.pinjaman)
    .map(a => {
      const due = new Date(a.pinjaman.jatuhTempo);
      const diffDays = Math.ceil((due - now) / 86400000);
      return { anggota: a, diffDays };
    })
    .filter(x => x.diffDays <= 7)
    .sort((a, b) => a.diffDays - b.diffDays);
}

/* ===== Login / Daftar (Supabase Auth) ===== */
function initLogin() {
  document.getElementById("toggleAuthModeBtn").addEventListener("click", () => {
    const loginForm = document.getElementById("loginForm");
    const daftarForm = document.getElementById("daftarForm");
    const btn = document.getElementById("toggleAuthModeBtn");
    const showingLogin = !loginForm.hidden;
    loginForm.hidden = showingLogin;
    daftarForm.hidden = !showingLogin;
    btn.textContent = showingLogin ? "Sudah punya akun? Masuk di sini" : "Belum punya akun? Daftar di sini";
  });

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const hp = document.getElementById("loginHp").value.trim();
    const pw = document.getElementById("loginPassword").value;
    const btn = document.getElementById("loginSubmitBtn");
    btn.disabled = true; btn.textContent = "Memproses...";
    try {
      await dbSignIn(hp, pw);
      state = await dbFetchState();
      const a = state.anggota.find(x => x.hp === hp);
      if (!a) throw new Error("Login berhasil tapi data anggota tidak ditemukan. Hubungi admin.");
      if (a.status !== "aktif") throw new Error("Akun anggota ini nonaktif.");
      currentUserId = a.id;
      viewAsAdmin = a.role === "admin";
      enterApp();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Masuk";
    }
  });

  document.getElementById("daftarForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nama = document.getElementById("daftarNama").value.trim();
    const hp = document.getElementById("daftarHp").value.trim();
    const pw = document.getElementById("daftarPassword").value;
    const btn = document.getElementById("daftarSubmitBtn");
    btn.disabled = true; btn.textContent = "Memproses...";
    try {
      await dbSignUp(nama, hp, pw);
      await dbSignIn(hp, pw);
      state = await dbFetchState();
      const a = state.anggota.find(x => x.hp === hp);
      currentUserId = a.id;
      viewAsAdmin = false;
      showToast("Pendaftaran berhasil, selamat datang!");
      enterApp();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Daftar";
    }
  });
}

async function logout() {
  await dbSignOut();
  currentUserId = null;
  state = null;
  document.getElementById("appShell").hidden = true;
  document.getElementById("loginScreen").hidden = false;
  document.getElementById("loginForm").reset();
  document.getElementById("daftarForm").reset();
}

function enterApp() {
  document.getElementById("loginScreen").hidden = true;
  document.getElementById("appShell").hidden = false;
  document.querySelectorAll(".admin-only").forEach(el => el.hidden = !isAdmin());
  renderHome();
}

/* Jalan sekali saat halaman dibuka: kalau sesi Supabase Auth masih
   berlaku (browser belum logout), langsung masuk tanpa perlu login ulang. */
async function bootFromExistingSession() {
  const userId = await dbGetSessionUserId();
  if (!userId) return;
  try {
    state = await dbFetchState();
    const a = getAnggota(userId);
    if (!a) return;
    currentUserId = userId;
    viewAsAdmin = a.role === "admin";
    enterApp();
  } catch (e) {
    console.warn("Gagal memuat sesi tersimpan:", e.message);
  }
}

/* Membungkus ulang seluruh state setelah aksi mutasi (approve, verifikasi,
   dst) supaya tampilan selalu sesuai data terbaru di database. */
async function refreshState() {
  state = await dbFetchState();
}

/* ===== Tabs ===== */
const TAB_LABELS = { home: "Beranda", pinjaman: "Pinjaman", pembayaran: "Pembayaran", anggota: "Anggota", lainnya: "Lainnya" };
function switchTab(tab) {
  document.querySelectorAll(".tab-panel").forEach(el => el.hidden = true);
  document.getElementById("tab-" + tab).hidden = false;
  document.querySelectorAll(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.tab === tab));
  document.getElementById("topbarSub").textContent = TAB_LABELS[tab];
  if (tab === "home") renderHome();
  if (tab === "pinjaman") renderPinjaman();
  if (tab === "pembayaran") renderPembayaran();
  if (tab === "anggota") renderMemberList(document.getElementById("memberSearch").value);
  if (tab === "lainnya") { lainnyaView = "menu"; renderLainnya(); }
}

/* ===== HOME ===== */
function renderHome() {
  const u = currentUser();
  if (!u) return;
  document.getElementById("heroAvatar").textContent = initials(u.nama);
  document.getElementById("heroName").textContent = u.nama + (isAdmin() ? " (Admin)" : "");
  document.getElementById("heroPeriode").textContent = `Periode ke-${state.periodeSekarang} dari ${state.totalPeriode}`;

  document.getElementById("statTotalAnggota").textContent = totalAnggotaAktif();
  document.getElementById("statKas").textContent = formatRupiah(kasTerkumpul());
  document.getElementById("statPinjamanBeredar").textContent = formatRupiah(pinjamanBeredar());
  document.getElementById("statMenunggak").textContent = anggotaMenunggak();
  document.getElementById("statJatuhTempo").textContent = jatuhTempoBulanIni() + " anggota";

  document.getElementById("addPengumumanBtn").hidden = !isAdmin();
  ["cardPinjamanBeredar", "cardMenunggak", "cardJatuhTempo"].forEach(id => {
    document.getElementById(id).classList.toggle("clickable", isAdmin());
  });

  const list = document.getElementById("pengumumanList");
  if (state.pengumuman.length === 0) {
    list.innerHTML = `<div class="activity-empty">Belum ada pengumuman.</div>`;
  } else {
    list.innerHTML = [...state.pengumuman].sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal)).map(p => `
      <div class="activity-item">
        <div class="activity-icon in">📢</div>
        <div class="activity-main">
          <div class="activity-title">${escapeHtml(p.teks)}</div>
          <div class="activity-sub">${formatDate(p.tanggal)}</div>
        </div>
        ${isAdmin() ? `<div class="activity-actions"><button class="btn-mini reject" data-del-pengumuman="${p.id}">Hapus</button></div>` : ""}
      </div>`).join("");
    if (isAdmin()) {
      list.querySelectorAll("[data-del-pengumuman]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            await dbDeletePengumuman(btn.dataset.delPengumuman);
            await refreshState();
            renderHome();
          } catch (err) {
            showToast("Gagal menghapus: " + err.message);
          }
        });
      });
    }
  }
  renderNotifBadge();
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/* ===== Reminders ===== */
function renderNotifBadge() {
  const due = pengingatList().filter(x => x.diffDays >= 0);
  const badge = document.getElementById("notifBadge");
  if (due.length > 0) { badge.hidden = false; badge.textContent = due.length; }
  else badge.hidden = true;
}
function openNotifDrawer() {
  const items = pengingatList();
  const listEl = document.getElementById("notifList");
  if (items.length === 0) {
    listEl.innerHTML = `<div class="notif-empty">Tidak ada pengingat jatuh tempo dalam waktu dekat.</div>`;
  } else {
    listEl.innerHTML = items.map(x => {
      const late = x.diffDays < 0;
      const angsuran = angsuranPerBulan(x.anggota.pinjaman);
      const teks = late
        ? `Anda memiliki tunggakan ${Math.abs(x.diffDays)} hari, sebesar ${formatRupiah(angsuran)}`
        : `Pembayaran jatuh tempo ${x.diffDays === 0 ? "hari ini" : "dalam " + x.diffDays + " hari"} — ${formatRupiah(angsuran)}`;
      return `
      <div class="notif-item" data-id="${x.anggota.id}">
        <div class="notif-emoji">${late ? "⚠️" : "🔔"}</div>
        <div>
          <div class="notif-title">${x.anggota.nama}</div>
          <div class="notif-sub">${teks}</div>
          <div class="notif-sub">Sisa pinjaman: ${formatRupiah(sisaHutang(x.anggota.pinjaman))}</div>
        </div>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".notif-item").forEach(el => {
      el.addEventListener("click", () => { closeNotifDrawer(); openMemberDetail(el.dataset.id); });
    });
  }
  document.getElementById("notifDrawer").hidden = false;
}
function closeNotifDrawer() { document.getElementById("notifDrawer").hidden = true; }

/* ===== PINJAMAN ===== */
function renderPinjaman() {
  const u = currentUser();
  const block = document.getElementById("pinjamanAktifBlock");
  if (u.pinjaman) {
    const p = u.pinjaman;
    const pct = Math.round((p.cicilanTerbayar / p.totalCicilan) * 100);
    const riwayat = riwayatAngsuranAktif(u);
    const riwayatHtml = riwayat.length === 0
      ? `<div class="activity-empty">Belum ada pembayaran untuk pinjaman ini.</div>`
      : `<div class="activity-list">${riwayat.map((t, i) => `
        <div class="activity-item">
          <div class="activity-icon in">📄</div>
          <div class="activity-main">
            <div class="activity-title">Angsuran ke-${i + 1}</div>
            <div class="activity-sub">${formatDate(t.tanggal)}</div>
          </div>
          <div class="activity-amount in">+${formatRupiah(t.jumlah)}</div>
        </div>`).join("")}</div>`;
    block.innerHTML = `
      <div class="section-heading">Pinjaman Aktif</div>
      <div class="chart-card">
        <div class="md-stat-grid" style="margin-bottom:12px">
          <div class="md-stat"><div class="md-stat-label">Jumlah</div><div class="md-stat-value">${formatRupiah(p.jumlah)}</div></div>
          <div class="md-stat"><div class="md-stat-label">Bunga</div><div class="md-stat-value">${p.bungaPersenBulan}% / bulan</div></div>
          <div class="md-stat"><div class="md-stat-label">Sisa Cicilan</div><div class="md-stat-value">${p.totalCicilan - p.cicilanTerbayar} dari ${p.totalCicilan}</div></div>
          <div class="md-stat"><div class="md-stat-label">Sisa Hutang</div><div class="md-stat-value">${formatRupiah(sisaHutang(p))}</div></div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-label">${pct}% · ${p.cicilanTerbayar}/${p.totalCicilan} pembayaran</div>
        <div class="progress-label" style="margin-top:8px">Jatuh tempo: ${formatDate(p.jatuhTempo)} · Angsuran/bulan: ${formatRupiah(angsuranPerBulan(p))}</div>
      </div>
      <div class="md-section-title">Riwayat Pembayaran (${p.cicilanTerbayar} dari ${p.totalCicilan} kali)</div>
      ${riwayatHtml}`;
  } else {
    block.innerHTML = `
      <div class="section-heading">Pinjaman Aktif</div>
      <div class="empty-state" style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius)">Anda tidak memiliki pinjaman aktif.</div>`;
  }

  const statusBlock = document.getElementById("statusPinjamanBlock");
  statusBlock.hidden = !isAdmin();
  if (isAdmin()) {
    renderPinjamanStatusList(
      document.getElementById("statusPinjamanList"),
      buildPinjamanStatusRows(state.anggota.filter(a => a.pinjaman)),
      "Tidak ada anggota dengan pinjaman aktif."
    );
  }

  const approvalBlock = document.getElementById("approvalPinjamanBlock");
  approvalBlock.hidden = !isAdmin();
  if (isAdmin()) {
    const pending = state.pengajuanPinjaman.filter(p => p.status === "menunggu");
    const listEl = document.getElementById("approvalPinjamanList");
    if (pending.length === 0) {
      listEl.innerHTML = `<div class="activity-empty">Tidak ada pengajuan menunggu.</div>`;
    } else {
      listEl.innerHTML = pending.map(p => {
        const a = getAnggota(p.anggotaId);
        return `
        <div class="activity-item">
          <div class="activity-icon out">💰</div>
          <div class="activity-main">
            <div class="activity-title">${a.nama} — ${formatRupiah(p.jumlah)}</div>
            <div class="activity-sub">${escapeHtml(p.tujuan)} · ${formatDate(p.createdAt)}</div>
          </div>
          <div class="activity-actions">
            <button class="btn-mini approve" data-approve-pinjaman="${p.id}">Setujui</button>
            <button class="btn-mini reject" data-reject-pinjaman="${p.id}">Tolak</button>
          </div>
        </div>`;
      }).join("");
      listEl.querySelectorAll("[data-approve-pinjaman]").forEach(btn => btn.addEventListener("click", () => decidePengajuanPinjaman(btn.dataset.approvePinjaman, true)));
      listEl.querySelectorAll("[data-reject-pinjaman]").forEach(btn => btn.addEventListener("click", () => decidePengajuanPinjaman(btn.dataset.rejectPinjaman, false)));
    }
  }
}

async function decidePengajuanPinjaman(id, approve) {
  const p = state.pengajuanPinjaman.find(x => x.id === id);
  if (!p) return;
  const a = getAnggota(p.anggotaId);
  const actor = currentUser();
  try {
    await dbDecidePengajuanPinjaman(p, a.nama, approve, actor ? actor.nama : "-");
    await refreshState();
    renderPinjaman();
    showToast(approve ? "Pinjaman disetujui." : "Pengajuan ditolak.");
  } catch (err) {
    showToast("Gagal: " + err.message);
  }
}

/* ===== PEMBAYARAN ===== */
let histFilterJenis = "semua";

function renderPembayaran() {
  const u = currentUser();

  const verifBlock = document.getElementById("verifikasiBlock");
  verifBlock.hidden = !isAdmin();
  if (isAdmin()) {
    const pending = state.buktiPembayaran.filter(b => b.status === "menunggu");
    const listEl = document.getElementById("verifikasiList");
    if (pending.length === 0) {
      listEl.innerHTML = `<div class="activity-empty">Tidak ada bukti menunggu verifikasi.</div>`;
    } else {
      listEl.innerHTML = pending.map(b => {
        const a = getAnggota(b.anggotaId);
        return `
        <div class="activity-item">
          <div class="activity-icon in">📤</div>
          <div class="activity-main">
            <div class="activity-title">${a.nama} — ${formatRupiah(b.nominal)}</div>
            <div class="activity-sub">${formatDate(b.tanggal)}${b.catatan ? " · " + escapeHtml(b.catatan) : ""}</div>
          </div>
          <div class="activity-actions">
            <button class="btn-mini approve" data-approve-bukti="${b.id}">Setujui</button>
            <button class="btn-mini reject" data-reject-bukti="${b.id}">Tolak</button>
          </div>
        </div>`;
      }).join("");
      listEl.querySelectorAll("[data-approve-bukti]").forEach(btn => btn.addEventListener("click", () => decideBukti(btn.dataset.approveBukti, true)));
      listEl.querySelectorAll("[data-reject-bukti]").forEach(btn => btn.addEventListener("click", () => decideBukti(btn.dataset.rejectBukti, false)));
    }
  }

  const buktiSaya = state.buktiPembayaran.filter(b => b.anggotaId === u.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const buktiEl = document.getElementById("buktiSayaList");
  if (buktiSaya.length === 0) {
    buktiEl.innerHTML = `<div class="activity-empty">Anda belum mengupload bukti pembayaran.</div>`;
  } else {
    buktiEl.innerHTML = buktiSaya.map(b => `
      <div class="activity-item">
        <div class="activity-icon ${b.status === "ditolak" ? "out" : "in"}">📎</div>
        <div class="activity-main">
          <div class="activity-title">${formatRupiah(b.nominal)}</div>
          <div class="activity-sub">${formatDate(b.tanggal)}${b.catatan ? " · " + escapeHtml(b.catatan) : ""}</div>
        </div>
        <div class="status-pill ${b.status}">${b.status === "menunggu" ? "Menunggu Verifikasi" : b.status === "disetujui" ? "Disetujui" : "Ditolak"}</div>
      </div>`).join("");
  }

  renderHistori();
}

async function decideBukti(id, approve) {
  const b = state.buktiPembayaran.find(x => x.id === id);
  if (!b) return;
  const a = getAnggota(b.anggotaId);
  const actor = currentUser();
  try {
    await dbDecideBukti(b, a, approve, actor ? actor.nama : "-");
    await refreshState();
    renderPembayaran();
    showToast(approve ? "Pembayaran diverifikasi." : "Bukti ditolak.");
  } catch (err) {
    showToast("Gagal: " + err.message);
  }
}

function renderHistori() {
  const u = currentUser();
  const scoped = isAdmin() ? state.transaksi : state.transaksi.filter(t => t.anggotaId === u.id);
  const filtered = histFilterJenis === "semua" ? scoped : scoped.filter(t => t.jenis === histFilterJenis);
  const sorted = [...filtered].sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
  const jenisLabel = { setoran: "Setoran", pinjaman: "Pinjaman", angsuran: "Angsuran", penyesuaian: "Penyesuaian Kas" };
  const jenisIcon = { setoran: "➕", pinjaman: "💰", angsuran: "📄", penyesuaian: "⚖️" };
  const listEl = document.getElementById("histList");
  if (sorted.length === 0) {
    listEl.innerHTML = `<div class="activity-empty">Belum ada transaksi.</div>`;
    return;
  }
  listEl.innerHTML = sorted.map(t => {
    const a = getAnggota(t.anggotaId);
    const sign = t.arah === "masuk" ? "+" : "-";
    return `
      <div class="activity-item" style="${t.dibatalkan ? "opacity:0.5" : ""}">
        <div class="activity-icon ${t.arah === "masuk" ? "in" : "out"}">${jenisIcon[t.jenis]}</div>
        <div class="activity-main">
          <div class="activity-title">${jenisLabel[t.jenis]}${isAdmin() && a ? " — " + a.nama : ""}${t.dibatalkan ? ' <span class="status-pill ditolak">Dibatalkan</span>' : ""}</div>
          <div class="activity-sub">${formatDate(t.tanggal)}${t.keterangan ? " · " + escapeHtml(t.keterangan) : ""}</div>
        </div>
        <div class="activity-amount ${t.arah === "masuk" ? "in" : "out"}">${sign}${formatRupiah(t.jumlah)}</div>
      </div>`;
  }).join("");
}

/* ===== ANGGOTA (Transparansi Publik) ===== */
function renderMemberList(filter = "") {
  const list = document.getElementById("memberList");
  const q = filter.trim().toLowerCase();
  const filtered = state.anggota.filter(a => a.nama.toLowerCase().includes(q));
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">Anggota tidak ditemukan.</div>`;
    return;
  }
  list.innerHTML = filtered.map(a => {
    const st = statusPinjaman(a);
    return `
    <div class="member-card" data-id="${a.id}">
      <div class="member-avatar">${initials(a.nama)}</div>
      <div class="member-main">
        <div class="member-name">${a.nama}${a.status === "nonaktif" ? " (nonaktif)" : ""}</div>
        <div class="member-sub">${a.pinjaman ? formatRupiah(a.pinjaman.jumlah) + " · sisa " + formatRupiah(sisaHutang(a.pinjaman)) : "Tidak ada pinjaman"}</div>
      </div>
      <div class="status-pill ${st.cls}">${st.label}</div>
    </div>`;
  }).join("");
  list.querySelectorAll(".member-card").forEach(el => el.addEventListener("click", () => openMemberDetail(el.dataset.id)));
}

function openMemberDetail(id) {
  const a = getAnggota(id);
  if (!a) return;
  const st = statusPinjaman(a);
  const score = skorKepatuhan(a);
  document.getElementById("memberModalTitle").textContent = a.nama;

  const riwayat = state.transaksi.filter(t => t.anggotaId === a.id).sort((x, y) => new Date(y.tanggal) - new Date(x.tanggal));
  const jenisLabel = { setoran: "Setoran", pinjaman: "Pinjaman", angsuran: "Angsuran" };
  const jenisIcon = { setoran: "➕", pinjaman: "💰", angsuran: "📄" };
  const riwayatHtml = riwayat.length === 0 ? `<div class="activity-empty">Belum ada transaksi.</div>` : riwayat.map(t => `
    <div class="activity-item">
      <div class="activity-icon ${t.arah === "masuk" ? "in" : "out"}">${jenisIcon[t.jenis]}</div>
      <div class="activity-main">
        <div class="activity-title">${jenisLabel[t.jenis]}</div>
        <div class="activity-sub">${formatDate(t.tanggal)}</div>
      </div>
      <div class="activity-amount ${t.arah === "masuk" ? "in" : "out"}">${t.arah === "masuk" ? "+" : "-"}${formatRupiah(t.jumlah)}</div>
    </div>`).join("");

  document.getElementById("memberModalBody").innerHTML = `
    <div class="member-detail-header">
      <div class="member-detail-avatar">${initials(a.nama)}</div>
      <div>
        <div class="member-name" style="font-size:16px">${a.nama}</div>
        <div class="member-detail-code">${a.hp} · Bergabung ${formatDate(a.tanggalBergabung)}</div>
      </div>
    </div>

    <div class="md-stat-grid">
      <div class="md-stat"><div class="md-stat-label">Status Pinjaman</div><div class="md-stat-value"><span class="status-pill ${st.cls}">${st.label}</span></div></div>
      <div class="md-stat"><div class="md-stat-label">Skor Kepatuhan</div><div class="md-stat-value">${score}/100 <span class="stars">${starsForScore(score)}</span></div></div>
      <div class="md-stat"><div class="md-stat-label">Total Simpanan</div><div class="md-stat-value">${formatRupiah(a.totalSimpanan)}</div></div>
      <div class="md-stat"><div class="md-stat-label">Sisa Pinjaman</div><div class="md-stat-value">${a.pinjaman ? formatRupiah(sisaHutang(a.pinjaman)) : "-"}</div></div>
    </div>

    ${a.pinjaman ? `
    <div class="md-section-title">Riwayat Pembayaran (${a.pinjaman.cicilanTerbayar} dari ${a.pinjaman.totalCicilan} kali) · Jatuh tempo ${formatDate(a.pinjaman.jatuhTempo)}</div>
    <div class="activity-list">${
      riwayatAngsuranAktif(a).length === 0
        ? `<div class="activity-empty">Belum ada pembayaran untuk pinjaman ini.</div>`
        : riwayatAngsuranAktif(a).map((t, i) => `
          <div class="activity-item">
            <div class="activity-icon in">📄</div>
            <div class="activity-main">
              <div class="activity-title">Angsuran ke-${i + 1}</div>
              <div class="activity-sub">${formatDate(t.tanggal)}</div>
            </div>
            <div class="activity-amount in">+${formatRupiah(t.jumlah)}</div>
          </div>`).join("")
    }</div>
    ` : ""}

    <div class="md-section-title">Riwayat Transaksi (Semua)</div>
    <div class="activity-list">${riwayatHtml}</div>

    ${isAdmin() ? `
    <div class="md-actions">
      ${a.pinjaman
        ? `<button class="btn-outline" id="mdCatatAngsuranBtn">Catat Angsuran Manual</button>`
        : `<button class="btn-outline" id="mdInputPinjamanBtn">Input Pinjaman Manual</button>`}
      ${a.pinjaman && a.pinjaman.cicilanTerbayar === 0
        ? `<button class="btn-outline danger" id="mdHapusPinjamanBtn">Hapus Pinjaman Ini (Salah Input)</button>`
        : ""}
      <button class="btn-outline" id="mdToggleStatusBtn">${a.status === "aktif" ? "Nonaktifkan" : "Aktifkan"} Anggota</button>
    </div>` : ""}
  `;
  document.getElementById("memberModalOverlay").hidden = false;

  if (isAdmin()) {
    document.getElementById("mdToggleStatusBtn").addEventListener("click", async () => {
      const statusBaru = a.status === "aktif" ? "nonaktif" : "aktif";
      const actor = currentUser();
      try {
        await dbSetAnggotaStatus(a.id, a.nama, statusBaru, actor ? actor.nama : "-");
        await refreshState();
        document.getElementById("memberModalOverlay").hidden = true;
        renderMemberList(document.getElementById("memberSearch").value);
        showToast(`Anggota ${statusBaru === "nonaktif" ? "dinonaktifkan" : "diaktifkan"}.`);
      } catch (err) {
        showToast("Gagal: " + err.message);
      }
    });

    if (a.pinjaman) {
      document.getElementById("mdCatatAngsuranBtn").addEventListener("click", () => {
        adminToolTargetAnggotaId = a.id;
        document.getElementById("adminAngsuranModalTitle").textContent = `Catat Angsuran Manual — ${a.nama}`;
        document.getElementById("adminAngsuranForm").reset();
        document.getElementById("adminAngsuranTanggal").value = todayIso();
        document.getElementById("adminAngsuranModalOverlay").hidden = false;
      });
      if (a.pinjaman.cicilanTerbayar === 0) {
        document.getElementById("mdHapusPinjamanBtn").addEventListener("click", async () => {
          const actor = currentUser();
          try {
            await dbHapusPinjaman(a, actor ? actor.nama : "-");
            await refreshState();
            document.getElementById("memberModalOverlay").hidden = true;
            renderMemberList(document.getElementById("memberSearch").value);
            showToast("Pinjaman berhasil dihapus.");
          } catch (err) {
            showToast("Gagal: " + err.message);
          }
        });
      }
    } else {
      document.getElementById("mdInputPinjamanBtn").addEventListener("click", () => {
        adminToolTargetAnggotaId = a.id;
        document.getElementById("adminPinjamanModalTitle").textContent = `Input Pinjaman — ${a.nama}`;
        document.getElementById("adminPinjamanForm").reset();
        document.getElementById("adminPinjamanTanggal").value = todayIso();
        document.getElementById("adminPinjamanModalOverlay").hidden = false;
      });
    }
  }
}

/* ===== LAINNYA ===== */
const LAINNYA_ITEMS = [
  { key: "bukukas", icon: "📒", label: "Buku Kas", adminOnly: false },
  { key: "neraca", icon: "⚖️", label: "Neraca Keuangan", adminOnly: false },
  { key: "timeline", icon: "🗓️", label: "Timeline Periode", adminOnly: false },
  { key: "auditlog", icon: "🧾", label: "Audit Log", adminOnly: false },
  { key: "unduhLaporan", icon: "⬇️", label: "Unduh Laporan Keuangan (PDF)", adminOnly: false },
  { key: "sesuaikanKas", icon: "🧮", label: "Sesuaikan Kas", adminOnly: true },
  { key: "peran", icon: "🔁", label: "Lihat Sebagai (Demo)", adminOnly: false },
  { key: "tentang", icon: "ℹ️", label: "Tentang & Keterbatasan", adminOnly: false },
  { key: "keluar", icon: "🚪", label: "Keluar", adminOnly: false, danger: true }
];

function renderLainnya() {
  const menuEl = document.getElementById("lainnyaMenu");
  const subEl = document.getElementById("lainnyaSubview");
  if (lainnyaView === "menu") {
    menuEl.hidden = false;
    subEl.hidden = true;
    menuEl.innerHTML = LAINNYA_ITEMS.filter(item => !item.adminOnly || isAdmin()).map(item => `
      <div class="menu-item ${item.danger ? "danger" : ""}" data-key="${item.key}">
        <div class="menu-item-icon">${item.icon}</div>
        <div class="menu-item-label">${item.label}</div>
        <div class="menu-item-chevron">›</div>
      </div>`).join("");
    menuEl.querySelectorAll(".menu-item").forEach(el => {
      el.addEventListener("click", () => {
        if (el.dataset.key === "keluar") { logout(); return; }
        if (el.dataset.key === "unduhLaporan") { generateLaporanKeuanganPDF(); return; }
        if (el.dataset.key === "sesuaikanKas") { openSesuaikanKasModal(); return; }
        lainnyaView = el.dataset.key;
        renderLainnya();
      });
    });
  } else {
    menuEl.hidden = true;
    subEl.hidden = false;
    subEl.innerHTML = `<div class="subview-header"><button class="back-btn" id="lainnyaBackBtn">←</button><h3>${LAINNYA_ITEMS.find(i => i.key === lainnyaView).label}</h3></div><div id="lainnyaSubContent"></div>`;
    document.getElementById("lainnyaBackBtn").addEventListener("click", () => { lainnyaView = "menu"; renderLainnya(); });
    const content = document.getElementById("lainnyaSubContent");
    if (lainnyaView === "bukukas") renderBukuKas(content);
    if (lainnyaView === "neraca") renderNeraca(content);
    if (lainnyaView === "timeline") renderTimeline(content);
    if (lainnyaView === "auditlog") renderAuditLog(content);
    if (lainnyaView === "peran") renderPeranSwitch(content);
    if (lainnyaView === "tentang") renderTentang(content);
  }
}

/* ===== Unduh Laporan Keuangan (PDF) =====
   jsPDF + autoTable di-vendor lokal (assets/vendor/), bukan CDN, supaya
   fitur ini tetap jalan tanpa internet — konsisten dengan arsitektur
   client-only aplikasi ini. Transaksi yang dibatalkan (t.dibatalkan)
   sengaja dikecualikan dari Buku Kas & saldo berjalan di laporan, sama
   seperti seharusnya diperlakukan kas sungguhan. */
async function generateLaporanKeuanganPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 14;
  let y = 16;

  const u = currentUser();
  const TEAL = [15, 118, 110];

  const ensureSpace = (needed) => {
    if (y + needed > pageHeight - 16) { doc.addPage(); y = 16; }
  };
  const sectionTitle = (text) => {
    doc.setFontSize(11);
    doc.setFont(undefined, "bold");
    doc.text(text, marginX, y);
    doc.setFont(undefined, "normal");
    y += 2;
  };

  doc.setFontSize(15);
  doc.setFont(undefined, "bold");
  doc.text("SEKE MESARI", marginX, y);
  doc.setFontSize(11);
  doc.setFont(undefined, "normal");
  y += 6;
  doc.text("Laporan Keuangan — Arisan & Pinjaman Keluarga", marginX, y);
  y += 6;
  doc.setFontSize(8.5);
  doc.setTextColor(90);
  doc.text(
    `Periode ke-${state.periodeSekarang} dari ${state.totalPeriode}  ·  Dicetak: ${formatDateTime(nowIso())}  ·  Oleh: ${u ? u.nama + " (" + (u.role === "admin" ? "Admin/Bendahara" : "Anggota") + ")" : "-"}`,
    marginX, y
  );
  doc.setTextColor(0);
  y += 7;

  /* 1. Ringkasan Neraca */
  const kas = kasTerkumpul();
  const piutang = pinjamanBeredar();
  const aset = totalAsetNeraca();
  const simpanan = totalSimpananAnggota();
  const ekuitas = ekuitasNeraca();
  const seimbang = Math.round(aset) === Math.round(simpanan + ekuitas);

  sectionTitle("1. Ringkasan Neraca Keuangan");
  doc.autoTable({
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [["Pos", "Nilai"]],
    body: [
      ["Kas Koperasi", formatRupiah(kas)],
      ["Piutang Pinjaman Anggota", formatRupiah(piutang)],
      ["Total Aset", formatRupiah(aset)],
      ["Simpanan Anggota (Kewajiban)", formatRupiah(simpanan)],
      ["SHU / Laba Ditahan (Ekuitas)", formatRupiah(ekuitas)],
      ["Total Kewajiban + Ekuitas", formatRupiah(simpanan + ekuitas)]
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: TEAL },
    didParseCell: (data) => {
      if (data.section === "body" && (data.row.index === 2 || data.row.index === 5)) {
        data.cell.styles.fontStyle = "bold";
      }
    }
  });
  y = doc.lastAutoTable.finalY + 4;
  doc.setFontSize(8);
  doc.setFont(undefined, "italic");
  doc.setTextColor(seimbang ? 90 : 200, seimbang ? 90 : 40, seimbang ? 90 : 40);
  doc.text(
    seimbang ? "Neraca seimbang (Total Aset = Total Kewajiban + Ekuitas)." : "PERINGATAN: Neraca TIDAK seimbang — periksa data transaksi.",
    marginX, y
  );
  doc.setTextColor(0);
  doc.setFont(undefined, "normal");
  y += 7;

  /* 2. Rincian Piutang Pinjaman per Anggota */
  ensureSpace(30);
  const peminjam = state.anggota.filter(a => a.pinjaman);
  sectionTitle("2. Rincian Piutang Pinjaman per Anggota");
  doc.autoTable({
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [["No", "Nama", "Pinjaman Awal", "Cicilan", "Sisa Hutang", "Jatuh Tempo", "Status"]],
    body: peminjam.length
      ? peminjam.map((a, i) => [
          i + 1, a.nama, formatRupiah(a.pinjaman.jumlah),
          `${a.pinjaman.cicilanTerbayar}/${a.pinjaman.totalCicilan}`,
          formatRupiah(sisaHutang(a.pinjaman)), formatDate(a.pinjaman.jatuhTempo),
          statusPinjaman(a).label
        ])
      : [["-", "Tidak ada anggota dengan pinjaman aktif.", "", "", "", "", ""]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: TEAL }
  });
  y = doc.lastAutoTable.finalY + 7;

  /* 3. Rincian Simpanan & Status Keanggotaan */
  ensureSpace(30);
  sectionTitle("3. Rincian Simpanan & Status Keanggotaan");
  doc.autoTable({
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [["No", "Nama", "Total Simpanan", "Status", "Skor Kepatuhan"]],
    body: state.anggota.map((a, i) => [i + 1, a.nama, formatRupiah(a.totalSimpanan), statusPinjaman(a).label, skorKepatuhan(a)]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: TEAL }
  });
  y = doc.lastAutoTable.finalY + 7;

  /* 4. Buku Kas — riwayat transaksi lengkap dengan saldo berjalan */
  ensureSpace(30);
  sectionTitle("4. Buku Kas — Riwayat Transaksi Lengkap");
  const jenisLabel = { setoran: "Setoran", pinjaman: "Pencairan Pinjaman", angsuran: "Angsuran", penyesuaian: "Penyesuaian Kas" };
  const aktif = state.transaksi.filter(t => !t.dibatalkan).sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
  let saldo = state.kasTerkumpulAwal;
  const bukuKasRows = aktif.map((t, i) => {
    saldo += t.arah === "masuk" ? t.jumlah : -t.jumlah;
    return [
      i + 1, formatDate(t.tanggal), getAnggota(t.anggotaId)?.nama || "Koperasi", jenisLabel[t.jenis] || t.jenis,
      t.arah === "masuk" ? formatRupiah(t.jumlah) : "-",
      t.arah === "keluar" ? formatRupiah(t.jumlah) : "-",
      formatRupiah(saldo)
    ];
  });
  const dibatalkanCount = state.transaksi.length - aktif.length;
  doc.autoTable({
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [["No", "Tanggal", "Anggota", "Jenis", "Masuk", "Keluar", "Saldo"]],
    body: bukuKasRows,
    foot: [
      ["", "", "", "Saldo Kas Awal", "", "", formatRupiah(state.kasTerkumpulAwal)],
      ["", "", "", "Saldo Kas Akhir", "", "", formatRupiah(saldo)]
    ],
    styles: { fontSize: 7.5 },
    headStyles: { fillColor: TEAL },
    footStyles: { fontStyle: "bold", fillColor: [240, 240, 240], textColor: 20 }
  });
  y = doc.lastAutoTable.finalY + 4;
  if (dibatalkanCount > 0) {
    ensureSpace(6);
    doc.setFontSize(8);
    doc.text(`Catatan: ${dibatalkanCount} transaksi dibatalkan tidak dihitung di atas, tetap tercatat di Audit Log.`, marginX, y);
    y += 5;
  }

  /* Footer tiap halaman */
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text("Laporan dibuat otomatis oleh aplikasi SEKE MESARI dari data lokal perangkat — bukan dokumen resmi bermaterai.", marginX, pageHeight - 10);
    doc.text(`Halaman ${p} dari ${pageCount}`, pageWidth - marginX, pageHeight - 10, { align: "right" });
    doc.setTextColor(0);
  }

  const filename = `Laporan-Keuangan-SEKE-MESARI-Periode${state.periodeSekarang}-${todayIso()}.pdf`;
  doc.save(filename);
  const actor = currentUser();
  await dbLogAudit(actor ? actor.nama : "-", `Mengunduh Laporan Keuangan (PDF) periode ke-${state.periodeSekarang}`);
  showToast("Laporan keuangan sedang diunduh...");
}

function renderBukuKas(content) {
  const rows = [...state.transaksi].sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
  const jenisLabel = { setoran: "Setoran Anggota", pinjaman: "Pencairan Pinjaman", angsuran: "Angsuran" };
  content.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tanggal</th><th>Keterangan</th><th>Masuk</th><th>Keluar</th>${isAdmin() ? "<th></th>" : ""}</tr></thead>
        <tbody>
          ${rows.map(t => {
            const a = getAnggota(t.anggotaId);
            const ket = t.jenis === "penyesuaian"
              ? (t.keterangan || "Penyesuaian Kas")
              : `${jenisLabel[t.jenis]} — ${a ? a.nama : "-"}`;
            const cancelled = t.dibatalkan;
            const bisaBatal = isAdmin() && !cancelled && t.jenis !== "pinjaman";
            const bisaPulihkan = isAdmin() && cancelled && t.jenis !== "pinjaman";
            return `<tr class="${cancelled ? "dibatalkan" : ""}" data-tx="${t.id}">
              <td>${formatDate(t.tanggal)}${cancelled ? ' <span class="status-pill ditolak">Dibatalkan</span>' : ""}</td>
              <td>${escapeHtml(ket)}</td>
              <td>${t.arah === "masuk" ? formatRupiah(t.jumlah) : "-"}</td>
              <td>${t.arah === "keluar" ? formatRupiah(t.jumlah) : "-"}</td>
              ${isAdmin() ? `<td>${
                bisaBatal ? `<button class="btn-mini reject" data-batalkan-tx="${t.id}">Batalkan</button>`
                : bisaPulihkan ? `<button class="btn-mini approve" data-pulihkan-tx="${t.id}">Pulihkan</button>`
                : ""
              }</td>` : ""}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="form-note" style="margin-top:10px">Transaksi tidak pernah dihapus — hanya dapat dibatalkan (audit trail tetap tersimpan). Salah membatalkan? Tap "Pulihkan" untuk mengembalikan.</div>
  `;
  if (isAdmin()) {
    content.querySelectorAll("[data-batalkan-tx]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const t = state.transaksi.find(x => x.id === btn.dataset.batalkanTx);
        if (!t) return;
        const actor = currentUser();
        try {
          await dbBatalkanTransaksi(t, actor ? actor.nama : "-");
          await refreshState();
          renderBukuKas(content);
          showToast("Transaksi dibatalkan.");
        } catch (err) {
          showToast("Gagal: " + err.message);
        }
      });
    });
    content.querySelectorAll("[data-pulihkan-tx]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const t = state.transaksi.find(x => x.id === btn.dataset.pulihkanTx);
        if (!t) return;
        const actor = currentUser();
        try {
          await dbPulihkanTransaksi(t, actor ? actor.nama : "-");
          await refreshState();
          renderBukuKas(content);
          showToast("Transaksi dipulihkan.");
        } catch (err) {
          showToast("Gagal: " + err.message);
        }
      });
    });
  }
}

function renderNeraca(content) {
  const kas = kasTerkumpul();
  const piutang = pinjamanBeredar();
  const aset = totalAsetNeraca();
  const simpanan = totalSimpananAnggota();
  const ekuitas = ekuitasNeraca();
  const kewajibanEkuitas = simpanan + ekuitas;

  content.innerHTML = `
    <div class="neraca-card">
      <div class="neraca-heading">ASET</div>
      <div class="neraca-row">
        <div class="neraca-label">Kas Koperasi</div>
        <div class="neraca-value">${formatRupiah(kas)}</div>
      </div>
      <div class="neraca-row">
        <div class="neraca-label">Piutang Pinjaman Anggota</div>
        <div class="neraca-value">${formatRupiah(piutang)}</div>
      </div>
      <div class="neraca-row neraca-total">
        <div class="neraca-label">Total Aset</div>
        <div class="neraca-value">${formatRupiah(aset)}</div>
      </div>
    </div>

    <div class="neraca-card" style="margin-top:12px">
      <div class="neraca-heading">KEWAJIBAN &amp; EKUITAS</div>
      <div class="neraca-row">
        <div class="neraca-label">Simpanan Anggota</div>
        <div class="neraca-value">${formatRupiah(simpanan)}</div>
      </div>
      <div class="neraca-row">
        <div class="neraca-label">SHU / Laba Ditahan</div>
        <div class="neraca-value">${formatRupiah(ekuitas)}</div>
      </div>
      <div class="neraca-row neraca-total">
        <div class="neraca-label">Total Kewajiban &amp; Ekuitas</div>
        <div class="neraca-value">${formatRupiah(kewajibanEkuitas)}</div>
      </div>
    </div>

    <div class="neraca-balance-badge">✓ Neraca seimbang — Total Aset = Total Kewajiban &amp; Ekuitas</div>

    <div class="form-note" style="margin-top:14px">
      "SHU / Laba Ditahan" dihitung otomatis sebagai selisih Total Aset dikurangi Simpanan Anggota — bukan angka tebakan, jadi neraca ini selalu balance sesuai persamaan akuntansi dasar (Aset = Kewajiban + Ekuitas). Ini snapshot posisi keuangan saat ini; untuk riwayat transaksi kronologis lihat Buku Kas.
    </div>
  `;
}

function renderTimeline(content) {
  let boxes = "";
  for (let i = 1; i <= state.totalPeriode; i++) {
    const cls = i < state.periodeSekarang ? "done" : i === state.periodeSekarang ? "current" : "";
    const icon = i < state.periodeSekarang ? "✓" : i === state.periodeSekarang ? "●" : "";
    boxes += `<div class="periode-box ${cls}"><div class="p-icon">${icon}</div>Periode ${i}</div>`;
  }
  content.innerHTML = `<div class="timeline-periode">${boxes}</div>
    <div class="form-note" style="margin-top:14px">SEKE MESARI berjalan dalam siklus ${state.totalPeriode} periode pembayaran. Saat ini periode ke-${state.periodeSekarang}.</div>`;
}

function renderAuditLog(content) {
  if (state.auditLog.length === 0) {
    content.innerHTML = `<div class="activity-empty">Belum ada aktivitas admin tercatat.</div>`;
    return;
  }
  content.innerHTML = `<div class="activity-list">${state.auditLog.map(l => `
    <div class="activity-item">
      <div class="activity-icon in">🧾</div>
      <div class="activity-main">
        <div class="activity-title">${escapeHtml(l.actor)}</div>
        <div class="activity-sub">${escapeHtml(l.aksi)}</div>
        <div class="activity-sub">${formatDateTime(l.waktu)}</div>
      </div>
    </div>`).join("")}</div>`;
}

function renderPeranSwitch(content) {
  const u = currentUser();
  content.innerHTML = `
    <div class="form-note" style="margin-bottom:12px">Khusus demo/pratinjau: lihat tampilan aplikasi sebagai peran lain tanpa logout. Ini tidak mengubah akun sungguhan.</div>
    <div class="role-switch">
      <button id="roleAnggotaBtn" class="${!viewAsAdmin ? "active" : ""}">Lihat sebagai Anggota</button>
      <button id="roleAdminBtn" class="${viewAsAdmin ? "active" : ""}">Lihat sebagai Admin</button>
    </div>
  `;
  document.getElementById("roleAdminBtn").addEventListener("click", () => {
    if (u.role !== "admin") { showToast("Akun ini bukan admin — login sebagai admin untuk peran nyata."); return; }
    viewAsAdmin = true;
    document.querySelectorAll(".admin-only").forEach(el => el.hidden = false);
    renderLainnya();
    renderHome(); renderPinjaman(); renderPembayaran(); renderMemberList();
  });
  document.getElementById("roleAnggotaBtn").addEventListener("click", () => {
    viewAsAdmin = false;
    document.querySelectorAll(".admin-only").forEach(el => el.hidden = true);
    renderLainnya();
    renderHome(); renderPinjaman(); renderPembayaran(); renderMemberList();
  });
}

function renderTentang(content) {
  content.innerHTML = `
    <div class="info-box">
      <h4>Tentang</h4>
      Aplikasi arisan &amp; pinjaman keluarga untuk SEKE MESARI. Data tersimpan di database Supabase — semua anggota melihat data bersama yang sama, bukan salinan lokal per HP.

      <h4>Batasan yang perlu diketahui</h4>
      Login (HP + password) memakai Supabase Auth — password tersimpan terenkripsi di server, bukan di kode aplikasi.<br><br>
      Pengingat jatuh tempo hanya muncul di dalam aplikasi — tidak ada notifikasi WhatsApp/push ke HP.<br><br>
      Foto bukti pembayaran disimpan di Supabase Storage.<br><br>
      Aplikasi ini butuh koneksi internet untuk berfungsi (berbeda dari versi awal yang bisa dipakai offline).
    </div>
  `;
}

/* ===== Modals: Ajukan Pinjaman ===== */
function initPinjamanModal() {
  document.getElementById("ajukanPinjamanBtn").addEventListener("click", () => {
    document.getElementById("pinjamanForm").reset();
    document.getElementById("pinjamanModalOverlay").hidden = false;
  });
  document.getElementById("pinjamanModalCloseBtn").addEventListener("click", () => {
    document.getElementById("pinjamanModalOverlay").hidden = true;
  });
  document.getElementById("pinjamanModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "pinjamanModalOverlay") document.getElementById("pinjamanModalOverlay").hidden = true;
  });
  document.getElementById("pinjamanForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = currentUser();
    if (u.pinjaman) { showToast("Anda masih memiliki pinjaman aktif."); return; }
    const jumlah = Number(document.getElementById("pinjamanJumlah").value);
    const tujuan = document.getElementById("pinjamanTujuan").value.trim();
    const btn = document.getElementById("pinjamanForm").querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await dbAjukanPinjaman(u.id, jumlah, tujuan);
      await refreshState();
      document.getElementById("pinjamanModalOverlay").hidden = true;
      showToast("Pengajuan pinjaman terkirim, menunggu persetujuan admin.");
      renderPinjaman();
    } catch (err) {
      showToast("Gagal: " + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ===== Modals: Upload Bukti ===== */
function initBuktiModal() {
  const open = () => {
    document.getElementById("buktiForm").reset();
    document.getElementById("buktiPreview").hidden = true;
    document.getElementById("buktiTanggal").value = todayIso();
    document.getElementById("buktiModalOverlay").hidden = false;
  };
  document.getElementById("uploadBuktiBtnPinjaman").addEventListener("click", open);
  document.getElementById("uploadBuktiBtnPembayaran").addEventListener("click", open);
  document.getElementById("buktiModalCloseBtn").addEventListener("click", () => { document.getElementById("buktiModalOverlay").hidden = true; });
  document.getElementById("buktiModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "buktiModalOverlay") document.getElementById("buktiModalOverlay").hidden = true;
  });
  document.getElementById("buktiFoto").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const preview = document.getElementById("buktiPreview");
    if (!file) { preview.hidden = true; return; }
    const reader = new FileReader();
    reader.onload = () => { preview.src = reader.result; preview.hidden = false; };
    reader.readAsDataURL(file);
  });
  document.getElementById("buktiForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = currentUser();
    const nominal = Number(document.getElementById("buktiNominal").value);
    const tanggal = document.getElementById("buktiTanggal").value;
    const catatan = document.getElementById("buktiCatatan").value.trim();
    const file = document.getElementById("buktiFoto").files[0] || null;
    const btn = document.getElementById("buktiForm").querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Mengirim...";
    try {
      const fotoUrl = await dbUploadBuktiFoto(file, u.id);
      await dbUploadBukti(u.id, tanggal, nominal, catatan, fotoUrl);
      await refreshState();
      document.getElementById("buktiModalOverlay").hidden = true;
      showToast("Bukti pembayaran terkirim, menunggu verifikasi admin.");
      renderPembayaran();
    } catch (err) {
      showToast("Gagal: " + err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Kirim";
    }
  });
}

/* ===== Stat card drilldown (Home, admin-only) ===== */
function initStatDrilldown() {
  document.getElementById("statDrilldownCloseBtn").addEventListener("click", () => {
    document.getElementById("statDrilldownOverlay").hidden = true;
  });
  document.getElementById("statDrilldownOverlay").addEventListener("click", (e) => {
    if (e.target.id === "statDrilldownOverlay") document.getElementById("statDrilldownOverlay").hidden = true;
  });
  document.getElementById("cardPinjamanBeredar").addEventListener("click", () => {
    if (!isAdmin()) return;
    openStatDrilldown("Pinjaman Beredar — Semua Peminjam", state.anggota.filter(a => a.pinjaman), "Tidak ada anggota dengan pinjaman aktif.");
  });
  document.getElementById("cardMenunggak").addEventListener("click", () => {
    if (!isAdmin()) return;
    openStatDrilldown("Anggota Menunggak", state.anggota.filter(a => a.pinjaman && a.tunggakan >= 1), "Tidak ada anggota yang menunggak.");
  });
  document.getElementById("cardJatuhTempo").addEventListener("click", () => {
    if (!isAdmin()) return;
    const now = new Date();
    const list = state.anggota.filter(a => {
      if (!a.pinjaman) return false;
      const d = new Date(a.pinjaman.jatuhTempo);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    openStatDrilldown("Jatuh Tempo Bulan Ini", list, "Tidak ada anggota jatuh tempo bulan ini.");
  });
}

/* ===== Admin tools: Sesuaikan Kas, Input Pinjaman Manual, Catat Angsuran Manual =====
   Dipakai admin untuk onboarding data riil (kas awal, pinjaman yang
   sudah berjalan) tanpa perlu SQL manual. */
function openSesuaikanKasModal() {
  if (!isAdmin()) { showToast("Hanya admin yang bisa mengakses ini."); return; }
  document.getElementById("sesuaikanKasForm").reset();
  document.getElementById("sesuaikanKasModalOverlay").hidden = false;
}

function initAdminToolModals() {
  document.getElementById("sesuaikanKasModalCloseBtn").addEventListener("click", () => {
    document.getElementById("sesuaikanKasModalOverlay").hidden = true;
  });
  document.getElementById("sesuaikanKasModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "sesuaikanKasModalOverlay") document.getElementById("sesuaikanKasModalOverlay").hidden = true;
  });
  document.getElementById("sesuaikanKasForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const arah = document.getElementById("sesuaikanKasArah").value;
    const jumlah = Number(document.getElementById("sesuaikanKasJumlah").value);
    const keterangan = document.getElementById("sesuaikanKasKeterangan").value.trim();
    const actor = currentUser();
    try {
      await dbSesuaikanKas(jumlah, arah, keterangan, actor ? actor.nama : "-");
      await refreshState();
      document.getElementById("sesuaikanKasModalOverlay").hidden = true;
      showToast("Kas berhasil disesuaikan.");
      renderHome();
    } catch (err) {
      showToast("Gagal: " + err.message);
    }
  });

  document.getElementById("adminPinjamanModalCloseBtn").addEventListener("click", () => {
    document.getElementById("adminPinjamanModalOverlay").hidden = true;
  });
  document.getElementById("adminPinjamanModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "adminPinjamanModalOverlay") document.getElementById("adminPinjamanModalOverlay").hidden = true;
  });
  document.getElementById("adminPinjamanForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const jumlah = Number(document.getElementById("adminPinjamanJumlah").value);
    const tanggal = document.getElementById("adminPinjamanTanggal").value;
    const target = getAnggota(adminToolTargetAnggotaId);
    const actor = currentUser();
    try {
      await dbAdminBuatPinjaman(target.id, target.nama, jumlah, tanggal, actor ? actor.nama : "-");
      await refreshState();
      document.getElementById("adminPinjamanModalOverlay").hidden = true;
      document.getElementById("memberModalOverlay").hidden = true;
      showToast("Pinjaman berhasil dicatat.");
      renderMemberList(document.getElementById("memberSearch").value);
    } catch (err) {
      showToast("Gagal: " + err.message);
    }
  });

  document.getElementById("adminAngsuranModalCloseBtn").addEventListener("click", () => {
    document.getElementById("adminAngsuranModalOverlay").hidden = true;
  });
  document.getElementById("adminAngsuranModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "adminAngsuranModalOverlay") document.getElementById("adminAngsuranModalOverlay").hidden = true;
  });
  document.getElementById("adminAngsuranForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tanggal = document.getElementById("adminAngsuranTanggal").value;
    const nominal = Number(document.getElementById("adminAngsuranNominal").value);
    const target = getAnggota(adminToolTargetAnggotaId);
    const actor = currentUser();
    try {
      await dbAdminCatatAngsuran(target, tanggal, nominal, actor ? actor.nama : "-");
      await refreshState();
      document.getElementById("adminAngsuranModalOverlay").hidden = true;
      document.getElementById("memberModalOverlay").hidden = true;
      showToast("Angsuran berhasil dicatat.");
      renderMemberList(document.getElementById("memberSearch").value);
    } catch (err) {
      showToast("Gagal: " + err.message);
    }
  });
}

/* ===== Add Pengumuman =====
   Pakai modal sendiri, bukan window.prompt() — di dalam iframe (artifact)
   maupun sebagian in-app browser mobile, prompt()/alert()/confirm() bisa
   diblokir sandbox dan langsung return null tanpa error terlihat. */
function initPengumumanModal() {
  document.getElementById("addPengumumanBtn").addEventListener("click", () => {
    document.getElementById("pengumumanForm").reset();
    document.getElementById("pengumumanModalOverlay").hidden = false;
  });
  document.getElementById("pengumumanModalCloseBtn").addEventListener("click", () => {
    document.getElementById("pengumumanModalOverlay").hidden = true;
  });
  document.getElementById("pengumumanModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "pengumumanModalOverlay") document.getElementById("pengumumanModalOverlay").hidden = true;
  });
  document.getElementById("pengumumanForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const teks = document.getElementById("pengumumanTeks").value.trim();
    if (!teks) return;
    const actor = currentUser();
    try {
      await dbInsertPengumuman(teks);
      await dbLogAudit(actor ? actor.nama : "-", `Menambahkan pengumuman: ${teks}`);
      await refreshState();
      document.getElementById("pengumumanModalOverlay").hidden = true;
      showToast("Pengumuman ditambahkan.");
      renderHome();
    } catch (err) {
      showToast("Gagal: " + err.message);
    }
  });
}

/* ===== Toast ===== */
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

/* ===== Theme ===== */
function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    document.getElementById("themeBtn").textContent = "☀️";
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    document.getElementById("themeBtn").textContent = "🌙";
  }
  localStorage.setItem(THEME_KEY, theme);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
}

/* ===== Init ===== */
function init() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) applyTheme(savedTheme);
  else document.getElementById("themeBtn").textContent = window.matchMedia("(prefers-color-scheme: dark)").matches ? "☀️" : "🌙";

  initLogin();
  initPinjamanModal();
  initBuktiModal();
  initPengumumanModal();
  initStatDrilldown();
  initAdminToolModals();

  document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  document.getElementById("memberModalCloseBtn").addEventListener("click", () => { document.getElementById("memberModalOverlay").hidden = true; });
  document.getElementById("memberModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "memberModalOverlay") document.getElementById("memberModalOverlay").hidden = true;
  });

  document.getElementById("memberSearch").addEventListener("input", (e) => renderMemberList(e.target.value));

  document.getElementById("notifBtn").addEventListener("click", openNotifDrawer);
  document.getElementById("notifCloseBtn").addEventListener("click", closeNotifDrawer);
  document.getElementById("notifDrawer").addEventListener("click", (e) => { if (e.target.id === "notifDrawer") closeNotifDrawer(); });

  document.getElementById("themeBtn").addEventListener("click", toggleTheme);

  document.querySelectorAll("#histFilter .filter-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#histFilter .filter-chip").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      histFilterJenis = btn.dataset.jenis;
      renderHistori();
    });
  });

  bootFromExistingSession();
}

document.addEventListener("DOMContentLoaded", init);
