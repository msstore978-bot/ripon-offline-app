/** ক্যামেরা স্ক্যানারের ডিকোডার: আমাদের তৈরি বারকোড ছবি → (ছোট/বড়, ঝাপসা, নয়েজ, ঘোরানো, উল্টো) → ঠিকঠাক পড়া */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { ok, eq, done } = require('./harness');
const Scan = require('../web/js/barcode-scan.js');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Barcode.gs'), 'utf8'), ctx);
const bitmap = (text, opts) => vm.runInContext('barcodeBitmap_', ctx)(text, opts);

/* ---- পরীক্ষার ছবির যন্ত্রপাতি ---- */
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7; };
function fromBitmap(bm, W, H, ox, oy, bg) {          // বারকোড বিটম্যাপ → বড় ধূসর ক্যানভাস
  const img = new Float32Array(W * H).fill(bg);
  for (let y = 0; y < bm.h; y++) for (let x = 0; x < bm.w; x++) {
    const X = x + ox, Y = y + oy; if (X < W && Y < H) img[Y * W + X] = bm.pixels[y][x] ? 25 : 235;
  }
  return img;
}
function sample(img, W, H, x, y) {                   // bilinear
  if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return 128;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0;
  return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + W] * (1 - fx) * fy + img[i + W + 1] * fx * fy;
}
function transform(img, W, H, { scale = 1, rot = 0, blur = 0, noise = 0, shade = 0, flip = false, quarter = 0 }) {
  const w2 = Math.round(W * scale), h2 = Math.round(H * scale), out = new Float32Array(w2 * h2);
  const cx = W / 2, cy = H / 2, a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    let sx = (x - w2 / 2) / scale, sy = (y - h2 / 2) / scale;
    if (flip) { sx = -sx; sy = -sy; }
    const rx = sx * ca + sy * sa + cx, ry = -sx * sa + sy * ca + cy;
    out[y * w2 + x] = sample(img, W, H, rx, ry);
  }
  let cur = out, w = w2, h = h2;
  if (blur > 0) {                                       // separable gaussian
    const r = Math.ceil(blur * 3), k = []; let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * blur * blur)); k.push(v); ks += v; }
    const tmp = new Float32Array(w * h), o2 = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * cur[y * w + Math.min(w - 1, Math.max(0, x + i))]; tmp[y * w + x] = s / ks; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]; o2[y * w + x] = s / ks; }
    cur = o2;
  }
  const res = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = cur[y * w + x] + (noise ? gauss() * noise : 0) - shade * (x / w) * 90;   // shade: এক পাশ অন্ধকার
    res[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
  }
  let g = res, gw = w, gh = h;
  for (let q = 0; q < quarter; q++) {                   // ৯০° ঘোরানো
    const r90 = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) r90[x * gh + (gh - 1 - y)] = g[y * gw + x];
    g = r90; [gw, gh] = [gh, gw];
  }
  return { gray: g, w: gw, h: gh };
}
const scene = (bm, dist) => {                           // ফোনের ফ্রেমের মতো: ছবির চারপাশে কাগজ/টেবিল
  const W = bm.w + 240, H = bm.h + 260, img = fromBitmap(bm, W, H, 120, 130, 200);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x < 70 || y < 70) && img[y * W + x] === 200) img[y * W + x] = 120;   // পাশে অন্য বস্তু
  return transform(img, W, H, dist);
};

/* ---- EAN-13 এনকোডার (শুধু টেস্টের জন্য) ---- */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_R = EAN_L.map(b => b.replace(/./g, c => c === '0' ? '1' : '0')), EAN_G = EAN_R.map(b => [...b].reverse().join(''));
const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function eanCheck(d12) { let s = 0; for (let i = 0; i < 12; i++) s += +d12[i] * (i % 2 ? 3 : 1); return String((10 - s % 10) % 10); }
function eanBitmap(d13, m) {
  const d = [...d13].map(Number); let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (PAR[d[0]][i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
  bits += '01010'; for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]];
  bits += '101';
  const quiet = 11, w = (bits.length + 2 * quiet) * m, h = 110, px = [];
  for (let y = 0; y < h; y++) { const r = new Array(w).fill(0); for (let i = 0; i < bits.length; i++) if (bits[i] === '1') for (let k = 0; k < m; k++) r[(quiet + i) * m + k] = 1; px.push(r); }
  return { pixels: px, w, h };
}

/* ---- ১) সহজ অবস্থা: পরিষ্কার ছবি ---- */
const texts = ['PRD-000001', 'PRD-000042', 'PRD-001234', '8901234567890', 'ABC-123', '12345678', 'X', 'Hello World', 'a1b2', 'SKU/77.A_9', '0123456789', '99'];
texts.forEach(t => {
  const bm = bitmap(t), W = bm.w + 200, H = bm.h + 200;
  const img = fromBitmap(bm, W, H, 100, 100, 220), g = new Uint8Array(W * H); img.forEach((v, i) => g[i] = v);
  const r = Scan.decodeGray(g, W, H);
  eq(r && r.text, t, 'পরিষ্কার Code128 "' + t + '"');
});

