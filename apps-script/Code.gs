/**
 * ==========================================================================
 *  Stock Management + POS  —  Code.gs   (Google Apps Script backend)
 *  Database : Google Sheets      Images : Google Drive
 *  Frontend : Index.html         Timezone: Asia/Dhaka
 * ==========================================================================
 *  প্রথমবার ব্যবহারের নিয়ম:
 *   1) Sheet থেকে Extensions > Apps Script খুলে এই ফাইলটি Code.gs-এ পেস্ট করুন
 *      এবং Index.html নামে একটি HTML ফাইল বানিয়ে সেখানে Index.html-এর কোড দিন।
 *   2) উপরের মেনু থেকে  setupDatabase  ফাংশনটি একবার Run করে অনুমতি (Authorize) দিন।
 *   3) (ঐচ্ছিক) importExcelProducts  Run করলে Excel-এর ৪২টি প্রোডাক্ট Products শিটে চলে আসবে।
 *   4) Deploy > New deployment > Web app
 *        Execute as : Me      |   Who has access : Only myself
 * ==========================================================================
 */

const APP_TITLE = 'স্টক ম্যানেজমেন্ট ও POS';
const TZ = 'Asia/Dhaka';
const SPREADSHEET_ID = '';        // Standalone script হলে এখানে Sheet ID দিতে পারেন। খালি থাকলে নিজে নিজে ঠিক করে নেবে।
const DB_VERSION = '2';   // ২: Products-এ 'Barcode Image ID / URL' কলাম যোগ
const DEFAULT_LOW_STOCK = 5;
const IMAGE_FOLDER_NAME = 'Stock App - Product Images';
const BARCODE_FOLDER_NAME = 'Stock App - Barcodes';

/** Google Sheets structure (কলামের ক্রম বদলাবেন না) */
const SHEETS = {
  Products: ['Product ID', 'Product Name', 'Category', 'Supplier', 'Size', 'Purchase Price', 'Cost',
             'Sales Price', 'Stock', 'Low Stock', 'Image ID', 'Image URL', 'Created Date', 'Barcode',
             'Barcode Image ID', 'Barcode Image URL'],
  Sales:    ['Sale ID', 'Date', 'Product ID', 'Product Name', 'Quantity', 'Sales Price', 'Discount',
             'Net Price', 'Total', 'Cost', 'Profit'],
  Expenses: ['Expense ID', 'Date', 'Category', 'Description', 'Amount'],
  Savings:  ['Saving ID', 'Date', 'Amount', 'Note'],
  Settings: ['Setting Name', 'Setting Value']
};
/** যে কলামগুলো Text হিসেবে থাকবে (Sheets যেন তারিখকে নিজে থেকে বদলে না ফেলে) */
const TEXT_COLS = { Products: [13, 14], Sales: [2], Expenses: [2], Savings: [2], Settings: [2] };

/* ------------------------------------------------------------------ */
/*  Web App entry                                                      */
/* ------------------------------------------------------------------ */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
class UserError extends Error {
  constructor(message) { super(message); this.name = 'UserError'; }
}

/** সব public ফাংশন এই wrapper দিয়ে চলে: সফল হলে {ok:true,data}, ব্যর্থ হলে {ok:false,error} */
function run_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e && e.name === 'UserError') return { ok: false, error: e.message };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, error: 'সার্ভারে সমস্যা হয়েছে: ' + (e && e.message ? e.message : e) };
  }
}

