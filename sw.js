// Service worker hanya untuk syarat instalasi PWA (Add to Home Screen).
// Sengaja tidak menyimpan cache — aplikasi ini selalu butuh koneksi ke
// Supabase, jadi cache offline hanya akan menyebabkan tampilan basi
// setelah ada update.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // no-op: selalu ambil langsung dari network, tidak diintersep.
});
