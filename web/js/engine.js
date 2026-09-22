/**
 * engine.js — অফলাইন ইঞ্জিন
 *
 *  • আগের Code.gs (অপরিবর্তিত) ব্রাউজারেই চালায় — gas-shim.js Google-এর সার্ভিসের নকল দেয়।
 *  • ডাটা IndexedDB-তে থাকে, তাই ইন্টারনেট ছাড়াই সব কাজ চলে।
 *  • লেনদেন করলে (বিক্রি, প্রোডাক্ট, স্টক, খরচ, সঞ্চয়, সেটিংস) সেটা "outbox"-এ জমা হয়।
 *  • ইন্টারনেট এলে outbox-এর কাজগুলো একই ফাংশন দিয়ে Apps Script-এ (Api.gs) চলে,
 *    তারপর Google Sheets-এর সর্বশেষ ডাটা নামিয়ে এনে স্থানীয় কপি নতুন করা হয়।
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RiponEngineFactory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const G = typeof self !== 'undefined' ? self : globalThis;   // ব্রাউজারে window/self

  /** যেসব ফাংশন ডাটা বদলায় — এগুলোই সার্ভারে পাঠানো হয় */
  const MUTATING = { createProduct: 1, updateProduct: 1, updateStock: 1, createSale: 1, createExpense: 1, createSaving: 1, saveSettings: 1 };
  const CHUNK = 25;
  const clone = function (x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); };

  /** অফলাইনে তৈরি প্রোডাক্ট আইডি সার্ভারে বদলে গেলে কাজের ভেতরের আইডি বদলানো */
  function remapOp(op, map) {
    if (!map || op.mapped) return op;
    const m = function (id) { return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : id; };
    const a = op.args || [];
    if (op.fn === 'updateProduct' && a[0] && a[0].id != null) a[0].id = m(String(a[0].id));
    else if (op.fn === 'updateStock' && a[0] != null) a[0] = m(String(a[0]));
    else if (op.fn === 'createSale' && a[0] && Array.isArray(a[0].items)) a[0].items.forEach(function (it) { it.id = m(String(it.id)); });
    return op;
  }

  /**
   * deps = {
   *   shim         : GasShim,
   *   storage      : { load(): Promise<{tables,state,files}>, save(patch): Promise },
   *   fetchCode    : () => Promise<string>            // Code.gs-এর লেখা
   *   evalCode     : (text, globals) => (name => function)
   *   post         : (cfg, body) => Promise<json>     // Apps Script Web App-এ POST
   *   isOnline     : () => boolean,
   *   now          : () => ms,   uid : () => string,
   *   setTimeout / clearTimeout,
   *   objectUrl    : (mime, bytes) => url
   * }
   */
  function create(deps) {
    const ST = { cfg: null, meta: { lastHash: '', lastSync: 0, sheetUrl: '', lastError: '' }, outbox: [], failed: [], idMap: {} };
    const store = { tables: {}, props: {}, cache: {}, files: {}, sheetUrl: '' };
    let shim = null, getFn = null, ready = false, syncing = false, cachingImages = false, authBlocked = false;
    let stateDirty = false, saveChain = Promise.resolve(), timer = null;
    const urlCache = {};
    const listeners = { status: [], data: [], images: [] };

    function on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); }
    function emit(ev) { (listeners[ev] || []).forEach(function (cb) { try { cb(); } catch (e) { /* UI ত্রুটি ইঞ্জিন থামাবে না */ } }); }
    function hasData() { return !!(store.props.DB_READY && store.tables.Products); }

    /* ---------------- সংরক্ষণ ---------------- */
    function persist() {
      const patch = { tables: {}, files: {}, state: null };
      store.dirty.tables.forEach(function (n) { patch.tables[n] = store.tables[n] || null; });
      store.dirty.files.forEach(function (id) { patch.files[id] = store.files[id] || null; delete urlCache[id]; });
      if (stateDirty || store.dirty.kv) {
        patch.state = { props: store.props, cache: store.cache, cfg: ST.cfg, meta: ST.meta, outbox: ST.outbox, failed: ST.failed, idMap: ST.idMap };
      }
      store.dirty.tables.clear(); store.dirty.files.clear(); store.dirty.kv = false; stateDirty = false;
      if (!Object.keys(patch.tables).length && !Object.keys(patch.files).length && !patch.state) return saveChain;   // কিছু বদলায়নি
      saveChain = saveChain.then(function () { return deps.storage.save(patch); });
      return saveChain;
    }

    /* ---------------- শুরু ---------------- */
    async function init() {
      const d = (await deps.storage.load()) || {};
      const s = d.state || {};
      store.tables = d.tables || {};
      store.props = s.props || {};
      store.cache = s.cache || {};
      store.files = d.files || {};
      ST.cfg = s.cfg || null;
      ST.meta = Object.assign(ST.meta, s.meta || {});
      ST.outbox = s.outbox || [];
      ST.failed = s.failed || [];
      ST.idMap = s.idMap || {};
      store.sheetUrl = ST.meta.sheetUrl || '';
      shim = deps.shim.createShim(store);
      getFn = deps.evalCode(await deps.fetchCode(), shim.globals);
      const noFiles = getFn('setBarcodeFiles_');
      if (typeof noFiles === 'function') noFiles(false);   // বারকোড ছবির ফাইল সার্ভারে সিঙ্কের সময় তৈরি হবে
      ready = true;
      return { configured: !!ST.cfg && hasData() };
    }

    /* ---------------- Code.gs-এর ফাংশন ডাকা ---------------- */
    async function call(fn, args) {
      if (!ready) throw new Error('অফলাইন ইঞ্জিন এখনও প্রস্তুত নয়');
      const f = getFn(fn);
      if (typeof f !== 'function') return { ok: false, error: 'অজানা ফাংশন: ' + fn };
      args = args || [];
      const copy = clone(args);
      let res;
      try { res = f.apply(null, args); }
      catch (e) { res = { ok: false, error: String(e && e.message ? e.message : e) }; }
      const mut = !!MUTATING[fn];
      if (mut && res && res.ok && !(res.data && res.data.duplicate)) {
        ST.outbox.push({
          opId: deps.uid(), fn: fn, args: copy, ts: deps.now(),
          local: (fn === 'createProduct' && res.data && res.data.id) ? { id: res.data.id } : undefined
        });
        stateDirty = true;
      }
      await persist();
      if (mut && res && res.ok) { emit('status'); scheduleSync(1800); }
      return res;
    }

    /* ---------------- সিঙ্ক ---------------- */
    function scheduleSync(ms) {
      if (!ST.cfg || authBlocked) return;
      if (timer) deps.clearTimeout(timer);
      timer = deps.setTimeout(function () { timer = null; syncNow(); }, ms || 1500);
    }

    function friendly(e) {
      const m = String(e && e.message ? e.message : e);
      if (e && (e.code === 'AUTH' || e.code === 'NOKEY')) authBlocked = true;
      return m;
    }

    async function syncNow() {
      if (!ready || !ST.cfg || !hasData()) return { skipped: 'not-configured' };
      if (syncing) return { skipped: 'busy' };
      if (!deps.isOnline()) { emit('status'); return { skipped: 'offline' }; }
      syncing = true; ST.meta.lastError = ''; authBlocked = false; emit('status');
      let changed = false, sent = 0;
      try {
        for (let guard = 0; guard < 500; guard++) {
          // ব্যাচ: সর্বোচ্চ CHUNK টি; নতুন প্রোডাক্ট তৈরির কাজে ব্যাচ শেষ (যাতে আইডি বদলালে পরের কাজ ঠিক থাকে)
          const batch = [];
          for (let i = 0; i < ST.outbox.length && batch.length < CHUNK; i++) {
            const op = ST.outbox[i];
            batch.push(op);
            if (op.fn === 'createProduct') break;
          }
          const last = batch.length === ST.outbox.length;
          const sendOps = batch.map(function (o) {
            const c = clone(o); if (!c.mapped) remapOp(c, ST.idMap); return { opId: c.opId, fn: c.fn, args: c.args, ts: c.ts, local: c.local };
          });
          const resp = await deps.post(ST.cfg, { action: 'sync', ops: sendOps, want: last ? 'snapshot' : null, have: ST.meta.lastHash });
          if (!resp || !resp.ok) { const err = new Error((resp && resp.error) || 'সিঙ্ক ব্যর্থ হয়েছে'); err.code = resp && resp.code; throw err; }
          const d = resp.data || {};
          const doneIds = {};
          batch.forEach(function (o) { doneIds[o.opId] = o; });
          (d.results || []).forEach(function (r) {
            const o = doneIds[r.opId];
            if (o && !r.ok) ST.failed.push({ opId: o.opId, fn: o.fn, args: o.args, ts: o.ts, error: r.error || 'ব্যর্থ', failedAt: deps.now() });
          });
          ST.outbox = ST.outbox.filter(function (o) { return !doneIds[o.opId]; });
          sent += batch.length;
          if (d.idMap && Object.keys(d.idMap).length) {
            Object.assign(ST.idMap, d.idMap);
            ST.outbox.forEach(function (o) { remapOp(o, d.idMap); o.mapped = true; });
          }
          stateDirty = true;
          if (last) {
            if (d.snapshot) { applySnapshot(d.snapshot); changed = true; }
            break;
          }
          await persist();
        }
        ST.meta.lastSync = deps.now();
      } catch (e) {
        ST.meta.lastError = friendly(e);
      } finally {
        syncing = false; stateDirty = true;
        await persist();
        emit('status');
      }
      if (changed) { emit('data'); cacheImages(); }
      if (!ST.meta.lastError && ST.outbox.length) scheduleSync(600);   // সিঙ্ক চলার সময় জমা হওয়া নতুন কাজ
      return { sent: sent, changed: changed, error: ST.meta.lastError };
    }

    /** সার্ভারের ডাটা স্থানীয় ডাটা বানায়, তারপর যেসব কাজ এখনও সার্ভারে যায়নি সেগুলো আবার চালায় */
    function applySnapshot(snap) {
      Object.keys(store.tables).forEach(function (k) { if (!snap.tables[k]) { delete store.tables[k]; store.dirty.tables.add(k); } });
      Object.keys(snap.tables).forEach(function (k) { store.tables[k] = clone(snap.tables[k]); store.dirty.tables.add(k); });
      store.props.DB_READY = String((snap.props && snap.props.DB_READY) || '1');
      store.props.IMAGE_FOLDER_ID = String((snap.props && snap.props.IMAGE_FOLDER_ID) || '');
      store.dirty.kv = true;
      store.cache = {};
      store.sheetUrl = snap.sheetUrl || '';
      ST.meta.sheetUrl = store.sheetUrl;
      ST.meta.lastHash = snap.hash || '';

      const pending = ST.outbox; ST.outbox = [];
      const setClock = getFn('setClock_');
      pending.forEach(function (o) {
        remapOp(o, ST.idMap);
        let res;
        try {
          if (setClock) setClock(o.ts);
          res = getFn(o.fn).apply(null, clone(o.args));
        } catch (e) { res = { ok: false, error: String(e && e.message ? e.message : e) }; }
        finally { if (setClock) setClock(null); }
        if (res && res.ok) { o.mapped = true; ST.outbox.push(o); }
        else ST.failed.push({ opId: o.opId, fn: o.fn, args: o.args, ts: o.ts, error: (res && res.error) || 'নতুন ডাটার সাথে মেলেনি', failedAt: deps.now() });
      });
      ST.idMap = {};
      stateDirty = true;
      pruneFiles();
    }

    /* ---------------- প্রথম সংযোগ / সার্ভার বদল ---------------- */
    async function configure(url, key) {
      url = String(url || '').trim(); key = String(key || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Web app URL সঠিক নয় (https://script.google.com/macros/s/…/exec)');
      if (!key) throw new Error('API Key দিন');
      if (syncing) throw new Error('সিঙ্ক চলছে, একটু পরে চেষ্টা করুন');
      const fresh = !hasData() || !ST.cfg || ST.cfg.url !== url;
      if (fresh && ST.outbox.length && hasData()) throw new Error('এখনও ' + ST.outbox.length + 'টি কাজ সিঙ্কের বাকি — আগে সিঙ্ক শেষ করুন');
      const cfg = { url: url, key: key };
      const ping = await deps.post(cfg, { action: 'ping' });
      if (!ping || !ping.ok) { const e = new Error((ping && ping.error) || 'সংযোগ ব্যর্থ'); e.code = ping && ping.code; throw e; }
      if (!fresh) { ST.cfg = cfg; authBlocked = false; stateDirty = true; await persist(); emit('status'); return { fresh: false }; }
      const snap = await deps.post(cfg, { action: 'snapshot' });
      if (!snap || !snap.ok) throw new Error((snap && snap.error) || 'ডাটা ডাউনলোড ব্যর্থ');
      ST.outbox = []; ST.failed = []; ST.idMap = {};
      Object.keys(store.files).forEach(function (id) { delete store.files[id]; store.dirty.files.add(id); });
      ST.cfg = cfg; authBlocked = false;
      applySnapshot(snap.data.snapshot);
      ST.meta.lastSync = deps.now(); ST.meta.lastError = '';
      stateDirty = true;
      await persist();
      emit('status'); emit('data');
      cacheImages();
      return { fresh: true };
    }

    /** স্থানীয় ডাটা মুছে সার্ভার থেকে নতুন করে নামানো (শুধু কোনো কাজ বাকি না থাকলে) */
    async function redownload() {
      if (!ST.cfg) throw new Error('সার্ভারের সাথে সংযোগ দেওয়া নেই');
      if (ST.outbox.length) throw new Error('এখনও ' + ST.outbox.length + 'টি কাজ সিঙ্কের বাকি');
      const snap = await deps.post(ST.cfg, { action: 'snapshot' });
      if (!snap || !snap.ok) throw new Error((snap && snap.error) || 'ডাটা ডাউনলোড ব্যর্থ');
      applySnapshot(snap.data.snapshot);
      ST.meta.lastSync = deps.now();
      stateDirty = true; await persist();
      emit('status'); emit('data'); cacheImages();
    }

    /* ---------------- ব্যর্থ কাজ ---------------- */
    function retryFailed(opId) {
      const i = ST.failed.findIndex(function (f) { return f.opId === opId; });
      if (i < 0) return;
      const f = ST.failed.splice(i, 1)[0];
      const res = getFn(f.fn).apply(null, clone(f.args));   // স্থানীয় ডাটায় আবার চালিয়ে দেখা
      if (res && res.ok) { ST.outbox.push({ opId: deps.uid(), fn: f.fn, args: clone(f.args), ts: f.ts, local: undefined }); stateDirty = true; persist(); emit('status'); emit('data'); scheduleSync(500); return { ok: true }; }
      ST.failed.splice(i, 0, Object.assign(f, { error: (res && res.error) || f.error }));
      stateDirty = true; persist(); emit('status');
      return { ok: false, error: res && res.error };
    }
    function discardFailed(opId) {
      ST.failed = ST.failed.filter(function (f) { return f.opId !== opId; });
      stateDirty = true; persist(); emit('status');
    }

    /* ---------------- ছবি (অফলাইনে দেখার জন্য) ---------------- */
    function neededImageIds() {
      const ids = {};
      (store.tables.Products || []).slice(1).forEach(function (r) { if (r && r[10]) ids[String(r[10])] = 1; });
      (store.tables.Settings || []).slice(1).forEach(function (r) { if (r && r[0] === 'LogoId' && r[1]) ids[String(r[1])] = 1; });
      return Object.keys(ids);
    }
    function pruneFiles() {
      const keep = {};
      neededImageIds().forEach(function (id) { keep[id] = 1; });
      Object.keys(store.files).forEach(function (id) {
        if (!keep[id] && !ST.outbox.some(function (o) { return JSON.stringify(o.args).indexOf(id) >= 0; })) {
          // ছবি আর কোনো প্রোডাক্টে নেই — তবে অফলাইনে তোলা, এখনো সার্ভারে না যাওয়া ছবি (L…) outbox-এর ভেতরেই আছে
          delete store.files[id]; store.dirty.files.add(id);
        }
      });
    }
    async function cacheImages() {
      if (!ST.cfg || cachingImages || !deps.isOnline()) return;
      cachingImages = true;
      try {
        const need = neededImageIds().filter(function (id) { return !store.files[id]; });
        for (let i = 0; i < need.length; i += 6) {
          const r = await deps.post(ST.cfg, { action: 'images', ids: need.slice(i, i + 6) });
          if (!r || !r.ok) break;
          (r.data.images || []).forEach(function (im) {
            store.files[im.id] = { mime: im.mime, bytes: deps.shim.b64decode(im.b64) };
            store.dirty.files.add(im.id);
          });
          await persist();
          emit('images');
        }
      } catch (e) { /* ছবি না এলেও অ্যাপ চলবে */ }
      finally { cachingImages = false; }
    }
    function imgUrl(id) {
      const f = store.files[id];
      if (!f) return '';
      if (!urlCache[id]) urlCache[id] = deps.objectUrl(f.mime, f.bytes);
      return urlCache[id];
    }

    /** সার্ভারে সরাসরি অনুরোধ (যেমন Google Sheet-এ বারকোড ছবি তৈরি) — ইন্টারনেট লাগে */
    async function request(action, body) {
      if (!ST.cfg) throw new Error('সার্ভারের সাথে সংযোগ দেওয়া নেই');
      if (!deps.isOnline()) throw new Error('এই কাজের জন্য ইন্টারনেট দরকার');
      const r = await deps.post(ST.cfg, Object.assign({ action: action }, body || {}));
      if (!r || !r.ok) { const e = new Error((r && r.error) || 'সার্ভারে কাজটি হয়নি'); e.code = r && r.code; throw e; }
      return r.data;
    }

    function status() {
      return {
        configured: !!ST.cfg && hasData(), online: deps.isOnline(), syncing: syncing,
        pending: ST.outbox.length, failed: ST.failed.slice(), lastSync: ST.meta.lastSync,
        lastError: ST.meta.lastError, sheetUrl: ST.meta.sheetUrl
      };
    }

    return {
      init: init, call: call, request: request, syncNow: syncNow, scheduleSync: scheduleSync, configure: configure, redownload: redownload,
      retryFailed: retryFailed, discardFailed: discardFailed, cacheImages: cacheImages, imgUrl: imgUrl,
      status: status, on: on, getConfig: function () { return ST.cfg ? { url: ST.cfg.url, key: ST.cfg.key } : null; },
      _state: ST, _store: store
    };
  }

  /* =====================================================================
     ব্রাউজারের জন্য জোড়া লাগানো: IndexedDB + fetch + eval
     ===================================================================== */
  function browserEngine() {
    const DB = 'ripon-offline';
    let db = null;
    function open() {
      return new Promise(function (res, rej) {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = function () { ['tables', 'kv', 'files'].forEach(function (n) { r.result.createObjectStore(n); }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }
    function readAll(name) {
      return new Promise(function (res, rej) {
        const out = {}, c = db.transaction(name, 'readonly').objectStore(name).openCursor();
        c.onsuccess = function (e) { const cur = e.target.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else res(out); };
        c.onerror = function () { rej(c.error); };
      });
    }
    const storage = {
      load: async function () {
        db = await open();
        if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) { /* ঠিক আছে */ } }
        const all = await Promise.all([readAll('tables'), readAll('kv'), readAll('files')]);
        return { tables: all[0], state: all[1].state, files: all[2] };
      },
      save: function (patch) {
        return new Promise(function (res, rej) {
          const tx = db.transaction(['tables', 'kv', 'files'], 'readwrite');
          Object.keys(patch.tables).forEach(function (n) { const s = tx.objectStore('tables'); if (patch.tables[n]) s.put(patch.tables[n], n); else s.delete(n); });
          Object.keys(patch.files).forEach(function (id) { const s = tx.objectStore('files'); if (patch.files[id]) s.put(patch.files[id], id); else s.delete(id); });
          if (patch.state) tx.objectStore('kv').put(patch.state, 'state');
          tx.oncomplete = function () { res(); };
          tx.onerror = tx.onabort = function () { rej(tx.error || new Error('ডিভাইসে ডাটা সংরক্ষণ করা যায়নি (জায়গা শেষ?)')); };
        });
      }
    };
    async function post(cfg, body) {
      const ctl = new AbortController();
      const t = setTimeout(function () { ctl.abort(); }, 120000);
      try {
        // Content-Type: text/plain → "simple request", তাই CORS preflight লাগে না (Apps Script preflight নিতে পারে না)
        const r = await fetch(cfg.url, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ key: cfg.key }, body)), redirect: 'follow', signal: ctl.signal
        });
        const txt = await r.text();
        try { return JSON.parse(txt); }
        catch (e) { throw new Error('সার্ভার থেকে সঠিক উত্তর আসেনি — Web app URL ও Deploy সেটিং (Who has access: Anyone) দেখুন'); }
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('সার্ভার সময়মতো সাড়া দেয়নি');
        if (e instanceof TypeError) throw new Error('ইন্টারনেট সংযোগ নেই বা সার্ভারে পৌঁছানো যায়নি');
        throw e;
      } finally { clearTimeout(t); }
    }
    return create({
      shim: G.GasShim, storage: storage, post: post,
      fetchCode: function () {
        // Barcode.gs (ছবি তৈরির ফাংশন) + Code.gs (অপরিবর্তিত ব্যাকএন্ড) — Apps Script-এর মতোই একসাথে
        return Promise.all(['gas/Barcode.gs.txt', 'gas/Code.gs.txt'].map(function (f) {
          return fetch(f).then(function (r) { if (!r.ok) throw new Error(f + ' লোড হয়নি'); return r.text(); });
        })).then(function (a) { return a.join('\n'); });
      },
      evalCode: function (text, globals) {
        Object.keys(globals).forEach(function (k) { G[k] = globals[k]; });
        (0, eval)(text + '\n//# sourceURL=Code.gs');
        return function (name) { return G[name]; };
      },
      isOnline: function () { return navigator.onLine !== false; },
      now: function () { return Date.now(); },
      uid: function () { return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); },
      setTimeout: function (f, ms) { return setTimeout(f, ms); }, clearTimeout: function (t) { clearTimeout(t); },
      objectUrl: function (mime, bytes) { return URL.createObjectURL(new Blob([bytes], { type: mime || 'image/jpeg' })); }
    });
  }

  const api = { create: create, remapOp: remapOp };
  if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
    G.Engine = browserEngine();
  }
  return api;
});