/** একসাথে দুইজন লিখলে যেন ডাটা এলোমেলো না হয় */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new UserError('সিস্টেম এখন ব্যস্ত, কিছুক্ষণ পর আবার চেষ্টা করুন');
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** সংখ্যা → বাংলা অঙ্ক (ব্যবহারকারীকে দেখানো বার্তার জন্য) */
function bn_(n) { return String(n).replace(/\d/g, function (d) { return '০১২৩৪৫৬৭৮৯'.charAt(Number(d)); }); }
function num_(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function round2_(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function str_(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
/** '=' '+' '-' '@' দিয়ে শুরু হলে Sheets যেন ফর্মুলা মনে না করে */
function safe_(s) { s = String(s == null ? '' : s); return /^[=+\-@]/.test(s) ? "'" + s : s; }

/* ---- অফলাইন সিঙ্কের জন্য ঘড়ি (ডিফল্টে আগের মতোই এখনকার সময়) ---- */
let __CLOCK_MS = null;
/** অফলাইনে করা লেনদেন সার্ভারে তোলার সময় আসল তারিখ/সময় বসাতে ব্যবহার হয়। null দিলে স্বাভাবিক ঘড়ি। */
function setClock_(ms) { __CLOCK_MS = ms ? Number(ms) : null; }
function clock_() { return __CLOCK_MS ? new Date(__CLOCK_MS) : new Date(); }
function todayStr_() { return Utilities.formatDate(clock_(), TZ, 'yyyy-MM-dd'); }
function nowStr_() { return Utilities.formatDate(clock_(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v == null ? '' : v).slice(0, 10);
}
function validDate_(s) {
  s = String(s || '').slice(0, 10);
  const d = new Date(s + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new UserError('তারিখ সঠিক নয়');
  }
  return s;
}

/** সংখ্যা যাচাই: opt = {min, positive, int} */
function numIn_(v, label, opt) {
  opt = opt || {};
  if (v === '' || v == null) throw new UserError(label + ' দিন');
  const n = Number(v);
  if (!isFinite(n)) throw new UserError(label + ' সঠিক সংখ্যা হতে হবে');
  if (opt.positive && n <= 0) throw new UserError(label + ' ০-এর বেশি হতে হবে');
  if (opt.min !== undefined && n < opt.min) throw new UserError(label + ' ' + bn_(opt.min) + '-এর কম হতে পারবে না');
  if (opt.int && Math.floor(n) !== n) throw new UserError(label + ' পূর্ণ সংখ্যা হতে হবে');
  if (Math.abs(n) > 1e9) throw new UserError(label + ' অস্বাভাবিক বড়');
  return n;
}

/** ID তৈরি: PRD-000001, SL-000001 ... */
function nextId_(prefix, ids) {
  let max = 0;
  ids.forEach(function (v) {
    const m = String(v).match(/(\d+)$/);
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  });
  return prefix + '-' + String(max + 1).padStart(6, '0');
}

/* ------------------------------------------------------------------ */
/*  Database (Google Sheets)                                           */
/* ------------------------------------------------------------------ */
let _ss = null;
let _dbChecked = false;

function getSS_() {
  if (_ss) return _ss;
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  if (SPREADSHEET_ID) {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } else {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
    if (!ss) {
      const id = props.getProperty('SPREADSHEET_ID');
      if (id) {
        ss = SpreadsheetApp.openById(id);
      } else {
        ss = SpreadsheetApp.create('Stock Management Database');
        ss.setSpreadsheetTimeZone(TZ);
        props.setProperty('SPREADSHEET_ID', ss.getId());
      }
    }
  }
  _ss = ss;
  return ss;
}

function ensureDb_(force) {
  const ss = getSS_();
  if (_dbChecked && !force) return ss;
  const props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('DB_READY') === DB_VERSION) { _dbChecked = true; return ss; }

  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setFontColor('#ffffff').setBackground('#0B2F33');
      sh.setFrozenRows(1);
    } else {
      // পুরোনো শিটে নতুন কলামের হেডার যোগ করা (ডাটা অক্ষত থাকে)
      const cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
      const fixed = cur.map(function (v, i) { return (v === '' || v == null) ? headers[i] : v; });
      if (fixed.some(function (v, i) { return v !== cur[i]; })) {
        sh.getRange(1, 1, 1, headers.length).setValues([fixed])
          .setFontWeight('bold').setFontColor('#ffffff').setBackground('#0B2F33');
      }
    }
    (TEXT_COLS[name] || []).forEach(function (c) {
      sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  // নতুন খালি ডিফল্ট শিট (Sheet1 ইত্যাদি) থাকলে মুছে ফেলা
  ss.getSheets().forEach(function (sh) {
    if (!SHEETS[sh.getName()] && /^(sheet|শিট|শীট)\s?\d*$/i.test(sh.getName()) &&
        sh.getLastRow() === 0 && ss.getSheets().length > 1) {
      try { ss.deleteSheet(sh); } catch (e) {}
    }
  });

  // Settings-এর ডিফল্ট সারি
  const st = ss.getSheetByName('Settings');
  if (st.getLastRow() < 2) {
    st.getRange(2, 1, 6, 2).setValues([
      ['ShopName', 'আমার দোকান'], ['ShopAddress', ''], ['LogoId', ''],
      ['LogoUrl', ''], ['OpeningBalance', ''], ['OpeningDate', '']
    ]);
  }
  props.setProperty('DB_READY', DB_VERSION);
  _dbChecked = true;
  return ss;
}

function sheet_(name) {
  const ss = ensureDb_(false);
  let sh = ss.getSheetByName(name);
  if (!sh) { ensureDb_(true); sh = ss.getSheetByName(name); }
  return sh;
}

/** ডাটা সারিগুলো (হেডার বাদে) পড়া */
function readRows_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SHEETS[name].length).getValues();
}
function readCol_(name, col) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, col, last - 1, 1).getValues().map(function (r) { return r[0]; });
}
function appendRows_(name, rows) {
  if (!rows.length) return;
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** Settings (key/value) */
function settingsMap_() {
  const m = {};
  readRows_('Settings').forEach(function (r) { if (r[0] !== '') m[String(r[0])] = r[1]; });
  return m;
}
function saveSettingsMap_(obj) {
  const sh = sheet_('Settings');
  const last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
  const idx = {};
  rows.forEach(function (r, i) { idx[String(r[0])] = i; });
  Object.keys(obj).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(idx, k)) rows[idx[k]][1] = obj[k];
    else { rows.push([k, obj[k]]); idx[k] = rows.length - 1; }
  });
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
}
function settingsView_() {
  const m = settingsMap_();
  const ob = m.OpeningBalance;
  return {
    shopName: String(m.ShopName || 'আমার দোকান'),
    shopAddress: String(m.ShopAddress || ''),
    logoId: String(m.LogoId || ''),
    openingBalance: (ob === '' || ob == null) ? '' : num_(ob),
    openingDate: m.OpeningDate ? dateStr_(m.OpeningDate) : '',
    spreadsheetUrl: getSS_().getUrl()
  };
}

/* ------------------------------------------------------------------ */
/*  Google Drive (Product image / Logo)                                */
/* ------------------------------------------------------------------ */
function getImageFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('IMAGE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const folder = DriveApp.createFolder(IMAGE_FOLDER_NAME);
  props.setProperty('IMAGE_FOLDER_ID', folder.getId());
  return folder;
}

/** img = {data: base64 (header ছাড়া), mime}  →  {id, url} */
function saveImage_(img, label) {
  const mime = String(img.mime || 'image/jpeg');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new UserError('শুধু ছবি (JPG / PNG / WEBP) আপলোড করা যাবে');
  const bytes = Utilities.base64Decode(String(img.data));
  if (bytes.length > 5 * 1024 * 1024) throw new UserError('ছবি ৫ MB-এর বেশি হতে পারবে না');
  const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : (mime === 'image/gif' ? 'gif' : 'jpg'));
  const blob = Utilities.newBlob(bytes, mime, String(label) + '_' + Date.now() + '.' + ext);
  const file = getImageFolder_().createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  const id = file.getId();
  return { id: id, url: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w400' };
}
function trashImage_(id) {
  try { if (id) DriveApp.getFileById(String(id)).setTrashed(true); } catch (e) {}
}

