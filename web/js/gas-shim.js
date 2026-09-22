/**
 * gas-shim.js
 * Google Apps Script-এর SpreadsheetApp / PropertiesService / CacheService / LockService /
 * Utilities / DriveApp — ব্রাউজারের মেমরিতে নকল করে, যাতে আগের Code.gs
 * অক্ষত রেখেই অফলাইনে হুবহু একই ফাংশন চালানো যায়।
 *
 * সব কিছু synchronous (Apps Script-এর মতোই)। ডিস্কে সংরক্ষণ (IndexedDB) engine.js করে —
 * এখানে শুধু কোন টেবিল বদলেছে সেটা `store.dirty`-তে জানিয়ে রাখা হয়।
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GasShim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- base64 ---------- */
  function b64decode(str) {
    str = String(str || '');
    if (typeof atob === 'function') {
      const bin = atob(str), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(str, 'base64'));
  }
  function b64encode(bytes) {
    if (typeof btoa === 'function') {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray ? bytes.subarray(i, i + 0x8000) : bytes.slice(i, i + 0x8000));
      return btoa(s);
    }
    return Buffer.from(bytes).toString('base64');
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  /* ---------- Utilities.formatDate ---------- */
  function formatDate(d, tz, pattern) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
    const hh = p.hour === '24' ? '00' : p.hour;
    return String(pattern).replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
      .replace('HH', hh).replace('mm', p.minute).replace('ss', p.second);
  }

  /**
   * store = { tables:{ শীট: [[..],[..]] }, props:{}, cache:{}, files:{ id:{mime,bytes} }, sheetUrl:'' }
   * টেবিল/প্রপার্টি বদলালে store.dirty-তে চিহ্ন রাখে (engine.js সেগুলো সংরক্ষণ করে)।
   */
  function createShim(store) {
    store.tables = store.tables || {};
    store.props = store.props || {};
    store.cache = store.cache || {};
    store.files = store.files || {};
    store.dirty = store.dirty || { tables: new Set(), kv: false, files: new Set() };
    const dirty = store.dirty;

    /* ----- Range / Sheet ----- */
    function Sheet(name) { this.name = name; }
    Sheet.prototype._rows = function () { return store.tables[this.name]; };
    Sheet.prototype.getName = function () { return this.name; };
    Sheet.prototype.getMaxRows = function () { return Math.max(1000, this._rows().length + 500); };
    Sheet.prototype.getLastRow = function () {
      const rows = this._rows();
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r && r.some(function (v) { return v !== '' && v !== undefined && v !== null; })) return i + 1;
      }
      return 0;
    };
    Sheet.prototype.getLastColumn = function () {
      let m = 0;
      this._rows().forEach(function (r) { if (r && r.length > m) m = r.length; });
      return m;
    };
    Sheet.prototype.setFrozenRows = function () {};
    Sheet.prototype.setColumnWidth = function () {};
    Sheet.prototype.setRowHeights = function () {};
    Sheet.prototype.clear = function () { store.tables[this.name] = []; dirty.tables.add(this.name); };
    Sheet.prototype.insertRowsAfter = function () {};
    Sheet.prototype.deleteRow = function (n) {
      this._rows().splice(n - 1, 1); dirty.tables.add(this.name);
    };
    Sheet.prototype.deleteRows = function (n, count) {
      this._rows().splice(n - 1, count); dirty.tables.add(this.name);
    };
    Sheet.prototype.getDataRange = function () {
      return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
    };
    Sheet.prototype.getRange = function (r, c, nr, nc) {
      const sheet = this;
      nr = nr || 1; nc = nc || 1;
      const rg = {
        getValues: function () {
          const rows = sheet._rows(), out = [];
          for (let i = 0; i < nr; i++) {
            const src = rows[r - 1 + i] || [], row = [];
            for (let j = 0; j < nc; j++) {
              const v = src[c - 1 + j];
              row.push(v === undefined || v === null ? '' : v);
            }
            out.push(row);
          }
          return out;
        },
        setValues: function (vals) {
          if (vals.length !== nr || (vals[0] || []).length !== nc) {
            throw new Error('The number of rows/columns in the data does not match the range (' + vals.length + 'x' + (vals[0] || []).length + ' vs ' + nr + 'x' + nc + ')');
          }
          vals.forEach(function (row, i) { row.forEach(function (v, j) { setCell(sheet, r - 1 + i, c - 1 + j, v); }); });
          dirty.tables.add(sheet.name);
          return rg;
        },
        setValue: function (v) { setCell(sheet, r - 1, c - 1, v); dirty.tables.add(sheet.name); return rg; },
        setNumberFormat: function () { return rg; },
        setFontWeight: function () { return rg; },
        setFontColor: function () { return rg; },
        setBackground: function () { return rg; }
      };
      return rg;
    };
    function setCell(sheet, i, j, v) {
      const rows = sheet._rows();
      while (rows.length <= i) rows.push([]);
      const row = rows[i];
      while (row.length < j) row.push('');
      // Sheets-এর মতো: শুরুর ' চিহ্ন শুধু "টেক্সট" বোঝায়, ঘরে থাকে না
      if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);
      row[j] = v;
    }

    /* ----- Spreadsheet ----- */
    const ss = {
      getSheetByName: function (n) { return Object.prototype.hasOwnProperty.call(store.tables, n) ? new Sheet(n) : null; },
      insertSheet: function (n) { store.tables[n] = []; dirty.tables.add(n); return new Sheet(n); },
      getSheets: function () { return Object.keys(store.tables).map(function (n) { return new Sheet(n); }); },
      deleteSheet: function (sh) { delete store.tables[sh.name]; dirty.tables.add(sh.name); },
      getUrl: function () { return store.sheetUrl || ''; },
      getId: function () { return 'LOCAL'; },
      setSpreadsheetTimeZone: function () {}
    };
    const SpreadsheetApp = {
      getActiveSpreadsheet: function () { return ss; },
      openById: function () { return ss; },
      create: function () { return ss; },
      flush: function () {}
    };

    /* ----- Properties / Cache / Lock ----- */
    const PropertiesService = {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store.props, k) ? store.props[k] : null; },
          setProperty: function (k, v) { store.props[k] = String(v); dirty.kv = true; },
          deleteProperty: function (k) { delete store.props[k]; dirty.kv = true; }
        };
      }
    };
    const CacheService = {
      getScriptCache: function () {
        return {
          get: function (k) {
            const e = store.cache[k];
            if (!e) return null;
            if (e.exp && e.exp < Date.now()) { delete store.cache[k]; return null; }
            return e.v;
          },
          put: function (k, v, ttl) {
            store.cache[k] = { v: String(v), exp: ttl ? Date.now() + ttl * 1000 : 0 };
            dirty.kv = true;
          }
        };
      }
    };
    const oneLock = function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; };
    const LockService = { getScriptLock: oneLock, getUserLock: oneLock, getDocumentLock: oneLock };

    /* ----- Utilities ----- */
    const Utilities = {
      formatDate: formatDate,
      base64Decode: b64decode,
      base64Encode: b64encode,
      newBlob: function (bytes, mime, name) {
        return {
          bytes: bytes, mime: mime, name: name,
          getBytes: function () { return bytes; },
          getContentType: function () { return mime; }
        };
      },
      getUuid: uuid
    };

    /* ----- Drive (ছবি স্থানীয়ভাবে রাখা হয়; সার্ভারে তোলার সময় আসল Drive ফাইল হয়) ----- */
    const folder = {
      getId: function () { return store.props.IMAGE_FOLDER_ID || 'LOCAL-FOLDER'; },
      isTrashed: function () { return false; },
      createFile: function (blob) {
        const id = 'L' + uuid().replace(/-/g, '').slice(0, 14);
        store.files[id] = { mime: blob.mime, bytes: blob.bytes };
        dirty.files.add(id);
        return { getId: function () { return id; }, setSharing: function () {} };
      }
    };
    const DriveApp = {
      Access: { ANYONE_WITH_LINK: 1 },
      Permission: { VIEW: 1 },
      getFolderById: function () { return folder; },
      createFolder: function () { return folder; },
      getFileById: function (id) {
        return {
          setTrashed: function () {
            if (store.files[id]) { delete store.files[id]; dirty.files.add(id); }
          }
        };
      }
    };

    const globals = {
      SpreadsheetApp: SpreadsheetApp, PropertiesService: PropertiesService, CacheService: CacheService,
      LockService: LockService, Utilities: Utilities, DriveApp: DriveApp,
      Logger: { log: function (m) { if (typeof console !== 'undefined') console.log(m); } },
      HtmlService: {}
    };
    return { globals: globals, store: store };
  }

  return { createShim: createShim, b64decode: b64decode, b64encode: b64encode, formatDate: formatDate };
});
