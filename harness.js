/**
 * টেস্টের পরিবেশ: Code.gs (+ ঐচ্ছিক Api.gs) একটি আলাদা vm-এ চালায়,
 * Google-এর সার্ভিসের জায়গায় ব্রাউজারের একই gas-shim.js ব্যবহার করে।
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { createShim } = require('../web/js/gas-shim.js');
const root = path.join(__dirname, '..');

function makeEnv(opts) {
  opts = opts || {};
  const store = opts.store || { tables: {}, props: {}, cache: {}, files: {} };
  if (opts.sheet1) store.tables['Sheet1'] = [];
  const shim = createShim(store);
  const clock = { now: new Date(opts.now || '2026-09-19T10:00:00Z') };
  const FakeDate = class extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now.getTime()); else super(...a); }
    static now() { return clock.now.getTime(); }
  };
  const g = Object.assign({ console, Date: FakeDate }, shim.globals);
  if (opts.server) {   // Api.gs-এর জন্য বাড়তি সার্ভিস
    g.ContentService = { MimeType: { JSON: 'JSON' }, createTextOutput: t => ({ text: t, setMimeType() { return this; }, getContent() { return t; } }) };
    g.Utilities = Object.assign({}, g.Utilities, {
      computeDigest: (alg, s) => Array.from(crypto.createHash('md5').update(String(s)).digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' }
    });
    g.DriveApp = Object.assign({}, g.DriveApp, {
      getFileById: id => ({
        setTrashed() { delete store.files[id]; },
        getBlob() { const f = store.files[id]; if (!f) throw new Error('not found'); return { getContentType: () => f.mime, getBytes: () => f.bytes }; }
      })
    });
  }
  const ctx = vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  if (opts.server) vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Api.gs'), 'utf8'), ctx, { filename: 'Api.gs' });
  const call = (fn, ...a) => vm.runInContext(fn, ctx)(...a);
  return { ctx, store, call, clock, setNow: iso => (clock.now = new Date(iso)), sheets: store.tables };
}

let fails = 0, passes = 0;
function ok(c, msg) { if (!c) { fails++; console.log('FAIL:', msg); } else { passes++; if (process.env.VERBOSE) console.log('ok  :', msg); } }
function eq(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); ok(x === y, msg + (x === y ? '' : ' => ' + x + ' expected ' + y)); }
function done(name) { console.log(name + ': ' + (fails ? 'FAILED ' + fails : 'ALL PASSED (' + passes + ' checks)')); process.exit(fails ? 1 : 0); }

module.exports = { makeEnv, ok, eq, done };
