/**
 * ==========================================================================
 *  Api.gs  —  অফলাইন অ্যাপের (GitHub / PWA) জন্য JSON API
 *  Code.gs-এর কোনো ফাংশন এখানে বদলানো বা কপি করা হয়নি — শুধু সেগুলোকেই ডাকা হয়।
 * ==========================================================================
 *  ব্যবহারের নিয়ম:
 *   1) এই ফাইলটি Apps Script প্রজেক্টে (Code.gs-এর পাশে) নতুন ফাইল হিসেবে যোগ করুন।
 *   2) generateApiKey ফাংশনটি একবার Run করুন → Execution log-এ আপনার গোপন API Key দেখা যাবে।
 *   3) Deploy > New deployment (বা Manage deployments > Edit > New version) > Web app
 *        Execute as : Me      |   Who has access : Anyone
 *      (Anyone দিতে হয় কারণ অ্যাপটি github.io থেকে ডাকে; নিরাপত্তা দেয় API Key)
 *   4) “Web app URL” + API Key অ্যাপে একবার বসিয়ে দিন।
 * ==========================================================================
 */

const SYNC_SHEET = 'SyncOps';
const SYNC_KEEP = 4000;
/**
 * অফলাইন থেকে শুধু এই ফাংশনগুলোই সার্ভারে চালানো যাবে (সবই Code.gs-এর আগের ফাংশন)।
 * ফাইল লোডের ক্রম যাই হোক, যেন সমস্যা না হয় তাই ফাংশনের ভেতরে তৈরি করা হয়।
 */
function syncFuncs_() {
  return {
    createProduct: createProduct,
    updateProduct: updateProduct,
    updateStock: updateStock,
    createSale: createSale,
    createExpense: createExpense,
    createSaving: createSaving,
    saveSettings: saveSettings
  };
}

/* ------------------------------------------------------------------ */
/*  এককালীন সেটআপ                                                     */
/* ------------------------------------------------------------------ */
/** নতুন গোপন API Key বানায় ও Script Properties-এ রাখে। Execution log থেকে Key কপি করুন। */
function generateApiKey() {
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  Logger.log('আপনার API Key (এটি গোপন রাখুন): ' + key);
  return key;
}

/* ------------------------------------------------------------------ */
/*  Web App entry (POST)                                               */
/* ------------------------------------------------------------------ */
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (err) {
    return apiOut_({ ok: false, error: 'অনুরোধটি সঠিক নয়' });
  }
  const saved = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!saved) return apiOut_({ ok: false, code: 'NOKEY', error: 'সার্ভারে API Key সেট করা হয়নি — Apps Script এডিটরে generateApiKey চালান' });
  if (!req || String(req.key || '') !== saved) return apiOut_({ ok: false, code: 'AUTH', error: 'API Key ভুল' });

  try {
    switch (req.action) {
      case 'ping':     return apiOut_({ ok: true, data: { pong: true, at: nowStr_() } });
      case 'snapshot': return apiOut_({ ok: true, data: { snapshot: snapshot_() } });
      case 'sync':     return apiOut_(syncAction_(req));
      case 'images':   return apiOut_({ ok: true, data: { images: imagesAction_(req.ids) } });
      case 'barcodes': return apiOut_(barcodesAction_(req));
      default:         return apiOut_({ ok: false, error: 'অজানা action' });
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return apiOut_({ ok: false, error: 'সার্ভারে সমস্যা: ' + (err && err.message ? err.message : err) });
  }
}

function apiOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/*  Snapshot: ডাটাবেসের পুরো কপি (অফলাইন অ্যাপ এটাই স্থানীয়ভাবে রাখে)   */
/* ------------------------------------------------------------------ */
function snapshot_() {
  ensureDb_(false);
  const tables = {};
  Object.keys(SHEETS).forEach(function (name) {
    tables[name] = sheet_(name).getDataRange().getValues().map(function (row) {
      return row.map(function (v) {
        return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : v;
      });
    });
  });
  const props = PropertiesService.getScriptProperties();
  const body = {
    tables: tables,
    props: { DB_READY: props.getProperty('DB_READY') || DB_VERSION, IMAGE_FOLDER_ID: props.getProperty('IMAGE_FOLDER_ID') || '' },
    sheetUrl: getSS_().getUrl()
  };
  const json = JSON.stringify(body);
  body.hash = hash_(json);
  return body;
}