/* ------------------------------------------------------------------ */
/*  Barcode ছবি (Barcode.gs দিয়ে তৈরি → Drive-এ PNG ফাইল)                 */
/* ------------------------------------------------------------------ */
/** অফলাইন অ্যাপ ডিভাইসে এটা false করে রাখে — ছবির ফাইল সার্ভারে সিঙ্কের সময় তৈরি হয় */
let __BARCODE_FILES = true;
function setBarcodeFiles_(on) { __BARCODE_FILES = !!on; }

function getBarcodeFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BARCODE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const folder = DriveApp.createFolder(BARCODE_FOLDER_NAME);
  props.setProperty('BARCODE_FOLDER_ID', folder.getId());
  return folder;
}

/** value-এর জন্য বারকোড PNG বানিয়ে Drive-এ রাখে → {id, url} */
function makeBarcodeFile_(productId, value) {
  const blob = Utilities.newBlob(Utilities.base64Decode(barcodePngB64_(value)), 'image/png',
    String(productId) + '_' + barcodeSafeName_(value) + '.png');
  const file = getBarcodeFolder_().createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  const id = file.getId();
  return { id: id, url: 'https://drive.google.com/uc?export=view&id=' + id };
}
/** Drive-এ সমস্যা হলেও প্রোডাক্ট সেভ আটকাবে না */
function safeBarcodeFile_(productId, value) {
  try { return makeBarcodeFile_(productId, value); }
  catch (e) { console.error('barcode file: ' + e); return { id: '', url: '' }; }
}

/* ------------------------------------------------------------------ */
/*  Products / Stock                                                   */
/* ------------------------------------------------------------------ */
function productFromRow_(r) {
  return {
    id: String(r[0]), name: String(r[1]), category: String(r[2] || ''), supplier: String(r[3] || ''),
    size: String(r[4] || ''), purchase: num_(r[5]), cost: num_(r[6]), price: num_(r[7]),
    stock: num_(r[8]), low: num_(r[9]), imageId: String(r[10] || ''), created: String(r[12] || ''),
    barcode: String(r[13] || '')
  };
}
function productsList_() {
  return readRows_('Products').filter(function (r) { return r[0] !== ''; }).map(productFromRow_);
}

/** ফর্মের ডাটা যাচাই ও পরিষ্কার করা */
function validateProduct_(p, forCreate) {
  const d = {
    name: str_(p.name, 150),
    category: str_(p.category, 80),
    supplier: str_(p.supplier, 100),
    size: str_(p.size, 50),
    barcode: str_(p.barcode, 60)
  };
  if (!d.name) throw new UserError('প্রোডাক্টের নাম দিন');
  d.purchase = numIn_(p.purchase, 'ক্রয়মূল্য', { min: 0 });
  d.cost = (p.cost === '' || p.cost == null) ? 0 : numIn_(p.cost, 'অতিরিক্ত খরচ', { min: 0 });
  d.price = numIn_(p.price, 'বিক্রয়মূল্য', { min: 0 });
  d.low = (p.low === '' || p.low == null) ? DEFAULT_LOW_STOCK : numIn_(p.low, 'লো স্টক লিমিট', { min: 0, int: true });
  if (forCreate) d.stock = numIn_(p.stock, 'স্টক', { min: 0, int: true });
  return d;
}

function getProducts() {
  return run_(function () { return productsList_(); });
}

function createProduct(p) {
  return run_(function () {
    return withLock_(function () {
      p = p || {};
      const d = validateProduct_(p, true);
      const rows = readRows_('Products');
      if (d.barcode && rows.some(function (r) { return String(r[13]) === d.barcode; })) {
        throw new UserError('এই বারকোড অন্য একটি প্রোডাক্টে ব্যবহার হয়েছে');
      }
      const id = nextId_('PRD', rows.map(function (r) { return r[0]; }));
      let imageId = '', imageUrl = '';
      if (p.image && p.image.data) {
        const img = saveImage_(p.image, id);
        imageId = img.id; imageUrl = img.url;
      }
      const barcode = d.barcode || id;               // ফাঁকা থাকলে প্রোডাক্ট আইডিই বারকোড
      const bc = __BARCODE_FILES ? safeBarcodeFile_(id, barcode) : { id: '', url: '' };
      const raw = [id, d.name, d.category, d.supplier, d.size, d.purchase, d.cost, d.price, d.stock,
                   d.low, imageId, imageUrl, nowStr_(), barcode, bc.id, bc.url];
      appendRows_('Products', [textSafe_(raw)]);
      return productFromRow_(raw);
    });
  });
}

