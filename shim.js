/* Hace que la página funcione sola en el celular: guarda los datos y los archivos en el propio dispositivo
   (IndexedDB) con la misma interfaz que usa la versión de Claude. No hace falta internet ni cuenta. */
(function () {
  'use strict';
  var DB_NAME = 'gestion-inmobiliaria', mem = {}, listeners = [], idb = null;

  function openIdb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (res, rej) {
      var t = idb.transaction(store, mode), s = t.objectStore(store), out = fn(s);
      t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
      t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error('abort')); };
    });
  }
  var ready = openIdb().then(function (d) {
    idb = d;
    return new Promise(function (res, rej) {
      var t = idb.transaction('kv', 'readonly'), s = t.objectStore('kv'), c = s.openCursor();
      c.onsuccess = function () { var cur = c.result; if (cur) { mem[cur.key] = cur.value; cur.continue(); } };
      t.oncomplete = function () { res(); }; t.onerror = function () { rej(t.error); };
    });
  }).then(function () { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} });

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function docSnap(path) { var ex = path in mem; return { id: path.split('/').pop(), exists: ex, metadata: { fromCache: false }, data: function () { return ex ? clone(mem[path]) : undefined; } }; }
  function colSnap(col) {
    var docs = Object.keys(mem).filter(function (k) { return k.indexOf(col + '/') === 0 && k.slice(col.length + 1).indexOf('/') < 0; })
      .map(function (k) { return { id: k.slice(col.length + 1), exists: true, data: function () { return clone(mem[k]); } }; });
    return { size: docs.length, empty: !docs.length, docs: docs, metadata: { fromCache: false } };
  }
  function notify(path) {
    var col = path.split('/')[0];
    listeners.slice().forEach(function (l) {
      try {
        if (l.kind === 'doc' && l.path === path) l.cb(docSnap(path));
        else if (l.kind === 'col' && l.path === col) l.cb(colSnap(col));
      } catch (e) {}
    });
  }
  var db = {
    doc: function (path) {
      return {
        get: function () { return ready.then(function () { return docSnap(path); }); },
        set: function (data) {
          return ready.then(function () { var v = clone(data); return tx('kv', 'readwrite', function (s) { return s.put(v, path); }).then(function () { mem[path] = v; notify(path); }); });
        },
        update: function (data) { return db.doc(path).set(Object.assign({}, mem[path] || {}, data)); },
        delete: function () {
          return ready.then(function () { return tx('kv', 'readwrite', function (s) { return s.delete(path); }).then(function () { delete mem[path]; notify(path); }); });
        },
        onSnapshot: function (cb) {
          var l = { kind: 'doc', path: path, cb: cb }; listeners.push(l);
          ready.then(function () { if (listeners.indexOf(l) >= 0) cb(docSnap(path)); });
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        }
      };
    },
    collection: function (col) {
      return {
        get: function () { return ready.then(function () { return colSnap(col); }); },
        onSnapshot: function (cb) {
          var l = { kind: 'col', path: col, cb: cb }; listeners.push(l);
          ready.then(function () { if (listeners.indexOf(l) >= 0) cb(colSnap(col)); });
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        }
      };
    }
  };

  function hex32() { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  var assets = {
    upload: function (blob, opts) {
      return ready.then(function () {
        var id = hex32(), type = (opts && opts.type) || blob.type || 'application/octet-stream';
        return tx('blobs', 'readwrite', function (s) { return s.put({ blob: blob, type: type }, id); }).then(function () { return { id: id, url: '_blob/' + id, sizeBytes: blob.size, contentType: type }; });
      });
    },
    delete: function (id) { return ready.then(function () { return tx('blobs', 'readwrite', function (s) { return s.delete(id); }); }).then(function () { return { deleted: true }; }); },
    list: function () { return Promise.resolve({ assets: [], usage: {} }); }
  };
  /* Dentro de la app de Android (APK) no se puede "descargar" como en un navegador: se abre el menú de compartir
     (WhatsApp, Drive, Guardar en el teléfono...). */
  function nativeCap() { var c = window.Capacitor; return c && c.isNativePlatform && c.isNativePlatform() && c.Plugins && c.Plugins.Filesystem && c.Plugins.Share ? c : null; }
  function toBase64(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result).split(',')[1] || ''); }; fr.onerror = function () { rej(fr.error); }; fr.readAsDataURL(blob); }); }
  function nativeSave(cap, o) {
    return toBase64(o.data).then(function (b64) { return cap.Plugins.Filesystem.writeFile({ path: o.filename, data: b64, directory: 'CACHE' }); })
      .then(function (r) { return cap.Plugins.Share.share({ title: o.filename, dialogTitle: 'Guardar o enviar', files: [r.uri] }); })
      .then(function () { return { status: 'saved' }; }, function (e) { if (/cancel/i.test(String(e && (e.message || e)))) throw { code: 'declined' }; throw { code: 'failed', message: String(e && e.message || e) }; });
  }
  var downloads = {
    save: function (o) {
      var cap = nativeCap(); if (cap) return nativeSave(cap, o);
      return new Promise(function (res, rej) {
        try {
          var url = URL.createObjectURL(o.data), a = document.createElement('a');
          a.href = url; a.download = o.filename; a.style.display = 'none'; document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000); res({ status: 'saved' });
        } catch (e) { rej({ code: 'failed', message: String(e) }); }
      });
    }
  };
  var user = { can: function () { return Promise.resolve(true); }, isOwner: function () { return true; }, canEdit: function () { return true; }, id: function () { return Promise.resolve('local'); } };
  /* En el APK: los enlaces a otras páginas (WhatsApp) se abren afuera y los archivos guardados se comparten. */
  document.addEventListener('click', function (e) {
    var cap = nativeCap(); if (!cap) return;
    var a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^_blob\/[0-9a-f]{32}$/.test(href)) {
      e.preventDefault();
      var li = a.closest('li, .rcrow'), nm = li && li.querySelector('b'), name = (nm && nm.textContent.trim()) || 'archivo';
      fetch(href).then(function (r) { return r.blob(); }).then(function (bl) {
        var ext = /pdf/.test(bl.type) ? '.pdf' : /text/.test(bl.type) ? '.txt' : '';
        return nativeSave(cap, { filename: /\.[A-Za-z0-9]{2,4}$/.test(name) ? name : name + ext, data: bl });
      }).catch(function () {});
    } else if (/^https?:\/\//.test(href) && a.target === '_blank') {
      e.preventDefault(); window.location.href = href;
    }
  }, true);
  window.claude = { use: function (name) { return ready.then(function () { return name === 'db' ? db : name === 'assets' ? assets : name === 'downloads' ? downloads : name === 'user' ? user : null; }); } };
})();
