/** বারকোড: Google Sheets/Drive-এ ছবি তৈরি, স্বয়ংক্রিয় বারকোড, পুরোনো শিট মাইগ্রেশন, PNG-এর বৈধতা */
const zlib = require('zlib');
const { makeEnv, ok, eq, done } = require('./harness');

/** PNG বাইট → {w,h,bits[y][x]} (১ = কালো) — Node-এর zlib দিয়ে, স্বাধীনভাবে */
function readPng(bytes) {
  const b = Buffer.from(bytes);
  eq([...b.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let pos = 8, w = 0, h = 0, idat = [], depth = 0, ctype = -1;
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('ascii', pos + 4, pos + 8), data = b.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  ok(depth === 1 && ctype === 0, 'PNG 1-bit grayscale');
  const raw = zlib.inflateSync(Buffer.concat(idat)), rb = Math.ceil(w / 8), bits = [];
  for (let y = 0; y < h; y++) {
    const row = []; const off = y * (rb + 1) + 1;
    for (let x = 0; x < w; x++) row.push(((raw[off + (x >> 3)] >> (7 - (x & 7))) & 1) ? 0 : 1);
    bits.push(row);
  }
  return { w, h, bits };
}

const env = makeEnv({ now: '2026-09-19T10:00:00Z' });
const call = env.call, T = env.store.tables;
call('setupDatabase'); call('importExcelProducts');

/* ---- ১) Sheet-এর কাঠামো ---- */
eq(T.Products[0].slice(13), ['Barcode', 'Barcode Image ID', 'Barcode Image URL'], 'Products শিটে বারকোড ছবির কলাম আছে');
eq(T.Products[1][13], 'PRD-000001', 'ইমপোর্ট করা প্রোডাক্টে বারকোড = আইডি');

/* ---- ২) নতুন প্রোডাক্ট → স্বয়ংক্রিয় বারকোড ছবি (Drive ফাইল) ---- */
let r = call('createProduct', { name: 'নতুন ঘড়ি', purchase: 100, price: 150, stock: 4 });
ok(r.ok, 'createProduct ok');
let row = T.Products[T.Products.length - 1];
eq(row[13], row[0], 'বারকোড ফাঁকা দিলে প্রোডাক্ট আইডিই বারকোড');
ok(row[14] && /uc\?export=view&id=/.test(row[15]), 'Barcode Image ID ও URL সেভ হয়েছে');
let f = env.store.files[row[14]];
ok(f && f.mime === 'image/png', 'Drive-এ PNG ফাইল তৈরি হয়েছে');
const png = readPng(f.bytes);
ok(png.w > 300 && png.h > 100, 'ছবির মাপ: ' + png.w + '×' + png.h);
eq(r.data.barcode, row[0], 'API-র উত্তরেও barcode আছে');

/* ---- ৩) নিজের বারকোড দিলে সেটাই ছবি হয়; বদলালে পুরোনো ছবি মুছে নতুন ---- */
const id = row[0], oldFile = row[14];
r = call('updateProduct', { id, name: 'নতুন ঘড়ি', purchase: 100, price: 150, low: 5, barcode: '8901234567890' });
row = T.Products.find(x => x[0] === id);
eq(row[13], '8901234567890', 'নিজের বারকোড রাখা হয়েছে');
ok(row[14] !== oldFile && !env.store.files[oldFile] && env.store.files[row[14]], 'বারকোড বদলে গেছে → পুরোনো ছবি মুছেছে, নতুন তৈরি');
r = call('updateProduct', { id, name: 'নতুন ঘড়ি (নাম বদল)', purchase: 100, price: 150, low: 5, barcode: '8901234567890' });
ok(T.Products.find(x => x[0] === id)[14] === row[14], 'শুধু নাম বদলালে বারকোড ছবি অপরিবর্তিত');
r = call('updateProduct', { id, name: 'নতুন ঘড়ি', purchase: 100, price: 150, low: 5, barcode: '' });
eq(T.Products.find(x => x[0] === id)[13], id, 'বারকোড মুছে দিলে আবার আইডিই বারকোড');
r = call('createProduct', { name: 'ডুপ্লিকেট', purchase: 1, price: 2, stock: 1, barcode: id });
ok(!r.ok && /বারকোড/.test(r.error), 'একই বারকোড দুই প্রোডাক্টে চলে না');

/* ---- ৪) generateBarcodes(): বিদ্যমান সব প্রোডাক্টের ছবি + "Barcodes" শিট ---- */
let g = env.ctx.generateBarcodes ? require('vm').runInContext('generateBarcodes()', env.ctx) : null;
eq([g.made, g.left], [42, 0], 'বিদ্যমান ৪২টি প্রোডাক্টের বারকোড ছবি তৈরি (নতুনটির আগেই ছিল: ' + g.kept + ')');
const noImg = T.Products.slice(1).filter(x => x[0] && !x[14]);
eq(noImg.length, 0, 'কোনো প্রোডাক্ট ছবি ছাড়া নেই');
const ids = new Set(T.Products.slice(1).map(x => x[14])); eq(ids.size, T.Products.length - 1, 'প্রতিটি প্রোডাক্টের আলাদা ছবি');
const B = T.Barcodes;
eq(B[0], ['Product ID', 'Product Name', 'Barcode', 'Barcode Image', 'Download'], 'Barcodes শিটের হেডার');
eq(B.length, T.Products.length, 'Barcodes শিটে প্রতিটি প্রোডাক্টের সারি');
ok(/^=IMAGE\("https:\/\/drive\.google\.com\/uc\?export=view&id=/.test(B[1][3]) && /^=HYPERLINK\(".*export=download/.test(B[1][4]), 'ছবি (=IMAGE) ও ডাউনলোড লিংক (=HYPERLINK) আছে');
g = require('vm').runInContext('generateBarcodes()', env.ctx); eq([g.made, g.kept], [0, 43], 'দ্বিতীয়বার চালালে নতুন কিছু তৈরি হয় না');
const before = Object.keys(env.store.files).length;
g = require('vm').runInContext('generateBarcodes(true)', env.ctx); eq(g.made, 43, 'force দিলে সব নতুন করে');
eq(Object.keys(env.store.files).length, before, 'পুরোনো ছবিগুলো মুছে গেছে (ফাইল জমে না)');

/* ---- ৫) ডাউনলোড/প্রিন্টের জন্য ছবি (অফলাইনেও চলা ফাংশন) ---- */
r = call('getBarcodeImage', 'PRD-000001');
ok(r.ok && r.data.mime === 'image/png' && r.data.filename === 'PRD-000001_PRD-000001.png', 'getBarcodeImage: ' + r.data.filename);
const dl = readPng(Buffer.from(r.data.b64, 'base64'));
ok(dl.w > 300, 'ডাউনলোডের PNG বৈধ');
call('updateProduct', { id, name: 'নতুন ঘড়ি', purchase: 100, price: 150, low: 5, barcode: '8901234567890' });
r = call('getBarcodeImage', '8901234567890'); eq([r.data.productId, r.data.value], [id, '8901234567890'], 'বারকোড দিয়েও প্রোডাক্টের ছবি পাওয়া যায়');
r = call('getBarcodeImage', 'NOSUCH-1'); eq([r.data.productId, r.data.value], ['', 'NOSUCH-1'], 'অচেনা মান হলেও ছবি বানানো যায়');
ok(!call('getBarcodeImage', '').ok, 'খালি ইনপুটে ত্রুটি');

/* ---- ৬) পুরোনো (১৪ কলামের) Sheet নতুন কোডে নিজে থেকে আপগ্রেড ---- */
const old = makeEnv({});
old.store.props.DB_READY = '1';
old.store.tables.Products = [
  ['Product ID', 'Product Name', 'Category', 'Supplier', 'Size', 'Purchase Price', 'Cost', 'Sales Price', 'Stock', 'Low Stock', 'Image ID', 'Image URL', 'Created Date', 'Barcode'],
  ['PRD-000001', 'পুরোনো ঘড়ি', 'ঘড়ি', '', '', 50, 0, 80, 7, 5, '', '', '2026-01-01 10:00:00', '']
];
['Sales', 'Expenses', 'Savings', 'Settings'].forEach(n => old.store.tables[n] = [['x']]);
r = old.call('getProducts');
ok(r.ok && r.data.length === 1 && r.data[0].stock === 7, 'পুরোনো ডাটা অক্ষত');
eq(old.store.tables.Products[0].slice(13), ['Barcode', 'Barcode Image ID', 'Barcode Image URL'], 'পুরোনো শিটের হেডারে নতুন কলাম যোগ হয়েছে');
eq(old.store.props.DB_READY, '2', 'DB ভার্সন ২');
done('barcode (Sheets + Drive)');