function updateProduct(p) {
  return run_(function () {
    return withLock_(function () {
      p = p || {};
      const rows = readRows_('Products');
      const i = rows.findIndex(function (r) { return String(r[0]) === String(p.id); });
      if (i < 0) throw new UserError('প্রোডাক্ট পাওয়া যায়নি');
      const d = validateProduct_(p, false);
      if (d.barcode && rows.some(function (r, k) { return k !== i && String(r[13]) === d.barcode; })) {
        throw new UserError('এই বারকোড অন্য একটি প্রোডাক্টে ব্যবহার হয়েছে');
      }
      const old = rows[i];
      let imageId = String(old[10] || ''), imageUrl = String(old[11] || '');
      if (p.image && p.image.data) {
        const img = saveImage_(p.image, old[0]);
        if (imageId) trashImage_(imageId);
        imageId = img.id; imageUrl = img.url;
      }
      // স্টক এখানে বদলায় না — শুধু বিক্রি বা Stock Update দিয়ে বদলায়
      // বারকোড: বদলালে (বা ছবি না থাকলে) নতুন ছবি তৈরি
      const barcode = d.barcode || String(old[0]);
      const oldBarcode = String(old[13] || '') || String(old[0]);
      let bcId = String(old[14] || ''), bcUrl = String(old[15] || '');
      if (__BARCODE_FILES && (barcode !== oldBarcode || !bcId)) {
        const bc = safeBarcodeFile_(old[0], barcode);
        if (bc.id) { if (bcId) trashImage_(bcId); bcId = bc.id; bcUrl = bc.url; }
      }
      const raw = [old[0], d.name, d.category, d.supplier, d.size, d.purchase, d.cost, d.price, old[8],
                   d.low, imageId, imageUrl, old[12], barcode, bcId, bcUrl];
      sheet_('Products').getRange(i + 2, 1, 1, raw.length).setValues([textSafe_(raw)]);
      return productFromRow_(raw);
    });
  });
}

/** Products সারির টেক্সট ঘরগুলো (নাম, ক্যাটাগরি, সাপ্লায়ার, সাইজ) ফর্মুলা-নিরাপদ করা */
function textSafe_(raw) {
  return raw.map(function (v, k) { return (k >= 1 && k <= 4) ? safe_(v) : v; });
}

/** delta > 0 হলে স্টক যোগ, delta < 0 হলে সংশোধন (কমানো)। স্টক কখনো নেগেটিভ হবে না। */
function updateStock(productId, delta) {
  return run_(function () {
    return withLock_(function () {
      const d = Number(delta);
      if (!isFinite(d) || d === 0 || Math.floor(d) !== d || Math.abs(d) > 1000000) {
        throw new UserError('সঠিক পূর্ণ সংখ্যা দিন');
      }
      const rows = readRows_('Products');
      const i = rows.findIndex(function (r) { return String(r[0]) === String(productId); });
      if (i < 0) throw new UserError('প্রোডাক্ট পাওয়া যায়নি');
      const cur = num_(rows[i][8]);
      const next = cur + d;
      if (next < 0) throw new UserError('পর্যাপ্ত স্টক নেই (বর্তমান স্টক ' + bn_(cur) + ')');
      sheet_('Products').getRange(i + 2, 9).setValue(next);
      return { id: String(rows[i][0]), stock: next };
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Sales / POS                                                        */
/* ------------------------------------------------------------------ */
/** এক লাইনের হিসাব: ডিসকাউন্ট (৳ বা %) → Net Price → Total */
function calcLine_(price, qty, dtype, disc) {
  let d = Number(disc);
  if (!isFinite(d) || d < 0) d = 0;
  let per = dtype === 'percent' ? price * Math.min(d, 100) / 100 : Math.min(d, price);
  per = round2_(per);
  const net = round2_(price - per);
  return { per: per, net: net, total: round2_(net * qty) };
}

/**
 * payload = { token, items: [{id, qty, disc, dtype}] }
 * দাম ও খরচ সবসময় সার্ভারের Products শিট থেকে নেওয়া হয় (ক্লায়েন্টের দাম বিশ্বাস করা হয় না)।
 * একই token দুইবার এলে দ্বিতীয়বার Sale সেভ হয় না।
 */
function createSale(payload) {
  return run_(function () {
    return withLock_(function () {
      payload = payload || {};
      const token = str_(payload.token, 80);
      if (!token) throw new UserError('অবৈধ অনুরোধ, পেজ রিলোড করুন');
      const cache = CacheService.getScriptCache();
      const key = 'sale_' + token;
      const prev = cache.get(key);
      if (prev) { const old = JSON.parse(prev); old.duplicate = true; return old; }

      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) throw new UserError('কার্ট খালি আছে');
      if (items.length > 100) throw new UserError('একসাথে সর্বোচ্চ ১০০টি আইটেম বিক্রি করা যাবে');

      const prow = readRows_('Products');
      const index = new Map();
      prow.forEach(function (r, i) { if (r[0] !== '') index.set(String(r[0]), i); });

      // ১) সার্ভার-সাইড যাচাই (প্রোডাক্ট আছে কিনা + স্টক যথেষ্ট কিনা)
      const need = new Map();
      items.forEach(function (it) {
        const id = String(it.id);
        if (!index.has(id)) throw new UserError('প্রোডাক্ট পাওয়া যায়নি: ' + id);
        const q = Number(it.qty);
        if (!isFinite(q) || q < 1 || Math.floor(q) !== q) throw new UserError('পরিমাণ সঠিক নয়');
        need.set(id, (need.get(id) || 0) + q);
      });
      need.forEach(function (q, id) {
        const r = prow[index.get(id)];
        if (q > num_(r[8])) {
          throw new UserError('পর্যাপ্ত স্টক নেই: ' + r[1] + ' (স্টকে আছে ' + bn_(num_(r[8])) + ' টি)');
        }
      });

      // ২) হিসাব ও Sales সারি তৈরি
      const now = nowStr_();
      const saleId = nextId_('SL', readCol_('Sales', 1));
      const rows = [], lines = [];
      let subtotal = 0, discountTotal = 0, total = 0;
      items.forEach(function (it) {
        const r = prow[index.get(String(it.id))];
        const qty = Number(it.qty), price = num_(r[7]);
        const c = calcLine_(price, qty, it.dtype, it.disc);
        const cost = round2_((num_(r[5]) + num_(r[6])) * qty);   // ক্রয়মূল্য + অতিরিক্ত খরচ
        const profit = round2_(c.total - cost);
        rows.push([saleId, now, String(r[0]), safe_(r[1]), qty, price, c.per, c.net, c.total, cost, profit]);
        lines.push({ id: String(r[0]), name: String(r[1]), qty: qty, price: price, discount: c.per, net: c.net, total: c.total });
        subtotal += price * qty; discountTotal += c.per * qty; total += c.total;
      });

      // ৩) Sale সেভ → স্টক কমানো
      appendRows_('Sales', rows);
      const stock = {};
      const pSheet = sheet_('Products');
      need.forEach(function (q, id) {
        const i = index.get(id);
        const left = num_(prow[i][8]) - q;
        pSheet.getRange(i + 2, 9).setValue(left);
        stock[id] = left;
      });

      const result = {
        saleId: saleId, date: now, items: lines, subtotal: round2_(subtotal),
        discount: round2_(discountTotal), total: round2_(total), stock: stock
      };
      cache.put(key, JSON.stringify(result), 21600);
      return result;
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Expense                                                            */
/* ------------------------------------------------------------------ */
function createExpense(e) {
  return run_(function () {
    return withLock_(function () {
      e = e || {};
      const date = e.date ? validDate_(e.date) : todayStr_();
      const category = str_(e.category, 80);
      if (!category) throw new UserError('খরচের নাম / ক্যাটাগরি দিন');
      const description = str_(e.description, 300);
      const amount = round2_(numIn_(e.amount, 'খরচের পরিমাণ', { positive: true }));
      const id = nextId_('EXP', readCol_('Expenses', 1));
      appendRows_('Expenses', [[id, date, safe_(category), safe_(description), amount]]);
      return { id: id, date: date, category: category, description: description, amount: amount };
    });
  });
}

function getExpenses() {
  return run_(function () {
    const today = todayStr_(), month = today.slice(0, 7);
    let tToday = 0, tMonth = 0;
    const list = [], cats = {};
    readRows_('Expenses').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]), a = num_(r[4]);
      if (d === today) tToday += a;
      if (d.slice(0, 7) === month) tMonth += a;
      if (r[2]) cats[String(r[2])] = 1;
      list.push({ id: String(r[0]), date: d, category: String(r[2]), description: String(r[3]), amount: a });
    });
    list.sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); });
    return { today: round2_(tToday), month: round2_(tMonth), items: list.slice(0, 100), categories: Object.keys(cats) };
  });
}

/* ------------------------------------------------------------------ */
/*  Savings                                                            */
/* ------------------------------------------------------------------ */
function createSaving(s) {
  return run_(function () {
    return withLock_(function () {
      s = s || {};
      const date = s.date ? validDate_(s.date) : todayStr_();
      const amount = round2_(numIn_(s.amount, 'সঞ্চয়ের পরিমাণ', { positive: true }));
      const note = str_(s.note, 300);
      const id = nextId_('SAV', readCol_('Savings', 1));
      appendRows_('Savings', [[id, date, amount, safe_(note)]]);
      return { id: id, date: date, amount: amount, note: note };
    });
  });
}

function getSavings() {
  return run_(function () {
    const today = todayStr_(), month = today.slice(0, 7);
    let tToday = 0, tMonth = 0, tAll = 0;
    const list = [];
    readRows_('Savings').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]), a = num_(r[2]);
      tAll += a;
      if (d === today) tToday += a;
      if (d.slice(0, 7) === month) tMonth += a;
      list.push({ id: String(r[0]), date: d, amount: a, note: String(r[3] || '') });
    });
    list.sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); });
    return { today: round2_(tToday), month: round2_(tMonth), total: round2_(tAll), items: list.slice(0, 100) };
  });
}