/* ---- ২) ক্যামেরার মতো ঝামেলা: মাপ, ঝাপসা, নয়েজ, হালকা ঘোরানো, ছায়া ---- */
const cases = [
  ['ছোট (০.৬×, ক্যামেরার লেন্সের হালকা ঝাপসা সহ)', { scale: 0.6, blur: 0.8 }], ['বড় (১.৮×)', { scale: 1.8 }], ['ঝাপসা', { blur: 1.4 }],
  ['নয়েজ', { noise: 14 }], ['৩° কাত', { rot: 3 }], ['−৪° কাত', { rot: -4 }], ['ছায়া', { shade: 0.7 }],
  ['ছোট+ঝাপসা+নয়েজ', { scale: 0.75, blur: 1.0, noise: 10 }], ['কাত+ছায়া+নয়েজ', { rot: 2.5, shade: 0.5, noise: 9 }],
  ['উল্টো (১৮০°)', { flip: true }], ['ফোন ঘোরানো (৯০°)', { quarter: 1 }]
];
let total = 0, good = 0;
['PRD-000001', '8901234567890', 'PRD-000042', 'ABC-123'].forEach(t => {
  const bm = bitmap(t);
  cases.forEach(([name, d]) => {
    total++;
    const s = scene(bm, d), r = Scan.decodeGray(s.gray, s.w, s.h);
    const pass = !!r && r.text === t; if (pass) good++; else console.log('  ✗', t, '—', name);
  });
});
ok(good === total, 'ক্যামেরার ঝামেলাসহ ' + good + '/' + total + ' ঠিকঠাক পড়া গেছে');

/* ---- ৩) ভুল পড়া নয়: বারকোড ছাড়া ছবি/ভাঙা বারকোডে কিছুই দেয় না ---- */
const noise = new Uint8Array(400 * 300); for (let i = 0; i < noise.length; i++) noise[i] = Math.round(rnd() * 255);
eq(Scan.decodeGray(noise, 400, 300), null, 'এলোমেলো নয়েজে কোনো ভুল বারকোড আসে না');
const flat = new Uint8Array(400 * 300).fill(180); eq(Scan.decodeGray(flat, 400, 300), null, 'ফাঁকা ছবিতে কিছু আসে না');
{ const bm = bitmap('PRD-000001'); for (let y = 0; y < bm.h; y++) for (let x = 40; x < 58; x++) bm.pixels[y][x] ^= 1;   // মাঝখানে দাগ নষ্ট
  const s = scene(bm, {}); const r = Scan.decodeGray(s.gray, s.w, s.h); ok(!r || r.text === 'PRD-000001', 'নষ্ট বারকোড ভুল মান দেয় না (Checksum)'); }

/* ---- ৪) EAN-13 / UPC-A (দোকানের কেনা পণ্যের প্রচলিত বারকোড) ---- */
['590123412345', '400638133393', '978020137962', '890103010101', '036000291452', '501234567890'].forEach(p => {
  const d13 = p + eanCheck(p), bm = eanBitmap(d13, 3);
  let s = scene(bm, {}); let r = Scan.decodeGray(s.gray, s.w, s.h); eq(r && r.text, d13, 'EAN-13 ' + d13);
  s = scene(bm, { scale: 0.7, blur: 0.9, noise: 8, rot: 2 }); r = Scan.decodeGray(s.gray, s.w, s.h); eq(r && r.text, d13, 'EAN-13 ' + d13 + ' (ঝামেলাসহ)');
  s = scene(bm, { flip: true }); r = Scan.decodeGray(s.gray, s.w, s.h); eq(r && r.text, d13, 'EAN-13 ' + d13 + ' (উল্টো)');
});
// UPC-A (১২ সংখ্যা) = EAN-13 এর আগে ০
{ const upc = '036000291452', bm = eanBitmap('0' + upc, 3), s = scene(bm, {}); const r = Scan.decodeGray(s.gray, s.w, s.h); eq(r && r.text, '0' + upc, 'UPC-A ' + upc + ' → ১৩ সংখ্যায় (আগে ০)'); }

/* ---- ৫) গতি: একটি ফ্রেম (960×540) কত সময় ---- */
{ const bm = bitmap('PRD-000001'), s = scene(bm, { scale: 1.4 }); const t0 = process.hrtime.bigint();
  const N = 20; for (let i = 0; i < N; i++) Scan.decodeGray(s.gray, s.w, s.h);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N; ok(ms < 60, 'প্রতি ফ্রেম গড় ' + ms.toFixed(1) + ' ms (' + s.w + '×' + s.h + ')');
  const empty = new Uint8Array(960 * 540).fill(150), t1 = process.hrtime.bigint(); for (let i = 0; i < N; i++) Scan.decodeGray(empty, 960, 540);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6 / N; ok(ms2 < 80, 'বারকোড না থাকলেও (সবচেয়ে খারাপ অবস্থা) প্রতি ফ্রেম ' + ms2.toFixed(1) + ' ms'); }
module.exports = { eanBitmap, eanCheck };
if (require.main === module) done('scanner (Code128 + EAN-13 decoder)');
