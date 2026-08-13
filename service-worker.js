/*
 * Cleanup worker for the old cache-first PWA release.  It activates once on
 * existing phones, deletes the cache that could keep old scanner code alive,
 * then unregisters itself.  The scanner now always receives the latest
 * Vercel files instead of freezing on an outdated WebAssembly bundle.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .then(() => self.registration.unregister())
  );
});
