// Needed only so the browser offers "Install" / "Add to home screen".
// It caches nothing on purpose: every launch must get the latest test build.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  e.respondWith(fetch(e.request));
});