/* ------------------------------------------------------------------ */
/*  Dashboard  (Balance / Cash / Profit হিসাব)                          */
/* ------------------------------------------------------------------ */
/**
 *  Opening Balance (আজ) = সেট করা প্রারম্ভিক ব্যালেন্স + [শুরুর তারিখ থেকে গতকাল পর্যন্ত] বিক্রি − খরচ
 *                       (অর্থাৎ গতকালের Closing Balance স্বয়ংক্রিয়ভাবে আজকের Opening)
 *  Balance         = Opening + আজকের বিক্রি − আজকের খরচ
 *  Profit          = (Net Sales − Product Cost) − Expense
 *  Cash            = Balance − মোট সঞ্চয়   (সঞ্চয়ে সরিয়ে রাখা টাকা ক্যাশ থেকে বাদ)
 */
function computeDashboard_() {
  const today = todayStr_(), month = today.slice(0, 7);
  const st = settingsMap_();
  const openingSet = !(st.OpeningBalance === '' || st.OpeningBalance == null);
  const initial = num_(st.OpeningBalance);
  const start = st.OpeningDate ? dateStr_(st.OpeningDate) : today;

  let sT = 0, cT = 0, qT = 0, sM = 0, cM = 0, sB = 0;
  readRows_('Sales').forEach(function (r) {
    if (r[0] === '') return;
    const d = dateStr_(r[1]), total = num_(r[8]), cost = num_(r[9]);
    if (d === today) { sT += total; cT += cost; qT += num_(r[4]); }
    if (d.slice(0, 7) === month) { sM += total; cM += cost; }
    if (d >= start && d < today) sB += total;
  });

  let eT = 0, eM = 0, eB = 0;
  readRows_('Expenses').forEach(function (r) {
    if (r[0] === '') return;
    const d = dateStr_(r[1]), a = num_(r[4]);
    if (d === today) eT += a;
    if (d.slice(0, 7) === month) eM += a;
    if (d >= start && d < today) eB += a;
  });

  let vT = 0, vM = 0, vAll = 0;
  readRows_('Savings').forEach(function (r) {
    if (r[0] === '') return;
    const d = dateStr_(r[1]), a = num_(r[2]);
    vAll += a;
    if (d === today) vT += a;
    if (d.slice(0, 7) === month) vM += a;
  });

  const opening = initial + sB - eB;
  const balance = opening + sT - eT;
  return {
    today: today, openingSet: openingSet, openingDate: start,
    opening: round2_(opening),
    salesToday: round2_(sT), qtyToday: qT, expenseToday: round2_(eT),
    productProfitToday: round2_(sT - cT), profitToday: round2_(sT - cT - eT),
    balance: round2_(balance),
    salesMonth: round2_(sM), expenseMonth: round2_(eM),
    productProfitMonth: round2_(sM - cM), profitMonth: round2_(sM - cM - eM),
    cash: round2_(balance - vAll),
    savingsToday: round2_(vT), savingsMonth: round2_(vM), savingsTotal: round2_(vAll)
  };
}

