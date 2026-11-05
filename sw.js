/* Funciona sin internet: guarda la página y sirve los archivos subidos (contratos, fotos, recibos). */
var CACHE = 'gestion-inmobiliaria-v1';
var SHELL = ['./', 'index.html', 'shim.js', 'jspdf.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
function idb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('gestion-inmobiliaria', 1);
    r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs'); };
    r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
  });
}
function getBlob(id) {
  return idb().then(function (d) { return new Promise(function (res, rej) { var q = d.transaction('blobs', 'readonly').objectStore('blobs').get(id); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); });
}
self.addEventListener('fetch', function (e) {
  var req = e.request; if (req.method !== 'GET') return;
  var url = new URL(req.url), m = url.pathname.match(/\/_blob\/([0-9a-f]{32})$/);
  if (m) {
    e.respondWith(getBlob(m[1]).then(function (rec) {
      if (!rec) return new Response('No encontrado', { status: 404 });
      return new Response(rec.blob, { headers: { 'Content-Type': rec.type || 'application/octet-stream', 'Content-Disposition': 'inline' } });
    }, function () { return new Response('Error', { status: 500 }); }));
    return;
  }
  /* primero lo guardado (rápido y sin internet); en segundo plano se actualiza */
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: false }).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
