/**
 * Barcode.gs — বারকোড ছবি তৈরির ফাংশন (Code 128)
 *
 * • কোনো বাইরের সার্ভিস/লাইব্রেরি লাগে না; সব কিছু নিজে তৈরি করে PNG ছবি বানায়।
 * • একই কোড Apps Script (Google Sheets/Drive), অফলাইন অ্যাপ (ব্রাউজার) ও টেস্টে চলে।
 * • ফাংশনগুলো "pure" — শুধু ইনপুট থেকে আউটপুট; Drive/Sheet-এ লেখার কাজ Code.gs করে।
 *
 * প্রধান ফাংশন:
 *   barcodePngB64_(text, opts)  →  PNG ছবির base64 (Drive-এ সেভ / ডাউনলোড / <img> এর জন্য)
 *   code128Widths_(text)        →  দাগ/ফাঁকের প্রস্থের তালিকা (module)
 */

/* Code 128 প্যাটার্ন: মান ০–১০৫ (৬টি করে বার/স্পেস প্রস্থ, মোট ১১ module), ১০৬ = Stop (৭টি, মোট ১৩ module) */
var CODE128_WIDTHS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

/** ৫×৭ বিটম্যাপ ফন্ট (বারকোডের নিচের লেখার জন্য) */
var BARCODE_FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100']
};

/* ------------------------------------------------------------------ */
/*  Code 128 এনকোডার (Subset B ও C নিজে বেছে নেয়)                        */
/* ------------------------------------------------------------------ */

/** টেক্সট → Code128 মানের তালিকা (Start + ডাটা + Checksum), Stop বাদে */
function code128Values_(text) {
  text = String(text);
  if (!text.length) throw new Error('বারকোডের লেখা খালি');
  for (var k = 0; k < text.length; k++) {
    var cc = text.charCodeAt(k);
    if (cc < 32 || cc > 126) throw new Error('বারকোডে শুধু ইংরেজি অক্ষর, সংখ্যা ও চিহ্ন চলে');
  }
  var vals = [], set = '', i = 0;
  var digitsAt = function (pos) {          // pos থেকে একটানা কতগুলো সংখ্যা
    var n = 0;
    while (pos + n < text.length && text.charAt(pos + n) >= '0' && text.charAt(pos + n) <= '9') n++;
    return n;
  };
  while (i < text.length) {
    var run = digitsAt(i);
    // একটানা ৪+ সংখ্যা (শুরু/শেষে ২+) হলে Subset C (দুই সংখ্যা = ১ প্রতীক), নইলে Subset B
    var useC = run >= 4 || (run >= 2 && i + run === text.length && set === 'C');
    if (i === 0 && run === text.length && run >= 2) useC = true;
    if (useC) {
      if (set !== 'C') { vals.push(set === '' ? 105 : 99); set = 'C'; }
      var pairs = Math.floor(run / 2);
      for (var p = 0; p < pairs; p++) { vals.push(parseInt(text.substr(i, 2), 10)); i += 2; }
    } else {
      if (set !== 'B') { vals.push(set === '' ? 104 : 100); set = 'B'; }
      vals.push(text.charCodeAt(i) - 32); i++;
    }
  }
  var sum = vals[0];
  for (var j = 1; j < vals.length; j++) sum += vals[j] * j;
  vals.push(sum % 103);
  return vals;
}