function getDashboardData() {
  return run_(function () { return computeDashboard_(); });
}

function addDays_(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * দিনভিত্তিক ক্যাশ বুক: প্রারম্ভিক → বিক্রি → খরচ → শেষ ব্যালেন্স → সঞ্চয় → ক্যাশ।
 * শুধু যেসব দিনে লেনদেন হয়েছে (এবং আজ) সেগুলো দেখায়, নতুন দিন আগে।
 */
function getCashBook(days) {
  return run_(function () {
    const today = todayStr_();
    const st = settingsMap_();
    const initial = num_(st.OpeningBalance);
    const start = st.OpeningDate ? dateStr_(st.OpeningDate) : today;
    const sales = {}, exp = {}, sav = {};
    let savBefore = 0;
    readRows_('Sales').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]);
      if (d >= start && d <= today) sales[d] = (sales[d] || 0) + num_(r[8]);
    });
    readRows_('Expenses').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]);
      if (d >= start && d <= today) exp[d] = (exp[d] || 0) + num_(r[4]);
    });
    readRows_('Savings').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]), a = num_(r[2]);
      if (d < start) savBefore += a;
      else if (d <= today) sav[d] = (sav[d] || 0) + a;
    });
    const rows = [];
    let open = initial, cum = savBefore, d = start, guard = 0;
    while (d <= today && guard++ < 4000) {
      const s = round2_(sales[d] || 0), e = round2_(exp[d] || 0), v = round2_(sav[d] || 0);
      cum += v;
      const close = round2_(open + s - e);
      if (s || e || v || d === today) {
        rows.push({ date: d, opening: round2_(open), sales: s, expense: e, closing: close, savings: v, cash: round2_(close - cum) });
      }
      open = close;
      d = addDays_(d, 1);
    }
    rows.reverse();
    const n = Math.min(Math.max(Math.floor(Number(days)) || 31, 1), 366);
    return { openingSet: !(st.OpeningBalance === '' || st.OpeningBalance == null), start: start, rows: rows.slice(0, n), total: rows.length };
  });
}

/** অ্যাপ খোলার সময় একবারে সব দরকারি ডাটা (দ্রুত লোডের জন্য) */
function getAppData() {
  return run_(function () {
    return { settings: settingsView_(), products: productsList_(), dashboard: computeDashboard_(), today: todayStr_() };
  });
}

