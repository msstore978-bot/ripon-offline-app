/**
 * অফলাইন → সিঙ্ক পুরো প্রবাহের টেস্ট:
 *   সার্ভার = Code.gs + Api.gs (আসল Apps Script যেভাবে চলে)
 *   ডিভাইস  = engine.js + gas-shim.js + অপরিবর্তিত Code.gs
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeEnv, ok, eq, done } = require('./harness');
const { create } = require('../web/js/engine.js');
const shimLib = require('../web/js/gas-shim.js');
const CODE = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');

const server = makeEnv({ server: true, now: '2026-09-19T10:00:00Z' });
server.call('setupDatabase'); server.call('importExcelProducts');
const KEY = server.call('generateApiKey');
const URL = 'https://script.google.com/macros/s/TEST/exec';
const rpc = (body) => JSON.parse(server.call('doPost', { postData: { contents: JSON.stringify(body) } }).text);

function device(name, nowIso) {
  const clock = { now: new Date(nowIso) }, mem = { tables: {}, state: undefined, files: {} };
  const st = { online: true, hook: null, posts: [] };
  const FakeDate = class extends Date { constructor(...a) { if (a.length === 0) super(clock.now.getTime()); else super(...a); } static now() { return clock.now.getTime(); } };
  let ctx = null, n = 0, events = { data: 0, status: 0, images: 0 };
  const eng = create({
    shim: shimLib,
    storage: {
      load: async () => structuredClone({ tables: mem.tables, state: mem.state, files: mem.files }),
      save: async (p) => {
        Object.keys(p.tables).forEach(k => { if (p.tables[k]) mem.tables[k] = structuredClone(p.tables[k]); else delete mem.tables[k]; });
        Object.keys(p.files).forEach(k => { if (p.files[k]) mem.files[k] = structuredClone(p.files[k]); else delete mem.files[k]; });
        if (p.state) mem.state = structuredClone(p.state);
      }
    },
    fetchCode: async () => CODE,
    evalCode: (text, globals) => { ctx = vm.createContext(Object.assign({ console, Date: FakeDate }, globals)); vm.runInContext(text, ctx); return nm => vm.runInContext(nm, ctx); },
    post: async (cfg, body) => {
      if (!st.online) throw new Error('offline');
      st.posts.push(body.action);
      if (st.hook && body.action === 'sync') { const h = st.hook; st.hook = null; await h(); }
      return rpc(Object.assign({ key: cfg.key }, body));
    },
    isOnline: () => st.online, now: () => clock.now.getTime(), uid: () => name + '-op' + (++n),
    setTimeout: () => 0, clearTimeout: () => {}, objectUrl: (m, b) => 'blob:' + b.length
  });
  eng.on('data', () => events.data++); eng.on('status', () => events.status++); eng.on('images', () => events.images++);
  return { eng, st, clock, events, mem, call: (fn, ...a) => eng.call(fn, a), local: fn => vm.runInContext(fn, ctx) };
}
const same = (dev, label) => {   // অফলাইন কপি == Google Sheets (সব ট্যাব)
  ['Products', 'Sales', 'Expenses', 'Savings', 'Settings'].forEach(t => eq(dev.eng._store.tables[t], server.store.tables[t], label + ': ' + t + ' স্থানীয় == সার্ভার'));
};

(async () => {
  /* ---- ১) প্রথম সংযোগ ---- */
  const A = device('A', '2026-09-18T15:00:00Z');
  eq((await A.eng.init()).configured, false, 'নতুন ডিভাইসে আগে সংযোগ লাগে');
  let err = null; try { await A.eng.configure(URL, 'ভুল-কি'); } catch (e) { err = e.message; }
  eq(err, 'API Key ভুল', 'ভুল API Key প্রত্যাখ্যাত');
  await A.eng.configure(URL, KEY);
  let r = await A.call('getAppData');
  ok(r.ok && r.data.products.length === 42, 'ডাউনলোডের পর অফলাইনে ৪২টি প্রোডাক্ট');
  same(A, 'প্রথম ডাউনলোড');

  /* ---- ২) অফলাইনে বিক্রি (আগের দিনের সময়ে) ---- */
  A.st.online = false;
  r = await A.call('createSale', { token: 'tk1', items: [{ id: 'PRD-000001', qty: 2 }] });
  ok(r.ok, 'অফলাইনে বিক্রি সফল'); eq(r.data.stock['PRD-000001'], 46, 'স্থানীয় স্টক কমেছে');
  r = await A.call('createExpense', { category: 'নাস্তা', amount: 30 });
  eq(A.eng.status().pending, 2, 'দুইটি কাজ জমা আছে');
  eq((await A.eng.syncNow()).skipped, 'offline', 'অফলাইনে সিঙ্ক হয় না');
  // সার্ভারে এখনও কিছু নেই
  eq(server.store.tables.Sales.length, 1, 'সার্ভারে এখনও কোনো বিক্রি নেই (শুধু হেডার)');

  /* ---- ৩) অনলাইনে এলে সিঙ্ক ---- */
  A.st.online = true;
  r = await A.eng.syncNow();
  eq([r.sent, r.error, r.changed], [2, '', true], 'সিঙ্ক সফল');
  eq(A.eng.status().pending, 0, 'কাজ জমা নেই');
  eq(server.store.tables.Sales[1][1].slice(0, 10), '2026-09-18', 'সার্ভারে বিক্রির তারিখ অফলাইনে করার দিনই (সিঙ্কের দিন নয়)');
  eq(server.store.tables.Expenses[1][1], '2026-09-18', 'খরচের তারিখও ঠিক');
  eq(server.call('getProducts').data.find(p => p.id === 'PRD-000001').stock, 46, 'সার্ভারের স্টক কমেছে');
  same(A, 'সিঙ্কের পর');

  /* ---- ৪) একই কাজ দুইবার পাঠালে ডুপ্লিকেট হয় না ---- */
  const op = { opId: 'dup-1', fn: 'createExpense', args: [{ category: 'X', amount: 5, date: '2026-09-19' }], ts: Date.now() };
  rpc({ key: KEY, action: 'sync', ops: [op] }); rpc({ key: KEY, action: 'sync', ops: [op] });
  eq(server.store.tables.Expenses.filter(x => x[2] === 'X').length, 1, 'idempotent: একই opId একবারই চলেছে');
  ok(rpc({ key: 'bad', action: 'ping' }).error === 'API Key ভুল', 'ভুল কি → অনুমতি নেই');
  ok(!rpc({ key: KEY, action: 'sync', ops: [{ opId: 'x9', fn: 'importExcelProducts', args: [] }] }).data.results[0].ok, 'অনুমোদিত তালিকার বাইরের ফাংশন চলে না');
  await A.eng.syncNow();   // Api.gs-এর সরাসরি লেখা খরচ নামিয়ে আনা

  /* ---- ৫) কিছু বদলায়নি → unchanged ---- */
  const dBefore = A.events.data;
  r = await A.eng.syncNow(); eq(r.changed, false, 'কিছু না বদলালে ডাটা আবার নামে না'); eq(A.events.data, dBefore, 'UI রিফ্রেশও হয় না');

  /* ---- ৬) দুই ডিভাইসে একই আইডির নতুন প্রোডাক্ট ---- */
  const B = device('B', '2026-09-19T08:00:00Z');
  await B.eng.init(); await B.eng.configure(URL, KEY);
  A.st.online = false; B.st.online = false;
  const pa = await A.call('createProduct', { name: 'A-ঘড়ি', purchase: 100, price: 150, stock: 3 });
  const pb = await B.call('createProduct', { name: 'B-ঘড়ি', purchase: 50, price: 80, stock: 5, image: { data: Buffer.from('imgbytes').toString('base64'), mime: 'image/jpeg' } });
  eq([pa.data.id, pb.data.id], ['PRD-000043', 'PRD-000043'], 'দুই ডিভাইসে স্থানীয় আইডি একই (সংঘর্ষ)');
  ok(B.eng.imgUrl(pb.data.imageId).startsWith('blob:'), 'অফলাইনে তোলা ছবি স্থানীয়ভাবেই দেখা যায়');
  await B.call('createSale', { token: 'b-tk', items: [{ id: 'PRD-000043', qty: 1 }] });
  B.st.online = A.st.online = true;
  await A.eng.syncNow();
  r = await B.eng.syncNow();
  eq(r.error, '', 'B-এর সিঙ্ক সফল');
  const prods = server.call('getProducts').data;
  eq(prods.find(p => p.name === 'A-ঘড়ি').id, 'PRD-000043', 'A-ঘড়ি পেয়েছে PRD-000043');
  const bp = prods.find(p => p.name === 'B-ঘড়ি');
  eq([bp.id, bp.stock], ['PRD-000044', 4], 'B-ঘড়ি নতুন আইডি PRD-000044, বিক্রির পর স্টক ৪');
  ok(server.store.tables.Sales.some(x => x[2] === 'PRD-000044' && x[3] === 'B-ঘড়ি'), 'B-এর বিক্রি সঠিক (নতুন) আইডিতে বসেছে');
  ok(/^L/.test(bp.imageId) && !!server.store.files[bp.imageId], 'ছবি সার্ভারের Drive-এ পৌঁছেছে');
  await B.eng.cacheImages();
  ok(B.eng.imgUrl(bp.imageId).startsWith('blob:'), 'সিঙ্কের পর Drive-এর ছবি অফলাইনের জন্য নামানো হয়েছে');
  same(B, 'সংঘর্ষের পর B'); await A.eng.syncNow(); same(A, 'সংঘর্ষের পর A');

  /* ---- ৭) স্টক সংঘর্ষ: অন্য ডিভাইস আগে বিক্রি করে ফেলেছে ---- */
  A.st.online = false;
  await A.call('createSale', { token: 'a-tk2', items: [{ id: 'PRD-000043', qty: 3 }] });   // A ভাবছে ৩টিই আছে
  B.st.online = true;
  await B.call('createSale', { token: 'b-tk2', items: [{ id: 'PRD-000043', qty: 2 }] });
  await B.eng.syncNow();                                                                    // সার্ভারে এখন ১টি
  A.st.online = true; await A.eng.syncNow();
  const fl = A.eng.status().failed;
  eq(fl.length, 1, 'ব্যর্থ কাজ হারায়নি — "সমস্যা" তালিকায় আছে');
  ok(/পর্যাপ্ত স্টক নেই/.test(fl[0].error), 'কারণ: ' + fl[0].error);
  eq(A.eng.status().pending, 0, 'আটকে থাকা কাজ নেই');
  eq((await A.call('getProducts')).data.find(p => p.id === 'PRD-000043').stock, 1, 'A-এর স্থানীয় স্টক সার্ভারের সত্যের সাথে মিলেছে');
  same(A, 'সংঘর্ষের পর');
  A.eng.discardFailed(fl[0].opId); eq(A.eng.status().failed.length, 0, 'ব্যর্থ কাজ বাদ দেওয়া যায়');

  /* ---- ৮) সিঙ্ক চলার সময় করা নতুন কাজ হারায় না (rebase) ---- */
  A.st.hook = async () => { await A.call('createExpense', { category: 'সিঙ্কের-মাঝে', amount: 11 }); };
  await A.call('createExpense', { category: 'প্রথম', amount: 7 });
  await A.eng.syncNow();
  eq(A.eng.status().pending, 1, 'সিঙ্কের মাঝে করা খরচ এখনও বাকি');
  ok((await A.call('getExpenses')).data.items.some(x => x.category === 'সিঙ্কের-মাঝে'), '…এবং স্থানীয়ভাবে দেখা যাচ্ছে (হারায়নি)');
  await A.eng.syncNow();
  ok(server.store.tables.Expenses.some(x => x[2] === 'সিঙ্কের-মাঝে'), 'পরের সিঙ্কে সার্ভারে পৌঁছেছে');
  eq(A.eng.status().pending, 0, 'সব কাজ শেষ'); same(A, 'শেষে');

  /* ---- ৯) অ্যাপ বন্ধ করে খুললেও অফলাইন কাজ থাকে (স্থায়ী সংরক্ষণ) ---- */
  A.st.online = false;
  await A.call('createSaving', { amount: 500, note: 'রাতের জমা' });
  const A2 = device('A', '2026-09-19T20:00:00Z'); A2.mem.tables = A.mem.tables; A2.mem.state = A.mem.state; A2.mem.files = A.mem.files;
  const boot = await A2.eng.init();
  eq(boot.configured, true, 'রিলোডের পর সংযোগ মনে আছে'); eq(A2.eng.status().pending, 1, 'রিলোডের পরও অসিঙ্ক কাজ আছে');
  eq((await A2.call('getSavings')).data.total, 500, 'রিলোডের পর ডাটা অক্ষত');

  /* ---- ১০) ঘড়ির hook আগের আচরণ বদলায়নি ---- */
  server.setNow('2026-09-25T09:30:00Z');
  eq(server.call('todayStr_'), '2026-09-25', 'স্বাভাবিক অবস্থায় todayStr_() এখনকার তারিখই দেয়');
  done('sync (device ⇄ Apps Script)');
})().catch(e => { console.error('CRASH', e); process.exit(2); });