/** টেক্সট → বার/স্পেস প্রস্থের তালিকা (প্রথমটি বার), Stop সহ */
function code128Widths_(text) {
  var vals = code128Values_(text).concat([106]), out = [];
  vals.forEach(function (v) {
    var s = CODE128_WIDTHS[v];
    for (var k = 0; k < s.length; k++) out.push(s.charCodeAt(k) - 48);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/*  ছবি: বিটম্যাপ → PNG (১-বিট, অসংকুচিত zlib ব্লক)                       */
/* ------------------------------------------------------------------ */
var _crcTable = null;
function crc32_(bytes) {
  if (!_crcTable) {
    _crcTable = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function adler32_(bytes) {
  var a = 1, b = 0;
  for (var i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function be32_(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function pngChunk_(type, data) {
  var t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  var body = t.concat(data);
  return be32_(data.length).concat(body, be32_(crc32_(body)));
}

/** pixels: সারি-ভিত্তিক তালিকা, প্রতি সারি = ০/১ এর অ্যারে (১ = কালো) → PNG বাইট অ্যারে */
function pngFromBits_(pixels, w, h) {
  var rowBytes = Math.ceil(w / 8), raw = [];
  for (var y = 0; y < h; y++) {
    raw.push(0);                                     // filter: none
    var row = pixels[y];
    for (var bx = 0; bx < rowBytes; bx++) {
      var byte = 0xFF;                               // ১ = সাদা (grayscale, 1-bit)
      for (var bit = 0; bit < 8; bit++) {
        var x = bx * 8 + bit;
        if (x < w && row[x]) byte &= ~(0x80 >> bit); // কালো পিক্সেল = ০
      }
      raw.push(byte);
    }
  }
  var z = [0x78, 0x01], pos = 0;
  while (pos < raw.length || pos === 0) {
    var len = Math.min(65535, raw.length - pos), last = (pos + len >= raw.length) ? 1 : 0;
    z.push(last, len & 255, (len >>> 8) & 255, (~len) & 255, ((~len) >>> 8) & 255);
    for (var q = 0; q < len; q++) z.push(raw[pos + q]);
    pos += len;
    if (last) break;
  }
  z = z.concat(be32_(adler32_(raw)));
  var ihdr = be32_(w).concat(be32_(h), [1, 0, 0, 0, 0]);   // 1-bit grayscale
  return [137, 80, 78, 71, 13, 10, 26, 10].concat(pngChunk_('IHDR', ihdr), pngChunk_('IDAT', z), pngChunk_('IEND', []));
}

var _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64Encode_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += _B64.charAt(b0 >> 2) + _B64.charAt(((b0 & 3) << 4) | (b1 >> 4)) +
      (i + 1 < bytes.length ? _B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=') +
      (i + 2 < bytes.length ? _B64.charAt(b2 & 63) : '=');
  }
  return out;
}

/**
 * বারকোডের বিটম্যাপ তৈরি (নিচে পড়ার মতো লেখাসহ)
 * opts: { module: px (৩), height: বারের উচ্চতা px (৯০), quiet: quiet-zone module (১০), text: true/false, label: নিচের লেখা }
 */
function barcodeBitmap_(text, opts) {
  opts = opts || {};
  var m = opts.module || 3, barH = opts.height || 90, quiet = opts.quiet || 10;
  var showText = opts.text !== false, label = String(opts.label != null ? opts.label : text);
  var widths = code128Widths_(text), modules = 0;
  widths.forEach(function (x) { modules += x; });
  var barsW = modules * m, textScale = Math.max(2, Math.round(m)), glyphW = 5 * textScale, gap = textScale;
  var textW = showText ? label.length * (glyphW + gap) - gap : 0;
  var w = Math.max(barsW + 2 * quiet * m, textW + 2 * quiet * m);
  var padTop = 6 * m, textH = showText ? 7 * textScale : 0, textGap = showText ? 4 * m : 0;
  var h = padTop + barH + textGap + textH + (showText ? 5 * m : padTop);
  var px = [], y, x;
  for (y = 0; y < h; y++) { var r = new Array(w); for (x = 0; x < w; x++) r[x] = 0; px.push(r); }
  var x0 = Math.floor((w - barsW) / 2), cx = x0, dark = true;
  widths.forEach(function (wd) {
    if (dark) for (var xx = cx; xx < cx + wd * m; xx++) for (var yy = padTop; yy < padTop + barH; yy++) px[yy][xx] = 1;
    cx += wd * m; dark = !dark;
  });
  if (showText) {
    var tx = Math.floor((w - textW) / 2), ty = padTop + barH + textGap;
    for (var c = 0; c < label.length; c++) {
      var ch = label.charAt(c).toUpperCase(), g = BARCODE_FONT[ch] || BARCODE_FONT['?'];
      for (var gy = 0; gy < 7; gy++) for (var gx = 0; gx < 5; gx++) {
        if (g[gy].charAt(gx) === '1') {
          for (var sy = 0; sy < textScale; sy++) for (var sx = 0; sx < textScale; sx++) {
            px[ty + gy * textScale + sy][tx + gx * textScale + sx] = 1;
          }
        }
      }
      tx += glyphW + gap;
    }
  }
  return { pixels: px, w: w, h: h };
}

/** টেক্সট → বারকোড PNG (base64)। Drive-এ সেভ, <img src="data:image/png;base64,…"> বা ডাউনলোডে ব্যবহার হয় */
function barcodePngB64_(text, opts) {
  var bm = barcodeBitmap_(String(text), opts);
  return b64Encode_(pngFromBits_(bm.pixels, bm.w, bm.h));
}

/** ফাইলের নামে চলে এমন নিরাপদ অংশ */
function barcodeSafeName_(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}