/* ------------------------------------------------------------------ */
/*  Reports                                                            */
/* ------------------------------------------------------------------ */
function getReports(from, to) {
  return run_(function () {
    const today = todayStr_(), month = today.slice(0, 7);
    from = from ? validDate_(from) : month + '-01';
    to = to ? validDate_(to) : today;
    if (from > to) { const t = from; from = to; to = t; }

    let todaySales = 0, monthSales = 0, tSales = 0, tCost = 0;
    const sales = [], top = {};
    readRows_('Sales').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]), total = num_(r[8]);
      if (d === today) todaySales += total;
      if (d.slice(0, 7) === month) monthSales += total;
      if (d < from || d > to) return;
      const cost = num_(r[9]), qty = num_(r[4]), pid = String(r[2]);
      tSales += total; tCost += cost;
      sales.push({ saleId: String(r[0]), date: String(r[1]), productId: pid, name: String(r[3]), qty: qty,
                   price: num_(r[5]), discount: num_(r[6]), net: num_(r[7]), total: total });
      if (!top[pid]) top[pid] = { id: pid, name: String(r[3]), qty: 0, amount: 0, profit: 0 };
      top[pid].qty += qty; top[pid].amount += total; top[pid].profit += total - cost;
    });

    let tExpense = 0;
    const expenses = [];
    readRows_('Expenses').forEach(function (r) {
      if (r[0] === '') return;
      const d = dateStr_(r[1]);
      if (d < from || d > to) return;
      const a = num_(r[4]);
      tExpense += a;
      expenses.push({ id: String(r[0]), date: d, category: String(r[2]), description: String(r[3]), amount: a });
    });
    expenses.sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); });
    sales.reverse();

    const topList = Object.keys(top).map(function (k) {
      const t = top[k]; t.amount = round2_(t.amount); t.profit = round2_(t.profit); return t;
    }).sort(function (a, b) { return b.qty - a.qty || b.amount - a.amount; }).slice(0, 15);

    const productProfit = tSales - tCost;
    return {
      from: from, to: to,
      todaySales: round2_(todaySales), monthSales: round2_(monthSales),
      summary: {
        sales: round2_(tSales), cost: round2_(tCost), productProfit: round2_(productProfit),
        expense: round2_(tExpense), netProfit: round2_(productProfit - tExpense)
      },
      salesCount: sales.length, salesTruncated: sales.length > 2000, sales: sales.slice(0, 2000),
      top: topList, expenses: expenses.slice(0, 2000)
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */
function getSettings() {
  return run_(function () { return settingsView_(); });
}

/** শুধু যে key-গুলো পাঠানো হবে সেগুলোই বদলাবে */
function saveSettings(s) {
  return run_(function () {
    return withLock_(function () {
      s = s || {};
      const upd = {};
      if ('shopName' in s) {
        const v = str_(s.shopName, 80);
        if (!v) throw new UserError('দোকানের নাম দিন');
        upd.ShopName = safe_(v);
      }
      if ('shopAddress' in s) upd.ShopAddress = safe_(str_(s.shopAddress, 200));
      if (s.logo && s.logo.data) {
        const oldLogo = settingsMap_().LogoId;
        const img = saveImage_(s.logo, 'logo');
        upd.LogoId = img.id; upd.LogoUrl = img.url;
        if (oldLogo) trashImage_(oldLogo);
      }
      if ('openingBalance' in s) {
        const amount = numIn_(s.openingBalance, 'প্রারম্ভিক ব্যালেন্স', { min: 0 });
        upd.OpeningBalance = String(round2_(amount));
        upd.OpeningDate = s.openingDate ? validDate_(s.openingDate) : todayStr_();
      }
      saveSettingsMap_(upd);
      return settingsView_();
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Barcode: ছবি নেওয়া / Google Sheets-এ সব প্রোডাক্টের বারকোড তৈরি          */
/* ------------------------------------------------------------------ */
/** একটি প্রোডাক্টের (আইডি বা বারকোড দিয়ে) বারকোড ছবি — PNG base64। অফলাইনেও কাজ করে (ডাউনলোড/প্রিন্টের জন্য) */
function getBarcodeImage(key) {
  return run_(function () {
    const k = str_(key, 80);
    if (!k) throw new UserError('প্রোডাক্ট আইডি বা বারকোড দিন');
    const p = productsList_().find(function (x) { return x.id === k || x.barcode === k; });
    const value = p ? (p.barcode || p.id) : k;
    return {
      value: value, productId: p ? p.id : '', name: p ? p.name : '', mime: 'image/png',
      b64: barcodePngB64_(value),
      filename: (p ? p.id + '_' : '') + barcodeSafeName_(value) + '.png'
    };
  });
}

/**
 * Google Sheets-এর জন্য বারকোড ছবি তৈরি (Apps Script Editor বা Sheet-এর মেনু "রিপন স্টক" থেকে Run করুন)।
 *   generateBarcodes()      → যেসব প্রোডাক্টের বারকোড ছবি নেই শুধু সেগুলো
 *   generateBarcodes(true)  → সবগুলো নতুন করে
 * কী হয়:
 *   ১) ফাঁকা "Barcode" ঘরে প্রোডাক্ট আইডি বসে
 *   ২) প্রতিটি প্রোডাক্টের আলাদা PNG ছবি Drive-এর "Stock App - Barcodes" ফোল্ডারে জমা হয়
 *   ৩) Products শিটে "Barcode Image ID / URL" ভরে যায়
 *   ৪) "Barcodes" শিটে প্রতিটি ছবি দেখা যায় (=IMAGE) এবং ডাউনলোড লিংক থাকে
 */
function generateBarcodes(force) {
  ensureDb_(false);
  const started = Date.now(), LIMIT_MS = 4.5 * 60 * 1000;
  const sh = sheet_('Products'), last = sh.getLastRow();
  let made = 0, kept = 0, left = 0;
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, SHEETS.Products.length).getValues();
    for (let i = 0; i < vals.length; i++) {
      const r = vals[i];
      if (r[0] === '') continue;
      const value = String(r[13] || '').trim() || String(r[0]);
      if (!force && r[14] && r[13]) { kept++; continue; }
      if (Date.now() - started > LIMIT_MS) { left++; continue; }     // সময় শেষ — আবার Run করলে বাকিগুলো হবে
      const bc = makeBarcodeFile_(r[0], value);
      if (r[14]) trashImage_(r[14]);
      sh.getRange(i + 2, 14, 1, 3).setValues([[value, bc.id, bc.url]]);
      made++;
    }
  }
  buildBarcodeSheet_();
  const msg = 'বারকোড ছবি: নতুন ' + made + 'টি, আগে থেকেই ছিল ' + kept + 'টি' + (left ? ', সময় শেষ — ' + left + 'টির জন্য আবার Run করুন' : '');
  Logger.log(msg);
  return { made: made, kept: kept, left: left, message: msg };
}

/** "Barcodes" শিট: ছবি + ডাউনলোড লিংক (Products শিট থেকে প্রতিবার নতুন করে বানানো হয়) */
function buildBarcodeSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName('Barcodes');
  if (!sh) sh = ss.insertSheet('Barcodes'); else sh.clear();
  const head = ['Product ID', 'Product Name', 'Barcode', 'Barcode Image', 'Download'];
  const rows = readRows_('Products').filter(function (r) { return r[0] !== ''; }).map(function (r) {
    const url = String(r[15] || ''), fid = String(r[14] || '');
    return [String(r[0]), safe_(String(r[1])), String(r[13] || r[0]),
      url ? '=IMAGE("' + url + '")' : '',
      fid ? '=HYPERLINK("https://drive.google.com/uc?export=download&id=' + fid + '","ডাউনলোড")' : ''];
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#0B2F33');
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.setRowHeights(2, rows.length, 90);
  }
  sh.setColumnWidth(1, 110); sh.setColumnWidth(2, 240); sh.setColumnWidth(3, 150);
  sh.setColumnWidth(4, 320); sh.setColumnWidth(5, 100);
}

/** Google Sheet খুললে উপরে "রিপন স্টক" মেনু যোগ করে */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('রিপন স্টক')
      .addItem('বারকোড ছবি তৈরি (যেগুলো নেই)', 'menuBarcodesNew')
      .addItem('সব বারকোড নতুন করে তৈরি', 'menuBarcodesAll')
      .addToUi();
  } catch (e) { /* মেনু ছাড়াও ফাংশন চালানো যায় */ }
}
function menuBarcodesNew() { SpreadsheetApp.getActive().toast(generateBarcodes(false).message, 'বারকোড', 8); }
function menuBarcodesAll() { SpreadsheetApp.getActive().toast(generateBarcodes(true).message, 'বারকোড', 8); }

/* ------------------------------------------------------------------ */
/*  এককালীন সেটআপ ফাংশন (Apps Script Editor থেকে Run করুন)              */
/* ------------------------------------------------------------------ */
function setupDatabase() {
  ensureDb_(true);
  getImageFolder_();
  Logger.log('Database প্রস্তুত: ' + getSS_().getUrl());
}

/**
 * Excel ফাইলের (Ripon Stock Management.xlsx) ৪২টি প্রোডাক্ট একবারে Products শিটে আনার জন্য।
 * শুধু Products শিট খালি থাকলেই কাজ করবে (দুইবার Run করলেও ডুপ্লিকেট হবে না)।
 * [নাম, স্টক, ক্রয়মূল্য, বিক্রয়মূল্য]  —  ক্যাটাগরি: ঘড়ি, লো স্টক লিমিট: ৫
 */
const EXCEL_PRODUCTS = [
  ["Toy বেবি ঘড়ি", 48, 27, 35],
  ["বেন টেন বেবি", 20, 38, 45],
  ["LED পেটে লাইট ঘড়ি", 6, 75, 90],
  ["আর্মি বেবি ঘড়ি", 16, 45, 55],
  ["স্কেল বেবি ঘড়ি", 23, 55, 65],
  ["মিউজিক বেবি ঘড়ি", 51, 60, 70],
  ["চরকি মিউজিক বেবি", 14, 110, 130],
  ["আপেল টাচ চারকোনা", 19, 65, 75],
  ["আপেল টাচ গোল", 26, 65, 75],
  ["আপেল টাচ বেবি", 16, 55, 70],
  ["রাডো লেডিস", 16, 65, 75],
  ["আরবী সাদা+কালো", 22, 140, 160],
  ["স্পোর্টস কার্ট ঘড়ি", 20, 90, 110],
  ["লেডিস ফিতা ঘড়ি", 13, 140, 160],
  ["লেডিস চেইন", 19, 170, 190],
  ["লেডিস চেইন", 8, 150, 170],
  ["ধান চেইন লেডিস", 15, 110, 130],
  ["লেডিস মোটা চেইন", 19, 140, 160],
  ["লেডিস চেইন", 2, 130, 150],
  ["লেডিস লাভ চেইন", 3, 330, 370],
  ["লেডিস পাথর টাচ", 16, 100, 105],
  ["জালি চেইন সোনালি+কালো", 24, 110, 130],
  ["কাপড় ফিতা ঘড়ি", 19, 90, 110],
  ["লেদার ফিতা টাইটেন", 20, 80, 95],
  ["টাইটেল প্লাস্টিক ফিতা", 12, 80, 90],
  ["Curren প্লাস্টিক ফিতা বড়", 5, 90, 110],
  ["প্লাস্টিক ফিতা মেগনেট লক", 3, 200, 230],
  ["লাসিকা কমা LED", 24, 180, 200],
  ["লেডিস টাচ কালো ফিতার", 5, 100, 120],
  ["গোল টাচ", 5, 100, 120],
  ["লেদার ফিতা দামি", 2, 160, 180],
  ["সাদা চেইন", 4, 160, 180],
  ["Rolex কমা চেইন ঘড়ি", 3, 250, 280],
  ["চেইন", 2, 300, 330],
  ["চেইন ঘড়ি", 5, 350, 400],
  ["আস্তর রিচার্জ", 3, 420, 500],
  ["Rolex দামি চেইন", 3, 500, 550],
  ["Sports ছোট লাসিকা", 6, 180, 210],
  ["লাসিকা big", 6, 230, 260],
  ["লাসিকা 157 LED", 6, 255, 280],
  ["T 800 smart", 1, 400, 450],
  ["T 900 smart", 1, 400, 450],
];

function importExcelProducts() {
  withLock_(function () {
    const sh = sheet_('Products');
    if (sh.getLastRow() > 1) throw new Error('Products শিটে আগে থেকেই ডাটা আছে, তাই ইমপোর্ট করা হয়নি।');
    const now = nowStr_();
    const rows = EXCEL_PRODUCTS.map(function (p, i) {
      const id = 'PRD-' + String(i + 1).padStart(6, '0');
      return [id, p[0], 'ঘড়ি', '', '', p[2], 0, p[3], p[1],
              DEFAULT_LOW_STOCK, '', '', now, id, '', ''];      // বারকোড = আইডি; ছবি পরে generateBarcodes() দিয়ে
    });
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log(rows.length + 'টি প্রোডাক্ট ইমপোর্ট হয়েছে। এবার generateBarcodes ফাংশন Run করে বারকোড ছবি বানান।');
  });
}
