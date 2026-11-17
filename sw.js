'use strict';

/* Rémanence mobile : la page marche hors ligne. Code en cache (version = empreinte posée par Dawn à l'export) ;
 * pack.json, pack.bin, pack2.bin, sim.bin et licences.json passent toujours par le réseau : l'appli les garde elle-même, chiffrés, dans IndexedDB. */
const VERSION = 'rem-e61899c11fd1a840';
const CODE = ['./', 'index.html', 'app.js', 'feed.js', 'app.css', 'remcrypto.js', 'remanence.js', 'remintro.js', 'pdfview.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CODE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || /\/(pack2?\.(json|bin)|sim\.bin|licences\.json)$/.test(url.pathname)) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