function hash_(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* ------------------------------------------------------------------ */
/*  Sync: অফলাইনে জমে থাকা কাজগুলো একই ফাংশন দিয়ে সার্ভারে চালানো      */
/* ------------------------------------------------------------------ */
function syncAction_(req) {
  const ops = Array.isArray(req.ops) ? req.ops : [];
  if (ops.length > 40) return { ok: false, error: 'একবারে সর্বোচ্চ ৪০টি কাজ পাঠানো যায়' };

  // একই ব্যবহারকারীর দুইটি sync একসাথে চললে ডুপ্লিকেট এড়াতে সারিবদ্ধ করা
  const gate = LockService.getUserLock();
  if (!gate.tryLock(30000)) return { ok: false, error: 'সার্ভার ব্যস্ত, একটু পরে আবার চেষ্টা করুন' };
  try {
    const results = [], idMap = {};
    if (ops.length) {
      const done = loadDoneOps_();
      const newRows = [];
      ops.forEach(function (op) {
        const opId = String(op && op.opId || '');
        if (!opId) { results.push({ opId: opId, ok: false, error: 'অবৈধ কাজ' }); return; }
        let r;
        if (done[opId]) {                       // আগেই চলেছে (নেটওয়ার্ক ফেল করে আবার পাঠানো)
          r = done[opId]; r.duplicate = true;
        } else {
          r = replayOp_(op);
          newRows.push([opId, nowStr_(), String(op.fn), r.ok ? 'OK' : 'ERR', JSON.stringify({ ok: r.ok, error: r.error || '', data: r.data || null }).slice(0, 3000)]);
        }
        if (r.ok && op.fn === 'createProduct' && op.local && op.local.id && r.data && r.data.id && r.data.id !== op.local.id) {
          idMap[op.local.id] = r.data.id;
        }
        results.push({ opId: opId, ok: !!r.ok, error: r.ok ? '' : String(r.error || 'ব্যর্থ'), duplicate: !!r.duplicate });
      });
      if (newRows.length) recordDoneOps_(newRows);
    }
    const out = { results: results, idMap: idMap };
    if (req.want === 'snapshot') {
      const snap = snapshot_();
      if (String(req.have || '') === snap.hash) out.unchanged = true;
      else out.snapshot = snap;
      out.hash = snap.hash;
    }
    return { ok: true, data: out };
  } finally {
    gate.releaseLock();
  }
}

/** একটি কাজ সার্ভারে চালানো — অফলাইনে করার আসল সময় বসিয়ে */
function replayOp_(op) {
  const table = syncFuncs_();
  const fn = Object.prototype.hasOwnProperty.call(table, String(op.fn)) ? table[String(op.fn)] : null;
  if (!fn) return { ok: false, error: 'অনুমোদিত নয়: ' + op.fn };
  const args = JSON.parse(JSON.stringify(op.args || []));   // আইডি বদলের কাজ অ্যাপ (engine.js) নিজেই করে
  setClock_(op.ts);
  try {
    return fn.apply(null, args);               // Code.gs-এর ফাংশনই {ok,data}/{ok:false,error} ফেরত দেয়
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    setClock_(null);
  }
}

function syncSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName(SYNC_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SYNC_SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['Op ID', 'At', 'Function', 'Result', 'Details']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#0B2F33');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
  }
  return sh;
}

function loadDoneOps_() {
  const sh = syncSheet_(), last = sh.getLastRow(), map = {};
  if (last < 2) return map;
  sh.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
    if (!r[0]) return;
    let d = {};
    try { d = JSON.parse(String(r[4] || '{}')); } catch (e) { d = {}; }
    map[String(r[0])] = { ok: r[3] === 'OK' && d.ok !== false, error: d.error || '', data: d.data || null };
  });
  return map;
}

function recordDoneOps_(rows) {
  const sh = syncSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  const last = sh.getLastRow();
  if (last > SYNC_KEEP + 1000) sh.deleteRows(2, last - SYNC_KEEP - 1);   // পুরোনো রেকর্ড ছাঁটাই
}

/* ------------------------------------------------------------------ */
/*  ছবি: অফলাইনে দেখার জন্য প্রোডাক্ট/লোগো ছবি ডাউনলোড                   */
/* ------------------------------------------------------------------ */
function imagesAction_(ids) {
  ids = Array.isArray(ids) ? ids.slice(0, 8) : [];
  // শুধু অ্যাপের নিজের ছবি (প্রোডাক্ট + লোগো) দেওয়া হবে — Drive-এর অন্য ফাইল নয়
  const allowed = {};
  readRows_('Products').forEach(function (r) { if (r[10]) allowed[String(r[10])] = true; });
  const logo = settingsMap_().LogoId;
  if (logo) allowed[String(logo)] = true;
  const out = [];
  ids.forEach(function (id) {
    id = String(id);
    if (!allowed[id]) return;
    try {
      const blob = DriveApp.getFileById(id).getBlob();
      out.push({ id: id, mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) });
    } catch (e) { /* ফাইল নেই — বাদ */ }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/*  বারকোড: Google Sheet + Drive-এ সব প্রোডাক্টের বারকোড ছবি তৈরি        */
/* ------------------------------------------------------------------ */
/** অ্যাপের "Google Sheet-এ বারকোড ছবি তৈরি করুন" বাটন — Code.gs-এর generateBarcodes-ই চালায় */
function barcodesAction_(req) {
  const gate = LockService.getUserLock();
  if (!gate.tryLock(30000)) return { ok: false, error: 'সার্ভার ব্যস্ত, একটু পরে আবার চেষ্টা করুন' };
  try {
    return { ok: true, data: generateBarcodes(!!req.force) };
  } finally {
    gate.releaseLock();
  }
}
